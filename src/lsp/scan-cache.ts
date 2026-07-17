/**
 * Drift-scan result cache for `vg lsp`.
 *
 * `runCoreScan` is the expensive part of a scan (per-package registry lookups),
 * not reading the manifest/lockfile — so on every editor activation, hashing
 * just the manifest+lockfile bytes first and comparing to the last successful
 * scan's hash lets an unchanged repo skip `runCoreScan` entirely and replay the
 * cached result instantly. Only a real dependency change (any manifest or
 * lockfile byte differs) pays for a fresh scan.
 *
 * Lives under `.vibgrate/cache/` (gitignored, machine-local) alongside the
 * graph's parse cache and freshness snapshot — same convention, same directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashBytes, hashString, canonicalize } from '../engine/hash.js';
import { cacheDir } from '../engine/cache.js';
import { stableStringify } from '../engine/serialize.js';
import { SKIP_DIRS, SKIP_FILES } from '../engine/discover.js';
import { isManifest } from './manifest-positions.js';
import type { ScanArtifact } from '../core-open/index.js';

// Bumped: v1 caches carried no `toolVersion`/`offline` guard, so a scan cached
// under an older engine build (or under `--local`, before registry access was
// available) replayed forever once the manifest stopped changing — even after
// an upgrade or the network came back. Bumping discards every v1 cache on read.
const CACHE_VERSION = 'vg-lsp-scan-cache/2';

function cachePath(root: string): string {
  return path.join(cacheDir(root), 'lsp-scan.json');
}

/**
 * Hash every manifest (`package.json`, `go.mod`, …) and lockfile
 * (`package-lock.json`, `go.sum`, …) under `root`, combined into one stable
 * digest. A cheap stat+read walk — no registry calls, no dependency
 * resolution — so it is safe to run before every scan as a gate.
 */
export function manifestHash(root: string): string {
  const files: { rel: string; hash: string }[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip rather than crash the probe
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const base = entry.name.toLowerCase();
      if (!isManifest(abs) && !SKIP_FILES.has(base)) continue;
      try {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        files.push({ rel, hash: hashBytes(fs.readFileSync(abs)) });
      } catch {
        // Unreadable/raced-away file — leave it out; worst case is an extra
        // rescan next time, never a wrong cache hit.
      }
    }
  };
  walk(root);

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return hashString(canonicalize(files));
}

export interface ScanCacheEntry {
  manifestHash: string;
  artifact: ScanArtifact;
}

/**
 * A cache hit must match on more than the manifest bytes: `toolVersion` guards
 * against an engine upgrade changing what a scan produces (mirrors the parse
 * cache's `toolVersion` invalidation in `engine/cache.ts`), and `offline`
 * guards against replaying an offline scan's unresolved drift once the
 * network — or `vibgrate.offline` — changes. Both are cheap to compare and
 * cheap to get wrong, so they are required, not optional.
 */
export interface ScanCacheKey {
  manifestHash: string;
  toolVersion: string;
  offline: boolean;
}

/** Best-effort read. Returns null on a missing, corrupt, stale-version, or non-matching-key cache. */
export function loadScanCache(root: string, key: ScanCacheKey): ScanCacheEntry | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(root), 'utf8')) as {
      version?: string;
      manifestHash?: string;
      toolVersion?: string;
      offline?: boolean;
      artifact?: ScanArtifact;
    };
    if (
      raw.version === CACHE_VERSION &&
      raw.manifestHash === key.manifestHash &&
      raw.toolVersion === key.toolVersion &&
      raw.offline === key.offline &&
      raw.artifact
    ) {
      return { manifestHash: raw.manifestHash, artifact: raw.artifact };
    }
  } catch {
    /* missing/corrupt — treat as no cache */
  }
  return null;
}

/** Best-effort write (a read-only checkout etc. just means no cache next time). */
export function writeScanCache(root: string, key: ScanCacheKey, artifact: ScanArtifact): void {
  try {
    fs.mkdirSync(cacheDir(root), { recursive: true });
    fs.writeFileSync(
      cachePath(root),
      stableStringify(
        { version: CACHE_VERSION, manifestHash: key.manifestHash, toolVersion: key.toolVersion, offline: key.offline, artifact },
        0,
      ),
    );
  } catch {
    /* best-effort only */
  }
}
