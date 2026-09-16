import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DepRecord } from './drift.js';

/**
 * Lockfile-pinned version resolution (VG-LIB-SUPERSET-PLAN A.2 / D13).
 *
 * The version we serve docs for should be the one your **lockfile** pins, not
 * whatever happens to be unpacked in `node_modules` (which is empty in CI / a
 * fresh clone). This reads the pin deterministically and offline. Where a lockfile
 * isn't present or parseable we return `undefined` and the caller falls back to the
 * installed tree, then the declared range — we never fabricate a version.
 *
 * npm covers `package-lock.json` (v1/v2/v3), `pnpm-lock.yaml` (v6/v9) and
 * `yarn.lock`. Other ecosystems follow the same shape and return `undefined`
 * until their parser lands — honest degradation, no false mismatch.
 */
export function lockfileVersion(root: string, ecosystem: DepRecord['ecosystem'], name: string): string | undefined {
  if (ecosystem === 'npm') return packageLockVersion(root, name) ?? pnpmLockVersion(root, name) ?? yarnLockVersion(root, name);
  if (ecosystem === 'pypi') return pypiLockVersion(root, name);
  if (ecosystem === 'rust') return tomlPackageLock(root, 'Cargo.lock', name, rustName);
  if (ecosystem === 'ruby') return gemfileLock(root, name);
  if (ecosystem === 'php') return composerLock(root, name);
  if (ecosystem === 'dotnet') return packagesLock(root, name);
  if (ecosystem === 'swift') return packageResolved(root, name);
  if (ecosystem === 'dart') return pubspecLock(root, name);
  if (ecosystem === 'java') return gradleLock(root, name);
  return undefined;
}

/** Gradle `gradle.lockfile` — lines `group:artifact:version=configurations…`. */
function gradleLock(root: string, name: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'gradle.lockfile'), 'utf8');
  } catch {
    return undefined;
  }
  const m = new RegExp(`^${escapeRegExp(name)}:([^=\\s]+)=`, 'm').exec(text);
  return m ? m[1] : undefined;
}

/** Swift `Package.resolved` — JSON pins (v2/v3 `pins[]`, v1 `object.pins[]`); match `identity`. */
function packageResolved(root: string, name: string): string | undefined {
  let data: {
    pins?: Array<{ identity?: string; package?: string; state?: { version?: string } }>;
    object?: { pins?: Array<{ identity?: string; package?: string; state?: { version?: string } }> };
  };
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, 'Package.resolved'), 'utf8'));
  } catch {
    return undefined;
  }
  const pins = data.pins ?? data.object?.pins;
  if (!Array.isArray(pins)) return undefined;
  const target = name.toLowerCase();
  for (const p of pins) {
    const id = (p.identity ?? p.package ?? '').toLowerCase();
    if (id === target && p.state?.version) return p.state.version;
  }
  return undefined;
}

/** Dart `pubspec.lock` — YAML; each `  <name>:` block carries `version: "x.y.z"`. */
function pubspecLock(root: string, name: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'pubspec.lock'), 'utf8');
  } catch {
    return undefined;
  }
  let inPkg = false;
  for (const line of text.split('\n')) {
    const key = /^  ([A-Za-z0-9_.]+):\s*$/.exec(line);
    if (key) {
      inPkg = key[1] === name;
      continue;
    }
    if (inPkg) {
      const vm = /^\s+version:\s*"?([^"\s]+)"?/.exec(line);
      if (vm) return vm[1];
    }
  }
  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ruby `Gemfile.lock` — the `specs:` block lists `    name (1.2.3)` (4-space indent). */
function gemfileLock(root: string, name: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'Gemfile.lock'), 'utf8');
  } catch {
    return undefined;
  }
  // Spec definitions are 4-space-indented with a concrete (digit-leading) version;
  // nested dep constraints (6-space) and the DEPENDENCIES list (2-space) don't match.
  const m = new RegExp(`^    ${escapeRegExp(name)} \\((\\d[^)]*)\\)`, 'm').exec(text);
  return m ? m[1] : undefined;
}

/** PHP `composer.lock` — JSON `packages` / `packages-dev` arrays of `{ name, version }`. */
function composerLock(root: string, name: string): string | undefined {
  let data: Record<string, Array<{ name?: string; version?: string }>>;
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, 'composer.lock'), 'utf8'));
  } catch {
    return undefined;
  }
  for (const section of ['packages', 'packages-dev']) {
    const arr = data[section];
    if (!Array.isArray(arr)) continue;
    const p = arr.find((x) => x && x.name === name);
    if (p && typeof p.version === 'string') return p.version.replace(/^v/, '');
  }
  return undefined;
}

/** .NET `packages.lock.json` — `dependencies.<framework>.<id>.resolved` (ids case-insensitive). */
function packagesLock(root: string, name: string): string | undefined {
  let data: { dependencies?: Record<string, Record<string, { resolved?: string }>> };
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, 'packages.lock.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const target = name.toLowerCase();
  for (const fw of Object.values(data.dependencies ?? {})) {
    if (!fw || typeof fw !== 'object') continue;
    for (const [id, v] of Object.entries(fw)) {
      if (id.toLowerCase() === target && v && typeof v.resolved === 'string') return v.resolved;
    }
  }
  return undefined;
}

/** PEP 503 name normalisation — names are case-insensitive and -/_/. are equivalent. */
function pep503(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/** Crate names: case-insensitive on crates.io; published name used verbatim otherwise. */
function rustName(name: string): string {
  return name.trim().toLowerCase();
}

/** Python: `poetry.lock` / `uv.lock` (TOML `[[package]]`), then `Pipfile.lock` (JSON). */
function pypiLockVersion(root: string, name: string): string | undefined {
  return (
    tomlPackageLock(root, 'poetry.lock', name, pep503) ??
    tomlPackageLock(root, 'uv.lock', name, pep503) ??
    pipfileLock(root, name)
  );
}

/**
 * Parse a TOML lockfile of `[[package]]` tables (poetry, uv, and Cargo.lock share this shape) for
 * the pinned version, without a TOML dependency: split on the array-of-tables
 * header and match `name`/`version` string keys within a block.
 */
function tomlPackageLock(root: string, file: string, name: string, normalize: (s: string) => string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    return undefined;
  }
  const target = normalize(name);
  for (const block of text.split(/\[\[package\]\]/)) {
    const nm = /(?:^|\n)\s*name\s*=\s*"([^"]+)"/.exec(block);
    if (nm && normalize(nm[1]) === target) {
      const ver = /(?:^|\n)\s*version\s*=\s*"([^"]+)"/.exec(block);
      if (ver) return ver[1];
    }
  }
  return undefined;
}

/** Pipenv `Pipfile.lock` — JSON; versions look like `"==1.2.3"`. */
function pipfileLock(root: string, name: string): string | undefined {
  let data: Record<string, Record<string, { version?: string }>>;
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, 'Pipfile.lock'), 'utf8'));
  } catch {
    return undefined;
  }
  const target = pep503(name);
  for (const section of ['default', 'develop']) {
    const deps = data[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [k, v] of Object.entries(deps)) {
      if (pep503(k) === target && v && typeof v.version === 'string') {
        return v.version.replace(/^==/, '');
      }
    }
  }
  return undefined;
}

export interface LockfileComponent {
  package: string;
  version: string;
}

/**
 * The full resolved dependency graph a lockfile encodes: every package
 * (`components`), which `name@version` key each of them actually resolves
 * its own dependencies to (`edges`), and which `name@version` keys the
 * project itself depends on directly (`rootDependsOn`).
 *
 * `edges` is `undefined` when the format doesn't give us real resolved
 * edges to work with (currently: pnpm and yarn, and npm's older v1 lockfile
 * shape) — the component list is still complete, we just can't say which
 * transitive package pulled in which. Never fabricate an edge: a consumer
 * building a dependency graph or purl-based match needs `undefined` to mean
 * "not tracked", not "no dependencies".
 */
export interface LockfileGraph {
  components: LockfileComponent[];
  edges: Map<string, string[]> | undefined;
  rootDependsOn: string[];
  /** Which registry these components resolve against; `undefined` means the npm family (the historical default, still keyed by `npmLockGraph`/`pnpmLockTree`/`yarnLockTree`). */
  ecosystem?: DepRecord['ecosystem'];
}

/**
 * Enumerate every package a JS lockfile actually resolves — the full
 * transitive tree, not just the names declared in package.json.
 *
 * `lockfileVersion` above answers a narrower question ("what version does
 * *this* declared dependency resolve to") and stays a point lookup by
 * design. An SBOM needs the opposite shape: the whole installed graph, since
 * that is what a vulnerability scanner or supply-chain review actually
 * walks. Tries npm, then pnpm, then yarn; returns `undefined` when none is
 * present or parseable — honest degradation, same as `lockfileVersion`.
 */
export function fullDependencyTree(root: string): LockfileComponent[] | undefined {
  return fullDependencyGraph(root)?.components;
}

/** Same lockfile search as `fullDependencyTree`, but keeps resolved dependency edges where available. */
export function fullDependencyGraph(root: string): LockfileGraph | undefined {
  return (
    npmLockGraph(root) ??
    componentsOnly(pnpmLockTree(root)) ??
    componentsOnly(yarnLockTree(root)) ??
    componentsOnly(cargoLockTree(root), 'rust') ??
    componentsOnly(goSumTree(root), 'go') ??
    componentsOnly(poetryLikeLockTree(root, 'poetry.lock'), 'pypi') ??
    componentsOnly(poetryLikeLockTree(root, 'uv.lock'), 'pypi')
  );
}

function componentsOnly(components: LockfileComponent[] | undefined, ecosystem?: DepRecord['ecosystem']): LockfileGraph | undefined {
  return components ? { components, edges: undefined, rootDependsOn: [], ecosystem } : undefined;
}

function sortComponents(map: Map<string, LockfileComponent>): LockfileComponent[] {
  return [...map.values()].sort((a, b) => a.package.localeCompare(b.package) || a.version.localeCompare(b.version));
}

function uniqSorted(keys: string[]): string[] {
  return [...new Set(keys)].sort();
}

interface NpmV2Package {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * npm `package-lock.json` v2/v3 `packages` map, falling back to v1's nested
 * `dependencies` tree (which carries no resolvable edges — see
 * `LockfileGraph.edges`).
 *
 * v2/v3 stores every resolved package once, keyed by its install path
 * (`node_modules/a/node_modules/b`), plus each package's own *declared*
 * dependency ranges. To turn that into resolved edges we replay npm's own
 * lookup: walk from a package's install path up through each ancestor's
 * `node_modules/<name>`, same as Node's `require` resolution, and take the
 * first match — that is what "hoisting" means, and it's exactly what
 * `packages` encodes without needing a second (real) install.
 */
function npmLockGraph(root: string): LockfileGraph | undefined {
  let data: {
    packages?: Record<string, NpmV2Package>;
    dependencies?: Record<string, { version?: string; dependencies?: Record<string, unknown> }>;
  };
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  } catch {
    return undefined;
  }

  if (!data.packages || typeof data.packages !== 'object') {
    if (!data.dependencies || typeof data.dependencies !== 'object') return undefined;
    const out = new Map<string, LockfileComponent>();
    walkNpmV1Tree(data.dependencies, out);
    return componentsOnly(out.size ? sortComponents(out) : undefined);
  }

  const packages = data.packages;
  const keyOf = new Map<string, string>(); // install path → "name@version"
  const components = new Map<string, LockfileComponent>();
  for (const [p, val] of Object.entries(packages)) {
    if (!p) continue; // "" is the root project itself
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(p);
    const version = val?.version;
    if (m && typeof version === 'string') {
      // npm's aliased installs (`"foo-cjs": "npm:foo@^1.0.0"`) key the
      // package by its install-path segment ("foo-cjs") but record the real
      // registry name in `name` ("foo") — use that when present, or the SBOM
      // reports a component/purl for a package that doesn't exist on npm.
      const name = typeof val?.name === 'string' ? val.name : m[1];
      const key = `${name}@${version}`;
      keyOf.set(p, key);
      components.set(key, { package: name, version });
    }
  }
  if (!components.size) return undefined;

  const resolveInstallPath = (fromPath: string, name: string): string | undefined => {
    let base = fromPath;
    for (;;) {
      const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (packages[candidate]) return candidate;
      if (!base) return undefined;
      const cut = base.lastIndexOf('/node_modules/');
      base = cut === -1 ? '' : base.slice(0, cut);
    }
  };

  const edges = new Map<string, string[]>();
  let rootDependsOn: string[] = [];
  for (const [p, val] of Object.entries(packages)) {
    const names = Object.keys({ ...val?.dependencies, ...val?.optionalDependencies, ...val?.peerDependencies });
    if (!names.length) continue;
    const childKeys = names
      .map((name) => resolveInstallPath(p, name))
      .map((childPath) => (childPath ? keyOf.get(childPath) : undefined))
      .filter((k): k is string => Boolean(k));
    if (!childKeys.length) continue;
    if (p === '') {
      rootDependsOn = uniqSorted(childKeys);
    } else {
      const fromKey = keyOf.get(p);
      if (fromKey) edges.set(fromKey, uniqSorted(childKeys));
    }
  }

  return { components: sortComponents(components), edges, rootDependsOn };
}

function walkNpmV1Tree(
  deps: Record<string, { version?: string; dependencies?: Record<string, unknown> }>,
  out: Map<string, LockfileComponent>,
): void {
  for (const [name, val] of Object.entries(deps)) {
    if (typeof val?.version === 'string') out.set(`${name}@${val.version}`, { package: name, version: val.version });
    if (val?.dependencies && typeof val.dependencies === 'object') {
      walkNpmV1Tree(val.dependencies as Record<string, { version?: string; dependencies?: Record<string, unknown> }>, out);
    }
  }
}

/**
 * `pnpm-lock.yaml` `packages:` section — every resolved package, v9-style
 * (`name@version:` / `'@scope/name@version':`) and v6-style
 * (`/name/version:` / `/@scope/name/version:`), peer suffixes stripped.
 */
function pnpmLockTree(root: string): LockfileComponent[] | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  } catch {
    return undefined;
  }
  const section = sectionOf(text, 'packages');
  if (!section) return undefined;
  const out = new Map<string, LockfileComponent>();
  const v9 = /^ {2}'?(@[^/'\n]+\/[^@/'\n]+|[^@/'\n]+)@([^:'\n(]+)(?:\([^)]*\))?'?:\s*$/gm;
  const v6 = /^ {2}\/(@[^/'\n]+\/[^@/'\n]+|[^@/'\n]+)\/([^:'\n(]+)(?:\([^)]*\))?:\s*$/gm;
  for (const re of [v9, v6]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(section))) {
      const name = m[1];
      const version = m[2].trim();
      if (name && version) out.set(`${name}@${version}`, { package: name, version });
    }
  }
  return out.size ? sortComponents(out) : undefined;
}

/** `yarn.lock` — every block's header name(s) paired with its resolved `version`. */
function yarnLockTree(root: string): LockfileComponent[] | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'yarn.lock'), 'utf8');
  } catch {
    return undefined;
  }
  const out = new Map<string, LockfileComponent>();
  let pendingNames: string[] = [];
  for (const line of text.split('\n')) {
    if (line && !/^\s/.test(line) && !line.startsWith('#')) {
      pendingNames = line
        .replace(/:\s*$/, '')
        .split(',')
        .map((spec) => yarnHeaderRealName(spec.trim().replace(/^"|"$/g, '')))
        .filter((n): n is string => Boolean(n));
    } else if (pendingNames.length) {
      const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
      if (m) {
        for (const name of pendingNames) out.set(`${name}@${m[1]}`, { package: name, version: m[1] });
        pendingNames = [];
      }
    }
  }
  return out.size ? sortComponents(out) : undefined;
}

/**
 * Split a yarn descriptor (`name@range`) into its two halves. The separator
 * is the first `@` *after* a leading scope segment, not the last `@` in the
 * string — an aliased descriptor (`string-width-cjs@npm:string-width@^4.2.3`)
 * has a second `@` further in (inside the `npm:` payload), and taking the
 * last one would fold the `npm:` prefix into the "name" half instead of
 * separating it out.
 */
function splitYarnDescriptor(spec: string): { name: string; range: string } | undefined {
  const searchFrom = spec.startsWith('@') ? spec.indexOf('/') + 1 : 0;
  const at = spec.indexOf('@', searchFrom);
  if (at <= 0) return undefined;
  return { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

/**
 * A yarn.lock header entry's real registry name. Normally the descriptor's
 * own name, but an aliased install (`"foo-cjs@npm:foo@^1.0.0"`, classic and
 * Berry syntax alike) is yarn's own way of writing npm's
 * `"foo-cjs": "npm:foo@^1.0.0"` — the range names the real package, and
 * reporting the alias `foo-cjs` as the component would fabricate a package
 * that doesn't exist on the registry (same failure mode `npmLockGraph`'s
 * alias handling above exists to avoid).
 */
function yarnHeaderRealName(spec: string): string | undefined {
  const parsed = splitYarnDescriptor(spec);
  if (!parsed) return undefined;
  if (!parsed.range.startsWith('npm:')) return parsed.name;
  // Yarn Berry writes every plain npm dependency as `name@npm:<range>` —
  // that's not aliasing, just its normal descriptor syntax, and a semver
  // range never contains '@'. Only `npm:<realName>@<range>` (the payload
  // itself splits into a name and a range) is an actual rename.
  const target = splitYarnDescriptor(parsed.range.slice(4));
  return target ? target.name : parsed.name;
}

/**
 * `Cargo.lock` — every `[[package]]` table's `name`/`version` pair. No
 * dependency edges: a crate's `dependencies = [...]` entries can be
 * version-disambiguated ("syn 2.0.119") or bare ("memchr") when only one
 * version of that crate is present, and resolving the bare form correctly
 * needs the same edge bookkeeping `npmLockGraph` does for npm — not worth
 * duplicating for a components-only SBOM listing.
 */
function cargoLockTree(root: string): LockfileComponent[] | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
  } catch {
    return undefined;
  }
  const out = new Map<string, LockfileComponent>();
  for (const block of text.split(/\[\[package\]\]/)) {
    const nm = /(?:^|\n)\s*name\s*=\s*"([^"]+)"/.exec(block);
    const ver = /(?:^|\n)\s*version\s*=\s*"([^"]+)"/.exec(block);
    if (nm && ver) out.set(`${nm[1]}@${ver[1]}`, { package: nm[1], version: ver[1] });
  }
  return out.size ? sortComponents(out) : undefined;
}

/**
 * `go.sum` — every `<module> <version> <hash>` line pins a resolved module;
 * each module appears twice (the module zip hash and a `/go.mod` hash for
 * its manifest), so only the bare (non-`/go.mod`) line is kept. No edges:
 * go.sum records the flattened build list, not which module required which.
 */
function goSumTree(root: string): LockfileComponent[] | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'go.sum'), 'utf8');
  } catch {
    return undefined;
  }
  const out = new Map<string, LockfileComponent>();
  for (const line of text.split('\n')) {
    // Each module has two lines — `module version h1:...` (the module zip)
    // and `module version/go.mod h1:...` (just its manifest). Skip the
    // `/go.mod` one or its suffix ends up folded into the captured version.
    const m = /^(\S+)\s+(v\S+)\s+h1:/.exec(line);
    if (!m || m[2].endsWith('/go.mod')) continue;
    const [, name, version] = m;
    out.set(`${name}@${version}`, { package: name, version });
  }
  return out.size ? sortComponents(out) : undefined;
}

/**
 * `poetry.lock` / `uv.lock` — same `[[package]]` TOML shape as `Cargo.lock`
 * (see `tomlPackageLock`, which does the equivalent point lookup), collected
 * in full for the SBOM's transitive component list.
 */
function poetryLikeLockTree(root: string, file: string): LockfileComponent[] | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    return undefined;
  }
  const out = new Map<string, LockfileComponent>();
  for (const block of text.split(/\[\[package\]\]/)) {
    const nm = /(?:^|\n)\s*name\s*=\s*"([^"]+)"/.exec(block);
    const ver = /(?:^|\n)\s*version\s*=\s*"([^"]+)"/.exec(block);
    if (nm && ver) out.set(`${nm[1]}@${ver[1]}`, { package: nm[1], version: ver[1] });
  }
  return out.size ? sortComponents(out) : undefined;
}

/** npm `package-lock.json` — JSON, deterministic, no dependency. */
function packageLockVersion(root: string, name: string): string | undefined {
  let data: { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  } catch {
    return undefined;
  }
  // v2/v3: packages keyed by install path; the top-level dep is "node_modules/<name>".
  const top = data.packages?.[`node_modules/${name}`]?.version;
  if (typeof top === 'string') return top;
  // v1: flat dependencies map.
  const v1 = data.dependencies?.[name]?.version;
  return typeof v1 === 'string' ? v1 : undefined;
}

/**
 * `pnpm-lock.yaml` (v6 and v9) — the direct dependency's resolved version.
 *
 * pnpm is not a niche case: this repository is itself pnpm-only, so until this
 * existed every `resolveVersion` here reported no lockfile pin and fell through
 * to the installed tree — precisely the fallback this module exists to avoid,
 * because `node_modules` is empty in CI and on a fresh clone.
 *
 * Read from `importers`, not `packages`: the importer block records what this
 * project actually depends on, while `packages` lists the whole transitive
 * graph and can hold several versions of one name. Parsed by hand, like every
 * other reader here — a lockfile is megabytes and only one line is wanted.
 */
function pnpmLockVersion(root: string, name: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  } catch {
    return undefined;
  }
  const importers = sectionOf(text, 'importers');
  if (!importers) return undefined;
  // Entries look like:
  //     commander:
  //       specifier: ^15.0.0
  //       version: 15.0.0(peer@1.2.3)
  // The name may be quoted when scoped ('@scope/pkg':).
  const key = escapeRegExp(name);
  const re = new RegExp(`^\\s+'?${key}'?:\\s*$\\n\\s+specifier:.*$\\n\\s+version:\\s*(\\S+)\\s*$`, 'm');
  const m = re.exec(importers);
  if (!m?.[1]) return undefined;
  // Strip pnpm's peer-suffix — `15.0.0(zod@4.4.3)` is still version 15.0.0.
  const version = m[1].replace(/\(.*$/, '').trim();
  return version || undefined;
}

/** The body of a top-level YAML block, up to the next column-0 key. */
function sectionOf(text: string, key: string): string | undefined {
  const start = new RegExp(`^${key}:\\s*$`, 'm').exec(text);
  if (!start) return undefined;
  const from = start.index + start[0].length;
  const next = /^\S[^\n]*:\s*$/m.exec(text.slice(from));
  return next ? text.slice(from, from + next.index) : text.slice(from);
}

/**
 * `yarn.lock` — a custom text format. Each block opens with one or more
 * comma-separated `name@range` specifiers (possibly quoted) and ends with an
 * indented `version "x.y.z"`. We find the block whose header names our package and
 * return its version. Scoped names (`@scope/pkg@range`) are handled via lastIndexOf.
 */
function yarnLockVersion(root: string, name: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'yarn.lock'), 'utf8');
  } catch {
    return undefined;
  }
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (line && !/^\s/.test(line) && !line.startsWith('#')) {
      inBlock = headerNamesPackage(line, name);
    } else if (inBlock) {
      const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
      if (m) return m[1];
    }
  }
  return undefined;
}

function headerNamesPackage(header: string, name: string): boolean {
  return header
    .replace(/:\s*$/, '')
    .split(',')
    .some((spec) => {
      const s = spec.trim().replace(/^"|"$/g, '');
      const at = s.lastIndexOf('@');
      if (at <= 0) return false; // <=0 keeps scoped leading '@' from matching empty name
      const specName = s.slice(0, at);
      return specName === name;
    });
}
