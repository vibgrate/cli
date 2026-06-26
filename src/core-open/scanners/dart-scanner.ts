// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { readTextFile, FileCache, readJsonFile } from '../utils/fs.js';
import { withTimeout } from '../utils/timeout.js';
import { PubCache } from './pub-cache.js';
import type { ProjectScan, DependencyRow, DetectedFramework } from '../types.js';

/** Well-known Dart/Flutter frameworks / libraries to track */
const KNOWN_DART_FRAMEWORKS: Record<string, string> = {
  // ── Flutter ──
  'flutter': 'Flutter SDK',
  'flutter_test': 'Flutter Test',

  // ── State Management ──
  'provider': 'Provider',
  'riverpod': 'Riverpod',
  'flutter_riverpod': 'Flutter Riverpod',
  'bloc': 'BLoC',
  'flutter_bloc': 'Flutter BLoC',
  'get': 'GetX',
  'mobx': 'MobX',
  'redux': 'Redux',

  // ── Navigation ──
  'go_router': 'GoRouter',
  'auto_route': 'AutoRoute',

  // ── HTTP & Networking ──
  'http': 'http',
  'dio': 'Dio',
  'retrofit': 'Retrofit',
  'graphql_flutter': 'GraphQL Flutter',

  // ── Database ──
  'sqflite': 'SQFlite',
  'hive': 'Hive',
  'isar': 'Isar',
  'drift': 'Drift',
  'firebase_core': 'Firebase Core',
  'cloud_firestore': 'Cloud Firestore',

  // ── UI Components ──
  'flutter_svg': 'Flutter SVG',
  'cached_network_image': 'Cached Network Image',
  'shimmer': 'Shimmer',
  'lottie': 'Lottie',
  'flutter_staggered_grid_view': 'Staggered Grid View',

  // ── Testing ──
  'mockito': 'Mockito',
  'mocktail': 'Mocktail',
  'integration_test': 'Integration Test',
  'test': 'Test',

  // ── Utilities ──
  'intl': 'Intl',
  'shared_preferences': 'Shared Preferences',
  'path_provider': 'Path Provider',
  'package_info_plus': 'Package Info Plus',
  'url_launcher': 'URL Launcher',
  'image_picker': 'Image Picker',

  // ── Serialization ──
  'json_serializable': 'JSON Serializable',
  'freezed': 'Freezed',
  'built_value': 'Built Value',

  // ── Logging & Error Tracking ──
  'logger': 'Logger',
  'sentry_flutter': 'Sentry Flutter',
  'firebase_crashlytics': 'Firebase Crashlytics',

  // ── Code Generation ──
  'build_runner': 'Build Runner',
  'injectable': 'Injectable',

  // ── Linting ──
  'flutter_lints': 'Flutter Lints',
  'lint': 'Lint',
};

/** Latest Dart major.minor (as of 2026) */
const LATEST_DART = { major: 3, minor: 6 };

interface DartDependency {
  name: string;
  version: string;
  isDev: boolean;
}

/**
 * Parse pubspec.yaml to extract dependencies.
 * 
 * Example YAML:
 *   name: my_app
 *   environment:
 *     sdk: '>=3.0.0 <4.0.0'
 *   dependencies:
 *     flutter:
 *       sdk: flutter
 *     provider: ^6.1.0
 *   dev_dependencies:
 *     flutter_test:
 *       sdk: flutter
 *     mockito: ^5.4.0
 */
function parsePubspecYaml(content: string): {
  dartVersion?: string;
  deps: DartDependency[];
} {
  const deps: DartDependency[] = [];
  let dartVersion: string | undefined;
  let currentSection: 'dependencies' | 'dev_dependencies' | null = null;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    // Extract Dart SDK version. Require a digit so `sdk: flutter` lines
    // (SDK dependencies inside dependency sections) cannot clobber the
    // environment constraint.
    if (trimmed.startsWith('sdk:')) {
      const match = trimmed.match(/sdk:\s*['"]?>?=?\s*(\d[^<'"]*)/);
      if (match) dartVersion = match[1]!.trim();
      continue;
    }

    // Track sections. Only an unindented key ends the current section —
    // testing the trimmed line here would match every indented dependency
    // line and reset the section before the dependency is captured.
    if (trimmed === 'dependencies:') {
      currentSection = 'dependencies';
      continue;
    } else if (trimmed === 'dev_dependencies:') {
      currentSection = 'dev_dependencies';
      continue;
    } else if (/^\w+:/.test(line)) {
      currentSection = null;
      continue;
    }

    if (!currentSection) continue;

    // Parse dependency lines
    // Simple: provider: ^6.1.0
    // SDK: flutter: { sdk: flutter }
    
    const simpleMatch = trimmed.match(/^([\w_]+):\s*([^\s{]+)/);
    if (simpleMatch) {
      const name = simpleMatch[1]!;
      const version = simpleMatch[2]!;
      
      // Skip SDK dependencies (flutter, flutter_test from SDK)
      if (version === 'sdk:' || trimmed.includes('sdk: flutter')) {
        continue;
      }
      
      deps.push({
        name,
        version,
        isDev: currentSection === 'dev_dependencies',
      });
    }
  }

  return { dartVersion, deps };
}

/**
 * Parse pubspec.lock to get exact resolved versions.
 */
async function parsePubspecLock(filePath: string, cache?: FileCache): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  
  try {
    const content = cache 
      ? await cache.readTextFile(filePath)
      : await readTextFile(filePath);
    
    let currentPackage: string | null = null;

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();

      // Match package name — exactly two-space indented bare key
      // ("  provider:"). Deeper keys like the four-space "description:"
      // nested map are entry fields, not packages, and must not steal
      // the current-package slot before "version:" is read.
      const pkgMatch = line.match(/^ {2}(\w+):$/);
      if (pkgMatch) {
        currentPackage = pkgMatch[1]!;
        continue;
      }
      
      // Match version (e.g., "    version: 6.1.2")
      if (currentPackage && trimmed.startsWith('version:')) {
        const verMatch = trimmed.match(/version:\s*"?([^"]+)"?/);
        if (verMatch) {
          resolved.set(currentPackage, verMatch[1]!);
          currentPackage = null;
        }
      }
    }
  } catch {
    // File doesn't exist or can't read it
  }
  
  return resolved;
}

/**
 * Extract Dart version number from constraint string.
 * Examples:
 *   ">=3.0.0 <4.0.0" → "3.0.0"
 *   "^3.2.0" → "3.2.0"
 */
function extractDartVersion(constraint: string): string | undefined {
  const match = constraint.match(/(\d+\.\d+\.\d+)/);
  return match?.[0];
}

// ── Dart project file names ──

const DART_MANIFEST_FILES = new Set([
  'pubspec.yaml',
]);

/**
 * Discover and scan all Dart/Flutter projects in the workspace.
 */
export async function scanDartProjects(
  rootDir: string,
  pubCache: PubCache,
  cache?: FileCache,
  projectScanTimeout?: number,
): Promise<ProjectScan[]> {
  // Find pubspec.yaml files
  const manifestFiles = cache
    ? await cache.findFiles(rootDir, (name) => DART_MANIFEST_FILES.has(name))
    : await findDartManifests(rootDir);

  const results: ProjectScan[] = [];
  const STUCK_TIMEOUT_MS = projectScanTimeout ?? cache?.projectScanTimeout ?? 180_000;

  for (const manifestFile of manifestFiles) {
    const dir = path.dirname(manifestFile);
    try {
      const scanPromise = scanOneDartProject(dir, manifestFile, rootDir, pubCache, cache);
      const result = await withTimeout(scanPromise, STUCK_TIMEOUT_MS);
      if (result.ok) {
        results.push(result.value);
      } else {
        const relPath = path.relative(rootDir, dir);
        if (cache) cache.addStuckPath(relPath || '.');
        console.error(`Timeout scanning Dart project ${dir} (>${STUCK_TIMEOUT_MS / 1000}s) — skipped`);
        if (cache?.shouldShowTimeoutHint()) {
          console.error(`  Tip: increase projectScanTimeout in vibgrate.config.ts (or --project-scan-timeout <seconds>) for large projects`);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error scanning Dart project ${dir}: ${msg}`);
    }
  }

  return results;
}

async function findDartManifests(rootDir: string): Promise<string[]> {
  const { findFiles } = await import('../utils/fs.js');
  return findFiles(rootDir, (name) => DART_MANIFEST_FILES.has(name));
}

async function scanOneDartProject(
  dir: string,
  manifestFile: string,
  rootDir: string,
  pubCache: PubCache,
  cache?: FileCache,
): Promise<ProjectScan> {
  const relDir = path.relative(rootDir, dir) || '.';
  const projectName = path.basename(dir === rootDir ? rootDir : dir);
  
  const content = cache ? await cache.readTextFile(manifestFile) : await readTextFile(manifestFile);
  const { dartVersion: dartVersionConstraint, deps: allDeps } = parsePubspecYaml(content);
  
  // Try to read pubspec.lock for exact versions
  const lockPath = path.join(dir, 'pubspec.lock');
  let resolvedVersions = new Map<string, string>();
  try {
    resolvedVersions = await parsePubspecLock(lockPath, cache);
  } catch {
    // No pubspec.lock or can't read it
  }
  
  // Filter out dev dependencies for main analysis
  const prodDeps = allDeps.filter(d => !d.isDev);
  
  // Determine Dart runtime version lag
  let runtimeMajorsBehind: number | undefined;
  let runtimeLatest: string | undefined;
  let dartVersion: string | undefined;

  if (dartVersionConstraint) {
    dartVersion = extractDartVersion(dartVersionConstraint);
    if (dartVersion) {
      const verMatch = dartVersion.match(/(\d+)\.(\d+)/);
      if (verMatch) {
        const reqMajor = parseInt(verMatch[1]!, 10);
        const reqMinor = parseInt(verMatch[2]!, 10);
        if (reqMajor === LATEST_DART.major) {
          runtimeMajorsBehind = Math.max(0, LATEST_DART.minor - reqMinor);
        } else if (reqMajor < LATEST_DART.major) {
          runtimeMajorsBehind = LATEST_DART.minor + (LATEST_DART.major - reqMajor) * 10;
        }
        runtimeLatest = `${LATEST_DART.major}.${LATEST_DART.minor}`;
      }
    }
  }

  // Resolve dependencies
  const dependencies: DependencyRow[] = [];
  const frameworks: DetectedFramework[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  // Fetch all metadata in parallel
  const metaPromises = prodDeps.map(async (dep) => {
    const meta = await pubCache.get(dep.name);
    return { dep, meta };
  });

  const resolved = await Promise.all(metaPromises);

  for (const { dep, meta } of resolved) {
    // Use resolved version if available
    const resolvedVersionStr = resolvedVersions.get(dep.name);
    const resolvedVersion = resolvedVersionStr ? semver.valid(semver.clean(resolvedVersionStr)) : null;
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
    if (dep.name in KNOWN_DART_FRAMEWORKS) {
      frameworks.push({
        name: KNOWN_DART_FRAMEWORKS[dep.name]!,
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
    type: 'dart',
    path: relDir,
    name: projectName,
    runtime: dartVersion,
    runtimeLatest,
    runtimeMajorsBehind,
    frameworks,
    dependencies,
    dependencyAgeBuckets: buckets,
    fileCount,
  };
}
