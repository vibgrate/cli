// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Gemfile.lock resolution (clean-room, zero-dependency).
 *
 * A `Gemfile` declares version *constraints* (`gem "rails", "~> 7.1"`); the exact resolved versions
 * live in `Gemfile.lock`. Bundler writes each resolved gem under a `specs:` block as `name (version)`
 * at four-space indent, with that gem's own dependency *constraints* nested one level deeper (six
 * spaces) — those are NOT resolved versions and must be ignored. This module reads the resolved gems
 * into a name → installed-version index the Ruby scanner prefers over the declared constraint.
 *
 * Clean-room: parsed from Bundler's public, documented lockfile layout — no third-party parser or
 * AGPL library is used.
 */
import * as path from 'node:path';
import type { LockfileIo } from './npm-lockfile.js';
export type { LockfileIo } from './npm-lockfile.js';

export interface GemfileLockIndex {
  /** Distinct gems with a resolved version. */
  size: number;
  /** Installed version for a gem by name. */
  resolve(name: string): string | null;
}

// A resolved gem line: exactly four leading spaces, `name (version)`. Six-space sub-dependency lines
// (whose versions look like `= 7.1.2` / `>= 1.0`) fail the four-space anchor and the digit check.
const SPEC_LINE = /^ {4}([A-Za-z0-9._-]+) \(([^()]+)\)\s*$/;

/** name → resolved version from a Gemfile.lock, across all GEM/GIT/PATH `specs:` blocks. */
export function parseGemfileLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) return out;
  for (const raw of text.split('\n')) {
    const m = SPEC_LINE.exec(raw);
    if (!m) continue;
    const name = m[1];
    // Drop a platform suffix (`1.15.5-x86_64-linux` → `1.15.5`); a constraint (`= 7.1.2`) starts
    // with a non-digit and is rejected.
    const version = m[2].split('-')[0].trim();
    if (!/^\d/.test(version)) continue;
    if (!out.has(name)) out.set(name, version);
  }
  return out;
}

/** Build a Gemfile.lock index for a directory, or null when none is present/usable. */
export async function loadGemfileLockIndex(dir: string, io: LockfileIo): Promise<GemfileLockIndex | null> {
  const lockPath = path.join(dir, 'Gemfile.lock');
  if (!(await io.exists(lockPath).catch(() => false))) return null;
  try {
    const map = parseGemfileLock(await io.readText(lockPath));
    if (!map.size) return null;
    return { size: map.size, resolve: (name) => map.get(name) ?? null };
  } catch {
    return null;
  }
}
