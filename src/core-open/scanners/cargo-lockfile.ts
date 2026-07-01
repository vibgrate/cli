// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Cargo.lock resolution (clean-room).
 *
 * `Cargo.toml` declares version *requirements* (`serde = "1.0"`), not the exact build. The resolved
 * version lives in `Cargo.lock` — a TOML file of `[[package]]` array-of-tables, each with a `name`
 * and the exact `version` Cargo selected. This module reads that file into a name → installed-version
 * index the Rust scanner prefers over coercing the declared requirement.
 *
 * Clean-room: parsed from Cargo's public, documented lockfile shape with a real TOML parser
 * (`smol-toml`, BSD-3-Clause) — no AGPL parser is used.
 */
import * as path from 'node:path';
import * as semver from 'semver';
import { parseToml } from '../utils/toml.js';
import type { LockfileIo } from './npm-lockfile.js';
export type { LockfileIo } from './npm-lockfile.js';

export interface CargoLockIndex {
  /** Distinct crates with at least one locked version. */
  size: number;
  /** Installed version for a crate by name; when several majors are locked, the best match for `spec`. */
  resolve(name: string, spec?: string): string | null;
}

/**
 * Parse a Cargo.lock into name → locked versions. A crate may appear more than once (multiple
 * incompatible majors in the tree), so versions accumulate into a list per name.
 */
export function parseCargoLock(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const doc = parseToml(text);
  const packages = doc?.package;
  if (!Array.isArray(packages)) return out;
  for (const entry of packages) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, version } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || typeof version !== 'string') continue;
    const list = out.get(name) ?? [];
    if (!list.includes(version)) list.push(version);
    out.set(name, list);
  }
  return out;
}

/** Pick the installed version for a name: the best match for the declared spec, else the highest locked. */
export function pickLockedVersion(versions: string[] | undefined, spec?: string): string | null {
  if (!versions || versions.length === 0) return null;
  const valid = versions.filter((v) => semver.valid(v));
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];
  if (spec) {
    // Cargo specs are semver-ish (`1.0`, `^1.2`, `~1`, `>=1,<2`). Try as-is, then as a caret default.
    const range = semver.validRange(spec) ?? semver.validRange(`^${spec}`);
    if (range) {
      const best = semver.maxSatisfying(valid, range);
      if (best) return best;
    }
  }
  return semver.maxSatisfying(valid, '*') ?? valid[0];
}

/** Build a Cargo.lock index for a directory, or null when no Cargo.lock is present/usable. */
export async function loadCargoLockIndex(dir: string, io: LockfileIo): Promise<CargoLockIndex | null> {
  const lockPath = path.join(dir, 'Cargo.lock');
  if (!(await io.exists(lockPath).catch(() => false))) return null;
  try {
    const map = parseCargoLock(await io.readText(lockPath));
    if (!map.size) return null;
    return { size: map.size, resolve: (name, spec) => pickLockedVersion(map.get(name), spec) };
  } catch {
    return null;
  }
}
