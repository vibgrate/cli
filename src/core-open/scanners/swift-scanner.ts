// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { readTextFile, FileCache } from '../utils/fs.js';
import { recordedSemver } from '../utils/recorded-semver.js';
import { parseLockfileJson, rethrowLockfileParseError } from '../utils/lockfile-parse.js';
import { lockfileWarningPath, notePackageResolved, withLockfileNotes } from '../utils/lockfile-unknown.js';
import { withTimeout } from '../utils/timeout.js';
import { SwiftCache } from './swift-cache.js';
import { latestStable } from '../runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../runtimes/snapshot.js';
import type { RuntimeCatalog } from '../runtimes/types.js';
import type { ProjectScan, DependencyRow, DetectedFramework } from '../types.js';
import { compareCodeUnits } from '../utils/code-unit.js';

/**
 * Well-known Swift frameworks / libraries to track.
 *
 * Keys are the repository names as they appear in package URLs, lowercased
 * (`https://github.com/apple/swift-log.git` -> `swift-log`), because lookups
 * are done with `dep.name.toLowerCase()`.
 */
export const KNOWN_SWIFT_FRAMEWORKS: Record<string, string> = {
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
  'swift-snapshot-testing': 'SnapshotTesting',

  // ── Logging ──
  'swift-log': 'SwiftLog',
  'cocoalumberjack': 'CocoaLumberjack',

  // ── Dependency Injection ──
  'swinject': 'Swinject',
  'needle': 'Needle',

  // ── Utilities ──
  'swiftyjson': 'SwiftyJSON',
  'promisekit': 'PromiseKit',
  'then': 'Then',
};

interface SwiftDependency {
  name: string;
  url: string;
  version: string;
  type: 'exact' | 'range' | 'branch' | 'revision';
}

/**
 * Parse Package.swift to extract dependencies.
 *
 * Remote and registry dependencies:
 *   .package(url: "https://github.com/vapor/vapor.git", from: "4.0.0")
 *   .package(url: "https://github.com/apple/swift-nio.git", .upToNextMajor(from: "2.0.0"))
 *   .package(url: "https://github.com/realm/realm-swift.git", exact: "10.0.0")
 *   .package(url: "https://github.com/apple/swift-argument-parser", "1.2.0"..<"2.0.0")
 *   .package(url: "https://github.com/pointfreeco/swift-snapshot-testing", "1.10.0"..."1.17.0")
 *   .package(name: "Kingfisher", url: "https://github.com/onevcat/Kingfisher.git", from: "7.0.0")
 *   .package(id: "mona.LinkedList", from: "1.0.0")
 *
 * Local `.package(path:)` dependencies are ignored: they have no version to drift.
 */
function parsePackageSwift(content: string): SwiftDependency[] {
  const deps: SwiftDependency[] = [];
  const callRe = /\.package\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(content)) !== null) {
    const openParen = match.index + match[0].length - 1;
    const extracted = extractPackageCall(content, openParen);
    if (!extracted) {
      callRe.lastIndex = openParen + 1;
      continue;
    }
    callRe.lastIndex = extracted.end;
    const dep = dependencyFromPackageArgs(extracted.args);
    if (dep) deps.push(dep);
  }
  return deps;
}

/** Args of one `.package(` call, starting at the opening parenthesis. */
function extractPackageCall(content: string, openParen: number): { args: string; end: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openParen; i < content.length; i++) {
    const c = content[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { args: content.slice(openParen + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Drop `//` and block comments without eating `//` inside string literals. */
function stripSwiftComments(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === '"') {
      const start = i;
      i++;
      while (i < input.length) {
        if (input[i] === '\\') {
          i += 2;
          continue;
        }
        if (input[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      out += input.slice(start, i);
      continue;
    }
    if (c === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i = Math.min(input.length, i + 2);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function packageNameFromUrl(url: string): string {
  const nameMatch = url.match(/\/([^/]+?)(\.git)?$/);
  return nameMatch?.[1] ?? url;
}

/**
 * Version requirement on a `.package` call.
 * `from:` / `.upToNextMajor(from:)` / `.upToNextMinor(from:)` stay ranges whose
 * current spec is the declared lower bound, matching the labeled forms.
 * `"lo"..<"hi"` and `"lo"..."hi"` use that same lower bound.
 */
function versionFromPackageArgs(args: string): { value: string; type: SwiftDependency['type'] } | null {
  const exact = args.match(/\bexact\s*:\s*"([^"]+)"/);
  if (exact?.[1]) return { value: exact[1], type: 'exact' };
  const branch = args.match(/\bbranch\s*:\s*"([^"]+)"/);
  if (branch?.[1]) return { value: branch[1], type: 'branch' };
  const revision = args.match(/\brevision\s*:\s*"([^"]+)"/);
  if (revision?.[1]) return { value: revision[1], type: 'revision' };
  const from = args.match(/\bfrom\s*:\s*"([^"]+)"/);
  if (from?.[1]) return { value: from[1], type: 'range' };
  const halfOpen = args.match(/"([^"]+)"\s*\.\.<\s*"[^"]*"/);
  if (halfOpen?.[1]) return { value: halfOpen[1], type: 'range' };
  const closed = args.match(/"([^"]+)"\s*\.\.\.\s*"[^"]*"/);
  if (closed?.[1]) return { value: closed[1], type: 'range' };
  return null;
}

function dependencyFromPackageArgs(rawArgs: string): SwiftDependency | null {
  const args = stripSwiftComments(rawArgs);
  // Local packages (`.package(path:)`, including `name:` + `path:`) have no registry version.
  const withoutStrings = args.replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (/\bpath\s*:/.test(withoutStrings)) return null;

  const version = versionFromPackageArgs(args);
  if (!version) return null;

  const urlMatch = args.match(/\burl\s*:\s*"([^"]+)"/);
  if (urlMatch?.[1]) {
    const url = urlMatch[1];
    // Identity follows the URL, including when the deprecated `name:` label comes first.
    // Package.resolved pins that identity, not the manifest's name label.
    return { name: packageNameFromUrl(url), url, version: version.value, type: version.type };
  }

  const idMatch = args.match(/\bid\s*:\s*"([^"]+)"/);
  if (idMatch?.[1]) {
    const id = idMatch[1];
    return { name: id, url: id, version: version.value, type: version.type };
  }
  return null;
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
function parsePackageResolved(filePath: string, content: string): Map<string, string> {
  const resolved = new Map<string, string>();
  const data = parseLockfileJson(filePath, content) as {
    pins?: Array<{
      identity?: string;
      state?: {
        version?: string;
      };
    }>;
  } | null;

  withLockfileNotes(undefined, (bucket) => {
    notePackageResolved(data, lockfileWarningPath(filePath), bucket);
    return undefined;
  });

  if (!data || typeof data !== 'object' || !data.pins) return resolved;
  for (const pin of data.pins) {
    if (!pin.identity || !pin.state?.version) continue;
    resolved.set(pin.identity.toLowerCase(), pin.state.version);
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
  catalog: RuntimeCatalog = BUNDLED_RUNTIME_CATALOG,
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
      const scanPromise = scanOneSwiftProject(dir, manifestFile, rootDir, swiftCache, cache, catalog);
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
      rethrowLockfileParseError(e);
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
  cache: FileCache | undefined,
  catalog: RuntimeCatalog,
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
    resolvedVersions = parsePackageResolved(resolvedPath, resolvedContent);
  } catch (err) {
    rethrowLockfileParseError(err);
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  
  // Determine Swift runtime version lag
  let runtimeMajorsBehind: number | undefined;
  let runtimeLatest: string | undefined;

  if (swiftVersion) {
    const verMatch = swiftVersion.match(/(\d+)\.(\d+)/);
    if (verMatch) {
      const reqMajor = parseInt(verMatch[1]!, 10);
      const reqMinor = parseInt(verMatch[2]!, 10);
      const latestSwift = latestStable(catalog, 'swift');
      if (latestSwift) {
        if (reqMajor === latestSwift.major) {
          runtimeMajorsBehind = Math.max(0, latestSwift.minor - reqMinor);
        } else if (reqMajor < latestSwift.major) {
          runtimeMajorsBehind = (latestSwift.major - reqMajor) * 10 + latestSwift.minor;
        }
        runtimeLatest = `${latestSwift.major}.${latestSwift.minor}`;
      }
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
    const resolvedVersion = resolvedVersionStr ? recordedSemver(resolvedVersionStr) : null;
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
    return compareCodeUnits(a.package, b.package);
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
