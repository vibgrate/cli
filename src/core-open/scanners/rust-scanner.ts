// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { readTextFile, readJsonFile, pathExists, FileCache } from '../utils/fs.js';
import { withTimeout } from '../utils/timeout.js';
import { CargoCache } from './cargo-cache.js';
import { loadCargoLockIndex, type CargoLockIndex } from './cargo-lockfile.js';
import type { LockfileIo } from './npm-lockfile.js';
import type { ProjectScan, DependencyRow, DetectedFramework } from '../types.js';

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

/** Latest Rust version (as of 2026) */
const LATEST_RUST = { major: 1, minor: 82 };

interface RustDependency {
  name: string;
  version: string;
  optional: boolean;
  features: string[];
  isDev: boolean;
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
 */
function parseCargoToml(content: string): RustDependency[] {
  const deps: RustDependency[] = [];
  let currentSection: 'dependencies' | 'dev-dependencies' | null = null;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    // Track sections
    if (trimmed === '[dependencies]') {
      currentSection = 'dependencies';
      continue;
    } else if (trimmed === '[dev-dependencies]') {
      currentSection = 'dev-dependencies';
      continue;
    } else if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = null;
      continue;
    }

    if (!currentSection) continue;

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
        isDev: currentSection === 'dev-dependencies',
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
        isDev: currentSection === 'dev-dependencies',
      });
    }
  }

  return deps;
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
  let lockIndex: CargoLockIndex | null = await loadCargoLockIndex(dir, lockIo).catch(() => null);
  if (!lockIndex && dir !== rootDir) lockIndex = await loadCargoLockIndex(rootDir, lockIo).catch(() => null);
  
  // Filter out dev dependencies for main analysis
  const prodDeps = allDeps.filter(d => !d.isDev);
  
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
  const metaPromises = prodDeps.map(async (dep) => {
    const meta = await cargoCache.get(dep.name);
    return { dep, meta };
  });

  const resolved = await Promise.all(metaPromises);

  for (const { dep, meta } of resolved) {
    // Prefer the lockfile's exact version; otherwise coerce the declared spec (e.g. "1.0" → 1.0.0).
    const locked = lockIndex?.resolve(dep.name, dep.version) ?? null;
    const resolvedVersion = (locked && semver.valid(locked)) ? locked : semver.valid(semver.coerce(dep.version));
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

      if (majorsBehind <= 0) buckets.current++;
      else if (majorsBehind === 1) buckets.oneBehind++;
      else buckets.twoPlusBehind++;
    } else {
      buckets.unknown++;
    }

    const section = dep.isDev ? 'devDependencies' as const : 'dependencies' as const;

    dependencies.push({
      package: dep.name,
      section,
      currentSpec: dep.version,
      resolvedVersion,
      latestStable,
      majorsBehind,
      drift,
    });

    // Detect known frameworks
    if (dep.name in KNOWN_RUST_FRAMEWORKS) {
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
    return a.package.localeCompare(b.package);
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
