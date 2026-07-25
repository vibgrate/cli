/**
 * Detect the current git ref for a repository worktree (Fusion §4.1.1).
 *
 * Used to key ActiveGraph slots and on-disk snapshots: one graph per
 * (repositoryId, gitRef), not merely per clone path.
 */

import { spawnSync } from 'node:child_process';

export type GitRefKind = 'branch' | 'detached' | 'none';

export interface GitRefInfo {
  /** Symbolic branch name, full SHA when detached, or empty when not a git repo. */
  ref: string;
  kind: GitRefKind;
}

export type GitRunner = (args: string[], cwd: string) => { stdout: string; status: number };

/**
 * Resolve the current branch name, or detached HEAD SHA.
 * Never throws — returns kind `none` when git is missing or the path is not a repo.
 */
export function detectGitRef(root: string, run: GitRunner = defaultGitRun): GitRefInfo {
  try {
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    if (branch.status !== 0) return { ref: '', kind: 'none' };
    const name = branch.stdout.trim();
    if (!name || name === 'HEAD') {
      const sha = run(['rev-parse', 'HEAD'], root);
      if (sha.status !== 0 || !sha.stdout.trim()) return { ref: '', kind: 'none' };
      return { ref: sha.stdout.trim(), kind: 'detached' };
    }
    return { ref: name, kind: 'branch' };
  } catch {
    return { ref: '', kind: 'none' };
  }
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
