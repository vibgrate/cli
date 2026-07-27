/**
 * Detect the current git ref for a repository worktree (Fusion §4.1.1).
 *
 * Used to key ActiveGraph slots and on-disk snapshots: one graph per
 * (repositoryId, gitRef), not merely per clone path.
 *
 * Results are cached per absolute root for the process lifetime so a hot path
 * (path resolution, auto-refresh write) never re-spawns `git rev-parse` on
 * every call. The ref only changes when the user checks out another branch —
 * restart `vg serve` (or any long-lived process) after a checkout, same as
 * before this cache existed for slot identity.
 */

import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export type GitRefKind = 'branch' | 'detached' | 'none';

export interface GitRefInfo {
  /** Symbolic branch name, full SHA when detached, or empty when not a git repo. */
  ref: string;
  kind: GitRefKind;
}

export type GitRunner = (args: string[], cwd: string) => { stdout: string; status: number };

/** Process-lifetime cache: abs(root) → ref. Bypassed when a custom `run` is passed (tests). */
const refCache = new Map<string, GitRefInfo>();

/**
 * Resolve the current branch name, or detached HEAD SHA.
 * Never throws — returns kind `none` when git is missing or the path is not a repo.
 * When `run` is omitted (production), the result is cached per absolute root for
 * the process lifetime. Tests that pass a custom `run` always re-invoke it.
 */
export function detectGitRef(root: string, run?: GitRunner): GitRefInfo {
  const useCache = run === undefined;
  const runner = run ?? defaultGitRun;
  const key = useCache ? path.resolve(root) : '';
  if (useCache) {
    const hit = refCache.get(key);
    if (hit) return hit;
  }
  let info: GitRefInfo;
  try {
    const branch = runner(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    if (branch.status !== 0) {
      info = { ref: '', kind: 'none' };
    } else {
      const name = branch.stdout.trim();
      if (!name || name === 'HEAD') {
        const sha = runner(['rev-parse', 'HEAD'], root);
        if (sha.status !== 0 || !sha.stdout.trim()) {
          info = { ref: '', kind: 'none' };
        } else {
          info = { ref: sha.stdout.trim(), kind: 'detached' };
        }
      } else {
        info = { ref: name, kind: 'branch' };
      }
    }
  } catch {
    info = { ref: '', kind: 'none' };
  }
  if (useCache) refCache.set(key, info);
  return info;
}

/** Tests / rare branch-switch mid-process: drop the cached ref for one root or all. */
export function clearDetectGitRefCache(root?: string): void {
  if (root === undefined) refCache.clear();
  else refCache.delete(path.resolve(root));
}

/**
 * Filesystem-safe snapshot id for a git ref.
 * `main` → `branch-main`; `feature/x` → `branch-feature__x`; SHA → `sha-<40hex>`.
 */
export function branchGraphSnapshotId(gitRef: string): string {
  const ref = gitRef.trim();
  if (!ref) return 'current';
  if (/^[0-9a-f]{40}$/i.test(ref)) return `sha-${ref.toLowerCase()}`;
  // Branch names may contain /, spaces, etc. — collapse to a single path segment.
  const safe = ref
    .replace(/\\/g, '/')
    .replace(/\/+/g, '__')
    .replace(/[^A-Za-z0-9._@+-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return `branch-${safe || 'unnamed'}`;
}

/** Stable cache key for an ActiveGraph slot. */
export function activeGraphSlotKey(repositoryId: string, gitRef: string): string {
  return `${repositoryId}::${gitRef.trim() || 'unknown'}`;
}

function defaultGitRun(args: string[], cwd: string): { stdout: string; status: number } {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: res.stdout ?? '', status: res.status ?? 1 };
}
