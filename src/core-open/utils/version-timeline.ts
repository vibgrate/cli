// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as semver from 'semver';
import { XMLParser } from 'fast-xml-parser';
import {
  type GitCommitRef,
  DEFAULT_MAX_COMMITS,
  fileAtCommit,
  fileCommits,
  resolveHead,
  resolveToplevel,
} from './git-history.js';
import { parseGradleLockfile } from '../scanners/gradle-lockfile.js';
import type { VulnEcosystem } from '../types.js';

/**
 * Per-package version history derived from a lockfile's git history, across every
 * package ecosystem Vibgrate can resolve advisories for.
 *
 * By replaying the resolved-version lockfile across the commits that changed it,
 * we learn the commit (author + date) at which each package first appeared and at
 * which each version bump happened. Attribution then intersects these timelines
 * with advisory ranges to answer "who introduced this vulnerable version, and how
 * long were we exposed" — for npm/pnpm/yarn, pip/poetry/pipenv, cargo, composer,
 * bundler, go, pub, hex, NuGet, and Maven/Gradle alike.
 *
 * Maven/Java has no single universally-committed resolved lockfile, so coverage is
 * a best-effort subset: Gradle's fully-resolved `gradle.lockfile` when present,
 * else a `pom.xml`'s direct dependencies that pin a concrete version. Dependencies
 * whose version is managed by a BOM/`<dependencyManagement>` resolve to no version
 * here and are honestly absent rather than fabricated.
 */

/** Bumps the cache key when the on-disk cache shape changes. */
const CACHE_SCHEMA = 3;
const CACHE_FILENAME = 'version-timeline.json';

/** A single point at which a package's resolved version changed. */
export interface VersionChange {
  /** Resolved version at this commit. */
  version: string;
  /** The commit that introduced this version. */
  commit: GitCommitRef;
}

/** A point in a package's presence history: a resolved version, or its removal. */
export interface PresenceEvent {
  /** Resolved version at this commit, or `null` when the package was removed from the lockfile here. */
  version: string | null;
  /** The commit that made the change. */
  commit: GitCommitRef;
}

/** Chronological version history for one package. */
export interface PackageTimeline {
  ecosystem: VulnEcosystem;
  name: string;
  /** Oldest → newest; consecutive identical versions are collapsed. Present states only. */
  changes: VersionChange[];
  /**
   * Full presence history, oldest → newest: every version transition plus the
   * commits where the package was removed from the lockfile (`version: null`). A
   * superset of `changes` (which omits removals). Lets remediation analysis see a
   * vulnerable version leave entirely, not just get bumped. Optional for
   * backward-compatible reads of an older cache.
   */
  presence?: PresenceEvent[];
}

/** Version history for one ecosystem's lockfile. */
export interface EcosystemTimeline {
  ecosystem: VulnEcosystem;
  /** Repository-top-relative lockfile path the timeline was built from. */
  lockfile: string;
  /** Packages, sorted by name. */
  packages: PackageTimeline[];
}

/** Version timelines across every ecosystem found in the repo. */
export interface VersionTimelines {
  /** HEAD SHA when built (the cache key), or `null` if unknown. */
  head: string | null;
  ecosystems: EcosystemTimeline[];
}

interface CacheEnvelope {
  schema: number;
  timelines: VersionTimelines;
}

// ── Version selection helper ─────────────────────────────────────────────────

/**
 * When a package appears at multiple versions (dedup), keep the highest semver as
 * its primary version — deterministic, and usually the direct dependency.
 */
function considerVersion(out: Map<string, string>, name: string, version: string): void {
  if (!name || !version) return;
  const prev = out.get(name);
  if (prev === undefined) {
    out.set(name, version);
    return;
  }
  const a = semver.valid(semver.coerce(prev));
  const b = semver.valid(semver.coerce(version));
  if (a && b) {
    if (semver.gt(b, a)) out.set(name, version);
  } else if (version > prev) {
    out.set(name, version);
  }
}

// ── npm ecosystem (npm / pnpm / yarn) ────────────────────────────────────────

/**
 * Parse an npm `package-lock.json` / `npm-shrinkwrap.json` blob into a
 * `name → version` map. Handles lockfileVersion 2/3 (`packages` keyed by
 * `node_modules/<name>`) and legacy version 1 (`dependencies` tree); the
 * shallowest (hoisted) version wins, ties break on sorted key order.
 */
export function parseNpmLockfile(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return out;
  }
  if (!json || typeof json !== 'object') return out;
  const root = json as Record<string, unknown>;

  const packages = root.packages;
  if (packages && typeof packages === 'object') {
    const depthByName = new Map<string, number>();
    for (const key of Object.keys(packages as Record<string, unknown>).sort()) {
      if (!key) continue; // "" is the project root itself
      const marker = 'node_modules/';
      const idx = key.lastIndexOf(marker);
      if (idx === -1) continue;
      const name = key.slice(idx + marker.length);
      if (!name) continue;
      const entry = (packages as Record<string, unknown>)[key];
      const version = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).version : undefined;
      if (typeof version !== 'string') continue;
      const depth = key.split(marker).length - 1;
      const prev = depthByName.get(name);
      if (prev === undefined || depth < prev) {
        out.set(name, version);
        depthByName.set(name, depth);
      }
    }
    return out;
  }

  const deps = root.dependencies;
  if (deps && typeof deps === 'object') {
    walkV1Dependencies(deps as Record<string, unknown>, out);
  }
  return out;
}

/** Recursively collect names → versions from a lockfileVersion-1 `dependencies` tree. */
function walkV1Dependencies(deps: Record<string, unknown>, out: Map<string, string>): void {
  for (const name of Object.keys(deps).sort()) {
    const entry = deps[name];
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.version === 'string' && !out.has(name)) {
      out.set(name, rec.version);
    }
    if (rec.dependencies && typeof rec.dependencies === 'object') {
      walkV1Dependencies(rec.dependencies as Record<string, unknown>, out);
    }
  }
}

/** Split a pnpm `packages:` key into name + version (handles v5/v6/v9 + peer suffixes). */
function parsePnpmPackageKey(key: string): { name: string; version: string } | null {
  const k = key.replace(/^\//, '');
  let sep = -1;
  for (let i = k.startsWith('@') ? 1 : 0; i < k.length - 1; i++) {
    if (k[i] === '@' && /[0-9]/.test(k[i + 1]!)) {
      sep = i;
      break;
    }
  }
  let name: string;
  let rest: string;
  if (sep > 0) {
    name = k.slice(0, sep);
    rest = k.slice(sep + 1);
  } else {
    const slash = k.lastIndexOf('/');
    if (slash <= 0) return null;
    name = k.slice(0, slash);
    rest = k.slice(slash + 1);
  }
  const vm = rest.match(/^[0-9][^_(\s]*/);
  if (!name || !vm) return null;
  return { name, version: vm[0] };
}

/** Parse a `pnpm-lock.yaml` blob (lockfile v5/v6/v9) into a `name → version` map. */
export function parsePnpmLockfile(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let inPackages = false;
  for (const raw of content.split('\n')) {
    if (/^\S/.test(raw)) {
      inPackages = /^packages:\s*$/.test(raw);
      continue;
    }
    if (!inPackages) continue;
    const m = raw.match(/^ {2}(\S.*?):\s*$/);
    if (!m) continue;
    let key = m[1].trim();
    if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) {
      key = key.slice(1, -1);
    }
    const parsed = parsePnpmPackageKey(key);
    if (parsed) considerVersion(out, parsed.name, parsed.version);
  }
  return out;
}

/** Extract the package name from a yarn header specifier (first one if comma-listed). */
function yarnHeaderName(header: string): string | null {
  const first = header.split(',')[0].trim().replace(/^"/, '').replace(/"$/, '');
  const at = first.indexOf('@', first.startsWith('@') ? 1 : 0);
  if (at <= 0) return null;
  return first.slice(0, at);
}

/** Parse a `yarn.lock` blob (classic v1 and berry v2+) into a `name → version` map. */
export function parseYarnLockfile(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let currentName: string | null = null;
  for (const raw of content.split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (/^\S/.test(raw) || raw.startsWith('"')) {
      currentName = yarnHeaderName(raw.replace(/:\s*$/, ''));
      continue;
    }
    const vm = raw.match(/^\s+version:?\s+"?([^"\s]+)"?/);
    if (vm && currentName) considerVersion(out, currentName, vm[1]!);
  }
  return out;
}

// ── Other ecosystems ─────────────────────────────────────────────────────────

/** Parse a TOML lockfile with `[[package]]` tables (Cargo.lock, poetry.lock). */
export function parseTomlPackages(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of content.split(/\[\[package\]\]/)) {
    const nameM = block.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const verM = block.match(/^\s*version\s*=\s*"([^"]+)"/m);
    if (nameM && verM) considerVersion(out, nameM[1]!, verM[1]!);
  }
  return out;
}

/** Parse a PHP `composer.lock` (JSON: `packages` + `packages-dev`). */
export function parseComposerLock(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return out;
  }
  const root = json as Record<string, unknown>;
  for (const key of ['packages', 'packages-dev']) {
    const arr = root?.[key];
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      if (p && typeof p === 'object') {
        const name = (p as Record<string, unknown>).name;
        const version = (p as Record<string, unknown>).version;
        if (typeof name === 'string' && typeof version === 'string') {
          considerVersion(out, name, version.replace(/^v/, ''));
        }
      }
    }
  }
  return out;
}

/** Parse a Ruby `Gemfile.lock` (the `specs:` sections). */
export function parseGemfileLock(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let inSpecs = false;
  for (const raw of content.split('\n')) {
    if (/^\S/.test(raw)) {
      inSpecs = false;
      continue;
    }
    if (/^ {2}specs:\s*$/.test(raw)) {
      inSpecs = true;
      continue;
    }
    if (!inSpecs) continue;
    // Resolved gems are indented exactly 4 spaces: "    name (version)".
    const m = raw.match(/^ {4}(\S+) \(([^)]+)\)\s*$/);
    if (m) considerVersion(out, m[1]!, m[2]!.split('-')[0]!.trim());
  }
  return out;
}

/** Parse a Go `go.mod` (`require` directives). Module path is the package name. */
export function parseGoMod(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let inRequire = false;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (inRequire) {
      if (line === ')') {
        inRequire = false;
        continue;
      }
      const m = line.match(/^(\S+)\s+(v\S+)/);
      if (m) considerVersion(out, m[1]!, m[2]!);
      continue;
    }
    if (line === 'require (') {
      inRequire = true;
      continue;
    }
    const single = line.match(/^require\s+(\S+)\s+(v\S+)/);
    if (single) considerVersion(out, single[1]!, single[2]!);
  }
  return out;
}

/** Parse a Python `Pipfile.lock` (JSON: `default` + `develop`). */
export function parsePipfileLock(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return out;
  }
  const root = json as Record<string, unknown>;
  for (const section of ['default', 'develop']) {
    const obj = root?.[section];
    if (!obj || typeof obj !== 'object') continue;
    for (const [name, info] of Object.entries(obj as Record<string, unknown>)) {
      const v = info && typeof info === 'object' ? (info as Record<string, unknown>).version : undefined;
      if (typeof v === 'string') considerVersion(out, name, v.replace(/^==/, '').trim());
    }
  }
  return out;
}

/** Parse a Dart `pubspec.lock` (YAML `packages:` → name → version). */
export function parsePubspecLock(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let inPackages = false;
  let current: string | null = null;
  for (const raw of content.split('\n')) {
    if (/^\S/.test(raw)) {
      inPackages = /^packages:\s*$/.test(raw);
      current = null;
      continue;
    }
    if (!inPackages) continue;
    const nameM = raw.match(/^ {2}(\S+):\s*$/);
    if (nameM) {
      current = nameM[1]!;
      continue;
    }
    const verM = raw.match(/^ {4}version:\s*"?([^"\s]+)"?/);
    if (verM && current) considerVersion(out, current, verM[1]!);
  }
  return out;
}

/** Parse an Elixir `mix.lock` (`"name" => {:hex, :name, "version", ...}`). */
export function parseMixLock(content: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /"([^"]+)"\s*=>\s*\{:hex,\s*:\w+,\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) considerVersion(out, m[1]!, m[2]!);
  return out;
}

/** Parse a NuGet `packages.lock.json` (per-framework `resolved` versions). */
export function parseNugetLock(content: string): Map<string, string> {
  const out = new Map<string, string>();
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return out;
  }
  const deps = (json as Record<string, unknown>)?.dependencies;
  if (!deps || typeof deps !== 'object') return out;
  for (const framework of Object.values(deps as Record<string, unknown>)) {
    if (!framework || typeof framework !== 'object') continue;
    for (const [name, info] of Object.entries(framework as Record<string, unknown>)) {
      const v = info && typeof info === 'object' ? (info as Record<string, unknown>).resolved : undefined;
      if (typeof v === 'string') considerVersion(out, name, v);
    }
  }
  return out;
}

// ── Maven (Java) ─────────────────────────────────────────────────────────────

const POM_PARSER = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

function pomArray<T>(v: T | T[] | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

/** A concrete, pinned version — not a range (`[1,2)`, `(,1.0]`) or an unresolved `${...}`. */
function isConcreteMavenVersion(version: string): boolean {
  return Boolean(version) && !version.includes('${') && !/[[\](),]/.test(version);
}

/**
 * Parse a Maven `pom.xml` into a `groupId:artifactId → version` map for the
 * direct `<dependencies>` that pin a concrete version. `${...}` is resolved
 * against the POM's own `<properties>` (plus `${project.version}`). Dependencies
 * whose version is managed by a BOM/`<dependencyManagement>` (no explicit
 * `<version>`), a range, or an unresolved property are skipped — honestly absent,
 * since their resolved version isn't knowable from this file offline. The
 * coordinate matches OSV's Maven naming and the Java scanner's `dep.package`.
 */
export function parsePomXml(content: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!content) return out;
  let doc: { project?: Record<string, unknown> };
  try {
    doc = POM_PARSER.parse(content) as { project?: Record<string, unknown> };
  } catch {
    return out;
  }
  const project = doc?.project;
  if (!project || typeof project !== 'object') return out;

  const properties: Record<string, string> = {};
  const rawProps = project.properties;
  if (rawProps && typeof rawProps === 'object') {
    for (const [k, val] of Object.entries(rawProps as Record<string, unknown>)) {
      if (val != null && typeof val !== 'object') properties[k] = String(val);
    }
  }
  // `${project.version}` falls back to the parent's version, as Maven does.
  const ownVersion =
    project.version != null
      ? String(project.version)
      : (project.parent as Record<string, unknown> | undefined)?.version != null
        ? String((project.parent as Record<string, unknown>).version)
        : undefined;
  if (ownVersion) {
    properties['project.version'] = ownVersion;
    properties['project.parent.version'] = ownVersion;
  }
  const resolve = (value: string): string =>
    value.replace(/\$\{([^}]+)\}/g, (_, key: string) => properties[key] ?? `\${${key}}`);

  const deps = (project.dependencies as Record<string, unknown> | undefined)?.dependency;
  for (const dep of pomArray(deps)) {
    if (!dep || typeof dep !== 'object') continue;
    const d = dep as Record<string, unknown>;
    if (d.version == null) continue; // BOM/dependencyManagement-managed — not resolvable here
    const groupId = d.groupId != null ? resolve(String(d.groupId)).trim() : '';
    const artifactId = d.artifactId != null ? resolve(String(d.artifactId)).trim() : '';
    if (!groupId || !artifactId) continue;
    const version = resolve(String(d.version)).trim();
    if (!isConcreteMavenVersion(version)) continue;
    considerVersion(out, `${groupId}:${artifactId}`, version);
  }
  return out;
}

// ── Lockfile registry ────────────────────────────────────────────────────────

type LockfileParser = (content: string) => Map<string, string>;

/**
 * The lockfiles we know how to replay, per ecosystem, in preference order. For
 * an ecosystem with several formats (npm, pypi, maven), the first one with git
 * history wins.
 */
const LOCKFILE_PARSERS: Array<{ ecosystem: VulnEcosystem; basename: string; parse: LockfileParser }> = [
  { ecosystem: 'npm', basename: 'package-lock.json', parse: parseNpmLockfile },
  { ecosystem: 'npm', basename: 'npm-shrinkwrap.json', parse: parseNpmLockfile },
  { ecosystem: 'npm', basename: 'pnpm-lock.yaml', parse: parsePnpmLockfile },
  { ecosystem: 'npm', basename: 'yarn.lock', parse: parseYarnLockfile },
  { ecosystem: 'pypi', basename: 'poetry.lock', parse: parseTomlPackages },
  { ecosystem: 'pypi', basename: 'Pipfile.lock', parse: parsePipfileLock },
  { ecosystem: 'cargo', basename: 'Cargo.lock', parse: parseTomlPackages },
  { ecosystem: 'composer', basename: 'composer.lock', parse: parseComposerLock },
  { ecosystem: 'rubygems', basename: 'Gemfile.lock', parse: parseGemfileLock },
  { ecosystem: 'go', basename: 'go.mod', parse: parseGoMod },
  { ecosystem: 'pub', basename: 'pubspec.lock', parse: parsePubspecLock },
  { ecosystem: 'hex', basename: 'mix.lock', parse: parseMixLock },
  { ecosystem: 'nuget', basename: 'packages.lock.json', parse: parseNugetLock },
  // Maven/Java: prefer Gradle's fully-resolved lockfile; fall back to a pom.xml's
  // pinned direct dependencies (root file only, like every other ecosystem here).
  { ecosystem: 'maven', basename: 'gradle.lockfile', parse: parseGradleLockfile },
  { ecosystem: 'maven', basename: 'pom.xml', parse: parsePomXml },
];

/** Route a lockfile blob to the right parser by basename (npm dispatch + others). */
export function parseLockfile(lockfile: string, content: string): Map<string, string> {
  const base = path.basename(lockfile);
  const entry = LOCKFILE_PARSERS.find((p) => p.basename === base);
  return entry ? entry.parse(content) : parseNpmLockfile(content);
}

function parsersByEcosystem(): Array<{ ecosystem: VulnEcosystem; candidates: Array<{ basename: string; parse: LockfileParser }> }> {
  const order: VulnEcosystem[] = [];
  const map = new Map<VulnEcosystem, Array<{ basename: string; parse: LockfileParser }>>();
  for (const p of LOCKFILE_PARSERS) {
    if (!map.has(p.ecosystem)) {
      map.set(p.ecosystem, []);
      order.push(p.ecosystem);
    }
    map.get(p.ecosystem)!.push({ basename: p.basename, parse: p.parse });
  }
  return order.map((ecosystem) => ({ ecosystem, candidates: map.get(ecosystem)! }));
}

// ── Cache ────────────────────────────────────────────────────────────────────

async function readCache(cacheDir: string): Promise<VersionTimelines | null> {
  try {
    const raw = await fs.readFile(path.join(cacheDir, CACHE_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (parsed?.schema === CACHE_SCHEMA && parsed.timelines) return parsed.timelines;
  } catch {
    // Missing/corrupt cache → rebuild.
  }
  return null;
}

async function writeCache(cacheDir: string, timelines: VersionTimelines): Promise<void> {
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const envelope: CacheEnvelope = { schema: CACHE_SCHEMA, timelines };
    await fs.writeFile(path.join(cacheDir, CACHE_FILENAME), JSON.stringify(envelope, null, 2));
  } catch {
    // Caching is best-effort; a read-only or privacy-restricted FS just skips it.
  }
}

// ── Builder ──────────────────────────────────────────────────────────────────

/** Replay one ecosystem's lockfile across its git history into per-package timelines. */
async function buildEcosystemTimeline(
  root: string,
  ecosystem: VulnEcosystem,
  basename: string,
  parse: LockfileParser,
  maxCommits: number,
): Promise<EcosystemTimeline | null> {
  const commits = await fileCommits(root, basename, { maxCommits });
  if (!commits.length) return null;

  // `lastState` tracks each package's current resolved version, or `null` once it
  // has been removed from the lockfile, so we can record removals (a vulnerable
  // version leaving entirely) alongside version bumps.
  const lastState = new Map<string, string | null>();
  const timelines = new Map<string, VersionChange[]>();
  const presences = new Map<string, PresenceEvent[]>();
  const pushPresence = (name: string, event: PresenceEvent): void => {
    let p = presences.get(name);
    if (!p) {
      p = [];
      presences.set(name, p);
    }
    p.push(event);
  };
  for (const commit of commits) {
    const blob = await fileAtCommit(root, commit.sha, basename);
    if (blob == null) continue;
    const versions = parse(blob);
    // Removals: present last commit (non-null), absent now. Safe to mutate values
    // of an existing Map key while iterating its entries.
    for (const [name, prev] of lastState) {
      if (prev !== null && !versions.has(name)) {
        lastState.set(name, null);
        pushPresence(name, { version: null, commit });
      }
    }
    // Additions and version changes.
    for (const [name, version] of versions) {
      if (lastState.get(name) === version) continue;
      lastState.set(name, version);
      let changes = timelines.get(name);
      if (!changes) {
        changes = [];
        timelines.set(name, changes);
      }
      changes.push({ version, commit });
      pushPresence(name, { version, commit });
    }
  }
  if (timelines.size === 0) return null;

  const packages: PackageTimeline[] = [...timelines.keys()]
    .sort()
    .map((name) => ({ ecosystem, name, changes: timelines.get(name)!, presence: presences.get(name)! }));
  return { ecosystem, lockfile: basename, packages };
}

/**
 * Build version timelines for every ecosystem found in the repository containing
 * `root`. Returns `null` when git history is unavailable or no known lockfile has
 * any history. Deterministic for a fixed repo state.
 *
 * @param opts.maxCommits cap on history depth per lockfile, default {@link DEFAULT_MAX_COMMITS}
 * @param opts.cacheDir   when set, read/write a `.vibgrate/`-style cache keyed by HEAD;
 *                        omit (the default) to keep the call side-effect-free
 */
export async function buildVersionTimelines(
  root: string,
  opts: { maxCommits?: number; cacheDir?: string } = {},
): Promise<VersionTimelines | null> {
  const top = await resolveToplevel(root);
  if (!top) return null;

  const head = await resolveHead(root);
  if (opts.cacheDir && head) {
    const cached = await readCache(opts.cacheDir);
    if (cached && cached.head === head) return cached;
  }

  const maxCommits = opts.maxCommits ?? DEFAULT_MAX_COMMITS;
  const ecosystems: EcosystemTimeline[] = [];
  for (const { ecosystem, candidates } of parsersByEcosystem()) {
    for (const { basename, parse } of candidates) {
      const et = await buildEcosystemTimeline(root, ecosystem, basename, parse, maxCommits);
      if (et) {
        ecosystems.push(et);
        break; // first lockfile with history wins for this ecosystem
      }
    }
  }
  if (ecosystems.length === 0) return null;

  const timelines: VersionTimelines = { head, ecosystems };
  if (opts.cacheDir && head) await writeCache(opts.cacheDir, timelines);
  return timelines;
}

/** Find the timeline for a specific package in a specific ecosystem. */
export function findPackageTimeline(
  timelines: VersionTimelines,
  ecosystem: VulnEcosystem,
  name: string,
): PackageTimeline | undefined {
  return timelines.ecosystems.find((e) => e.ecosystem === ecosystem)?.packages.find((p) => p.name === name);
}

/** Find a package's timeline by name across all ecosystems (first match wins). */
export function findPackageAnyEcosystem(timelines: VersionTimelines, name: string): PackageTimeline | undefined {
  for (const e of timelines.ecosystems) {
    const pt = e.packages.find((p) => p.name === name);
    if (pt) return pt;
  }
  return undefined;
}
