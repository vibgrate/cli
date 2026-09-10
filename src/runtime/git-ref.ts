/**
 * Detect the current git ref for a repository worktree (Fusion §4.1.1).
 *
 * Used to key ActiveGraph slots and on-disk snapshots: one graph per
 * (repositoryId, gitRef), not merely per clone path.
 *
 * Results are cached per absolute root so a hot path (path resolution,
 * auto-refresh write) never re-spawns `git rev-parse` on every call. The
 * cache is keyed on the *contents* of `.git/HEAD` (a few dozen bytes, read
 * per call — as cheap as a stat and exact): a checkout rewrites HEAD, so a
 * long-lived process (`vg serve`, `vgd`, the editor) sees the new ref on its
 * next call without a restart and never writes into the old ref's slot.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export type GitRefKind = 'branch' | 'detached' | 'none';

export interface GitRefInfo {
  /** Symbolic branch name, full SHA when detached, or empty when not a git repo. */
  ref: string;
  kind: GitRefKind;
}

export type GitRunner = (args: string[], cwd: string) => { stdout: string; status: number };

/** Cache: abs(root) → ref, valid while `.git/HEAD` still reads the same. Bypassed when a custom `run` is passed (tests). */
const refCache = new Map<string, { info: GitRefInfo; head: string }>();

/**
 * Resolve the current branch name, or detached HEAD SHA.
 * Never throws — returns kind `none` when git is missing or the path is not a repo.
 * When `run` is omitted (production), the result is cached per absolute root
 * and revalidated against the contents of `.git/HEAD` on every call, so a
 * checkout is seen live. Tests that pass a custom `run` always re-invoke it.
 */
export function detectGitRef(root: string, run?: GitRunner): GitRefInfo {
  const useCache = run === undefined;
  const runner = run ?? defaultGitRun;
  const key = useCache ? path.resolve(root) : '';
  const head = useCache ? headFingerprint(key) : '';
  if (useCache) {
    const hit = refCache.get(key);
    if (hit && hit.head === head) return hit.info;
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
  if (useCache) refCache.set(key, { info, head });
  return info;
}

/** Tests / callers that want a guaranteed re-probe: drop the cached ref for one root or all. */
export function clearDetectGitRefCache(root?: string): void {
  if (root === undefined) refCache.clear();
  else refCache.delete(path.resolve(root));
}

/**
 * The bytes of the `HEAD` file governing `root` — `ref: refs/heads/main\n`,
 * or a bare SHA when detached — or `''` when no git dir is found. Walks up
 * from `root` (vg may run in a subdirectory) and follows a `.git` *file*
 * (`gitdir: …`, how linked worktrees are laid out) to the worktree's own HEAD.
 */
export function headFingerprint(root: string): string {
  let dir = path.resolve(root);
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = path.join(dir, '.git');
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = undefined;
    }
    if (st) {
      let gitDir = dotGit;
      if (st.isFile()) {
        // Linked worktree / submodule: `.git` is a pointer file.
        try {
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
          if (m) gitDir = path.resolve(dir, m[1]!);
        } catch {
          return '';
        }
      }
      try {
        return fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8');
      } catch {
        return '';
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
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
    // Called from console-less processes (the vgd daemon, background warms) —
    // without this, each git call flashes a console window on Windows.
    windowsHide: true,
  });
  return { stdout: res.stdout ?? '', status: res.status ?? 1 };
}
