// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * npm lockfile resolution (clean-room).
 *
 * The scanner resolves each direct dependency's version from the registry's best match for the
 * declared range. A lockfile carries the EXACT installed version — which is more accurate for
 * "what's current", and is the only source of a resolved version in `--offline` mode (no registry).
 * This module parses the npm-family lockfiles into a name → installed-version index the node scanner
 * prefers over the registry guess.
 *
 * Clean-room: formats are read from their public, documented shapes (npm package-lock v1/v2/v3 JSON,
 * including the same JSON under the `npm-shrinkwrap.json` filename; Yarn classic + Berry text;
 * pnpm-lock v5/v6/v9 YAML) — no third-party (AGPL or otherwise) parser is used or ported. The only
 * dependency is the `yaml` package, for the genuinely-YAML pnpm lockfile.
 */
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assertLockfileText, LockfileParseError, rethrowLockfileParseError } from '../utils/lockfile-parse.js';
import { compareCodeUnits } from '../utils/code-unit.js';
import {
  type LockfileUnknownFields,
  notePackageLock,
  notePnpmLockDoc,
  noteYarnLockText,
  withLockfileNotes,
} from '../utils/lockfile-unknown.js';

export type NpmLockSource = 'package-lock' | 'yarn' | 'pnpm';

export interface NpmLockIndex {
  source: NpmLockSource;
  /** Distinct packages with a resolved version. */
  size: number;
  /** Installed version for a direct dependency by name (disambiguated by the declared spec when possible). */
  resolve(name: string, spec?: string): string | null;
  /**
   * Every package the lockfile resolves, with its resolved dependency edges — the transitive tree,
   * not just the direct dependencies. Built lazily on first call (a plain scan never needs it) and
   * memoised.
   */
  graph(): LockGraph;
}

/** One resolved package in a lockfile. */
export interface LockedPackage {
  name: string;
  version: string;
}

/**
 * The resolved dependency graph of a lockfile. Nodes and edges are keyed `name@version` (see
 * {@link lockKey}). Every node appears in `edges` (a leaf maps to an empty list), and every child
 * list is sorted so traversal order — and anything derived from it — is deterministic.
 */
export interface LockGraph {
  nodes: Map<string, LockedPackage>;
  edges: Map<string, string[]>;
}

/** Node key for a resolved package. */
export function lockKey(name: string, version: string): string {
  return `${name}@${version}`;
}

interface PackageLockShape {
  packages?: Record<string, { version?: string } | null>;
  dependencies?: Record<string, { version?: string } | null>;
}

// A top-level install lives at exactly `node_modules/<name>` (name may be scoped: `node_modules/@scope/pkg`).
const TOP_LEVEL_NODE_MODULES = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/;

/** name → top-level installed version from a package-lock.json (v2/v3 `packages`, falling back to v1 `dependencies`). */
export function parsePackageLock(
  json: unknown,
  relPath = 'package-lock.json',
  notes?: LockfileUnknownFields,
): Map<string, string> {
  return withLockfileNotes(notes, (bucket) => {
    notePackageLock(json, relPath, bucket);
    return parsePackageLockBody(json);
  });
}

function parsePackageLockBody(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!json || typeof json !== 'object') return out;
  const lock = json as PackageLockShape;

  if (lock.packages && typeof lock.packages === 'object') {
    for (const [p, entry] of Object.entries(lock.packages)) {
      const version = entry?.version;
      if (!version) continue;
      const m = TOP_LEVEL_NODE_MODULES.exec(p);
      if (m) out.set(m[1], version);
    }
  }
  // v1 lockfiles have no `packages`; the top-level install tree is `dependencies`.
  if (out.size === 0 && lock.dependencies && typeof lock.dependencies === 'object') {
    for (const [name, entry] of Object.entries(lock.dependencies)) {
      const version = entry?.version;
      if (version) out.set(name, version);
    }
  }
  return out;
}

export interface YarnLockIndex {
  /** Full `name@range` → version (precise). */
  bySpec: Map<string, string>;
  /** name → version, last-wins (fallback when the exact spec key isn't found, e.g. Berry's `name@npm:range`). */
  byName: Map<string, string>;
}

/** Split a `name@range` key into its package name (handles scoped names and Berry's `@npm:` protocol). */
function specName(spec: string): string | null {
  // Skip the leading '@' of a scope, then find the separator '@'.
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at > 0 ? spec.slice(0, at) : null;
}

/**
 * Parse a yarn.lock (classic v1 or Berry v2+). Entry headers are one or more comma-separated quoted
 * specs ending in `:`, followed by an indented `version: x.y.z`. Returns both a precise `name@range`
 * map and a name fallback.
 */
export function parseYarnLock(
  text: string,
  relPath = 'yarn.lock',
  notes?: LockfileUnknownFields,
): YarnLockIndex {
  return withLockfileNotes(notes, (bucket) => {
    noteYarnLockText(text, relPath, bucket);
    return parseYarnLockBody(text);
  });
}

function parseYarnLockBody(text: string): YarnLockIndex {
  const bySpec = new Map<string, string>();
  const byName = new Map<string, string>();
  let currentSpecs: string[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      // Header line: `"a@^1", b@^2:` → the specs for the block that follows.
      currentSpecs = raw
        .replace(/:\s*$/, '')
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
    } else {
      const vm = /^\s+version:?\s+"?([^"\s]+)"?/.exec(raw);
      if (vm && currentSpecs.length) {
        const version = vm[1];
        for (const spec of currentSpecs) {
          const name = specName(spec);
          if (!name) continue;
          bySpec.set(spec, version);
          byName.set(name, version);
        }
        currentSpecs = [];
      }
    }
  }
  return { bySpec, byName };
}

/** Strip a pnpm version descriptor down to a bare semver: drop the peer suffix `(…)`, any leading
 * slash, and a `name@` prefix. Returns null for non-version values (link:/file:/workspace refs). */
function cleanPnpmVersion(v: string): string | null {
  let s = v.split('(')[0].trim().replace(/^\/+/, '');
  const at = s.lastIndexOf('@');
  if (at > 0 && /^\d/.test(s.slice(at + 1))) s = s.slice(at + 1);
  return /^\d/.test(s) ? s : null;
}

/**
 * name → installed version from a parsed pnpm-lock.yaml. Reads the importer dependency blocks (v9)
 * and the top-level `dependencies`/`devDependencies`/`optionalDependencies` (v5/v6), whose values are
 * either a version string or `{ specifier, version }`. First occurrence wins (the root importer).
 */
export function parsePnpmLock(
  doc: unknown,
  relPath = 'pnpm-lock.yaml',
  notes?: LockfileUnknownFields,
): Map<string, string> {
  return withLockfileNotes(notes, (bucket) => {
    notePnpmLockDoc(doc, relPath, bucket);
    return parsePnpmLockBody(doc);
  });
}

function parsePnpmLockBody(doc: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!doc || typeof doc !== 'object') return out;
  const d = doc as Record<string, unknown>;
  const collect = (deps: unknown): void => {
    if (!deps || typeof deps !== 'object') return;
    for (const [name, val] of Object.entries(deps as Record<string, unknown>)) {
      const v = val && typeof val === 'object' ? (val as Record<string, unknown>).version : val;
      if (typeof v !== 'string') continue;
      const clean = cleanPnpmVersion(v);
      if (clean && !out.has(name)) out.set(name, clean);
    }
  };
  if (d.importers && typeof d.importers === 'object') {
    for (const imp of Object.values(d.importers as Record<string, unknown>)) {
      const i = imp as Record<string, unknown> | null;
      collect(i?.dependencies);
      collect(i?.devDependencies);
      collect(i?.optionalDependencies);
    }
  }
  collect(d.dependencies);
  collect(d.devDependencies);
  collect(d.optionalDependencies);
  return out;
}

/** Minimal file IO the loader needs — wired to the cache-backed readers in production, fakes in tests. */
export interface LockfileIo {
  exists(p: string): Promise<boolean>;
  readText(p: string): Promise<string>;
  readJson<T>(p: string): Promise<T>;
}

/**
 * Read one npm JSON lockfile (`package-lock.json` or `npm-shrinkwrap.json`) with
 * {@link parsePackageLock}. Returns null when the file is absent or has no resolved
 * versions. Invalid JSON throws {@link LockfileParseError} and does not fall through.
 */
async function loadPackageLockFile(lockPath: string, io: LockfileIo): Promise<NpmLockIndex | null> {
  if (!(await io.exists(lockPath).catch(() => false))) return null;
  let json: unknown;
  try {
    json = await io.readJson<unknown>(lockPath);
  } catch (err) {
    rethrowLockfileParseError(err);
    throw new LockfileParseError(lockPath, 'JSON');
  }
  const map = parsePackageLock(json, lockPath);
  if (!map.size) return null;
  return {
    source: 'package-lock',
    size: map.size,
    resolve: (name) => map.get(name) ?? null,
    graph: memoGraph(() => parsePackageLockGraph(json)),
  };
}

/**
 * Build the lockfile index for a directory. Prefers the lockfile that matches the resolved package
 * manager (npm → package-lock, yarn → yarn) but falls back to whichever is present. `package-lock.json`
 * wins over `npm-shrinkwrap.json` when both exist; the shrinkwrap is the same JSON and is read only
 * when `package-lock.json` is absent. Returns null when no supported lockfile exists (the scanner then
 * keeps using the registry-resolved version).
 */
export async function loadNpmLockIndex(dir: string, io: LockfileIo): Promise<NpmLockIndex | null> {
  const pnpmPath = path.join(dir, 'pnpm-lock.yaml');
  const yarnPath = path.join(dir, 'yarn.lock');
  const lockPath = path.join(dir, 'package-lock.json');
  const shrinkwrapPath = path.join(dir, 'npm-shrinkwrap.json');

  // pnpm first (its lockfile is the most explicit about installed versions).
  // A file that exists but is truncated or invalid is an error — do not fall
  // through to a different lockfile and silently report that graph instead.
  if (await io.exists(pnpmPath).catch(() => false)) {
    const text = await io.readText(pnpmPath);
    let doc: unknown;
    try {
      assertLockfileText(pnpmPath, text, 'YAML');
      doc = parseYaml(text);
    } catch (err) {
      rethrowLockfileParseError(err);
      throw new LockfileParseError(pnpmPath, 'YAML');
    }
    const map = parsePnpmLock(doc, pnpmPath);
    if (map.size) {
      return { source: 'pnpm', size: map.size, resolve: (name) => map.get(name) ?? null, graph: memoGraph(() => parsePnpmLockGraph(doc)) };
    }
  }
  // package-lock next: structured JSON and unambiguous. A present file is preferred
  // over npm-shrinkwrap.json (same parser) even when it yields no versions.
  const packageLockPresent = await io.exists(lockPath).catch(() => false);
  if (packageLockPresent) {
    const index = await loadPackageLockFile(lockPath, io);
    if (index) return index;
  } else {
    const shrinkwrap = await loadPackageLockFile(shrinkwrapPath, io);
    if (shrinkwrap) return shrinkwrap;
  }
  if (await io.exists(yarnPath).catch(() => false)) {
    const text = await io.readText(yarnPath);
    let parsed: ReturnType<typeof parseYarnLock>;
    try {
      assertLockfileText(yarnPath, text, 'yarn.lock');
      parsed = parseYarnLock(text, yarnPath);
    } catch (err) {
      rethrowLockfileParseError(err);
      throw new LockfileParseError(yarnPath, 'yarn.lock');
    }
    const { bySpec, byName } = parsed;
    if (byName.size) {
      return {
        source: 'yarn',
        size: byName.size,
        resolve: (name, spec) => (spec ? bySpec.get(`${name}@${spec}`) : undefined) ?? byName.get(name) ?? null,
        graph: memoGraph(() => parseYarnLockGraph(text)),
      };
    }
  }
  return null;
}

// ── Resolved dependency graph (transitive tree) ──────────────────────────────

/** Compute a graph once, on first use. */
function memoGraph(build: () => LockGraph): () => LockGraph {
  let cached: LockGraph | undefined;
  return () => (cached ??= build());
}

/** A registry version always starts with a digit; this skips `link:`, `file:`, `workspace:` and URL specs. */
const REGISTRY_VERSION = /^\d/;

class GraphBuilder {
  private readonly nodes = new Map<string, LockedPackage>();
  private readonly edges = new Map<string, Set<string>>();

  /** Add a package; returns its key, or null when the version is not a registry version. */
  addNode(name: string, version: unknown): string | null {
    if (!name || typeof version !== 'string' || !REGISTRY_VERSION.test(version)) return null;
    const key = lockKey(name, version);
    if (!this.nodes.has(key)) {
      this.nodes.set(key, { name, version });
      this.edges.set(key, new Set());
    }
    return key;
  }

  addEdge(from: string, to: string): void {
    if (from !== to) this.edges.get(from)?.add(to);
  }

  build(): LockGraph {
    const edges = new Map<string, string[]>();
    for (const [key, children] of this.edges) edges.set(key, [...children].sort(compareCodeUnits));
    return { nodes: this.nodes, edges };
  }
}

interface PackageLockEntry {
  name?: string;
  version?: string;
  link?: boolean;
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
}

/**
 * Resolve `dep` as `node_modules` resolution does: the dependent's own `node_modules`, then each
 * enclosing one, then the root. `fromPath` is the dependent's lockfile path.
 */
function resolveNodeModulesPath(keyByPath: Map<string, string>, fromPath: string, dep: string): string | undefined {
  let base = fromPath;
  for (;;) {
    const hit = keyByPath.get(base ? `${base}/node_modules/${dep}` : `node_modules/${dep}`);
    if (hit) return hit;
    if (base === '') return undefined;
    const i = base.lastIndexOf('node_modules/');
    base = i > 0 ? base.slice(0, i - 1) : '';
  }
}

interface PackageLockV1Entry {
  version?: string;
  requires?: Record<string, unknown>;
  dependencies?: Record<string, PackageLockV1Entry | null>;
}

function addPackageLockV1Nodes(g: GraphBuilder, scope: Record<string, PackageLockV1Entry | null> | undefined): void {
  if (!scope || typeof scope !== 'object') return;
  for (const [name, entry] of Object.entries(scope)) {
    if (!entry || typeof entry !== 'object') continue;
    g.addNode(name, entry.version);
    addPackageLockV1Nodes(g, entry.dependencies);
  }
}

function addPackageLockV1Edges(
  g: GraphBuilder,
  scope: Record<string, PackageLockV1Entry | null> | undefined,
  enclosing: Array<Record<string, PackageLockV1Entry | null>>,
): void {
  if (!scope || typeof scope !== 'object') return;
  for (const [name, entry] of Object.entries(scope)) {
    if (!entry || typeof entry !== 'object') continue;
    const from = g.addNode(name, entry.version);
    // A `requires` entry resolves in the package's own nested installs first, then each enclosing scope.
    const scopes = [entry.dependencies, scope, ...enclosing];
    if (from) {
      for (const dep of Object.keys(entry.requires ?? {})) {
        const target = scopes.find((s) => s && typeof s === 'object' && s[dep]);
        const to = target ? g.addNode(dep, target[dep]?.version) : null;
        if (to) g.addEdge(from, to);
      }
    }
    addPackageLockV1Edges(g, entry.dependencies, [scope, ...enclosing]);
  }
}

/**
 * The full dependency graph from a package-lock.json: every `node_modules` install in the v2/v3
 * `packages` map (any depth), or the nested v1 `dependencies` tree. Workspace members, links and the
 * root project are not registry packages and are left out.
 */
export function parsePackageLockGraph(json: unknown): LockGraph {
  const g = new GraphBuilder();
  if (!json || typeof json !== 'object') return g.build();
  const lock = json as { packages?: Record<string, PackageLockEntry | null>; dependencies?: Record<string, PackageLockV1Entry | null> };

  if (lock.packages && typeof lock.packages === 'object') {
    const keyByPath = new Map<string, string>();
    for (const [p, entry] of Object.entries(lock.packages)) {
      if (!entry || typeof entry !== 'object' || entry.link) continue;
      const at = p.lastIndexOf('node_modules/');
      if (at < 0) continue; // the root ('') or a workspace member
      // An aliased install (`node_modules/foo` → `bar`) records the real package name on the entry.
      const name = typeof entry.name === 'string' && entry.name ? entry.name : p.slice(at + 'node_modules/'.length);
      const key = g.addNode(name, entry.version);
      if (key) keyByPath.set(p, key);
    }
    for (const [p, entry] of Object.entries(lock.packages)) {
      const from = keyByPath.get(p);
      if (!from || !entry) continue;
      const deps = { ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies };
      for (const dep of Object.keys(deps)) {
        const to = resolveNodeModulesPath(keyByPath, p, dep);
        if (to) g.addEdge(from, to);
      }
    }
    return g.build();
  }

  addPackageLockV1Nodes(g, lock.dependencies);
  addPackageLockV1Edges(g, lock.dependencies, []);
  return g.build();
}

/**
 * Name and version from a pnpm `packages:` / `snapshots:` key. Handles v9/v6 (`name@1.2.3(peer@1)`,
 * optionally `/`-prefixed) and v5 (`/name/1.2.3_peerhash`). Null for non-registry keys.
 */
export function parsePnpmPackageKey(key: string): LockedPackage | null {
  const v5 = /^\/((?:@[^/]+\/)?[^/]+)\/(\d[^_/]*)/.exec(key);
  if (v5) return { name: v5[1], version: v5[2].split('(')[0] };
  const s = key.split('(')[0].trim().replace(/^\/+/, '');
  const at = s.lastIndexOf('@');
  if (at <= 0) return null;
  const name = s.slice(0, at);
  const version = s.slice(at + 1);
  return REGISTRY_VERSION.test(version) ? { name, version } : null;
}

/** The package a pnpm dependency value points at: a bare version, or an alias (`bar@1.2.3`, `/bar/1.2.3`). */
function pnpmDependencyTarget(dep: string, value: unknown): LockedPackage | null {
  if (typeof value !== 'string') return null;
  const bare = /^(\d[^_(]*)/.exec(value);
  if (bare) return { name: dep, version: bare[1] };
  return parsePnpmPackageKey(value);
}

/**
 * The full dependency graph from a parsed pnpm-lock.yaml. v9 keeps edges under `snapshots:` (one
 * entry per peer-dependency variant, merged here by name and version); v5/v6 keep them on `packages:`.
 */
export function parsePnpmLockGraph(doc: unknown): LockGraph {
  const g = new GraphBuilder();
  if (!doc || typeof doc !== 'object') return g.build();
  const d = doc as Record<string, unknown>;
  const isRecord = (v: unknown): v is Record<string, Record<string, unknown> | null> => !!v && typeof v === 'object';

  const sections: Array<Record<string, Record<string, unknown> | null>> = [];
  if (isRecord(d.packages)) sections.push(d.packages);
  if (isRecord(d.snapshots)) sections.push(d.snapshots);

  for (const section of sections) {
    for (const key of Object.keys(section)) {
      const pkg = parsePnpmPackageKey(key);
      if (pkg) g.addNode(pkg.name, pkg.version);
    }
  }
  for (const section of sections) {
    for (const [key, entry] of Object.entries(section)) {
      const pkg = parsePnpmPackageKey(key);
      const from = pkg ? g.addNode(pkg.name, pkg.version) : null;
      if (!from || !entry || typeof entry !== 'object') continue;
      for (const field of ['dependencies', 'optionalDependencies'] as const) {
        const deps = entry[field];
        if (!deps || typeof deps !== 'object') continue;
        for (const [dep, value] of Object.entries(deps as Record<string, unknown>)) {
          const target = pnpmDependencyTarget(dep, value);
          const to = target ? g.addNode(target.name, target.version) : null;
          if (to) g.addEdge(from, to);
        }
      }
    }
  }
  return g.build();
}

interface YarnBlock {
  specs: string[];
  version?: string;
  deps: Array<[string, string]>;
}

/**
 * The full dependency graph from a yarn.lock (classic or Berry). Each block's `dependencies` ranges are
 * resolved through the block headers; Berry's `workspace:` / `link:` entries are not registry packages.
 */
export function parseYarnLockGraph(text: string): LockGraph {
  const blocks: YarnBlock[] = [];
  let current: YarnBlock | null = null;
  let section = '';
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = {
        specs: raw.replace(/:\s*$/, '').split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean),
        deps: [],
      };
      blocks.push(current);
      section = '';
      continue;
    }
    if (!current) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent <= 2) {
      const vm = /^version:?\s+"?([^"\s]+)"?/.exec(line);
      if (vm) current.version = vm[1];
      const sm = /^(\w+):\s*$/.exec(line);
      section = sm ? sm[1] : '';
    } else if (section === 'dependencies' || section === 'optionalDependencies') {
      // Classic: `name "^1.0.0"`. Berry: `name: ^1.0.0` or `"@scope/name": "npm:^1.0.0"`.
      const dm = /^"?(@?[^"\s:]+)"?:?\s+"?(.+?)"?$/.exec(line);
      if (dm) current.deps.push([dm[1], dm[2]]);
    }
  }

  const g = new GraphBuilder();
  const keyBySpec = new Map<string, string>();
  const blockKey = new Map<YarnBlock, string>();
  for (const block of blocks) {
    if (block.specs.some((spec) => /@(workspace|link|portal|file):/.test(spec))) continue;
    for (const spec of block.specs) {
      const name = specName(spec);
      const key = name ? g.addNode(name, block.version) : null;
      if (!key) continue;
      keyBySpec.set(spec, key);
      blockKey.set(block, key);
    }
  }
  for (const block of blocks) {
    const from = blockKey.get(block);
    if (!from) continue;
    for (const [dep, range] of block.deps) {
      const to = keyBySpec.get(`${dep}@${range}`) ?? keyBySpec.get(`${dep}@npm:${range}`);
      if (to) g.addEdge(from, to);
    }
  }
  return g.build();
}
