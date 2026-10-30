// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { fetchHexVersionsBulk } from './hex-cache.js';
import { gt, minVersion, validRange } from 'semver';
import type { ProjectScan, DependencyRow, DepSection, DetectedFramework } from '../types.js';
import { readTextFile, pathExists, FileCache } from '../utils/fs.js';
import type { PackageVersionManifest } from '../package-version-manifest.js';
import * as path from 'node:path';

export interface ElixirDependency {
  name: string;
  version: string;
  /** True when every `only:` environment is `:dev` or `:test`. */
  isDev: boolean;
  /** True when the tuple sets `optional: true`. A dev row still wins the section. */
  optional: boolean;
}

const ELIXIR_MANIFEST_FILES = new Set(['mix.exs']);

/**
 * Known Elixir frameworks/libraries to detect during scanning.
 */
const KNOWN_FRAMEWORKS = new Set([
  'phoenix',
  'phoenix_live_view',
  'phoenix_html',
  'phoenix_ecto',
  'phoenix_pubsub',
  'ecto',
  'ecto_sql',
  'plug',
  'plug_cowboy',
  'cowboy',
  'ranch',
  'absinthe',
  'absinthe_plug',
  'guardian',
  'comeonin',
  'bcrypt_elixir',
  'argon2_elixir',
  'pbkdf2_elixir',
  'ex_machina',
  'mock',
  'mox',
  'excoveralls',
  'credo',
  'dialyxir',
  'ex_doc',
  'jason',
  'poison',
  'httpoison',
  'tesla',
  'finch',
  'mint',
  'hackney',
  'timex',
  'quantum',
  'oban',
  'broadway',
  'gen_stage',
  'flow',
  'bamboo',
  'swoosh',
  'ex_aws',
  'ex_aws_s3',
  'redix',
  'cachex',
  'nebulex',
  'floki',
  'wallaby',
  'hound',
]);

const DEV_ENVS = new Set(['dev', 'test']);

/**
 * Hex tuples start `{:name, "requirement"`. Walk to the matching `}` so a
 * keyword list of any length, including `only: [:dev, :test]` and options on
 * later lines, stays inside the tuple. Brackets and quotes do not end it.
 */
function readTupleRemainder(content: string, start: number): { options: string; end: number } | null {
  let braces = 1;
  let brackets = 0;
  let quote: '"' | "'" | null = null;

  for (let i = start; i < content.length; i++) {
    const ch = content[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      brackets++;
      continue;
    }
    if (ch === ']') {
      if (brackets > 0) brackets--;
      continue;
    }
    if (ch === '{') {
      braces++;
      continue;
    }
    if (ch === '}') {
      if (brackets > 0) continue;
      braces--;
      if (braces === 0) return { options: content.slice(start, i), end: i + 1 };
    }
  }

  return null;
}

/**
 * `only: :dev`, `only: :test`, or a list of only those atoms is a dev row.
 * `only: [:prod]` and any list that includes `:prod` stay production.
 */
function devOnlyEnvironments(options: string): boolean {
  const only = options.match(/\bonly:\s*(\[[^\]]*\]|:\w+)/);
  if (!only?.[1]) return false;
  const raw = only[1];
  const envs = raw.startsWith('[')
    ? [...raw.matchAll(/:(\w+)/g)].map((match) => match[1]!)
    : [raw.slice(1)];
  return envs.length > 0 && envs.every((env) => DEV_ENVS.has(env));
}

/** `git:`, `path:`, and `in_umbrella:` tuples are not Hex packages. */
function isNonHexTuple(options: string): boolean {
  return /\b(?:git|path|in_umbrella):/.test(options);
}

/**
 * Parse mix.exs source for the Elixir requirement and Hex `deps()` tuples.
 * `git:`, `path:`, and `in_umbrella:` dependencies are skipped.
 */
export function parseMixExs(content: string): {
  elixirVersion?: string;
  deps: ElixirDependency[];
} {
  const deps: ElixirDependency[] = [];
  let elixirVersion: string | undefined;

  const elixirMatch = content.match(/elixir:\s*"([^"]+)"/);
  if (elixirMatch) {
    elixirVersion = elixirMatch[1];
  }

  const tupleStart = /\{\s*:(\w+)\s*,\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;

  while ((match = tupleStart.exec(content)) !== null) {
    const name = match[1]!;
    const version = match[2]!;
    const remainder = readTupleRemainder(content, match.index + match[0].length);
    if (!remainder) break;
    if (remainder.end <= tupleStart.lastIndex) break;
    tupleStart.lastIndex = remainder.end;
    if (isNonHexTuple(remainder.options)) continue;

    deps.push({
      name,
      version,
      isDev: devOnlyEnvironments(remainder.options),
      optional: /\boptional:\s*true\b/.test(remainder.options),
    });
  }

  return { elixirVersion, deps };
}

/**
 * A dev row stays `devDependencies` even when it also sets `optional: true`,
 * matching the Cargo section order in `rust-scanner.ts`.
 */
function elixirSection(dep: ElixirDependency): DepSection {
  if (dep.isDev) return 'devDependencies';
  if (dep.optional) return 'optionalDependencies';
  return 'dependencies';
}

/**
 * Parse mix.lock to get exact resolved versions.
 */
async function parseMixLock(filePath: string, cache?: FileCache): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  
  try {
    const content = cache 
      ? await cache.readTextFile(filePath)
      : await readTextFile(filePath);
    
    // mix.lock format: "package_name": {:hex, :package_name, "1.0.0", ...}
    const lockRegex = /"(\w+)":\s*\{\s*:hex\s*,\s*:\w+\s*,\s*"([^"]+)"/g;
    let match: RegExpExecArray | null;

    while ((match = lockRegex.exec(content)) !== null) {
      const name = match[1];
      const version = match[2];
      resolved.set(name, version);
    }
  } catch {
    // Lock file doesn't exist or is invalid
  }
  
  return resolved;
}

/**
 * Calculate version drift for a dependency.
 */
function calculateDrift(
  currentVersion: string,
  latestVersion: string,
): 'current' | 'minor-behind' | 'major-behind' | 'unknown' {
  try {
    // Remove version prefixes like ~>, >=, etc.
    const cleaned = currentVersion.replace(/^[~><=\s]+/, '');
    
    const current = minVersion(validRange(cleaned) || cleaned);
    if (!current) {
      return 'unknown';
    }

    if (!gt(latestVersion, current.version)) {
      return 'current';
    }

    const latestParsed = minVersion(latestVersion);
    if (!latestParsed) {
      return 'unknown';
    }

    // Check if major version differs
    if (latestParsed.major > current.major) {
      return 'major-behind';
    }

    // Check if minor version differs (includes patch)
    return 'minor-behind';
  } catch {
    return 'unknown';
  }
}

/**
 * Scan a directory for Elixir projects.
 */
export async function scanElixir(
  projectPath: string,
  cache?: FileCache,
  manifest?: PackageVersionManifest,
  offline = false,
): Promise<ProjectScan | null> {
  const mixExsPath = `${projectPath}/mix.exs`;
  
  // Check if mix.exs exists
  const hasMixExs = cache 
    ? await cache.pathExists(mixExsPath)
    : await pathExists(mixExsPath);

  if (!hasMixExs) {
    return null;
  }

  const content = cache
    ? await cache.readTextFile(mixExsPath)
    : await readTextFile(mixExsPath);
  const { elixirVersion, deps } = parseMixExs(content);

  // Read mix.lock for exact versions
  const mixLockPath = `${projectPath}/mix.lock`;
  const resolvedVersions = await parseMixLock(mixLockPath, cache);

  // Hex lookups stay on production rows, including optional ones. Dev rows
  // are still emitted, and they do not move the drift buckets.
  const packageNames = deps.filter((dep) => !dep.isDev).map((dep) => dep.name);
  const latestVersions = await fetchHexVersionsBulk(packageNames, manifest, offline);

  // Build dependency list with drift analysis
  const dependencies: DependencyRow[] = [];
  const frameworks: DetectedFramework[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  for (const dep of deps) {
    const resolvedVersion = resolvedVersions.get(dep.name);
    const currentVersion = resolvedVersion || dep.version;
    const latestVersion = dep.isDev ? undefined : latestVersions.get(dep.name);
    const drift = latestVersion ? calculateDrift(currentVersion, latestVersion) : 'unknown';

    let majorsBehind: number | null = null;

    if (!dep.isDev && resolvedVersion && latestVersion) {
      try {
        const currentParsed = minVersion(validRange(currentVersion) || currentVersion);
        const latestParsed = minVersion(validRange(latestVersion) || latestVersion);
        if (currentParsed && latestParsed) {
          majorsBehind = latestParsed.major - currentParsed.major;
        }
      } catch { /* ignore parse errors */ }
    }

    dependencies.push({
      package: dep.name,
      section: elixirSection(dep),
      currentSpec: dep.version,
      resolvedVersion: resolvedVersion || null,
      latestStable: latestVersion || null,
      majorsBehind,
      drift,
    });

    if (dep.isDev) continue;

    // Update buckets for production rows only (optional rows included).
    if (drift === 'current') buckets.current++;
    else if (majorsBehind === 1) buckets.oneBehind++;
    else if (majorsBehind && majorsBehind > 1) buckets.twoPlusBehind++;
    else buckets.unknown++;

    // Detect frameworks
    if (KNOWN_FRAMEWORKS.has(dep.name)) {
      frameworks.push({
        name: dep.name,
        currentVersion: resolvedVersion || null,
        latestVersion: latestVersion || null,
        majorsBehind,
      });
    }
  }

  return {
    type: 'elixir',
    path: path.relative(projectPath.includes('/') ? projectPath.split('/').slice(0, -1).join('/') : '.', projectPath) || '.',
    name: path.basename(projectPath),
    runtime: elixirVersion,
    frameworks,
    dependencies,
    dependencyAgeBuckets: buckets,
  };
}

/**
 * Check if a file is an Elixir manifest file.
 */
export function isElixirManifest(fileName: string): boolean {
  return ELIXIR_MANIFEST_FILES.has(fileName);
}

/**
 * Scan for Elixir projects in a directory tree.
 */
export async function scanElixirProjects(
  rootDir: string,
  manifest?: PackageVersionManifest,
  cache?: FileCache,
  projectScanTimeout?: number,
  offline = false,
): Promise<ProjectScan[]> {
  // Find Elixir manifest files
  const manifestFiles = cache
    ? await cache.findFiles(rootDir, (name) => ELIXIR_MANIFEST_FILES.has(name))
    : [];

  // Group manifests by directory to form "projects"
  const projectDirs = new Map<string, string[]>();
  for (const f of manifestFiles) {
    const dir = path.dirname(f);
    if (!projectDirs.has(dir)) projectDirs.set(dir, []);
    projectDirs.get(dir)!.push(f);
  }

  const results: ProjectScan[] = [];

  for (const [dir] of projectDirs) {
    try {
      const scan = await scanElixir(dir, cache, manifest, offline);
      if (scan) {
        // Report the repo-relative directory, not the basename: the project
        // dedupe in run-scan keys on path, so a basename here makes the same
        // mix.exs appear twice (once via this scanner, once via the polyglot
        // scanner's repo-relative entry).
        scan.path = path.relative(rootDir, dir) || '.';
        results.push(scan);
      }
    } catch (error) {
      // Skip projects that fail to scan
      console.error(`Error scanning Elixir project at ${dir}:`, error);
    }
  }

  return results;
}
