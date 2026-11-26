// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { readTextFile, FileCache } from '../utils/fs.js';
import { recordedSemver } from '../utils/recorded-semver.js';
import { assertLockfileText, LockfileParseError, rethrowLockfileParseError } from '../utils/lockfile-parse.js';
import { lockfileWarningPath, notePubspecLockText, withLockfileNotes } from '../utils/lockfile-unknown.js';
import { withTimeout } from '../utils/timeout.js';
import { PubCache, type PubDevMeta } from './pub-cache.js';
import { latestStable } from '../runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../runtimes/snapshot.js';
import type { RuntimeCatalog } from '../runtimes/types.js';
import type { ProjectScan, DependencyRow, DetectedFramework } from '../types.js';
import { compareCodeUnits } from '../utils/code-unit.js';

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

interface DartDependency {
  name: string;
  version: string;
  isDev: boolean;
}

/**
 * A production declaration wins over a development declaration of the same
 * name, whichever section is listed first. The winning declaration supplies
 * the version. SDK entries are not rows in either section.
 */
function dedupeDartDeps(deps: DartDependency[]): DartDependency[] {
  const byName = new Map<string, DartDependency>();
  for (const dep of deps) {
    const kept = byName.get(dep.name);
    if (!kept || (kept.isDev && !dep.isDev)) byName.set(dep.name, dep);
  }
  return [...byName.values()];
}

/** Leading indent. A tab counts as two spaces so space- and tab-indented pubspecs compare. */
function indentWidth(line: string): number {
  let width = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 2;
    else break;
  }
  return width;
}

/** Unquote a YAML scalar and drop an unquoted trailing comment. */
function yamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const quoted = trimmed.match(/^(['"])([\s\S]*?)\1\s*(?:#.*)?$/);
  if (quoted) return quoted[2] ?? '';
  const comment = trimmed.search(/\s+#/);
  return (comment === -1 ? trimmed : trimmed.slice(0, comment)).trim();
}

/**
 * A map-form dependency (`http:` then nested keys). Path and git sources
 * have no pub version constraint. They are stored as `path:<path>` or
 * `git:<url>` (`git:<url>#<ref>` when a ref is set) so the package is kept
 * and those nested keys are not reported as packages. A nested `version:`
 * is the constraint and wins over path or git. `sdk: flutter` drops the entry.
 */
interface OpenPubDep {
  name: string;
  indent: number;
  isDev: boolean;
  /** Set while the open key is under `dependency_overrides`. */
  isOverride: boolean;
  version?: string;
  path?: string;
  gitUrl?: string;
  gitRef?: string;
  nestedKey?: string;
  nestedIndent?: number;
  skip: boolean;
}

function pubDepSpec(open: OpenPubDep): string | undefined {
  if (open.skip) return undefined;
  if (open.version) return open.version;
  if (open.path) return `path:${open.path}`;
  if (open.gitUrl) return open.gitRef ? `git:${open.gitUrl}#${open.gitRef}` : `git:${open.gitUrl}`;
  return undefined;
}

function takeOpenDep(deps: DartDependency[], overrides: Map<string, string>, open: OpenPubDep | null): void {
  if (!open) return;
  const version = pubDepSpec(open);
  if (!version) return;
  if (open.isOverride) overrides.set(open.name, version);
  else deps.push({ name: open.name, version, isDev: open.isDev });
}

/**
 * `dependency_overrides` replaces the spec of a package already collected
 * from `dependencies` or `dev_dependencies` and leaves that row's
 * production or development flag alone. A name that appears only as an
 * override is a production row. Names are appended in code-unit order so
 * the row list does not follow map iteration.
 */
function applyDependencyOverrides(deps: DartDependency[], overrides: Map<string, string>): DartDependency[] {
  if (overrides.size === 0) return deps;
  const byName = new Map(deps.map((dep) => [dep.name, dep]));
  const extras: DartDependency[] = [];
  for (const name of [...overrides.keys()].sort(compareCodeUnits)) {
    const version = overrides.get(name);
    if (!version) continue;
    const existing = byName.get(name);
    if (existing) existing.version = version;
    else extras.push({ name, version, isDev: false });
  }
  return extras.length === 0 ? deps : deps.concat(extras);
}

function flowField(body: string, key: string): string | undefined {
  const match = body.match(new RegExp(`(?:^|[{,\\s])${key}:\\s*([^,}]+)`));
  if (!match) return undefined;
  const scalar = yamlScalar(match[1] ?? '');
  return scalar || undefined;
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
 *     http:
 *       version: ^1.2.0
 *     shared:
 *       path: ../shared
 *     provider: ^6.1.0
 *   dev_dependencies:
 *     flutter_test:
 *       sdk: flutter
 *     mockito: ^5.4.0
 *   dependency_overrides:
 *     http: 1.2.1
 *
 * `dependencies` and `dev_dependencies` are both kept. An SDK entry
 * (`flutter: { sdk: flutter }`, a nested `sdk: flutter`, or `sdk: flutter`
 * on the same line) is skipped in either section and under
 * `dependency_overrides`. A skipped override does not replace a declared
 * spec. A key with no value at the dependency indent opens one package;
 * deeper keys belong to it and are never emitted as packages. A name
 * listed in both dependency sections is stored once, as a production
 * dependency. A `dependency_overrides` entry is read in the same forms
 * (one-line version, `{ version: … }` map, nested `version:`, `path:`,
 * and `git:`). It replaces that package's spec and keeps the production
 * or development flag from the declaration. A package listed only in
 * `dependency_overrides` is reported as a production dependency. Overrides
 * are applied after both sections are read, so the spec wins whether the
 * override is written before or after the declaration. The last override
 * for a name wins. `pubspec.lock` is not read here.
 */
function parsePubspecYaml(content: string): {
  dartVersion?: string;
  deps: DartDependency[];
} {
  const deps: DartDependency[] = [];
  const overrides = new Map<string, string>();
  let dartVersion: string | undefined;
  let currentSection: 'dependencies' | 'dev_dependencies' | 'dependency_overrides' | null = null;
  let childIndent: number | null = null;
  let open: OpenPubDep | null = null;

  const flush = () => {
    takeOpenDep(deps, overrides, open);
    open = null;
  };

  const enterSection = (section: 'dependencies' | 'dev_dependencies' | 'dependency_overrides') => {
    flush();
    currentSection = section;
    childIndent = null;
  };

  const record = (name: string, version: string, isDev: boolean) => {
    if (currentSection === 'dependency_overrides') overrides.set(name, version);
    else deps.push({ name, version, isDev });
  };

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = indentWidth(line);

    // Extract Dart SDK version. Require a digit so `sdk: flutter` lines
    // cannot clobber the environment constraint, and ignore `sdk:` inside
    // a dependency section, including `dependency_overrides`, so a nested
    // SDK constraint is not stored as the Dart version. Caret and tilde
    // forms (`^3.5.0`, `~3.4.1`) count the same as an explicit `>=` range.
    if (trimmed.startsWith('sdk:')) {
      const match = trimmed.match(/sdk:\s*['"]?>?=?\s*[~^]?(\d[^<'"]*)/);
      if (match && currentSection === null) dartVersion = match[1]!.trim();
      else if (open && /sdk:\s*flutter\b/.test(trimmed)) open.skip = true;
      continue;
    }

    if (trimmed === 'dependencies:') {
      enterSection('dependencies');
      continue;
    }
    if (trimmed === 'dev_dependencies:') {
      enterSection('dev_dependencies');
      continue;
    }
    if (trimmed === 'dependency_overrides:') {
      enterSection('dependency_overrides');
      continue;
    }
    // Only an unindented key ends the current section — testing the trimmed
    // line here would match every indented dependency line and reset the
    // section before the dependency is captured.
    if (indent === 0 && /^\w+:/.test(line)) {
      flush();
      currentSection = null;
      childIndent = null;
      continue;
    }

    if (!currentSection) continue;

    if (childIndent === null) {
      if (indent === 0) continue;
      childIndent = indent;
    }

    if (indent < childIndent) {
      flush();
      currentSection = null;
      childIndent = null;
      continue;
    }

    if (indent === childIndent) {
      flush();
      const isDev = currentSection === 'dev_dependencies';
      // One-line: provider: ^6.1.0. The value token is kept exactly,
      // including quotes, so existing manifests do not change spec text.
      const simpleMatch = trimmed.match(/^([\w_]+):\s*([^\s{]+)/);
      if (simpleMatch) {
        const name = simpleMatch[1]!;
        const version = simpleMatch[2]!;
        if (version === 'sdk:' || trimmed.includes('sdk: flutter')) continue;
        record(name, version, isDev);
        continue;
      }

      const bare = trimmed.match(/^([\w_]+):\s*(.*)$/);
      if (!bare) continue;
      const name = bare[1]!;
      const rest = (bare[2] ?? '').trim();
      if (rest.startsWith('{')) {
        if (/sdk:\s*flutter\b/.test(rest)) continue;
        const version = flowField(rest, 'version');
        const pathSpec = flowField(rest, 'path');
        const gitUrl = flowField(rest, 'git');
        let spec: string | undefined;
        if (version) spec = version;
        else if (pathSpec) spec = `path:${pathSpec}`;
        else if (gitUrl) spec = `git:${gitUrl}`;
        if (spec) record(name, spec, isDev);
        continue;
      }

      // Bare key: the following deeper lines belong to this package.
      open = {
        name,
        indent,
        isDev,
        isOverride: currentSection === 'dependency_overrides',
        skip: false,
      };
      continue;
    }

    if (!open || indent <= open.indent) continue;
    const keyMatch = trimmed.match(/^([\w_]+):\s*(.*)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1]!;
    const value = yamlScalar(keyMatch[2] ?? '');
    const direct = open.nestedIndent === undefined || indent <= open.nestedIndent;
    if (direct) {
      open.nestedKey = key;
      open.nestedIndent = indent;
      if (key === 'version' && value) open.version = value;
      else if (key === 'path' && value) open.path = value;
      else if (key === 'sdk' && value === 'flutter') open.skip = true;
      else if (key === 'git' && value) open.gitUrl = value;
      continue;
    }
    if (open.nestedKey === 'git') {
      if (key === 'url' && value) open.gitUrl = value;
      else if (key === 'ref' && value) open.gitRef = value;
    }
  }

  flush();
  return { dartVersion, deps: applyDependencyOverrides(dedupeDartDeps(deps), overrides) };
}

/**
 * Parse pubspec.lock to get exact resolved versions.
 */
async function parsePubspecLock(filePath: string, cache?: FileCache): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  
  let content: string;
  try {
    content = cache
      ? await cache.readTextFile(filePath)
      : await readTextFile(filePath);
  } catch (err) {
    rethrowLockfileParseError(err);
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
    throw new LockfileParseError(filePath, 'YAML');
  }
  assertLockfileText(filePath, content, 'YAML');

  try {
    withLockfileNotes(undefined, (bucket) => {
      notePubspecLockText(content, lockfileWarningPath(filePath), bucket);
      return undefined;
    });
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
  } catch (err) {
    rethrowLockfileParseError(err);
    throw new LockfileParseError(filePath, 'YAML');
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
  catalog: RuntimeCatalog = BUNDLED_RUNTIME_CATALOG,
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
      const scanPromise = scanOneDartProject(dir, manifestFile, rootDir, pubCache, cache, catalog);
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
      rethrowLockfileParseError(e);
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
  cache: FileCache | undefined,
  catalog: RuntimeCatalog,
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
  } catch (err) {
    rethrowLockfileParseError(err);
  }
  
  // pub.dev lookups and drift buckets stay on production rows. A name in
  // both sections is already one production row (`parsePubspecYaml`).
  // Development rows are still emitted.
  
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
        const latestDart = latestStable(catalog, 'dart');
        if (latestDart) {
          if (reqMajor === latestDart.major) {
            runtimeMajorsBehind = Math.max(0, latestDart.minor - reqMinor);
          } else if (reqMajor < latestDart.major) {
            runtimeMajorsBehind = latestDart.minor + (latestDart.major - reqMajor) * 10;
          }
          runtimeLatest = `${latestDart.major}.${latestDart.minor}`;
        }
      }
    }
  }

  // Resolve dependencies
  const dependencies: DependencyRow[] = [];
  const frameworks: DetectedFramework[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  // Fetch production metadata in parallel. Development packages are not looked up.
  const metaByName = new Map<string, PubDevMeta>();
  const metaPromises = allDeps.filter((dep) => !dep.isDev).map(async (dep) => {
    const meta = await pubCache.get(dep.name);
    return { name: dep.name, meta };
  });
  for (const { name, meta } of await Promise.all(metaPromises)) {
    metaByName.set(name, meta);
  }

  for (const dep of allDeps) {
    // Use resolved version if available
    const resolvedVersionStr = resolvedVersions.get(dep.name);
    const resolvedVersion = resolvedVersionStr ? recordedSemver(resolvedVersionStr) : null;
    const section = dep.isDev ? 'devDependencies' as const : 'dependencies' as const;

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

    const latestStable = metaByName.get(dep.name)?.latestStableOverall ?? null;

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
      section,
      currentSpec: dep.version,
      resolvedVersion,
      latestStable,
      majorsBehind,
      drift,
    });

    // Development packages are not production frameworks.
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
    return compareCodeUnits(a.package, b.package);
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
