// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { readTextFile, FileCache } from '../utils/fs.js';
import { withTimeout } from '../utils/timeout.js';
import { SwiftCache } from './swift-cache.js';
import type { ProjectScan, DependencyRow, DetectedFramework } from '../types.js';

/** Well-known Swift frameworks / libraries to track */
const KNOWN_SWIFT_FRAMEWORKS: Record<string, string> = {
  // ── Server-Side Frameworks ──
  'vapor': 'Vapor',
  'hummingbird': 'Hummingbird',
  'perfect': 'Perfect',
  'kitura': 'Kitura',

  // ── Networking ──
  'alamofire': 'Alamofire',
  'moya': 'Moya',
  'apollo-ios': 'Apollo iOS',

  // ── Database & ORM ──
  'fluent': 'Fluent',
  'sqlite.swift': 'SQLite.swift',
  'realm-swift': 'Realm Swift',
  'grdb.swift': 'GRDB.swift',

  // ── UI & SwiftUI ──
  'kingfisher': 'Kingfisher',
  'snapkit': 'SnapKit',
  'sdwebimage': 'SDWebImage',

  // ── Reactive ──
  'rxswift': 'RxSwift',
  'combine': 'Combine',
  'reactiveswift': 'ReactiveSwift',

  // ── Testing ──
  'quick': 'Quick',
  'nimble': 'Nimble',
  'snapshotTesting': 'SnapshotTesting',

  // ── Logging ──
  'swiftlog': 'SwiftLog',
  'cocoalumberjack': 'CocoaLumberjack',

  // ── Dependency Injection ──
  'swinject': 'Swinject',
  'needle': 'Needle',

  // ── Utilities ──
  'swiftyjson': 'SwiftyJSON',
  'promisekit': 'PromiseKit',
  'then': 'Then',
};

/** Latest Swift version (as of 2026) */
const LATEST_SWIFT = { major: 6, minor: 0 };

interface SwiftDependency {
  name: string;
  url: string;
  version: string;
  type: 'exact' | 'range' | 'branch' | 'revision';
}

/**
 * Parse Package.swift to extract dependencies.
 * 
 * Example:
 *   .package(url: "https://github.com/vapor/vapor.git", from: "4.0.0")
 *   .package(url: "https://github.com/apple/swift-nio.git", .upToNextMajor(from: "2.0.0"))
 *   .package(url: "https://github.com/realm/realm-swift.git", exact: "10.0.0")
 */
function parsePackageSwift(content: string): SwiftDependency[] {
  const deps: SwiftDependency[] = [];
  
  // Match .package(url: "...", ...)
  const packageRegex = /\.package\s*\(\s*url:\s*"([^"]+)"[^)]*?(from|exact|upToNextMajor|revision|branch):\s*"([^"]+)"/g;
  
  let match: RegExpExecArray | null;
  while ((match = packageRegex.exec(content)) !== null) {
    const url = match[1]!;
    const versionType = match[2]!;
    const versionValue = match[3]!;
    
    // Extract package name from URL
    const nameMatch = url.match(/\/([^/]+?)(\.git)?$/);
    const name = nameMatch?.[1] ?? url;
    
    let type: SwiftDependency['type'] = 'range';
    let version = versionValue;
    
    if (versionType === 'exact') {
      type = 'exact';
    } else if (versionType === 'branch') {
      type = 'branch';
    } else if (versionType === 'revision') {
      type = 'revision';
    }
    
    deps.push({ name, url, version, type });
  }
  
  return deps;
}

/**
 * Parse Package.resolved to get exact resolved versions.
 * 
 * Example JSON structure:
 * {
 *   "pins": [
 *     {
 *       "identity": "vapor",
 *       "location": "https://github.com/vapor/vapor.git",
 *       "state": {
 *         "version": "4.89.0"
 *       }
 *     }
 *   ]
 * }
 */
function parsePackageResolved(content: string): Map<string, string> {
  const resolved = new Map<string, string>();
  
  try {
    const data = JSON.parse(content) as {
      pins?: Array<{
        identity?: string;
        state?: {
          version?: string;
        };
      }>;
    };
    
    if (!data.pins) return resolved;
    
    for (const pin of data.pins) {
      if (!pin.identity || !pin.state?.version) continue;
      resolved.set(pin.identity.toLowerCase(), pin.state.version);
    }
  } catch {
    // Invalid JSON
  }
  
  return resolved;
}

/**
 * Extract Swift version from Package.swift.
 * 
 * Example:
 *   // swift-tools-version:5.9
 *   // swift-tools-version: 6.0
 */
function extractSwiftVersion(content: string): string | undefined {
  const match = content.match(/\/\/\s*swift-tools-version:\s*(\d+\.\d+)/i);
  return match?.[1];
}

// ── Swift project file names ──

const SWIFT_MANIFEST_FILES = new Set([
  'Package.swift',
]);

/**
 * Discover and scan all Swift projects in the workspace.
 */
export async function scanSwiftProjects(
  rootDir: string,
  swiftCache: SwiftCache,
  cache?: FileCache,
  projectScanTimeout?: number,
): Promise<ProjectScan[]> {
  // Find Package.swift files
  const manifestFiles = cache
    ? await cache.findFiles(rootDir, (name) => SWIFT_MANIFEST_FILES.has(name))
    : await findSwiftManifests(rootDir);

  const results: ProjectScan[] = [];
  const STUCK_TIMEOUT_MS = projectScanTimeout ?? cache?.projectScanTimeout ?? 180_000;

  for (const manifestFile of manifestFiles) {
    const dir = path.dirname(manifestFile);
    try {
      const scanPromise = scanOneSwiftProject(dir, manifestFile, rootDir, swiftCache, cache);
      const result = await withTimeout(scanPromise, STUCK_TIMEOUT_MS);
      if (result.ok) {
        results.push(result.value);
      } else {
        const relPath = path.relative(rootDir, dir);
        if (cache) cache.addStuckPath(relPath || '.');
        console.error(`Timeout scanning Swift project ${dir} (>${STUCK_TIMEOUT_MS / 1000}s) — skipped`);
        if (cache?.shouldShowTimeoutHint()) {
          console.error(`  Tip: increase projectScanTimeout in vibgrate.config.ts (or --project-scan-timeout <seconds>) for large projects`);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error scanning Swift project ${dir}: ${msg}`);
    }
  }

  return results;
}

async function findSwiftManifests(rootDir: string): Promise<string[]> {
  const { findFiles } = await import('../utils/fs.js');
  return findFiles(rootDir, (name) => SWIFT_MANIFEST_FILES.has(name));
}

async function scanOneSwiftProject(
  dir: string,
  manifestFile: string,
  rootDir: string,
  swiftCache: SwiftCache,
  cache?: FileCache,
): Promise<ProjectScan> {
  const relDir = path.relative(rootDir, dir) || '.';
  const projectName = path.basename(dir === rootDir ? rootDir : dir);
  
  const content = cache ? await cache.readTextFile(manifestFile) : await readTextFile(manifestFile);
  const swiftVersion = extractSwiftVersion(content);
  const allDeps = parsePackageSwift(content);
  
  // Try to read Package.resolved for exact versions
  const resolvedPath = path.join(dir, 'Package.resolved');
  let resolvedVersions = new Map<string, string>();
  try {
    const resolvedContent = cache ? await cache.readTextFile(resolvedPath) : await readTextFile(resolvedPath);
    resolvedVersions = parsePackageResolved(resolvedContent);
  } catch {
    // No Package.resolved or can't read it
  }
  
  // Determine Swift runtime version lag
  let runtimeMajorsBehind: number | undefined;
  let runtimeLatest: string | undefined;

  if (swiftVersion) {
    const verMatch = swiftVersion.match(/(\d+)\.(\d+)/);
    if (verMatch) {
      const reqMajor = parseInt(verMatch[1]!, 10);
      const reqMinor = parseInt(verMatch[2]!, 10);
      if (reqMajor === LATEST_SWIFT.major) {
        runtimeMajorsBehind = Math.max(0, LATEST_SWIFT.minor - reqMinor);
      } else if (reqMajor < LATEST_SWIFT.major) {
        runtimeMajorsBehind = (LATEST_SWIFT.major - reqMajor) * 10 + LATEST_SWIFT.minor;
      }
      runtimeLatest = `${LATEST_SWIFT.major}.${LATEST_SWIFT.minor}`;
    }
  }

  // Resolve dependencies
  const dependencies: DependencyRow[] = [];
  const frameworks: DetectedFramework[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  // Fetch all metadata in parallel
  const metaPromises = allDeps.map(async (dep) => {
    const meta = await swiftCache.get(dep.url);
    return { dep, meta };
  });

  const resolved = await Promise.all(metaPromises);

  for (const { dep, meta } of resolved) {
    // Use resolved version if available, otherwise use specified version
    const resolvedVersionStr = resolvedVersions.get(dep.name.toLowerCase()) ?? 
                              (dep.type === 'exact' ? dep.version : null);
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

    dependencies.push({
      package: dep.name,
      section: 'dependencies',
      currentSpec: dep.version,
      resolvedVersion,
      latestStable,
      majorsBehind,
      drift,
    });

    // Detect known frameworks
    const lowerName = dep.name.toLowerCase();
    if (lowerName in KNOWN_SWIFT_FRAMEWORKS) {
      frameworks.push({
        name: KNOWN_SWIFT_FRAMEWORKS[lowerName]!,
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
    type: 'swift',
    path: relDir,
    name: projectName,
    runtime: swiftVersion,
    runtimeLatest,
    runtimeMajorsBehind,
    frameworks,
    dependencies,
    dependencyAgeBuckets: buckets,
    fileCount,
  };
}
