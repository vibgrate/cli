import * as fs from 'node:fs';
import * as path from 'node:path';
import { discover } from './discover.js';
import { hashBytes } from './hash.js';
import { cacheDir } from './cache.js';
import { stableStringify } from './serialize.js';
import type { FileStat } from './build.js';

/**
 * Freshness tracking for the code map (VG auto-refresh).
 *
 * Every build writes a *snapshot* — the stat (size, mtime) and content hash of
 * each corpus file, plus the build scope — under `.vibgrate/cache/` (gitignored,
 * machine-local, never part of the committed artifact). A *probe* then answers
 * "did the working tree drift from the map?" with a stat-only walk: no file is
 * read unless its size/mtime moved, and a moved stat is confirmed by re-hashing
 * just that file. Touch-only changes (git checkout, `touch`, editor re-saves
 * with identical content) are *absorbed*: the snapshot's stats are updated in
 * place so they never trigger a rebuild — not now, not on the next probe.
 *
 * This is what lets `vg serve` and `vg ask` stay fresh without a filesystem
 * watcher: freshness only matters at the moment of a query, so we check on
 * read, cheaply, and rebuild incrementally only when content really changed.
 */

const SNAPSHOT_VERSION = 'vg-freshness/1';

/** The graph-affecting discovery/build scope, replayed verbatim on refresh. */
export interface BuildScope {
  only?: string[];
  exclude?: string[];
  paths?: string[];
  deep?: boolean;
  noGround?: boolean;
  scip?: string;
  noScip?: boolean;
  noTsc?: boolean;
  cluster?: string;
  grammarsDir?: string;
}

interface SnapshotFile {
  version: string;
  /** corpusHash of the build this snapshot belongs to. */
  corpusHash: string;
  scope: BuildScope;
  files: Record<string, { size: number; mtimeMs: number; hash: string }>;
}

export interface Drift {
  /** Files whose *content* changed (stat moved AND hash differs). */
  changed: string[];
  /** Files present now but absent from the snapshot. */
  added: string[];
  /** Snapshot files no longer present. */
  removed: string[];
}

export interface ProbeResult {
  drift: Drift;
  /** The recorded build scope — what a refresh must replay. */
  scope: BuildScope;
  /** corpusHash the current map was built from. */
  corpusHash: string;
}

export function snapshotPath(root: string): string {
  return path.join(cacheDir(root), 'freshness.json');
}

/** Persist the snapshot after a successful build. Best-effort (cache-only). */
export function writeSnapshot(
  root: string,
  corpusHash: string,
  fileStats: FileStat[],
  scope: BuildScope = {},
): void {
  const files: SnapshotFile['files'] = {};
  for (const f of fileStats) files[f.rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: f.hash };
  const snapshot: SnapshotFile = { version: SNAPSHOT_VERSION, corpusHash, scope: pruneScope(scope), files };
  try {
    fs.mkdirSync(cacheDir(root), { recursive: true });
    fs.writeFileSync(snapshotPath(root), stableStringify(snapshot, 0));
  } catch {
    /* read-only checkout etc. — freshness just stays unavailable */
  }
}

export function loadSnapshot(root: string): SnapshotFile | null {
  try {
    const loaded = JSON.parse(fs.readFileSync(snapshotPath(root), 'utf8')) as SnapshotFile;
    if (loaded.version === SNAPSHOT_VERSION && loaded.files && typeof loaded.corpusHash === 'string') {
      return { ...loaded, scope: loaded.scope ?? {} };
    }
  } catch {
    /* missing/corrupt → no snapshot */
  }
  return null;
}

export function hasDrift(drift: Drift): boolean {
  return drift.changed.length + drift.added.length + drift.removed.length > 0;
}

/** Total drifted files — the number shown to humans. */
export function driftCount(drift: Drift): number {
  return drift.changed.length + drift.added.length + drift.removed.length;
}

/**
 * Compare the working tree to the snapshot. Returns null when no snapshot
 * exists (nothing was ever built on this machine — auto-refresh stays off
 * rather than guessing the build scope). Stat-only except for files whose
 * stat moved; touch-only moves are absorbed back into the snapshot.
 */
export function probeFreshness(root: string): ProbeResult | null {
  const snapshot = loadSnapshot(root);
  if (!snapshot) return null;

  const { scope } = snapshot;
  let discovered;
  try {
    discovered = discover({ root, only: scope.only, exclude: scope.exclude, paths: scope.paths });
  } catch {
    return null; // root vanished / unreadable — treat as unknown, not stale
  }

  const drift: Drift = { changed: [], added: [], removed: [] };
  const seen = new Set<string>();
  let absorbed = false;

  for (const file of discovered) {
    seen.add(file.rel);
    const entry = snapshot.files[file.rel];
    if (!entry) {
      drift.added.push(file.rel);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file.abs);
    } catch {
      drift.removed.push(file.rel); // raced away between walk and stat
      continue;
    }
    if (stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) continue;
    // Stat moved — confirm with content before declaring drift.
    let hash = '';
    try {
      hash = hashBytes(fs.readFileSync(file.abs));
    } catch {
      drift.removed.push(file.rel);
      continue;
    }
    if (hash === entry.hash) {
      // Touch-only (checkout/`touch`/identical re-save): absorb the new stat
      // so this file never re-triggers a probe, without any rebuild.
      snapshot.files[file.rel] = { size: stat.size, mtimeMs: stat.mtimeMs, hash };
      absorbed = true;
    } else {
      drift.changed.push(file.rel);
    }
  }

  for (const rel of Object.keys(snapshot.files)) {
    if (!seen.has(rel)) drift.removed.push(rel);
  }

  // Persist absorptions only when the tree is otherwise clean — a real drift
  // triggers a rebuild that rewrites the snapshot wholesale anyway.
  if (absorbed && !hasDrift(drift)) {
    try {
      fs.writeFileSync(snapshotPath(root), stableStringify(snapshot, 0));
    } catch {
      /* best-effort */
    }
  }

  drift.changed.sort();
  drift.added.sort();
  drift.removed.sort();
  return { drift, scope, corpusHash: snapshot.corpusHash };
}

/** Drop empty/undefined scope fields so the snapshot stays minimal and stable. */
function pruneScope(scope: BuildScope): BuildScope {
  const out: BuildScope = {};
  if (scope.only?.length) out.only = [...scope.only].sort();
  if (scope.exclude?.length) out.exclude = [...scope.exclude];
  if (scope.paths?.length) out.paths = [...scope.paths];
  if (scope.deep) out.deep = true;
  if (scope.noGround) out.noGround = true;
  if (scope.scip) out.scip = scope.scip;
  if (scope.noScip) out.noScip = true;
  if (scope.noTsc) out.noTsc = true;
  if (scope.cluster) out.cluster = scope.cluster;
  if (scope.grammarsDir) out.grammarsDir = scope.grammarsDir;
  return out;
}
