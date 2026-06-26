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
 * First slice: npm (`package-lock.json` v1/v2/v3, `yarn.lock`). Other ecosystems
 * (`poetry.lock`, `go.sum`, `Cargo.lock`, …) follow the same shape and return
 * `undefined` until their parser lands — honest degradation, no false mismatch.
 */
export function lockfileVersion(root: string, ecosystem: DepRecord['ecosystem'], name: string): string | undefined {
  if (ecosystem === 'npm') return packageLockVersion(root, name) ?? yarnLockVersion(root, name);
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
