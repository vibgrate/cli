// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { fetchHexVersionsBulk } from './hex-cache.js';
import { gt, minVersion, validRange } from 'semver';
import type { ProjectScan, DependencyRow, DepSection, DetectedFramework } from '../types.js';
import { readTextFile, pathExists, FileCache } from '../utils/fs.js';
import type { PackageVersionManifest } from '../package-version-manifest.js';
import * as path from 'node:path';

interface ElixirDependency {
  name: string;
  version: string;
  /** True when every `only:` environment is `:dev` or `:test`. */
  isDev: boolean;
  /** True when `optional: true`. Dev wins over this when the row is built. */
  optional: boolean;
}

/** Mix source options that are not Hex packages. */
const NON_HEX_SOURCE_KEYS = new Set(['git', 'github', 'path', 'in_umbrella']);

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

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

function skipWsComments(content: string, i: number): number {
  while (i < content.length) {
    const c = content[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    break;
  }
  return i;
}

/** End index after a `"` string or `"""` heredoc that starts at `i`. */
function endOfString(content: string, i: number): number {
  if (content.startsWith('"""', i)) {
    const end = content.indexOf('"""', i + 3);
    return end < 0 ? content.length : end + 3;
  }
  i++;
  while (i < content.length) {
    if (content[i] === '\\') {
      i += 2;
      continue;
    }
    if (content[i] === '"') return i + 1;
    if (content[i] === '\n') return i;
    i++;
  }
  return i;
}

function readString(content: string, i: number): { value: string; end: number } {
  if (content.startsWith('"""', i)) {
    const end = content.indexOf('"""', i + 3);
    const close = end < 0 ? content.length : end;
    return { value: content.slice(i + 3, close), end: end < 0 ? content.length : end + 3 };
  }
  const start = i + 1;
  const end = endOfString(content, i);
  const rawEnd = content[end - 1] === '"' && !content.startsWith('"""', i) ? end - 1 : end;
  let value = '';
  for (let j = start; j < rawEnd; j++) {
    if (content[j] === '\\' && j + 1 < rawEnd) {
      value += content[j + 1];
      j++;
      continue;
    }
    value += content[j];
  }
  return { value, end };
}

function skipCharlist(content: string, i: number): number {
  if (content.startsWith("'''", i)) {
    const end = content.indexOf("'''", i + 3);
    return end < 0 ? content.length : end + 3;
  }
  i++;
  while (i < content.length) {
    if (content[i] === '\\') {
      i += 2;
      continue;
    }
    if (content[i] === '\'') return i + 1;
    if (content[i] === '\n') return i;
    i++;
  }
  return i;
}

/**
 * Skip an Elixir sigil (`~s"..."`, `~S"""..."""`, `~r/.../`) when one starts
 * at `i`. Returns null when `i` is not a sigil.
 */
function skipSigil(content: string, i: number): number | null {
  if (content[i] !== '~') return null;
  let j = i + 1;
  if (!/[A-Za-z]/.test(content[j] ?? '')) return null;
  j++;
  const delim = content[j];
  if (delim === undefined) return null;
  const pairs: Record<string, string> = {
    '"': '"',
    "'": "'",
    '(': ')',
    '[': ']',
    '{': '}',
    '/': '/',
    '|': '|',
    '<': '>',
  };
  const close = pairs[delim];
  if (close === undefined) return null;
  if (delim === '"' && content.startsWith('"""', j)) {
    const end = content.indexOf('"""', j + 3);
    return end < 0 ? content.length : end + 3;
  }
  if (delim === "'" && content.startsWith("'''", j)) {
    const end = content.indexOf("'''", j + 3);
    return end < 0 ? content.length : end + 3;
  }
  const uppercase = content[i + 1] === content[i + 1]?.toUpperCase();
  j++;
  while (j < content.length) {
    if (!uppercase && content[j] === '\\') {
      j += 2;
      continue;
    }
    if (content[j] === close) return j + 1;
    if ((delim === '"' || delim === "'") && content[j] === '\n') return j;
    j++;
  }
  return j;
}

function readAtom(content: string, i: number): { name: string; end: number } | null {
  if (content[i] !== ':') return null;
  const start = i + 1;
  if (!/[A-Za-z_]/.test(content[start] ?? '')) return null;
  let j = start + 1;
  while (isIdentChar(content[j])) j++;
  return { name: content.slice(start, j), end: j };
}

/** Consume one keyword value, stopping before a top-level comma or closer. */
function skipValue(content: string, i: number): number {
  i = skipWsComments(content, i);
  let depth = 0;
  while (i < content.length) {
    const sigilEnd = skipSigil(content, i);
    if (sigilEnd !== null) {
      i = sigilEnd;
      continue;
    }
    const c = content[i];
    if (c === '#') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      i = endOfString(content, i);
      continue;
    }
    if (c === '\'') {
      i = skipCharlist(content, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    if (c === ',' && depth === 0) return i;
    i++;
  }
  return i;
}

/**
 * `only:` is dev-only when the value is the atom `:dev` or `:test`, or a
 * list whose every atom is one of those. Any other environment, including
 * `:prod` beside `:dev`, keeps the row a production dependency.
 */
function parseOnlyDev(content: string, start: number): { dev: boolean; end: number } {
  const i0 = skipWsComments(content, start);
  if (content[i0] === ':') {
    const atom = readAtom(content, i0);
    if (!atom) return { dev: false, end: skipValue(content, start) };
    return { dev: atom.name === 'dev' || atom.name === 'test', end: atom.end };
  }
  if (content[i0] !== '[') return { dev: false, end: skipValue(content, start) };

  const envs: string[] = [];
  let i = i0 + 1;
  while (i < content.length) {
    i = skipWsComments(content, i);
    if (content[i] === ']') {
      const dev = envs.length > 0 && envs.every((env) => env === 'dev' || env === 'test');
      return { dev, end: i + 1 };
    }
    if (content[i] === ',') {
      i++;
      continue;
    }
    if (content[i] === ':') {
      const atom = readAtom(content, i);
      if (!atom) return { dev: false, end: skipValue(content, start) };
      envs.push(atom.name);
      i = atom.end;
      continue;
    }
    return { dev: false, end: skipValue(content, start) };
  }
  return { dev: false, end: skipValue(content, start) };
}

function parseOptionalFlag(content: string, start: number): { optional: boolean; end: number } {
  const i = skipWsComments(content, start);
  if (content.startsWith('true', i) && !isIdentChar(content[i + 4])) {
    return { optional: true, end: i + 4 };
  }
  if (content.startsWith('false', i) && !isIdentChar(content[i + 5])) {
    return { optional: false, end: i + 5 };
  }
  return { optional: false, end: skipValue(content, start) };
}

function matchTupleName(content: string, i: number): { name: string; innerStart: number } | null {
  i = skipWsComments(content, i);
  if (content[i] !== ':') return null;
  const atom = readAtom(content, i);
  if (!atom) return null;
  i = skipWsComments(content, atom.end);
  if (content[i] !== ',') return null;
  return { name: atom.name, innerStart: i + 1 };
}

function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < content.length) {
    const sigilEnd = skipSigil(content, i);
    if (sigilEnd !== null) {
      i = sigilEnd;
      continue;
    }
    const c = content[i];
    if (c === '#') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      i = endOfString(content, i);
      continue;
    }
    if (c === '\'') {
      i = skipCharlist(content, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Read one `{:name, "version", keyword: value, ...}` tuple.
 * `git:`, `github:`, `path:`, and `in_umbrella:` tuples are not Hex deps.
 * The first double-quoted string is the version requirement.
 */
function parseDepTuple(name: string, inner: string): ElixirDependency | null {
  let i = 0;
  let version: string | null = null;
  let skip = false;
  let isDev = false;
  let optional = false;

  while (i < inner.length) {
    const sigilEnd = skipSigil(inner, i);
    if (sigilEnd !== null) {
      i = sigilEnd;
      continue;
    }
    const c = inner[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < inner.length && inner[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      const str = readString(inner, i);
      if (version === null) version = str.value;
      i = str.end;
      continue;
    }
    if (c === '\'') {
      i = skipCharlist(inner, i);
      continue;
    }
    if (/[A-Za-z_]/.test(c ?? '')) {
      const start = i;
      i++;
      while (isIdentChar(inner[i])) i++;
      const ident = inner.slice(start, i);
      const after = skipWsComments(inner, i);
      if (inner[after] === ':') {
        const valueAt = after + 1;
        if (NON_HEX_SOURCE_KEYS.has(ident)) {
          skip = true;
          i = skipValue(inner, valueAt);
        } else if (ident === 'only') {
          const only = parseOnlyDev(inner, valueAt);
          isDev = only.dev;
          i = only.end;
        } else if (ident === 'optional') {
          const flag = parseOptionalFlag(inner, valueAt);
          optional = flag.optional;
          i = flag.end;
        } else {
          i = skipValue(inner, valueAt);
        }
        continue;
      }
      i = after;
      continue;
    }
    if (c === ':') {
      const atom = readAtom(inner, i);
      i = atom ? atom.end : i + 1;
      continue;
    }
    if (c === '[' || c === '{' || c === '(') {
      i = skipValue(inner, i);
      continue;
    }
    i++;
  }

  if (skip || version === null || version === '') return null;
  return { name, version, isDev, optional };
}

function parseDepTuples(content: string): ElixirDependency[] {
  const deps: ElixirDependency[] = [];
  let i = 0;
  while (i < content.length) {
    const sigilEnd = skipSigil(content, i);
    if (sigilEnd !== null) {
      i = sigilEnd;
      continue;
    }
    const c = content[i];
    if (c === '#') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      i = endOfString(content, i);
      continue;
    }
    if (c === '\'') {
      i = skipCharlist(content, i);
      continue;
    }
    if (c === '{') {
      const named = matchTupleName(content, i + 1);
      if (named) {
        const end = findMatchingBrace(content, i);
        if (end > i) {
          const dep = parseDepTuple(named.name, content.slice(named.innerStart, end));
          if (dep) deps.push(dep);
          i = end + 1;
          continue;
        }
      }
    }
    i++;
  }
  return deps;
}

/**
 * Parse mix.exs to extract dependencies.
 * Tuples may carry a keyword list of any length, including across lines.
 * `{:dep, git: "..."}`, `path:`, and `in_umbrella:` are skipped.
 */
async function parseMixExs(filePath: string, cache?: FileCache): Promise<{
  elixirVersion?: string;
  deps: ElixirDependency[];
}> {
  const content = cache
    ? await cache.readTextFile(filePath)
    : await readTextFile(filePath);

  const elixirMatch = content.match(/elixir:\s*"([^"]+)"/);
  const elixirVersion = elixirMatch?.[1];
  return { elixirVersion, deps: parseDepTuples(content) };
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

  // Hex lookups and drift buckets stay on production rows, including
  // optional ones. Development rows are still emitted. `only:` dev wins
  // over `optional: true`, the same precedence as the Rust scanner.
  const packageNames = deps.filter((dep) => !dep.isDev).map((dep) => dep.name);
  const latestVersions = await fetchHexVersionsBulk(packageNames, manifest, offline);

  const dependencies: DependencyRow[] = [];
  const frameworks: DetectedFramework[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  for (const dep of deps) {
    const resolvedVersion = resolvedVersions.get(dep.name) || null;
    let section: DepSection = 'dependencies';
    if (dep.isDev) section = 'devDependencies';
    else if (dep.optional) section = 'optionalDependencies';

    if (dep.isDev) {
      dependencies.push({
        package: dep.name,
        section,
        currentSpec: dep.version,
        resolvedVersion,
        latestStable: null,
        majorsBehind: null,
        drift: 'unknown',
      });
      continue;
    }

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
      section,
      currentSpec: dep.version,
      resolvedVersion,
      latestStable: latestVersion || null,
      majorsBehind,
      drift,
    });

    if (drift === 'current') buckets.current++;
    else if (majorsBehind === 1) buckets.oneBehind++;
    else if (majorsBehind && majorsBehind > 1) buckets.twoPlusBehind++;
    else buckets.unknown++;

    if (KNOWN_FRAMEWORKS.has(dep.name)) {
      frameworks.push({
        name: dep.name,
        currentVersion: resolvedVersion,
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
