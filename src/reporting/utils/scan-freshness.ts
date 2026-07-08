import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Is a prior `vg` scan artifact still up to date with the working tree?
 *
 * `vg fix` reads dependency drift from `.vibgrate/scan_result.json`. If the user
 * edited a dependency manifest — or a lockfile moved because they ran an install
 * or a previous `vg fix` — since that scan, the artifact describes a repository
 * that no longer exists, and the upgrade plan would be built against stale
 * versions (GUARDRAILS §1.4 — output integrity). So before planning, we check
 * whether any dependency manifest or lockfile is *newer* than the artifact and,
 * if so, re-scan.
 *
 * The signal is deliberately scoped to dependency manifests + lockfiles (not the
 * whole source tree): those are the only inputs that change what `vg fix`
 * analyses, and keying on them makes the check cheap and, crucially, loop-free —
 * a re-scan rewrites the artifact, bumping its mtime past every manifest, so the
 * next `vg fix` sees a fresh scan rather than re-scanning forever.
 *
 * Fail-open everywhere: a stat/read error reports "fresh". Freshness is an
 * optimisation, not a gate — a transient filesystem hiccup must never wedge
 * `vg fix` into a spurious re-scan (or a crash).
 */

/** Dependency manifests + lockfiles whose modification invalidates a prior scan. */
const WATCHED_FILES = new Set([
  // npm
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  // pypi
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
  'Pipfile',
  'Pipfile.lock',
  'uv.lock',
  // go
  'go.mod',
  'go.sum',
  // rust
  'Cargo.toml',
  'Cargo.lock',
  // ruby
  'Gemfile',
  'Gemfile.lock',
  // php
  'composer.json',
  'composer.lock',
  // swift
  'Package.swift',
  'Package.resolved',
  // dart
  'pubspec.yaml',
  'pubspec.lock',
  // java
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'gradle.lockfile',
  // dotnet
  'packages.lock.json',
]);

/** .NET project files carry their dependency versions inline (`<PackageReference>`). */
const WATCHED_EXT = /\.(cs|fs)proj$/i;

/**
 * Directories never worth descending into when hunting for manifests. Mirrors
 * `engine/drift.ts` `findManifests` so both agree on what counts as project
 * source rather than a build/vendor/dependency directory.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.vibgrate',
  'vendor',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'target',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
]);

export interface StalenessResult {
  /** True when a manifest/lockfile is newer than the scan artifact. */
  stale: boolean;
  /**
   * The repo-relative path of the newest changed manifest, for an actionable
   * "re-scanning because X changed" message. Undefined when not stale.
   */
  newestChanged?: string;
}

/**
 * Decide whether `artifactPath` is out of date with the dependency manifests and
 * lockfiles under `rootDir`. See the module comment for the rationale and the
 * fail-open contract.
 */
export function scanStaleness(rootDir: string, artifactPath: string): StalenessResult {
  let ref: number;
  try {
    ref = fs.statSync(artifactPath).mtimeMs;
  } catch {
    // No artifact to compare against — the caller handles "missing" on its own.
    return { stale: false };
  }

  let newest = -Infinity;
  let newestChanged: string | undefined;

  // Bounded walk (depth + entry cap), matching engine/drift.ts findManifests, so
  // a pathological tree can never make freshness the slow part of `vg fix`.
  const MAX_ENTRIES = 20000;
  let scanned = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || scanned > MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      scanned++;
      if (scanned > MAX_ENTRIES) break;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      if (!WATCHED_FILES.has(e.name) && !WATCHED_EXT.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(abs).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs > newest) {
        newest = mtimeMs;
        newestChanged = path.relative(rootDir, abs) || e.name;
      }
    }
  };
  walk(rootDir, 0);

  return newest > ref ? { stale: true, newestChanged } : { stale: false };
}

/** Convenience predicate over {@link scanStaleness}. */
export function isScanStale(rootDir: string, artifactPath: string): boolean {
  return scanStaleness(rootDir, artifactPath).stale;
}
