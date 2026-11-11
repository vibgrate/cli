// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { readTextFile, readJsonFile, pathExists, FileCache } from '../utils/fs.js';
import { recordedSemver } from '../utils/recorded-semver.js';
import { withTimeout } from '../utils/timeout.js';
import { CargoCache } from './cargo-cache.js';
import { rethrowLockfileParseError } from '../utils/lockfile-parse.js';
import { loadCargoLockIndex, type CargoLockIndex } from './cargo-lockfile.js';
import type { LockfileIo } from './npm-lockfile.js';
import type { ProjectScan, DependencyRow, DetectedFramework, DepSection } from '../types.js';
import { compareCodeUnits } from '../utils/code-unit.js';

/** Well-known Rust frameworks / libraries to track */
const KNOWN_RUST_FRAMEWORKS: Record<string, string> = {
  // ── Web Frameworks ──
  'actix-web': 'Actix Web',
  'rocket': 'Rocket',
  'axum': 'Axum',
  'warp': 'Warp',
  'tide': 'Tide',
  'poem': 'Poem',

  // ── Async Runtime ──
  'tokio': 'Tokio',
  'async-std': 'async-std',
  'smol': 'smol',

  // ── Serialization ──
  'serde': 'Serde',
  'serde_json': 'Serde JSON',
  'bincode': 'Bincode',
  'toml': 'TOML',

  // ── Database & ORM ──
  'diesel': 'Diesel',
  'sqlx': 'SQLx',
  'sea-orm': 'SeaORM',

  // ── HTTP Client ──
  'reqwest': 'reqwest',
  'hyper': 'hyper',
  'ureq': 'ureq',

  // ── CLI ──
  'clap': 'clap',
  'structopt': 'structopt',

  // ── Logging ──
  'log': 'log',
  'env_logger': 'env_logger',
  'tracing': 'tracing',
  'tracing-subscriber': 'tracing-subscriber',

  // ── Error Handling ──
  'anyhow': 'anyhow',
  'thiserror': 'thiserror',
  'eyre': 'eyre',

  // ── Testing ──
  'criterion': 'Criterion',
  'proptest': 'proptest',
  'mockall': 'mockall',

  // ── Cryptography ──
  'ring': 'ring',
  'rustls': 'rustls',
  'webpki': 'webpki',

  // ── Graphics & Game Dev ──
  'bevy': 'Bevy',
  'wgpu': 'wgpu',
  'winit': 'winit',

  // ── WebAssembly ──
  'wasm-bindgen': 'wasm-bindgen',
  'wasm-pack': 'wasm-pack',

  // ── Blockchain ──
  'substrate': 'Substrate',
  'ethers': 'ethers-rs',
};

/** A Cargo dependency table the scanner reads. Build maps to the same dev rows as dev. */
export type CargoDepTable = 'dependencies' | 'dev-dependencies' | 'build-dependencies';

export interface CargoDependencyHeader {
  table: CargoDepTable;
  /** True for `[target.<spec>.…]`. The spec itself is not stored. */
  target: boolean;
  /**
   * Set for `[dependencies.<crate>]` and `[target.<spec>.<kind>.<crate>]`.
   * Absent when the table lists each dependency as its own key.
   */
  crate?: string;
}

const CARGO_DEP_TABLES = new Set<string>(['dependencies', 'dev-dependencies', 'build-dependencies']);

function isCargoDepTable(value: string): value is CargoDepTable {
  return CARGO_DEP_TABLES.has(value);
}

/**
 * One TOML key (bare, literal `'...'`, or basic `"..."`).
 * A basic string treats `\` as an escape so `\"` does not end the key.
 * A literal string does not. The returned text is the key, not a decoded cfg.
 */
function readTomlKey(input: string, index: number): { raw: string; next: number } | null {
  let i = index;
  while (input[i] === ' ' || input[i] === '\t') i++;
  if (i >= input.length) return null;
  const quote = input[i];
  if (quote === "'" || quote === '"') {
    i++;
    let raw = '';
    while (i < input.length) {
      const ch = input[i]!;
      if (quote === '"' && ch === '\\') {
        if (i + 1 >= input.length) return null;
        raw += input[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === quote) return { raw, next: i + 1 };
      raw += ch;
      i++;
    }
    return null;
  }
  const bare = /^[A-Za-z0-9_-]+/.exec(input.slice(i));
  if (!bare) return null;
  return { raw: bare[0]!, next: i + bare[0]!.length };
}

/**
 * Classify a Cargo.toml table header.
 *
 * `[dependencies]`, `[dev-dependencies]`, and `[build-dependencies]` match
 * directly. `[target.<spec>.dependencies]`, `[target.<spec>.dev-dependencies]`,
 * and `[target.<spec>.build-dependencies]` map to those same tables.
 * `<spec>` may be a single-quoted cfg, a double-quoted cfg (escaped quotes
 * included), or a bare triple. `[dependencies.<crate>]`,
 * `[dev-dependencies.<crate>]`, `[build-dependencies.<crate>]`, and the
 * `[target.<spec>.<kind>.<crate>]` variants are the same tables with the
 * crate name on the header. Any other header is not a dependency table.
 */
export function cargoDependencyHeader(headerLine: string): CargoDependencyHeader | null {
  const trimmed = headerLine.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']') || trimmed.startsWith('[[')) return null;
  const inner = trimmed.slice(1, -1);
  const keys: string[] = [];
  let i = 0;
  while (i < inner.length) {
    const key = readTomlKey(inner, i);
    if (!key) return null;
    keys.push(key.raw);
    i = key.next;
    while (inner[i] === ' ' || inner[i] === '\t') i++;
    if (i >= inner.length) break;
    if (inner[i] !== '.') return null;
    i++;
  }
  if (keys.length === 1 && isCargoDepTable(keys[0]!)) return { table: keys[0], target: false };
  if (keys.length === 2 && isCargoDepTable(keys[0]!) && keys[1]) {
    return { table: keys[0], target: false, crate: keys[1] };
  }
  if (keys.length === 3 && keys[0] === 'target' && isCargoDepTable(keys[2]!)) return { table: keys[2], target: true };
  if (keys.length === 4 && keys[0] === 'target' && isCargoDepTable(keys[2]!) && keys[3]) {
    return { table: keys[2], target: true, crate: keys[3] };
  }
  return null;
}

/**
 * `[workspace.dependencies]` or `[workspace.dependencies.<crate>]`.
 * Any other header, including `[workspace]`, is not that table.
 */
function workspaceDependencyHeader(headerLine: string): { crate?: string } | null {
  const trimmed = headerLine.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']') || trimmed.startsWith('[[')) return null;
  const inner = trimmed.slice(1, -1);
  const keys: string[] = [];
  let i = 0;
  while (i < inner.length) {
    const key = readTomlKey(inner, i);
    if (!key) return null;
    keys.push(key.raw);
    i = key.next;
    while (inner[i] === ' ' || inner[i] === '\t') i++;
    if (i >= inner.length) break;
    if (inner[i] !== '.') return null;
    i++;
  }
  if (keys[0] !== 'workspace' || keys[1] !== 'dependencies') return null;
  if (keys.length === 2) return {};
  if (keys.length === 3 && keys[2]) return { crate: keys[2] };
  return null;
}

/** A `[workspace]` or `[workspace.*]` header marks the workspace root manifest. */
function hasWorkspaceTable(content: string): boolean {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[') || trimmed.startsWith('[[') || !trimmed.endsWith(']')) continue;
    const inner = trimmed.slice(1, -1).replace(/\s+/g, '');
    if (inner === 'workspace' || inner.startsWith('workspace.')) return true;
  }
  return false;
}

/**
 * One `[workspace.dependencies]` entry.
 * Absent `version` means the pin is path-only or git-only.
 * Absent `optional` or `features` means the workspace table did not set that key.
 */
export interface CargoWorkspacePin {
  version?: string;
  optional?: boolean;
  features?: string[];
}

interface DeclaredCargoDep extends CargoWorkspacePin {
  inherit: boolean;
}

/** Drop `#` comments, leaving quoted text alone so a `#` inside a string stays. */
function stripTomlComments(attrs: string): string {
  return attrs.split('\n').map((line) => {
    let quote: '"' | "'" | null = null;
    let out = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote) {
        out += ch;
        if (ch === '\\' && quote === '"') {
          i++;
          if (i < line.length) out += line[i]!;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === '#') break;
      out += ch;
    }
    return out;
  }).join('\n');
}

function readFeatureList(body: string): string[] {
  return body.split(',')
    .map((feature) => feature.trim().replace(/"/g, ''))
    .filter((feature) => feature.length > 0);
}

function readDeclaredCargoDep(attrs: string): DeclaredCargoDep {
  const cleaned = stripTomlComments(attrs);
  const versionMatch = /version\s*=\s*"([^"]+)"/.exec(cleaned);
  const optionalMatch = /optional\s*=\s*(true|false)\b/.exec(cleaned);
  const featuresMatch = /features\s*=\s*\[([^\]]*)\]/.exec(cleaned);
  // Quoted text can contain `workspace = true` (a git URL, a feature name).
  const unquoted = cleaned.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');
  const declared: DeclaredCargoDep = {
    inherit: /(?:^|[\s,{])workspace\s*=\s*true\b/.test(unquoted),
  };
  if (versionMatch) declared.version = versionMatch[1];
  if (optionalMatch) declared.optional = optionalMatch[1] === 'true';
  if (featuresMatch) declared.features = readFeatureList(featuresMatch[1]!);
  return declared;
}

function workspacePinFromAttrs(attrs: string): CargoWorkspacePin {
  const declared = readDeclaredCargoDep(attrs);
  const pin: CargoWorkspacePin = {};
  if (declared.version !== undefined) pin.version = declared.version;
  if (declared.optional !== undefined) pin.optional = declared.optional;
  if (declared.features !== undefined) pin.features = declared.features;
  return pin;
}

/**
 * `[workspace.dependencies]` from a workspace root Cargo.toml.
 * String form (`serde = "1.0"`) and table form (`serde = { version = "1.0" }`)
 * are both pins. `[workspace.dependencies.<crate>]` is the same pin.
 * A path-only or git-only table is stored with no `version`.
 */
export function parseWorkspaceDependencies(content: string): Map<string, CargoWorkspacePin> {
  const deps = new Map<string, CargoWorkspacePin>();
  let inTable = false;
  let subcrate: string | null = null;
  let sublines: string[] = [];

  const flush = (): void => {
    if (!subcrate) return;
    deps.set(subcrate, workspacePinFromAttrs(sublines.join('\n')));
    subcrate = null;
    sublines = [];
  };

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']') && !trimmed.startsWith('[[')) {
      flush();
      const header = workspaceDependencyHeader(trimmed);
      if (header?.crate) {
        subcrate = header.crate;
        inTable = false;
      } else {
        inTable = header !== null;
      }
      continue;
    }
    if (subcrate) {
      if (trimmed && !trimmed.startsWith('#')) sublines.push(trimmed);
      continue;
    }
    if (!inTable || !trimmed || trimmed.startsWith('#')) continue;
    const simple = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/.exec(trimmed);
    if (simple) {
      deps.set(simple[1]!, { version: simple[2]! });
      continue;
    }
    const complex = /^([A-Za-z0-9_-]+)\s*=\s*\{([^}]*)\}/.exec(trimmed);
    if (complex) deps.set(complex[1]!, workspacePinFromAttrs(complex[2]!));
  }
  flush();
  return deps;
}

/**
 * Inline-table body (`version = "1.0", optional = true`) and the lines under
 * `[dependencies.<crate>]`. `version` is the spec (`*` when absent).
 * `path` and `git` do not invent a version.
 * `workspace = true` with no local `version` uses `workspace.version` from
 * the matching `[workspace.dependencies]` pin (string or `version = "…"`).
 * A local `version` wins. `features` and `optional` come from that pin only
 * when the local table does not set them. A missing pin, or a path-only or
 * git-only pin, leaves the spec `*`.
 */
export function parseCargoDepAttrs(
  attrs: string,
  workspace?: CargoWorkspacePin | null,
): { version: string; optional: boolean; features: string[] } {
  const declared = readDeclaredCargoDep(attrs);
  const inherited = declared.inherit && workspace ? workspace : undefined;
  return {
    version: declared.version ?? inherited?.version ?? '*',
    optional: declared.optional ?? inherited?.optional ?? false,
    features: declared.features ?? (inherited?.features !== undefined ? [...inherited.features] : []),
  };
}

interface RustDependency {
  name: string;
  version: string;
  optional: boolean;
  features: string[];
  isDev: boolean;
  table: CargoDepTable;
  fromTarget: boolean;
}

/**
 * Lower wins, independent of file order.
 * A non-target production table beats a target production table.
 * Either production table beats dev and build.
 * `[dev-dependencies]` beats `[build-dependencies]`.
 * A non-target dev or build table beats the same kind under `target`.
 */
function cargoRowRank(dep: RustDependency): number {
  const targetBias = dep.fromTarget ? 1 : 0;
  if (dep.table === 'dependencies') return targetBias;
  if (dep.table === 'dev-dependencies') return 2 + targetBias;
  return 4 + targetBias;
}

function dedupeCargoDeps(deps: RustDependency[]): RustDependency[] {
  const byName = new Map<string, RustDependency>();
  for (const dep of deps) {
    const kept = byName.get(dep.name);
    if (!kept || cargoRowRank(dep) < cargoRowRank(kept)) byName.set(dep.name, dep);
  }
  return [...byName.values()];
}

function rustDep(
  name: string,
  header: CargoDependencyHeader,
  attrs: string,
  workspaceDeps: ReadonlyMap<string, CargoWorkspacePin>,
): RustDependency {
  const parsed = parseCargoDepAttrs(attrs, workspaceDeps.get(name));
  return {
    name,
    version: parsed.version,
    optional: parsed.optional,
    features: parsed.features,
    isDev: header.table !== 'dependencies',
    table: header.table,
    fromTarget: header.target,
  };
}

/**
 * Parse Cargo.toml to extract dependencies.
 *
 * Example:
 *   [dependencies]
 *   serde = { version = "1.0", features = ["derive"] }
 *   tokio = "1.35"
 *
 *   [dev-dependencies]
 *   criterion = "0.5"
 *
 *   [build-dependencies]
 *   cc = "1.0"
 *
 *   [target.'cfg(windows)'.dependencies]
 *   winapi = "0.3"
 *
 *   [dependencies.serde]
 *   version = "1.0"
 *   features = ["derive"]
 *
 *   [dev-dependencies.criterion]
 *   version = "0.5"
 *
 * A `[dependencies.<crate>]` table, and the dev, build, and target variants,
 * use the same attribute reader as an inline table. The pending sub-table is
 * flushed when the next header starts and at the end of the file.
 * Dev and build tables, including the matching `target` tables, are kept.
 * A crate named in a production table and a dev or build table is one
 * production row. The winning declaration supplies the version.
 * `workspace = true` reads the crate's pin from `workspaceDeps`, the workspace
 * root `[workspace.dependencies]` table. A local version still wins.
 */
function parseCargoToml(
  content: string,
  workspaceDeps: ReadonlyMap<string, CargoWorkspacePin> = new Map(),
): RustDependency[] {
  const deps: RustDependency[] = [];
  let current: CargoDependencyHeader | null = null;
  let subtableLines: string[] | null = null;

  const flushSubtable = (): void => {
    if (!current?.crate || subtableLines === null) return;
    deps.push(rustDep(current.crate, current, subtableLines.join('\n'), workspaceDeps));
    subtableLines = null;
  };

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      flushSubtable();
      current = cargoDependencyHeader(trimmed);
      subtableLines = current?.crate ? [] : null;
      continue;
    }

    if (!current) continue;

    if (current.crate) {
      if (trimmed && !trimmed.startsWith('#') && subtableLines) subtableLines.push(trimmed);
      continue;
    }

    // Parse dependency lines
    // Simple: serde = "1.0"
    // Complex: serde = { version = "1.0", features = ["derive"], optional = true }
    const simpleMatch = trimmed.match(/^([\w-]+)\s*=\s*"([^"]+)"/);
    if (simpleMatch) {
      deps.push({
        name: simpleMatch[1]!,
        version: simpleMatch[2]!,
        optional: false,
        features: [],
        isDev: current.table !== 'dependencies',
        table: current.table,
        fromTarget: current.target,
      });
      continue;
    }

    const complexMatch = trimmed.match(/^([\w-]+)\s*=\s*\{([^}]+)\}/);
    if (complexMatch) {
      deps.push(rustDep(complexMatch[1]!, current, complexMatch[2]!, workspaceDeps));
    }
  }

  flushSubtable();
  return dedupeCargoDeps(deps);
}

/**
 * Extract Rust edition from Cargo.toml.
 * 
 * Example:
 *   [package]
 *   edition = "2021"
 */
function extractRustEdition(content: string): string | undefined {
  const match = content.match(/^\s*edition\s*=\s*"(\d+)"/m);
  return match?.[1];
}

// ── Rust project file names ──

const RUST_MANIFEST_FILES = new Set([
  'Cargo.toml',
]);

/**
 * Discover and scan all Rust projects in the workspace.
 */
export async function scanRustProjects(
  rootDir: string,
  cargoCache: CargoCache,
  cache?: FileCache,
  projectScanTimeout?: number,
): Promise<ProjectScan[]> {
  // Find Cargo.toml files
  const manifestFiles = cache
    ? await cache.findFiles(rootDir, (name) => RUST_MANIFEST_FILES.has(name))
    : await findRustManifests(rootDir);

  const results: ProjectScan[] = [];
  const STUCK_TIMEOUT_MS = projectScanTimeout ?? cache?.projectScanTimeout ?? 180_000;

  for (const manifestFile of manifestFiles) {
    const dir = path.dirname(manifestFile);
    try {
      const scanPromise = scanOneRustProject(dir, manifestFile, rootDir, cargoCache, cache);
      const result = await withTimeout(scanPromise, STUCK_TIMEOUT_MS);
      if (result.ok) {
        results.push(result.value);
      } else {
        const relPath = path.relative(rootDir, dir);
        if (cache) cache.addStuckPath(relPath || '.');
        console.error(`Timeout scanning Rust project ${dir} (>${STUCK_TIMEOUT_MS / 1000}s) — skipped`);
        if (cache?.shouldShowTimeoutHint()) {
          console.error(`  Tip: increase projectScanTimeout in vibgrate.config.ts (or --project-scan-timeout <seconds>) for large projects`);
        }
      }
    } catch (e: unknown) {
      rethrowLockfileParseError(e);
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error scanning Rust project ${dir}: ${msg}`);
    }
  }

  return results;
}

async function findRustManifests(rootDir: string): Promise<string[]> {
  const { findFiles } = await import('../utils/fs.js');
  return findFiles(rootDir, (name) => RUST_MANIFEST_FILES.has(name));
}

async function readCargoManifestAt(
  manifestPath: string,
  readText: (filePath: string) => Promise<string>,
  exists: (filePath: string) => Promise<boolean>,
): Promise<string | null> {
  if (!(await exists(manifestPath))) return null;
  return readText(manifestPath);
}

/**
 * Cargo.toml of the nearest workspace root at `dir` or an ancestor inside
 * `rootDir`. The root is the manifest that contains `[workspace]` (or
 * `[workspace.*]`). A member that sets `workspace = true` inherits pins from
 * that file's `[workspace.dependencies]`.
 */
async function loadWorkspaceManifest(
  dir: string,
  rootDir: string,
  ownText: string,
  readText: (filePath: string) => Promise<string>,
  exists: (filePath: string) => Promise<boolean>,
): Promise<string | null> {
  let current = path.resolve(dir);
  const stop = path.resolve(rootDir);
  const ownDir = path.resolve(dir);
  for (;;) {
    if (current !== stop && !current.startsWith(`${stop}${path.sep}`)) return null;
    const text = current === ownDir
      ? ownText
      : await readCargoManifestAt(path.join(current, 'Cargo.toml'), readText, exists);
    if (text && hasWorkspaceTable(text)) return text;
    if (current === stop) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function scanOneRustProject(
  dir: string,
  manifestFile: string,
  rootDir: string,
  cargoCache: CargoCache,
  cache?: FileCache,
): Promise<ProjectScan> {
  const relDir = path.relative(rootDir, dir) || '.';
  const projectName = path.basename(dir === rootDir ? rootDir : dir);
  
  const content = cache ? await cache.readTextFile(manifestFile) : await readTextFile(manifestFile);
  const rustEdition = extractRustEdition(content);
  const readText = (filePath: string) => (cache ? cache.readTextFile(filePath) : readTextFile(filePath));
  const exists = (filePath: string) => (cache ? cache.pathExists(filePath) : pathExists(filePath));
  const workspaceText = await loadWorkspaceManifest(dir, rootDir, content, readText, exists);
  // Dev and build crates stay in this list. A name that is also production
  // is already a single production row (`parseCargoToml`).
  const allDeps = parseCargoToml(content, parseWorkspaceDependencies(workspaceText ?? ''));

  // Cargo.lock pins the exact resolved version of every crate. There is one per workspace, normally
  // beside this Cargo.toml; for a workspace member it lives at the root — so try the project dir then
  // the root. Prefer it over coercing the declared requirement.
  const lockIo: LockfileIo = {
    exists: (p) => (cache ? cache.pathExists(p) : pathExists(p)),
    readText: (p) => (cache ? cache.readTextFile(p) : readTextFile(p)),
    readJson: <T>(p: string) => (cache ? cache.readJsonFile<T>(p) : readJsonFile<T>(p)),
  };
  const swallow = (err: unknown): null => {
    rethrowLockfileParseError(err);
    return null;
  };
  let lockIndex: CargoLockIndex | null = await loadCargoLockIndex(dir, lockIo).catch(swallow);
  if (!lockIndex && dir !== rootDir) lockIndex = await loadCargoLockIndex(rootDir, lockIo).catch(swallow);

  // Determine Rust edition lag (edition is different from version)
  // Rust uses editions: 2015, 2018, 2021, 2024
  let runtimeMajorsBehind: number | undefined;
  let runtimeLatest: string | undefined;

  if (rustEdition) {
    const editionYear = parseInt(rustEdition, 10);
    const latestEdition = 2024; // As of 2026
    runtimeMajorsBehind = Math.max(0, Math.floor((latestEdition - editionYear) / 3));
    runtimeLatest = latestEdition.toString();
  }

  // Resolve dependencies
  const dependencies: DependencyRow[] = [];
  const frameworks: DetectedFramework[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  // Fetch all metadata in parallel
  const metaPromises = allDeps.map(async (dep) => {
    const meta = await cargoCache.get(dep.name);
    return { dep, meta };
  });

  const resolved = await Promise.all(metaPromises);

  for (const { dep, meta } of resolved) {
    // Prefer the lockfile's exact version; otherwise coerce the declared spec (e.g. "1.0" → 1.0.0).
    const locked = lockIndex?.resolve(dep.name, dep.version) ?? null;
    const resolvedVersion = locked && recordedSemver(locked)
      ? locked
      : recordedSemver(dep.version) ?? semver.valid(semver.coerce(dep.version));
    const latestStable = meta.latestStableOverall;

    let majorsBehind: number | null = null;
    let drift: DependencyRow['drift'] = 'unknown';

    if (resolvedVersion && latestStable) {
      const currentMajor = semver.major(resolvedVersion);
      const latestMajor = semver.major(latestStable);
      majorsBehind = latestMajor - currentMajor;

      if (majorsBehind === 0) {
        drift = semver.eq(resolvedVersion, latestStable) ? 'current' : 'minor-behind';
      } else if (majorsBehind > 0) {
        drift = 'major-behind';
      } else {
        drift = 'current'; // somehow ahead
      }

      // Dev and build rows are exported, and they do not change production
      // drift buckets. A target `dependencies` row is production.
      if (!dep.isDev) {
        if (majorsBehind <= 0) buckets.current++;
        else if (majorsBehind === 1) buckets.oneBehind++;
        else buckets.twoPlusBehind++;
      }
    } else if (!dep.isDev) {
      buckets.unknown++;
    }

    // A normal or target `dependencies` entry with `optional = true` is an
    // optional row. A dev or build entry stays a dev row even when it also
    // sets `optional = true`.
    let section: DepSection = 'dependencies';
    if (dep.isDev) section = 'devDependencies';
    else if (dep.optional) section = 'optionalDependencies';

    dependencies.push({
      package: dep.name,
      section,
      currentSpec: dep.version,
      resolvedVersion,
      latestStable,
      majorsBehind,
      drift,
    });

    // Dev and build crates are not production frameworks.
    if (!dep.isDev && dep.name in KNOWN_RUST_FRAMEWORKS) {
      frameworks.push({
        name: KNOWN_RUST_FRAMEWORKS[dep.name]!,
        currentVersion: resolvedVersion,
        latestVersion: latestStable,
        majorsBehind,
      });
    }
  }

  // Sort: worst drift first
  dependencies.sort((a, b) => {
    const order = { 'major-behind': 0, 'minor-behind': 1, 'current': 2, 'unknown': 3 };
    const diff = (order[a.drift] ?? 9) - (order[b.drift] ?? 9);
    if (diff !== 0) return diff;
    return compareCodeUnits(a.package, b.package);
  });

  // Count files
  let fileCount: number | undefined;
  try {
    fileCount = cache ? await cache.countFilesUnder(rootDir, dir) : undefined;
  } catch { /* ignore */ }

  return {
    type: 'rust',
    path: relDir,
    name: projectName,
    runtime: rustEdition,
    runtimeLatest,
    runtimeMajorsBehind,
    frameworks,
    dependencies,
    dependencyAgeBuckets: buckets,
    fileCount,
  };
}
