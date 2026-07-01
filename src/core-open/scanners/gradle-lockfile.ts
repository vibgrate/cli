// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Gradle dependency-lock resolution (clean-room, zero-dependency).
 *
 * Gradle's optional dependency locking writes a `gradle.lockfile` pinning the exact resolved version
 * of every dependency, one per line as `group:artifact:version=<configurations>`. This module reads
 * it into a `group:artifact` → version index the Java scanner prefers over the version declared in
 * `build.gradle` (which is often a dynamic version like `1.+` or supplied by a BOM/platform).
 *
 * Maven has no comparable standard lockfile, so this applies to Gradle projects only; a pom.xml-only
 * project simply has no `gradle.lockfile` and the loader returns null.
 *
 * Clean-room: parsed from Gradle's public, documented lockfile line format — no third-party parser or
 * AGPL library is used.
 */
import * as path from 'node:path';
import type { LockfileIo } from './npm-lockfile.js';
export type { LockfileIo } from './npm-lockfile.js';

export interface GradleLockIndex {
  /** Distinct `group:artifact` coordinates with a resolved version. */
  size: number;
  /** Installed version for a `group:artifact` coordinate. */
  resolve(coordinate: string): string | null;
}

// `group:artifact:version=conf1,conf2`. group/artifact may contain `.` and `-` but not `:` or `=`.
const LINE = /^([^:=\s]+):([^:=\s]+):([^=\s]+)=/;

/** `group:artifact` → resolved version from a gradle.lockfile. */
export function parseGradleLockfile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) return out;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('empty=')) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const coordinate = `${m[1]}:${m[2]}`;
    if (!out.has(coordinate)) out.set(coordinate, m[3]);
  }
  return out;
}

/** Build a gradle.lockfile index for a directory, or null when none is present/usable. */
export async function loadGradleLockIndex(dir: string, io: LockfileIo): Promise<GradleLockIndex | null> {
  const lockPath = path.join(dir, 'gradle.lockfile');
  if (!(await io.exists(lockPath).catch(() => false))) return null;
  try {
    const map = parseGradleLockfile(await io.readText(lockPath));
    if (!map.size) return null;
    return { size: map.size, resolve: (coordinate) => map.get(coordinate) ?? null };
  } catch {
    return null;
  }
}
