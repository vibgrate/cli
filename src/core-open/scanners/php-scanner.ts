// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { readTextFile, FileCache, readJsonFile } from '../utils/fs.js';
import { withTimeout } from '../utils/timeout.js';
import { ComposerCache } from './composer-cache.js';
import type { ProjectScan, DependencyRow, DetectedFramework } from '../types.js';

/** Well-known PHP frameworks / libraries to track */
const KNOWN_PHP_FRAMEWORKS: Record<string, string> = {
  // ── Web Frameworks ──
  'laravel/framework': 'Laravel',
  'symfony/symfony': 'Symfony',
  'symfony/http-foundation': 'Symfony HttpFoundation',
  'cakephp/cakephp': 'CakePHP',
  'yiisoft/yii2': 'Yii 2',
  'codeigniter4/framework': 'CodeIgniter',
  'slim/slim': 'Slim',
  'laminas/laminas-mvc': 'Laminas',

  // ── WordPress ──
  'roots/wordpress': 'WordPress',
  'johnpbloch/wordpress': 'WordPress Core',

  // ── Database & ORM ──
  'doctrine/orm': 'Doctrine ORM',
  'doctrine/dbal': 'Doctrine DBAL',
  'illuminate/database': 'Laravel Eloquent',
  'propel/propel': 'Propel',

  // ── Testing ──
  'phpunit/phpunit': 'PHPUnit',
  'pestphp/pest': 'Pest',
  'behat/behat': 'Behat',
  'codeception/codeception': 'Codeception',
  'mockery/mockery': 'Mockery',

  // ── HTTP Client ──
  'guzzlehttp/guzzle': 'Guzzle',
  'symfony/http-client': 'Symfony HttpClient',

  // ── Templating ──
  'twig/twig': 'Twig',
  'smarty/smarty': 'Smarty',
  'league/plates': 'Plates',

  // ── Authentication ──
  'firebase/php-jwt': 'PHP-JWT',
  'lcobucci/jwt': 'JWT',

  // ── API ──
  'league/fractal': 'Fractal',
  'api-platform/core': 'API Platform',

  // ── CLI ──
  'symfony/console': 'Symfony Console',

  // ── Logging ──
  'monolog/monolog': 'Monolog',

  // ── Utilities ──
  'nesbot/carbon': 'Carbon',
  'ramsey/uuid': 'UUID',
  'vlucas/phpdotenv': 'PHP dotenv',

  // ── Code Quality ──
  'phpstan/phpstan': 'PHPStan',
  'vimeo/psalm': 'Psalm',
  'friendsofphp/php-cs-fixer': 'PHP CS Fixer',
  'squizlabs/php_codesniffer': 'PHP_CodeSniffer',
};

/** Latest PHP major.minor (as of 2026) */
const LATEST_PHP = { major: 8, minor: 4 };

interface PhpDependency {
  name: string;
  version: string;
  isDev: boolean;
}

/**
 * Parse composer.json to extract dependencies.
 */
async function parseComposerJson(filePath: string, cache?: FileCache): Promise<{
  phpVersion?: string;
  deps: PhpDependency[];
}> {
  const data = cache 
    ? await cache.readJsonFile(filePath)
    : await readJsonFile(filePath) as any;
  
  const deps: PhpDependency[] = [];
  let phpVersion: string | undefined;

  // Extract PHP version requirement
  if (data.require?.php) {
    phpVersion = data.require.php;
  }

  // Extract dependencies
  if (data.require && typeof data.require === 'object') {
    for (const [name, version] of Object.entries(data.require)) {
      if (name === 'php' || name.startsWith('ext-')) continue;
      deps.push({
        name,
        version: String(version),
        isDev: false,
      });
    }
  }

  // Extract dev dependencies
  if (data['require-dev'] && typeof data['require-dev'] === 'object') {
    for (const [name, version] of Object.entries(data['require-dev'])) {
      if (name === 'php' || name.startsWith('ext-')) continue;
      deps.push({
        name,
        version: String(version),
        isDev: true,
      });
    }
  }

  return { phpVersion, deps };
}

/**
 * Parse composer.lock to get exact resolved versions.
 */
async function parseComposerLock(filePath: string, cache?: FileCache): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  
  try {
    const data = cache 
      ? await cache.readJsonFile(filePath)
      : await readJsonFile(filePath) as any;
    
    // Parse packages
    for (const pkg of (data.packages ?? []) as Array<{ name?: string; version?: string }>) {
      if (pkg.name && pkg.version) {
        resolved.set(pkg.name, pkg.version);
      }
    }
    
    // Parse dev packages
    for (const pkg of (data['packages-dev'] ?? []) as Array<{ name?: string; version?: string }>) {
      if (pkg.name && pkg.version) {
        resolved.set(pkg.name, pkg.version);
      }
    }
  } catch {
    // Invalid JSON or file doesn't exist
  }
  
  return resolved;
}

/**
 * Extract PHP version number from constraint string.
 * Examples:
 *   "^8.2" → "8.2"
 *   ">=8.1" → "8.1"
 *   "8.3.*" → "8.3"
 */
function extractPhpVersion(constraint: string): string | undefined {
  const match = constraint.match(/(\d+)\.(\d+)/);
  return match?.[0];
}

// ── PHP project file names ──

const PHP_MANIFEST_FILES = new Set([
  'composer.json',
]);

/**
 * Discover and scan all PHP projects in the workspace.
 */
export async function scanPhpProjects(
  rootDir: string,
  composerCache: ComposerCache,
  cache?: FileCache,
  projectScanTimeout?: number,
): Promise<ProjectScan[]> {
  // Find composer.json files
  const manifestFiles = cache
    ? await cache.findFiles(rootDir, (name) => PHP_MANIFEST_FILES.has(name))
    : await findPhpManifests(rootDir);

  const results: ProjectScan[] = [];
  const STUCK_TIMEOUT_MS = projectScanTimeout ?? cache?.projectScanTimeout ?? 180_000;

  for (const manifestFile of manifestFiles) {
    const dir = path.dirname(manifestFile);
    try {
      const scanPromise = scanOnePhpProject(dir, manifestFile, rootDir, composerCache, cache);
      const result = await withTimeout(scanPromise, STUCK_TIMEOUT_MS);
      if (result.ok) {
        results.push(result.value);
      } else {
        const relPath = path.relative(rootDir, dir);
        if (cache) cache.addStuckPath(relPath || '.');
        console.error(`Timeout scanning PHP project ${dir} (>${STUCK_TIMEOUT_MS / 1000}s) — skipped`);
        if (cache?.shouldShowTimeoutHint()) {
          console.error(`  Tip: increase projectScanTimeout in vibgrate.config.ts (or --project-scan-timeout <seconds>) for large projects`);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error scanning PHP project ${dir}: ${msg}`);
    }
  }

  return results;
}

async function findPhpManifests(rootDir: string): Promise<string[]> {
  const { findFiles } = await import('../utils/fs.js');
  return findFiles(rootDir, (name) => PHP_MANIFEST_FILES.has(name));
}

async function scanOnePhpProject(
  dir: string,
  manifestFile: string,
  rootDir: string,
  composerCache: ComposerCache,
  cache?: FileCache,
): Promise<ProjectScan> {
  const relDir = path.relative(rootDir, dir) || '.';
  const projectName = path.basename(dir === rootDir ? rootDir : dir);
  
  const { phpVersion: phpVersionConstraint, deps: allDeps } = await parseComposerJson(manifestFile, cache);
  
  // Try to read composer.lock for exact versions
  const lockPath = path.join(dir, 'composer.lock');
  let resolvedVersions = new Map<string, string>();
  try {
    resolvedVersions = await parseComposerLock(lockPath, cache);
  } catch {
    // No composer.lock or can't read it
  }
  
  // Filter out dev dependencies for main analysis
  const prodDeps = allDeps.filter(d => !d.isDev);
  
  // Determine PHP runtime version lag
  let runtimeMajorsBehind: number | undefined;
  let runtimeLatest: string | undefined;
  let phpVersion: string | undefined;

  if (phpVersionConstraint) {
    phpVersion = extractPhpVersion(phpVersionConstraint);
    if (phpVersion) {
      const verMatch = phpVersion.match(/(\d+)\.(\d+)/);
      if (verMatch) {
        const reqMajor = parseInt(verMatch[1]!, 10);
        const reqMinor = parseInt(verMatch[2]!, 10);
        if (reqMajor === LATEST_PHP.major) {
          runtimeMajorsBehind = Math.max(0, LATEST_PHP.minor - reqMinor);
        } else if (reqMajor < LATEST_PHP.major) {
          runtimeMajorsBehind = LATEST_PHP.minor + (LATEST_PHP.major - reqMajor) * 10;
        }
        runtimeLatest = `${LATEST_PHP.major}.${LATEST_PHP.minor}`;
      }
    }
  }

  // Resolve dependencies
  const dependencies: DependencyRow[] = [];
  const frameworks: DetectedFramework[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  // Fetch all metadata in parallel
  const metaPromises = prodDeps.map(async (dep) => {
    const meta = await composerCache.get(dep.name);
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
    if (dep.name in KNOWN_PHP_FRAMEWORKS) {
      frameworks.push({
        name: KNOWN_PHP_FRAMEWORKS[dep.name]!,
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
    type: 'php',
    path: relDir,
    name: projectName,
    runtime: phpVersion,
    runtimeLatest,
    runtimeMajorsBehind,
    frameworks,
    dependencies,
    dependencyAgeBuckets: buckets,
    fileCount,
  };
}
