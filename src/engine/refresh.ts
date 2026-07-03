import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildGraph } from './build.js';
import { probeFreshness, writeSnapshot, hasDrift, type Drift } from './freshness.js';
import { writeArtifacts, vibgrateDir } from './artifacts.js';
import { acquireLock, releaseLock } from './lock.js';
import { cacheDir } from './cache.js';
import type { ClusterMode } from './analyze.js';

/**
 * Auto-refresh: bring the code map back in sync with the working tree when the
 * freshness probe says it drifted. The rebuild is the ordinary incremental
 * `buildGraph` (warm parse cache → only changed files re-parse), replaying the
 * scope recorded at the last explicit build, guarded by a cross-process lock
 * so a serving MCP process and a foreground command never write at once.
 *
 * Two properties keep this safe to run implicitly:
 * - **No git churn**: if the rebuilt corpusHash equals the snapshot's (e.g. a
 *   drift that reverted itself), `graph.json` is left untouched — the artifact
 *   stays byte-identical.
 * - **No surprise artifacts**: `GRAPH_REPORT.md`/`graph.html` are rewritten
 *   only if they already exist; a refresh never adds files a user's explicit
 *   build chose not to produce.
 */

export interface RefreshOptions {
  /** Force single-threaded parsing (tests / constrained hosts). */
  inline?: boolean;
  /** Worker count for the parse pool. */
  jobs?: number;
}

export type RefreshOutcome =
  /** Map already matches the working tree. */
  | { status: 'fresh' }
  /** No freshness snapshot — no build ever ran here, so scope is unknown. */
  | { status: 'no-snapshot' }
  /** Another vg process is rebuilding right now; its write will land shortly. */
  | { status: 'locked' }
  /** Rebuilt. `wrote` is false when the corpus turned out unchanged. */
  | { status: 'refreshed'; drift: Drift; ms: number; reparsed: number; totalFiles: number; wrote: boolean }
  | { status: 'error'; message: string };

/** A refresh stuck longer than this is presumed crashed and its lock reclaimed. */
const REFRESH_LOCK_STALE_MS = 10 * 60 * 1000;

function refreshLockPath(root: string): string {
  return path.join(cacheDir(root), 'refresh.lock');
}

/**
 * Probe, and rebuild incrementally if the tree drifted from the map.
 * Silent (no output) — callers own the messaging for their surface.
 */
export async function refreshIfStale(root: string, opts: RefreshOptions = {}): Promise<RefreshOutcome> {
  const probe = probeFreshness(root);
  if (!probe) return { status: 'no-snapshot' };
  if (!hasDrift(probe.drift)) return { status: 'fresh' };

  const lock = refreshLockPath(root);
  if (!acquireLock(lock, REFRESH_LOCK_STALE_MS)) return { status: 'locked' };

  const start = process.hrtime.bigint();
  try {
    const { scope } = probe;
    const result = await buildGraph({
      root,
      only: scope.only,
      exclude: scope.exclude,
      paths: scope.paths,
      deep: scope.deep,
      noGround: scope.noGround,
      scip: scope.scip,
      noScip: scope.noScip,
      noTsc: scope.noTsc,
      cluster: scope.cluster as ClusterMode | undefined,
      grammarsDir: scope.grammarsDir,
      inline: opts.inline,
      jobs: opts.jobs,
    });

    const wrote = result.graph.provenance.corpusHash !== probe.corpusHash;
    if (wrote) {
      const dir = vibgrateDir(root);
      writeArtifacts(result.graph, {
        root,
        report: fs.existsSync(path.join(dir, 'GRAPH_REPORT.md')),
        html: fs.existsSync(path.join(dir, 'graph.html')),
      });
    }
    writeSnapshot(root, result.graph.provenance.corpusHash, result.fileStats, scope);

    const ms = Number((process.hrtime.bigint() - start) / 1000000n);
    return {
      status: 'refreshed',
      drift: probe.drift,
      ms,
      reparsed: result.reparsed,
      totalFiles: result.totalFiles,
      wrote,
    };
  } catch (err) {
    return { status: 'error', message: (err as Error).message };
  } finally {
    releaseLock(lock);
  }
}
