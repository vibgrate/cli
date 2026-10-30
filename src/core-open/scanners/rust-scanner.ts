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

type CargoDepTable = 'dependencies' | 'dev-dependencies' | 'build-dependencies';

interface RustDependency {
  name: string;
  version: string;
  optional: boolean;
  features: string[];
  /** `[dev-dependencies]` and `[build-dependencies]`, including target-specific forms. */
  isDev: boolean;
  /** Declared under `[target.<spec>.*]` rather than a plain dependency table. */
  fromTarget: boolean;
}

/**
 * `[target.<spec>.dependencies]` and the dev and build forms of that header.
 * `<spec>` is a single-quoted cfg, a double-quoted cfg (escaped quotes
 * included), or a bare target triple such as `x86_64-unknown-linux-gnu`.
 */
const TARGET_DEP_HEADER =
  /^\[target\.(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^.\]]+)\.(dependencies|dev-dependencies|build-dependencies)\]$/;

interface CargoTable {
  section: CargoDepTable;
  fromTarget: boolean;
}

function classifyCargoHeader(trimmed: string): CargoTable | null {
  if (
    trimmed === '[dependencies]' ||
    trimmed === '[dev-dependencies]' ||
    trimmed === '[build-dependencies]'
  ) {
    return { section: trimmed.slice(1, -1) as CargoDepTable, fromTarget: false };
  }
  const target = TARGET_DEP_HEADER.exec(trimmed);
  const section = target?.[1];
  if (section !== 'dependencies' && section !== 'dev-dependencies' && section !== 'build-dependencies') {
    return null;
  }
  return { section, fromTarget: true };
}

/**
 * A plain `[dependencies]` row outranks a target production table, which
 * outranks dev and build. Two rows of the same rank keep the first.
 */
function rustDepRank(dep: RustDependency): number {
  if (!dep.isDev && !dep.fromTarget) return 0;
  if (!dep.isDev) return 1;
  if (!dep.fromTarget) return 2;
  return 3;
}

/** One row per crate. A production declaration wins over a dev, build, or target duplicate. */
function dedupeRustDeps(deps: RustDependency[]): RustDependency[] {
  const byName = new Map<string, RustDependency>();
  const order: string[] = [];
  for (const dep of deps) {
    const existing = byName.get(dep.name);
    if (!existing) {
      byName.set(dep.name, dep);
      order.push(dep.name);
      continue;
    }
    if (rustDepRank(dep) < rustDepRank(existing)) byName.set(dep.name, dep);
  }
  return order.map((name) => byName.get(name)!);
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
 *   winapi = { version = "0.3", features = ["winuser"] }
 */
function parseCargoToml(content: string): RustDependency[] {
  const deps: RustDependency[] = [];
  let current: CargoTable | null = null;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      current = classifyCargoHeader(trimmed);
      continue;
    }

    if (!current) continue;

    // Parse dependency lines
    // Simple: serde = "1.0"
    // Complex: serde = { version = "1.0", features = ["derive"], optional = true }

    const isDev = current.section !== 'dependencies';
    const simpleMatch = trimmed.match(/^([\w-]+)\s*=\s*"([^"]+)"/);
    if (simpleMatch) {
      deps.push({
        name: simpleMatch[1]!,
        version: simpleMatch[2]!,
        optional: false,
        features: [],
        isDev,
        fromTarget: current.fromTarget,
      });
      continue;
    }

    const complexMatch = trimmed.match(/^([\w-]+)\s*=\s*\{([^}]+)\}/);
    if (complexMatch) {
      const name = complexMatch[1]!;
      const attrs = complexMatch[2]!;

      const versionMatch = attrs.match(/version\s*=\s*"([^"]+)"/);
      const version = versionMatch?.[1] ?? '*';

      const optionalMatch = attrs.match(/optional\s*=\s*true/);
      const optional = !!optionalMatch;

      const featuresMatch = attrs.match(/features\s*=\s*\[([^\]]*)\]/);
      const features = featuresMatch
        ? featuresMatch[1]!.split(',').map(f => f.trim().replace(/"/g, ''))
        : [];

      deps.push({
        name,
        version,
        optional,
        features,
        isDev,
        fromTarget: current.fromTarget,
      });
    }
  }

  return dedupeRustDeps(deps);
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
  const allDeps = parseCargoToml(content);

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

  // Dev and build crates are rows. Registry lookups, age buckets, and
  // framework detection stay on production crates, so those drift numbers
  // do not move when the development rows appear.
  const resolved = await Promise.all(allDeps.map(async (dep) => {
    const meta = dep.isDev ? null : await cargoCache.get(dep.name);
    return { dep, meta };
  }));

  for (const { dep, meta } of resolved) {
    // Prefer the lockfile's exact version; otherwise coerce the declared spec (e.g. "1.0" → 1.0.0).
    const locked = lockIndex?.resolve(dep.name, dep.version) ?? null;
    const resolvedVersion = locked && recordedSemver(locked)
      ? locked
      : recordedSemver(dep.version) ?? semver.valid(semver.coerce(dep.version));
    const latestStable = meta?.latestStableOverall ?? null;

    let majorsBehind: number | null = null;
    let drift: DependencyRow['drift'] = 'unknown';

    if (!dep.isDev) {
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

        if (majorsBehind <= 0) buckets.current++;
        else if (majorsBehind === 1) buckets.oneBehind++;
        else buckets.twoPlusBehind++;
      } else {
        buckets.unknown++;
      }
    }

    // A normal dependency with `optional = true` is an optional row. A dev
    // or build entry stays a dev row even when it also sets `optional = true`.
    // A production declaration wins over a dev, build, or target duplicate.
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
