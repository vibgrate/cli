// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { readTextFile, FileCache } from '../utils/fs.js';
import { withTimeout } from '../utils/timeout.js';
import { GoCache } from './go-cache.js';
import { latestStable, runtimeEolStatus, extractCycle, eolDate } from '../runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../runtimes/snapshot.js';
import type { RuntimeCatalog } from '../runtimes/types.js';
import type { ProjectScan, DependencyRow, DetectedFramework } from '../types.js';

/** Well-known Go frameworks / libraries to track */
const KNOWN_GO_FRAMEWORKS: Record<string, string> = {
  // ── Web Frameworks ──
  'github.com/gin-gonic/gin': 'Gin',
  'github.com/labstack/echo': 'Echo',
  'github.com/gofiber/fiber': 'Fiber',
  'github.com/gorilla/mux': 'Gorilla Mux',
  'github.com/go-chi/chi': 'Chi',
  'github.com/beego/beego': 'Beego',
  'github.com/revel/revel': 'Revel',

  // ── Kubernetes & Cloud Native ──
  'k8s.io/kubernetes': 'Kubernetes',
  'k8s.io/client-go': 'Kubernetes Client',
  'github.com/prometheus/prometheus': 'Prometheus',
  'github.com/prometheus/client_golang': 'Prometheus Client',
  'go.etcd.io/etcd': 'etcd',
  'github.com/hashicorp/consul': 'Consul',
  'github.com/hashicorp/vault': 'Vault',
  'github.com/traefik/traefik': 'Traefik',
  'github.com/istio/istio': 'Istio',

  // ── Database & ORM ──
  'gorm.io/gorm': 'GORM',
  'github.com/jmoiron/sqlx': 'sqlx',
  'github.com/go-sql-driver/mysql': 'MySQL Driver',
  'github.com/lib/pq': 'PostgreSQL Driver',
  'go.mongodb.org/mongo-driver': 'MongoDB Driver',
  'github.com/redis/go-redis': 'Redis Client',
  'github.com/go-redis/redis': 'go-redis',

  // ── gRPC & Protobuf ──
  'google.golang.org/grpc': 'gRPC',
  'google.golang.org/protobuf': 'Protobuf',
  'github.com/grpc-ecosystem/grpc-gateway': 'gRPC Gateway',

  // ── Testing ──
  'github.com/stretchr/testify': 'Testify',
  'github.com/onsi/ginkgo': 'Ginkgo',
  'github.com/onsi/gomega': 'Gomega',
  'github.com/golang/mock': 'GoMock',

  // ── Logging ──
  'go.uber.org/zap': 'Zap',
  'github.com/sirupsen/logrus': 'Logrus',
  'github.com/rs/zerolog': 'Zerolog',

  // ── Configuration ──
  'github.com/spf13/viper': 'Viper',
  'github.com/spf13/cobra': 'Cobra',
  'github.com/urfave/cli': 'urfave/cli',

  // ── HTTP Client ──
  'github.com/go-resty/resty': 'Resty',

  // ── Serialization ──
  'github.com/json-iterator/go': 'jsoniter',
  'gopkg.in/yaml.v3': 'YAML v3',

  // ── Message Queue ──
  'github.com/segmentio/kafka-go': 'kafka-go',
  'github.com/rabbitmq/amqp091-go': 'RabbitMQ',
  'github.com/nats-io/nats.go': 'NATS',

  // ── Utilities ──
  'github.com/google/uuid': 'UUID',
  'github.com/spf13/cast': 'Cast',
  'github.com/pkg/errors': 'pkg/errors',
};

// Latest Go major.minor is resolved at scan time — see runtime-baselines.ts

interface GoDependency {
  path: string;
  version: string;
  indirect: boolean;
}

/**
 * Parse go.mod to extract dependencies and Go version.
 * 
 * Example:
 *   module github.com/example/project
 *   go 1.21
 *   require (
 *     github.com/gin-gonic/gin v1.9.1
 *     github.com/stretchr/testify v1.8.4 // indirect
 *   )
 */
function parseGoMod(content: string): { goVersion?: string; deps: GoDependency[] } {
  const deps: GoDependency[] = [];
  let goVersion: string | undefined;
  let inRequireBlock = false;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    // Extract Go version
    if (trimmed.startsWith('go ')) {
      const match = trimmed.match(/^go\s+(\d+\.\d+)/);
      if (match) goVersion = match[1];
      continue;
    }

    // Track require blocks
    if (trimmed.startsWith('require (')) {
      inRequireBlock = true;
      continue;
    }

    if (trimmed === ')' && inRequireBlock) {
      inRequireBlock = false;
      continue;
    }

    // Parse dependency lines
    // Format: github.com/gin-gonic/gin v1.9.1
    // Format: github.com/gin-gonic/gin v1.9.1 // indirect
    let depLine = trimmed;
    if (inRequireBlock) {
      depLine = trimmed;
    } else if (trimmed.startsWith('require ')) {
      depLine = trimmed.substring(8);
    } else {
      continue;
    }

    const indirect = depLine.includes('// indirect');
    depLine = depLine.replace(/\/\/.*$/, '').trim();

    const parts = depLine.split(/\s+/);
    if (parts.length >= 2) {
      const [modulePath, version] = parts;
      if (modulePath && version) {
        deps.push({
          path: modulePath,
          version,
          indirect,
        });
      }
    }
  }

  return { goVersion, deps };
}

// ── Go project file names ──

const GO_MANIFEST_FILES = new Set([
  'go.mod',
]);

/**
 * Discover and scan all Go projects in the workspace.
 */
export async function scanGoProjects(
  rootDir: string,
  goCache: GoCache,
  cache?: FileCache,
  projectScanTimeout?: number,
  catalog: RuntimeCatalog = BUNDLED_RUNTIME_CATALOG,
): Promise<ProjectScan[]> {
  // Find go.mod files
  const manifestFiles = cache
    ? await cache.findFiles(rootDir, (name) => GO_MANIFEST_FILES.has(name))
    : await findGoManifests(rootDir);

  const results: ProjectScan[] = [];
  const STUCK_TIMEOUT_MS = projectScanTimeout ?? cache?.projectScanTimeout ?? 180_000;

  for (const manifestFile of manifestFiles) {
    const dir = path.dirname(manifestFile);
    try {
      const scanPromise = scanOneGoProject(dir, manifestFile, rootDir, goCache, cache, catalog);
      const result = await withTimeout(scanPromise, STUCK_TIMEOUT_MS);
      if (result.ok) {
        results.push(result.value);
      } else {
        const relPath = path.relative(rootDir, dir);
        if (cache) cache.addStuckPath(relPath || '.');
        console.error(`Timeout scanning Go project ${dir} (>${STUCK_TIMEOUT_MS / 1000}s) — skipped`);
        if (cache?.shouldShowTimeoutHint()) {
          console.error(`  Tip: increase projectScanTimeout in vibgrate.config.ts (or --project-scan-timeout <seconds>) for large projects`);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error scanning Go project ${dir}: ${msg}`);
    }
  }

  return results;
}

async function findGoManifests(rootDir: string): Promise<string[]> {
  const { findFiles } = await import('../utils/fs.js');
  return findFiles(rootDir, (name) => GO_MANIFEST_FILES.has(name));
}

async function scanOneGoProject(
  dir: string,
  manifestFile: string,
  rootDir: string,
  goCache: GoCache,
  cache: FileCache | undefined,
  catalog: RuntimeCatalog,
): Promise<ProjectScan> {
  const relDir = path.relative(rootDir, dir) || '.';
  const projectName = path.basename(dir === rootDir ? rootDir : dir);
  
  const content = cache ? await cache.readTextFile(manifestFile) : await readTextFile(manifestFile);
  const { goVersion, deps: allDeps } = parseGoMod(content);
  
  // Filter out indirect dependencies for main analysis
  const directDeps = allDeps.filter(d => !d.indirect);
  
  // Determine Go runtime version lag
  let runtimeMajorsBehind: number | undefined;
  let runtimeLatest: string | undefined;
  let runtimeEol: boolean | null | undefined;
  let runtimeEolDate: string | undefined;

  if (goVersion) {
    const verMatch = goVersion.match(/(\d+)\.(\d+)/);
    if (verMatch) {
      const reqMajor = parseInt(verMatch[1]!, 10);
      const reqMinor = parseInt(verMatch[2]!, 10);
      const LATEST_GO_MINOR = latestStable(catalog, 'go');
      if (LATEST_GO_MINOR) {
        if (reqMajor === LATEST_GO_MINOR.major) {
          runtimeMajorsBehind = Math.max(0, LATEST_GO_MINOR.minor - reqMinor);
        } else if (reqMajor < LATEST_GO_MINOR.major) {
          runtimeMajorsBehind = LATEST_GO_MINOR.minor + (LATEST_GO_MINOR.major - reqMajor) * 100;
        }
        runtimeLatest = `${LATEST_GO_MINOR.major}.${LATEST_GO_MINOR.minor}`;
      }
    }
    runtimeEol = runtimeEolStatus(catalog, 'go', goVersion);
    const cycle = extractCycle('go', goVersion);
    if (cycle) runtimeEolDate = eolDate(catalog, 'go', cycle);
  }

  // Resolve dependencies
  const dependencies: DependencyRow[] = [];
  const frameworks: DetectedFramework[] = [];
  const buckets = { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 };

  // Fetch all metadata in parallel
  const metaPromises = directDeps.map(async (dep) => {
    const meta = await goCache.get(dep.path);
    return { dep, meta };
  });

  const resolved = await Promise.all(metaPromises);

  for (const { dep, meta } of resolved) {
    const resolvedVersion = semver.valid(semver.clean(dep.version));
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
      package: dep.path,
      section: 'dependencies',
      currentSpec: dep.version,
      resolvedVersion,
      latestStable,
      majorsBehind,
      drift,
    });

    // Detect known frameworks
    if (dep.path in KNOWN_GO_FRAMEWORKS) {
      frameworks.push({
        name: KNOWN_GO_FRAMEWORKS[dep.path]!,
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
    type: 'go',
    path: relDir,
    name: projectName,
    runtime: goVersion,
    runtimeLatest,
    runtimeMajorsBehind,
    runtimeEol,
    runtimeEolDate,
    frameworks,
    dependencies,
    dependencyAgeBuckets: buckets,
    fileCount,
  };
}
