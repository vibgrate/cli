// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as semver from 'semver';
import { readTextFile, pathExists, FileCache } from '../utils/fs.js';
import { recordedSemver } from '../utils/recorded-semver.js';
import { withTimeout } from '../utils/timeout.js';
import { GoCache, type GoModuleMeta } from './go-cache.js';
import { latestStable, runtimeEolStatus, extractCycle, eolDate } from '../runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../runtimes/snapshot.js';
import type { RuntimeCatalog } from '../runtimes/types.js';
import type { ProjectScan, ProjectReference, DependencyRow, DetectedFramework } from '../types.js';
import { compareCodeUnits } from '../utils/code-unit.js';

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
  /**
   * Concrete `v…` token from the require line, or null when the line names a
   * module and does not pin one. A range is not a version — it stays on
   * `declared` and `version` stays null. Never synthesize a number.
   * A module `replace` overwrites this with the replacement version.
   */
  version: string | null;
  /**
   * What was written after the module path, or null when the line has no spec.
   * A module `replace` stores the original module path here so the requirement
   * that was swapped out stays visible next to the replacement version.
   */
  declared: string | null;
  indirect: boolean;
  /** Original module path when `path` and `version` come from a module replace. */
  replacedFrom?: string;
  /** Local-path replace: keep the row and do not query the module proxy. */
  localReplace?: boolean;
  /**
   * Filesystem path from the winning local `replace`, as written in go.mod
   * (relative to that file, or absolute). Used to link another module in this
   * scan. Not copied onto the dependency row.
   */
  localReplacePath?: string;
}

/** A `replace` collected from the file. Applied only after every require is read. */
interface ReplaceDirective {
  modulePath: string;
  /** Left-hand version when the replace is version-scoped; null applies to every version. */
  version: string | null;
  target: { kind: 'module'; path: string; version: string } | { kind: 'local'; path: string };
}

/**
 * Parse go.mod to extract dependencies, tool package paths, and Go version.
 *
 * `replace` may appear before or after the `require` it rewrites, so directives
 * are collected and applied after the whole file is read. A version on the left
 * (`a v1.2.0 => …`) applies only to that version and wins over a versionless
 * replace of the same module. A later directive for the same key wins.
 *
 * Example:
 *   module github.com/example/project
 *   go 1.24
 *   tool golang.org/x/tools/cmd/stringer
 *   require (
 *     github.com/gin-gonic/gin v1.9.1
 *     github.com/stretchr/testify v1.8.4 // indirect
 *   )
 */
function parseGoMod(content: string): {
  modulePath?: string;
  goVersion?: string;
  deps: GoDependency[];
  tools: string[];
} {
  const deps: GoDependency[] = [];
  const replaces: ReplaceDirective[] = [];
  const tools: string[] = [];
  let modulePath: string | undefined;
  let goVersion: string | undefined;
  let block: 'require' | 'replace' | 'tool' | null = null;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    // Extract Go version. A top-level directive; a `go` token inside a block
    // is not one, but matching here (and skipping the line) is the historical
    // behavior for a require line that happens to start with `go `.
    if (trimmed.startsWith('go ')) {
      const match = trimmed.match(/^go\s+(\d+\.\d+)/);
      if (match) goVersion = match[1];
      continue;
    }

    if (block === null) {
      // A one-line `require ( … )` / `replace ( … )` / `tool ( … )` is a
      // directive, not a block.
      if (/^tool\s*\(/.test(trimmed) && !/^tool\s*\(.*\)\s*$/.test(trimmed)) {
        block = 'tool';
        continue;
      }
      if (/^tool\s*\(.*\)\s*$/.test(trimmed)) {
        const toolPath = toolPackagePath(trimmed.replace(/^tool\s*\(/, '').replace(/\)\s*$/, ''));
        if (toolPath) tools.push(toolPath);
        continue;
      }
      if (trimmed.startsWith('module ')) {
        const moduleToken = goTokens(stripGoComment(trimmed.substring('module '.length)))[0];
        if (moduleToken) modulePath = moduleToken;
        continue;
      }
      if (trimmed.startsWith('tool ')) {
        const toolPath = toolPackagePath(trimmed.substring('tool '.length));
        if (toolPath) tools.push(toolPath);
        continue;
      }
      if (/^require\s*\(/.test(trimmed) && !/^require\s*\(.*\)\s*$/.test(trimmed)) {
        block = 'require';
        continue;
      }
      if (/^replace\s*\(/.test(trimmed) && !/^replace\s*\(.*\)\s*$/.test(trimmed)) {
        block = 'replace';
        continue;
      }
      if (/^require\s*\(.*\)\s*$/.test(trimmed)) {
        const dep = parseRequireLine(trimmed.replace(/^require\s*\(/, '').replace(/\)\s*$/, ''));
        if (dep) deps.push(dep);
        continue;
      }
      if (/^replace\s*\(.*\)\s*$/.test(trimmed)) {
        const directive = parseReplaceLine(trimmed.replace(/^replace\s*\(/, '').replace(/\)\s*$/, ''));
        if (directive) replaces.push(directive);
        continue;
      }
      if (trimmed.startsWith('require ')) {
        const dep = parseRequireLine(trimmed.substring(8));
        if (dep) deps.push(dep);
        continue;
      }
      if (trimmed.startsWith('replace ')) {
        const directive = parseReplaceLine(trimmed.substring(8));
        if (directive) replaces.push(directive);
        continue;
      }
      continue;
    }

    if (trimmed === ')') {
      block = null;
      continue;
    }

    if (block === 'require') {
      const dep = parseRequireLine(trimmed);
      if (dep) deps.push(dep);
    } else if (block === 'tool') {
      const toolPath = toolPackagePath(trimmed);
      if (toolPath) tools.push(toolPath);
    } else {
      const directive = parseReplaceLine(trimmed);
      if (directive) replaces.push(directive);
    }
  }

  applyReplacements(deps, replaces);
  return { modulePath, goVersion, deps, tools };
}

/** Package path from a `tool` line, ignoring a trailing comment. */
function toolPackagePath(line: string): string | null {
  const code = line.replace(/\/\/.*$/, '').trim();
  if (!code || code === '(' || code === ')') return null;
  const token = code.split(/\s+/)[0];
  if (!token || !looksLikeGoModule(token)) return null;
  return token;
}

/**
 * Required module that provides `toolPath`: the longest module path that is
 * the tool path itself or a `/`-bounded prefix of it. A `tool` line names the
 * package under the module as required, so a replaced row matches on
 * `replacedFrom`. Returns the row's (possibly replaced) path.
 */
function moduleProvidingTool(toolPath: string, deps: GoDependency[]): string | null {
  let best: { required: string; path: string } | null = null;
  for (const dep of deps) {
    const required = dep.replacedFrom ?? dep.path;
    if (toolPath !== required && !toolPath.startsWith(`${required}/`)) continue;
    if (best === null || required.length > best.required.length) best = { required, path: dep.path };
  }
  return best ? best.path : null;
}

/**
 * One require line, already stripped of a leading `require` keyword.
 * Returns null for comments, `replace`/`exclude`, and tokens that are not a
 * module path. A line containing `=>` is a replace, not a require.
 */
function parseRequireLine(depLine: string): GoDependency | null {
  const indirect = depLine.includes('// indirect');
  const code = depLine.replace(/\/\/.*$/, '').trim();
  if (!code || code === '(' || code === ')' || code.includes('=>')) return null;

  const parts = code.split(/\s+/);
  const modulePath = parts[0];
  if (!modulePath) return null;
  const rest = parts.slice(1);
  const concrete =
    rest.length === 1 && isGoVersionToken(rest[0]!) ? rest[0]! : null;
  // A `v…` pin is kept as written. A bare module path (version inherited or
  // not yet chosen) and a range stay visible with no invented version.
  if (!concrete && !looksLikeGoModule(modulePath)) return null;
  return {
    path: modulePath,
    version: concrete,
    declared: concrete ?? (rest.length ? rest.join(' ') : null),
    indirect,
  };
}

/** `v1.2.3`, a pseudo-version, or `v2.0.0+incompatible`. A range is not a version. */
function isGoVersionToken(token: string): boolean {
  return /^v\S+$/.test(token) && !/[\^~*<>|]/.test(token);
}

/**
 * `./…`, `../…`, or an absolute path (POSIX, UNC, or a Windows drive).
 * A module replacement always names a version; these do not.
 */
function isFilesystemPath(token: string): boolean {
  return (
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('.\\') ||
    token.startsWith('..\\') ||
    token.startsWith('/') ||
    token.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(token)
  );
}

/** Drop a `//` comment that is not inside a quoted path. */
function stripGoComment(line: string): string {
  let quote: '"' | '`' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** Quoted paths (`"../My Lib"`, `` `./dir` ``) stay one token. */
function goTokens(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i]!)) i++;
    if (i >= input.length) break;
    const q = input[i];
    if (q === '"' || q === '`') {
      i++;
      let s = '';
      while (i < input.length && input[i] !== q) {
        if (input[i] === '\\' && q === '"') {
          i++;
          if (i < input.length) s += input[i++];
          continue;
        }
        s += input[i++];
      }
      if (i < input.length) i++;
      tokens.push(s);
      continue;
    }
    let s = '';
    while (i < input.length && !/\s/.test(input[i]!)) s += input[i++];
    tokens.push(s);
  }
  return tokens;
}

/**
 * One replace arrow. A filesystem path on the right is local, even when a
 * version token follows it. A module path plus a version is a replacement
 * module. A module path with no version is ignored.
 */
function parseReplaceLine(line: string): ReplaceDirective | null {
  const code = stripGoComment(line).trim();
  if (!code || code === '(' || code === ')') return null;
  const arrow = code.indexOf('=>');
  if (arrow < 0) return null;
  const left = goTokens(code.slice(0, arrow));
  const right = goTokens(code.slice(arrow + 2));
  const modulePath = left[0];
  const rightPath = right[0];
  if (!modulePath || !rightPath || !looksLikeGoModule(modulePath)) return null;
  if (left.length > 2) return null;
  if (left.length === 2 && !isGoVersionToken(left[1]!)) return null;
  const version = left.length === 2 ? left[1]! : null;

  if (isFilesystemPath(rightPath) || right.length < 2 || !isGoVersionToken(right[1]!)) {
    if (!isFilesystemPath(rightPath)) return null;
    return { modulePath, version, target: { kind: 'local', path: rightPath } };
  }
  return {
    modulePath,
    version,
    target: { kind: 'module', path: rightPath, version: right[1]! },
  };
}

/**
 * Rewrite requires from the replace map. A version-scoped directive wins over
 * a versionless one. Local paths keep the original module and mark the row so
 * the scan does not ask the module proxy.
 */
function applyReplacements(deps: GoDependency[], directives: ReplaceDirective[]): void {
  const wildcard = new Map<string, ReplaceDirective>();
  const scoped = new Map<string, ReplaceDirective>();
  for (const directive of directives) {
    if (directive.version) scoped.set(`${directive.modulePath}\0${directive.version}`, directive);
    else wildcard.set(directive.modulePath, directive);
  }
  for (const dep of deps) {
    const specific = dep.version ? scoped.get(`${dep.path}\0${dep.version}`) : undefined;
    const rule = specific ?? wildcard.get(dep.path);
    if (!rule) continue;
    if (rule.target.kind === 'local') {
      dep.localReplace = true;
      dep.localReplacePath = rule.target.path;
      continue;
    }
    const original = dep.path;
    dep.replacedFrom = original;
    dep.declared = original;
    dep.path = rule.target.path;
    dep.version = rule.target.version;
  }
}

function looksLikeGoModule(token: string): boolean {
  if (
    token === 'require' ||
    token === 'module' ||
    token === 'go' ||
    token === 'replace' ||
    token === 'exclude' ||
    token === 'retract' ||
    token === 'toolchain' ||
    token === 'tool'
  ) {
    return false;
  }
  return token.includes('.') || token.includes('/');
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

  const scanned: ScannedGoProject[] = [];
  const STUCK_TIMEOUT_MS = projectScanTimeout ?? cache?.projectScanTimeout ?? 180_000;

  for (const manifestFile of manifestFiles) {
    const dir = path.dirname(manifestFile);
    try {
      const scanPromise = scanOneGoProject(dir, manifestFile, rootDir, goCache, cache, catalog);
      const result = await withTimeout(scanPromise, STUCK_TIMEOUT_MS);
      if (result.ok) {
        scanned.push(result.value);
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

  const usePaths = await readRootGoWorkUses(rootDir, cache);
  linkGoProjectReferences(scanned, rootDir, usePaths);
  return scanned.map((entry) => entry.project);
}

async function findGoManifests(rootDir: string): Promise<string[]> {
  const { findFiles } = await import('../utils/fs.js');
  return findFiles(rootDir, (name) => GO_MANIFEST_FILES.has(name));
}

interface ScannedGoProject {
  project: ProjectScan;
  /** `module` path from go.mod, when the file declares one. */
  modulePath?: string;
  /** Winning local-replace targets, as written next to `=>`. */
  localReplacePaths: string[];
  /**
   * Module paths this go.mod requires (direct and indirect), except a module
   * supplied by a local replace — that link is the replace directory.
   */
  requiredModulePaths: string[];
}

async function scanOneGoProject(
  dir: string,
  manifestFile: string,
  rootDir: string,
  goCache: GoCache,
  cache: FileCache | undefined,
  catalog: RuntimeCatalog,
): Promise<ScannedGoProject> {
  const relDir = path.relative(rootDir, dir) || '.';
  const projectName = path.basename(dir === rootDir ? rootDir : dir);
  
  const content = cache ? await cache.readTextFile(manifestFile) : await readTextFile(manifestFile);
  const { modulePath, goVersion, deps: allDeps, tools } = parseGoMod(content);

  // Indirect requires stay out of the scan unless they provide a `tool`
  // package. Those modules are development dependencies. A module that is
  // also a direct require stays in dependencies.
  const toolProviders = new Set<string>();
  for (const toolPath of tools) {
    const provider = moduleProvidingTool(toolPath, allDeps);
    if (provider) toolProviders.add(provider);
  }
  const directPaths = new Set(allDeps.filter((d) => !d.indirect).map((d) => d.path));
  const directDeps = allDeps.filter(
    (d) => !d.indirect || (toolProviders.has(d.path) && !directPaths.has(d.path)),
  );
  
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

  // Fetch all metadata in parallel. A local-path replace has no module to
  // look up — skip the proxy (and any offline manifest) so it cannot be
  // counted as behind upstream.
  const emptyMeta = (): GoModuleMeta => ({ latest: null, stableVersions: [], latestStableOverall: null });
  const metaPromises = directDeps.map(async (dep) => {
    if (dep.localReplace) return { dep, meta: emptyMeta() };
    const meta = await goCache.get(dep.path);
    return { dep, meta };
  });

  const resolved = await Promise.all(metaPromises);

  for (const { dep, meta } of resolved) {
    const resolvedVersion = dep.version ? recordedSemver(dep.version) : null;
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
      section: dep.indirect ? 'devDependencies' : 'dependencies',
      // `*` is the existing marker for a dependency declared with no version
      // (same as an unpinned Python/Ruby requirement). A written range stays
      // the spec. Neither is promoted to resolvedVersion. A module replace
      // keeps the replacement `v…` token here; the original path is
      // `replacedFrom` (and on `declared`, which loses to a concrete version).
      currentSpec: dep.version ?? dep.declared ?? '*',
      resolvedVersion,
      latestStable,
      majorsBehind,
      drift,
      ...(dep.replacedFrom ? { replacedFrom: dep.replacedFrom } : {}),
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
    return compareCodeUnits(a.package, b.package);
  });

  // Count files
  let fileCount: number | undefined;
  try {
    fileCount = cache ? await cache.countFilesUnder(rootDir, dir) : undefined;
  } catch { /* ignore */ }

  return {
    project: {
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
    },
    modulePath,
    localReplacePaths: allDeps.flatMap((dep) => (dep.localReplacePath ? [dep.localReplacePath] : [])),
    // A local replace already names the directory that supplies the module.
    // Matching that require against go.work would point at a second copy.
    requiredModulePaths: allDeps.flatMap((dep) => (dep.localReplace ? [] : [dep.path])),
  };
}

/** `use` paths from a go.work file at the scan root. Missing file yields none. */
async function readRootGoWorkUses(rootDir: string, cache: FileCache | undefined): Promise<string[]> {
  const workFile = path.join(rootDir, 'go.work');
  try {
    const exists = cache ? await cache.pathExists(workFile) : await pathExists(workFile);
    if (!exists) return [];
    const content = cache ? await cache.readTextFile(workFile) : await readTextFile(workFile);
    return parseGoWorkUses(content);
  } catch {
    return [];
  }
}

/**
 * Directory paths from `use` / `use ( … )`. A one-line `use ( … )` is a
 * directive, not a block. Comments are ignored. Order is file order.
 */
function parseGoWorkUses(content: string): string[] {
  const uses: string[] = [];
  let inUse = false;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = stripGoComment(line).trim();
    if (!trimmed) continue;

    if (!inUse) {
      if (/^use\s*\(/.test(trimmed) && !/^use\s*\(.*\)\s*$/.test(trimmed)) {
        inUse = true;
        continue;
      }
      if (/^use\s*\(.*\)\s*$/.test(trimmed)) {
        uses.push(...goTokens(trimmed.replace(/^use\s*\(/, '').replace(/\)\s*$/, '')));
        continue;
      }
      if (trimmed.startsWith('use ')) {
        uses.push(...goTokens(trimmed.substring('use '.length)));
      }
      continue;
    }

    if (trimmed === ')') {
      inUse = false;
      continue;
    }
    uses.push(...goTokens(trimmed));
  }

  return uses.filter((token) => token !== '(' && token !== ')');
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * `targetPath` resolved from `fromDir`, then made relative to the scan root.
 * A path that leaves the root is not a project in this scan.
 */
function scanRelative(rootDir: string, fromDir: string, targetPath: string): string | null {
  const abs = path.resolve(fromDir, targetPath.replace(/\\/g, '/'));
  const rel = path.relative(rootDir, abs);
  if (rel === '') return '.';
  const normalized = normalizeRel(rel);
  if (path.isAbsolute(rel) || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

/**
 * Local `replace` targets and root `go.work` `use` entries become
 * `projectReferences` when they name another scanned Go module.
 *
 * A replace is resolved from the go.mod directory. A `use` entry counts only
 * when this module requires that module path. Remote replaces and paths that
 * are not scanned projects add nothing. The list is sorted and de-duplicated
 * by project path, and omitted entirely when empty.
 */
function linkGoProjectReferences(scanned: ScannedGoProject[], rootDir: string, usePaths: string[]): void {
  const byPath = new Map<string, ProjectScan>();
  for (const entry of scanned) {
    byPath.set(normalizeRel(entry.project.path), entry.project);
  }

  const usedPaths = new Set<string>();
  for (const usePath of usePaths) {
    const rel = scanRelative(rootDir, rootDir, usePath);
    if (rel && byPath.has(rel)) usedPaths.add(rel);
  }

  const moduleToProject = new Map<string, ProjectScan>();
  const workspaceModules = scanned
    .filter((entry) => entry.modulePath && usedPaths.has(normalizeRel(entry.project.path)))
    .sort((a, b) => compareCodeUnits(normalizeRel(a.project.path), normalizeRel(b.project.path)));
  for (const entry of workspaceModules) {
    const modulePath = entry.modulePath;
    if (!modulePath || moduleToProject.has(modulePath)) continue;
    moduleToProject.set(modulePath, entry.project);
  }

  for (const entry of scanned) {
    const refs = new Map<string, ProjectReference>();
    const add = (target: ProjectScan): void => {
      if (target.path === entry.project.path || refs.has(target.path)) return;
      refs.set(target.path, { path: target.path, name: target.name, refType: 'project' });
    };

    const moduleDir = path.resolve(rootDir, entry.project.path);
    for (const replacePath of entry.localReplacePaths) {
      const rel = scanRelative(rootDir, moduleDir, replacePath);
      if (!rel) continue;
      const target = byPath.get(rel);
      if (target) add(target);
    }

    for (const required of entry.requiredModulePaths) {
      const target = moduleToProject.get(required);
      if (target) add(target);
    }

    const list = [...refs.values()].sort(
      (a, b) => compareCodeUnits(a.path, b.path) || compareCodeUnits(a.name, b.name),
    );
    if (list.length > 0) entry.project.projectReferences = list;
  }
}
