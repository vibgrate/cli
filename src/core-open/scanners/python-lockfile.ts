// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Python lockfile resolution (clean-room, zero-dependency).
 *
 * Python manifests (`requirements.txt`, `pyproject.toml`, `Pipfile`) mostly declare version *ranges*,
 * so the scanner can only resolve a version when a dependency is pinned with `==`. The exact resolved
 * environment lives in a lockfile. This module reads the common ones into a name → installed-version
 * index the Python scanner prefers over the declared spec:
 *
 *   - poetry.lock / uv.lock / pdm.lock — TOML `[[package]]` array-of-tables (`name`, `version`).
 *   - Pipfile.lock — JSON with `default` / `develop` maps of `{ "version": "==x.y.z" }`.
 *
 * Names are matched after PEP 503 normalization (lowercase; runs of `-`, `_`, `.` collapse to `-`),
 * so `Foo.Bar` in a manifest resolves against `foo-bar` in the lock.
 *
 * Clean-room: parsed from each tool's public, documented lockfile shape with a real TOML parser
 * (`smol-toml`, BSD-3-Clause) for the TOML locks and `JSON.parse` for Pipfile.lock — no AGPL library
 * is used. Only the two fields we need are read from each package entry.
 */
import * as path from 'node:path';
import { assertLockfileText, LockfileParseError, rethrowLockfileParseError } from '../utils/lockfile-parse.js';
import {
  type LockfileUnknownFields,
  type TomlLockKind,
  notePipfileLock,
  noteTomlLockDoc,
  withLockfileNotes,
} from '../utils/lockfile-unknown.js';
import { parseToml } from '../utils/toml.js';
import type { LockfileIo } from './npm-lockfile.js';
export type { LockfileIo } from './npm-lockfile.js';

export interface PythonLockIndex {
  source: 'poetry' | 'uv' | 'pdm' | 'pipfile';
  /** Distinct packages with a resolved version. */
  size: number;
  /** Installed version for a dependency by name (PEP 503 normalized). */
  resolve(name: string): string | null;
}

/** PEP 503 name normalization: lowercase, runs of `-` `_` `.` → a single `-`. */
export function normalizePyName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/** Strip a Pipfile/PEP 440 version marker down to the bare version: `==2.31.0` → `2.31.0`. */
function bareVersion(v: string): string | null {
  const s = v.trim().replace(/^[=~^><!]+\s*/, '').split(/[,;\s]/)[0];
  return /^\d/.test(s) ? s : null;
}

/**
 * name → version from a TOML lockfile of `[[package]]` tables (poetry / uv / pdm). First occurrence
 * wins. Keys are PEP 503 normalized.
 */
export function parsePyTomlLock(
  text: string,
  relPath = 'poetry.lock',
  notes?: LockfileUnknownFields,
  kind: TomlLockKind = 'poetry',
): Map<string, string> {
  return withLockfileNotes(notes, (bucket) => {
    const doc = parseToml(text);
    noteTomlLockDoc(doc, relPath, bucket, kind);
    return parsePyTomlLockBody(doc);
  });
}

function parsePyTomlLockBody(doc: Record<string, unknown> | null): Map<string, string> {
  const out = new Map<string, string>();
  const packages = doc?.package;
  if (!Array.isArray(packages)) return out;
  for (const entry of packages) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, version } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || typeof version !== 'string') continue;
    const key = normalizePyName(name);
    if (!out.has(key)) out.set(key, version);
  }
  return out;
}

/** name → version from a Pipfile.lock (JSON `default` + `develop` maps). Keys are PEP 503 normalized. */
export function parsePipfileLock(
  json: unknown,
  relPath = 'Pipfile.lock',
  notes?: LockfileUnknownFields,
): Map<string, string> {
  return withLockfileNotes(notes, (bucket) => {
    notePipfileLock(json, relPath, bucket);
    return parsePipfileLockBody(json);
  });
}

function parsePipfileLockBody(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!json || typeof json !== 'object') return out;
  const doc = json as Record<string, unknown>;
  for (const group of ['default', 'develop']) {
    const deps = doc[group];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, entry] of Object.entries(deps as Record<string, unknown>)) {
      const v = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).version : undefined;
      if (typeof v !== 'string') continue;
      const bare = bareVersion(v);
      const key = normalizePyName(name);
      if (bare && !out.has(key)) out.set(key, bare);
    }
  }
  return out;
}

const TOML_LOCKS: ReadonlyArray<['poetry' | 'uv' | 'pdm', string]> = [
  ['poetry', 'poetry.lock'],
  ['uv', 'uv.lock'],
  ['pdm', 'pdm.lock'],
];

/** Build a Python lockfile index for a directory, or null when no supported lockfile is present. */
export async function loadPythonLockIndex(dir: string, io: LockfileIo): Promise<PythonLockIndex | null> {
  for (const [source, file] of TOML_LOCKS) {
    const p = path.join(dir, file);
    if (!(await io.exists(p).catch(() => false))) continue;
    try {
      const text = await io.readText(p);
      assertLockfileText(p, text, 'TOML');
      const map = parsePyTomlLock(text, p, undefined, source);
      if (map.size) return { source, size: map.size, resolve: (n) => map.get(normalizePyName(n)) ?? null };
    } catch (err) {
      rethrowLockfileParseError(err);
      throw new LockfileParseError(p, 'TOML');
    }
  }
  const pipfile = path.join(dir, 'Pipfile.lock');
  if (await io.exists(pipfile).catch(() => false)) {
    let json: unknown;
    try {
      json = await io.readJson<unknown>(pipfile);
    } catch (err) {
      rethrowLockfileParseError(err);
      throw new LockfileParseError(pipfile, 'JSON');
    }
    const map = parsePipfileLock(json, pipfile);
    if (map.size) return { source: 'pipfile', size: map.size, resolve: (n) => map.get(normalizePyName(n)) ?? null };
  }
  return null;
}
