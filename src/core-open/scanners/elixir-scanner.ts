// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { fetchHexVersionsBulk } from './hex-cache.js';
import { gt, minVersion, validRange } from 'semver';
import type { ProjectScan, DependencyRow, DetectedFramework } from '../types.js';
import { readTextFile, pathExists, FileCache } from '../utils/fs.js';
import type { PackageVersionManifest } from '../package-version-manifest.js';
import * as path from 'node:path';

interface ElixirDependency {
  name: string;
  version: string;
  isDev: boolean;
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

/**
 * Parse mix.exs to extract dependencies.
 */
async function parseMixExs(filePath: string, cache?: FileCache): Promise<{
  elixirVersion?: string;
  deps: ElixirDependency[];
}> {
  const content = cache 
    ? await cache.readTextFile(filePath)
    : await readTextFile(filePath);
  
  const deps: ElixirDependency[] = [];
  let elixirVersion: string | undefined;

  // Extract Elixir version requirement
  const elixirMatch = content.match(/elixir:\s*"([^"]+)"/);
  if (elixirMatch) {
    elixirVersion = elixirMatch[1];
  }

  // Parse dependencies - they appear in deps() function
  // Format: {:package_name, "~> 1.0.0"} or {:package_name, "~> 1.0.0", only: :dev}
  const depsRegex = /\{\s*:(\w+)\s*,\s*"([^"]+)"(?:,\s*(?:only|optional|runtime):\s*:(\w+))?\s*\}/g;
  let match: RegExpExecArray | null;

  while ((match = depsRegex.exec(content)) !== null) {
    const name = match[1];
    const version = match[2];
    const scope = match[3]; // dev, test, prod, etc.

    deps.push({
      name,
      version,
      isDev: scope === 'dev' || scope === 'test',
    });
  }

  // Also handle git dependencies (for awareness, though we can't fetch versions)
  // {:dep, git: "https://github.com/user/repo.git", tag: "v1.0.0"}
  const gitDepsRegex = /\{\s*:(\w+)\s*,\s*git:\s*"[^"]+"/g;
  while ((match = gitDepsRegex.exec(content)) !== null) {
    const name = match[1];
    // Skip git dependencies for version checking
  }

  return { elixirVersion, deps };
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

  const { elixirVersion, deps } = await parseMixExs(mixExsPath, cache);

  // Read mix.lock for exact versions
  const mixLockPath = `${projectPath}/mix.lock`;
  const resolvedVersions = await parseMixLock(mixLockPath, cache);

  // Use resolved versions if available, otherwise parse from constraints
  const depsToCheck = deps.filter(d => !d.isDev);
  const packageNames = depsToCheck.map(d => d.name);

  // Fetch latest versions
  const latestVersions = await fetchHexVersionsBulk(packageNames, manifest, offline);

  // Build dependency list with drift analysis
  const dependencies: DependencyRow[] = [];
  const frameworks: DetectedFramework[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  for (const dep of depsToCheck) {
    const resolvedVersion = resolvedVersions.get(dep.name);
    const currentVersion = resolvedVersion || dep.version;
    const latestVersion = latestVersions.get(dep.name);
    const drift = latestVersion ? calculateDrift(currentVersion, latestVersion) : 'unknown';
    
    let majorsBehind: number | null = null;
    
    if (resolvedVersion && latestVersion) {
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
      section: dep.isDev ? 'devDependencies' : 'dependencies',
      currentSpec: dep.version,
      resolvedVersion: resolvedVersion || null,
      latestStable: latestVersion || null,
      majorsBehind,
      drift,
    });

    // Update buckets
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
