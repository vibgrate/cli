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
 * Clean-room: formats are read from their public, documented shapes (npm package-lock v1/v2/v3 JSON;
 * Yarn classic + Berry text; pnpm-lock v5/v6/v9 YAML) — no third-party (AGPL or otherwise) parser is
 * used or ported. The only dependency is the `yaml` package, for the genuinely-YAML pnpm lockfile.
 */
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assertLockfileText, LockfileParseError, rethrowLockfileParseError } from '../utils/lockfile-parse.js';
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
 * Build the lockfile index for a directory. Prefers the lockfile that matches the resolved package
 * manager (npm → package-lock, yarn → yarn) but falls back to whichever is present. Returns null when
 * no supported lockfile exists (the scanner then keeps using the registry-resolved version).
 */
export async function loadNpmLockIndex(dir: string, io: LockfileIo): Promise<NpmLockIndex | null> {
  const pnpmPath = path.join(dir, 'pnpm-lock.yaml');
  const yarnPath = path.join(dir, 'yarn.lock');
  const lockPath = path.join(dir, 'package-lock.json');

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
    if (map.size) return { source: 'pnpm', size: map.size, resolve: (name) => map.get(name) ?? null };
  }
  // package-lock next: structured JSON and unambiguous.
  if (await io.exists(lockPath).catch(() => false)) {
    let json: unknown;
    try {
      json = await io.readJson<unknown>(lockPath);
    } catch (err) {
      rethrowLockfileParseError(err);
      throw new LockfileParseError(lockPath, 'JSON');
    }
    const map = parsePackageLock(json, lockPath);
    if (map.size) return { source: 'package-lock', size: map.size, resolve: (name) => map.get(name) ?? null };
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
      };
    }
  }
  return null;
}
