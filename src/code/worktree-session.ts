/**
 * Isolated worktree sessions for VG Code (P3 — session power features).
 *
 * A worktree session runs the agent in its own git worktree under
 * `.vibgrate/worktrees/<id>`, so parallel agents (or one risky experiment)
 * never fight the user's working tree. The flow is: create (detached at the
 * current HEAD) → agent edits inside the worktree → diff-to-base reviewed as
 * one patch → apply to the main tree (an approval-shaped decision made by the
 * host) → remove. The worktree shares the repository's object store, so
 * checkpoint refs and the diff/apply round-trip all stay plain git.
 *
 * Pure over an injected git runner, so every path is unit-tested without a
 * repository. All functions are conservative: a failed git call returns an
 * error outcome, never a throw mid-session.
 */

import * as path from 'node:path';

/** Minimal git runner (same contract as checkpoint.ts). */
export type GitRunner = (
  args: string[],
  env?: Record<string, string>,
) => { stdout: string; exitCode: number };

/** Where worktree checkouts live, relative to the main repository root. */
export function worktreesDir(root: string): string {
  return path.join(root, '.vibgrate', 'worktrees');
}

/** True for a string shaped like a minted worktree id (`wt` + base36). */
export function looksLikeWorktreeId(v: string): boolean {
  return /^wt[a-z0-9]{4,16}$/.test(v);
}

export interface WorktreeInfo {
  id: string;
  /** Absolute path of the checkout. */
  path: string;
  /** The commit the worktree was created from (diff base). */
  base: string;
}

/**
 * Create a detached worktree at the current HEAD. Returns the info the
 * session reports on `session-start` (and stores with the chat), or an error
 * string when the repository cannot host one (no commits, bare, git absent).
 */
export function createSessionWorktree(
  git: GitRunner,
  root: string,
  id: string,
): WorktreeInfo | { error: string } {
  if (!looksLikeWorktreeId(id)) return { error: `invalid worktree id: ${id}` };
  const head = git(['rev-parse', 'HEAD']);
  if (head.exitCode !== 0 || !head.stdout.trim()) {
    return { error: 'worktree sessions need a git repository with at least one commit' };
  }
  const base = head.stdout.trim();
  const wtPath = path.join(worktreesDir(root), id);
  const add = git(['worktree', 'add', '--detach', wtPath, base]);
  if (add.exitCode !== 0) {
    return { error: `git worktree add failed: ${add.stdout.trim() || 'see git output'}` };
  }
  // Record the creation base in the worktree's own config: commits made
  // INSIDE the worktree move its HEAD, and the diff/apply delta must stay
  // anchored to where the worktree branched off — otherwise committed work
  // silently vanishes from the applied result.
  git(['-C', wtPath, 'config', 'vibgrate.worktreeBase', base]);
  return { id, path: wtPath, base };
}

/** Normalize to forward slashes for comparisons (git porcelain always uses /). */
function slashed(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Worktrees currently checked out under `.vibgrate/worktrees/` (best-effort). */
export function listSessionWorktrees(git: GitRunner, root: string): WorktreeInfo[] {
  const res = git(['worktree', 'list', '--porcelain']);
  if (res.exitCode !== 0) return [];
  const out: WorktreeInfo[] = [];
  // git prints forward-slash paths on every platform — compare normalized,
  // or Windows never matches its own worktrees.
  const prefix = slashed(worktreesDir(root)) + '/';
  let current: { path?: string; head?: string } = {};
  for (const line of `${res.stdout}\n`.split('\n')) {
    if (line.startsWith('worktree ')) current = { path: line.slice('worktree '.length).trim() };
    else if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length).trim();
    else if (!line.trim() && current.path) {
      if (slashed(current.path).startsWith(prefix)) {
        const id = path.basename(current.path);
        if (looksLikeWorktreeId(id)) {
          // The diff base is the recorded creation point, never the current
          // HEAD — commits inside the worktree must stay in the delta.
          const recorded = git(['-C', current.path, 'config', 'vibgrate.worktreeBase']);
          const base = recorded.exitCode === 0 && recorded.stdout.trim()
            ? recorded.stdout.trim()
            : (current.head ?? '');
          out.push({ id, path: current.path, base });
        }
      }
      current = {};
    }
  }
  return out;
}

export interface WorktreeDiff {
  /** Unified patch of everything the worktree changed vs its base (may be ''). */
  patch: string;
  /** Files touched, repo-relative. */
  files: string[];
}

/**
 * The worktree's full delta against a base commit, staged first so untracked
 * files are included. Staging happens in the worktree's own index — the main
 * tree's index is untouched by construction (separate worktree).
 */
export function worktreeDiffToBase(
  git: GitRunner,
  wtPath: string,
  base: string,
): WorktreeDiff | { error: string } {
  const stage = git(['-C', wtPath, 'add', '-A']);
  if (stage.exitCode !== 0) return { error: `could not stage the worktree: ${stage.stdout.trim()}` };
  const names = git(['-C', wtPath, 'diff', '--cached', '--name-only', base]);
  if (names.exitCode !== 0) return { error: `could not diff the worktree: ${names.stdout.trim()}` };
  const files = names.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!files.length) return { patch: '', files: [] };
  const diff = git(['-C', wtPath, 'diff', '--cached', '--binary', base]);
  if (diff.exitCode !== 0) return { error: `could not diff the worktree: ${diff.stdout.trim()}` };
  return { patch: diff.stdout, files };
}

export interface WorktreeApplyOutcome {
  applied: boolean;
  files: string[];
  error?: string;
}

/**
 * Apply a worktree's delta onto the main tree via `git apply --3way` (three-way
 * falls back to conflict markers instead of refusing when the main tree moved).
 * The patch travels through a file (`patchFile`) written by the caller, because
 * the runner contract has no stdin. Never commits — the user reviews the
 * applied changes like any other edit.
 */
export function applyWorktreePatch(
  git: GitRunner,
  root: string,
  patchFile: string,
  files: string[],
): WorktreeApplyOutcome {
  const res = git(['-C', root, 'apply', '--3way', '--whitespace=nowarn', patchFile]);
  if (res.exitCode !== 0) {
    return { applied: false, files, error: res.stdout.trim() || 'git apply failed' };
  }
  return { applied: true, files };
}

/** Remove a session worktree (its checkout and git's bookkeeping). */
export function removeSessionWorktree(
  git: GitRunner,
  root: string,
  id: string,
): { removed: boolean; error?: string } {
  if (!looksLikeWorktreeId(id)) return { removed: false, error: `invalid worktree id: ${id}` };
  const wtPath = path.join(worktreesDir(root), id);
  const res = git(['worktree', 'remove', '--force', wtPath]);
  if (res.exitCode !== 0) {
    return { removed: false, error: res.stdout.trim() || 'git worktree remove failed' };
  }
  return { removed: true };
}
