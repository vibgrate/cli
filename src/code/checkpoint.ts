/**
 * Checkpoints for VG Code (VG-CLI-CODE §18.4).
 *
 * A checkpoint is a snapshot of the working tree taken when the user approves a
 * change, so an approved edit can be undone after the fact. Two design choices
 * matter:
 *
 *  - **Per approval, not per tool call.** A snapshot costs a tree write; taking
 *    one for every read or search makes large repositories crawl. Approvals are
 *    the points a user would actually want to return to.
 *  - **Out of the way.** Snapshots are commits under `refs/vibgrate/checkpoints/`,
 *    written with a private index file. The user's own index, staged changes,
 *    branch, and HEAD are never touched, and nothing appears in `git log`.
 *    Ignored files stay ignored — a checkpoint captures the project, not
 *    `node_modules`.
 *
 * A checkpoint id is also recorded in run provenance, so the audit record of a
 * run points at the exact tree the agent produced: an auditor can check out
 * what happened rather than take the record's word for it.
 *
 * Pure over an injected git runner, so every path is unit-tested without a
 * repository.
 */

/** Result of running a git command. */
export interface GitResult {
  stdout: string;
  exitCode: number;
}

/** Runs a git command with an optional private index file. */
export type GitRunner = (args: string[], env?: Record<string, string>) => GitResult;

export interface Checkpoint {
  /** Full ref name, e.g. `refs/vibgrate/checkpoints/s7a/2`. */
  ref: string;
  /** Commit id the ref points at. */
  commit: string;
  /** Sequence within the session, starting at 1. */
  seq: number;
  /** Repo-relative files the approved change touched. */
  files: string[];
}

export function checkpointRef(sessionId: string, seq: number): string {
  // Session ids are engine-generated (`s<base36>`); keep the ref path safe anyway.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '') || 'session';
  return `refs/vibgrate/checkpoints/${safe}/${seq}`;
}

/** True when the root is inside a git work tree. */
export function isGitRepo(git: GitRunner): boolean {
  return git(['rev-parse', '--is-inside-work-tree']).exitCode === 0;
}

/**
 * Snapshot the current working tree.
 *
 * Returns null when the repository isn't usable for snapshots (no git, or a
 * fresh repo with no objects yet) — a checkpoint is a convenience, and failing
 * to take one must never block an approved change from being applied.
 */
export function createCheckpoint(
  git: GitRunner,
  opts: { sessionId: string; seq: number; files: string[]; indexFile: string; message?: string },
): Checkpoint | null {
  if (!isGitRepo(git)) return null;
  const env = { GIT_INDEX_FILE: opts.indexFile };

  // Stage everything into a *private* index: the user's staged work is untouched.
  if (git(['add', '-A'], env).exitCode !== 0) return null;
  const tree = git(['write-tree'], env);
  if (tree.exitCode !== 0) return null;
  const treeId = tree.stdout.trim();
  if (!treeId) return null;

  // Parent the snapshot on HEAD when there is one, so the commit is inspectable
  // with ordinary git tooling. A repo with no commits yet simply has no parent.
  const head = git(['rev-parse', 'HEAD']);
  const parent = head.exitCode === 0 && head.stdout.trim() ? ['-p', head.stdout.trim()] : [];
  const message = opts.message ?? `vg code checkpoint ${opts.seq}`;
  const commit = git(['commit-tree', treeId, ...parent, '-m', message], env);
  if (commit.exitCode !== 0) return null;
  const commitId = commit.stdout.trim();
  if (!commitId) return null;

  const ref = checkpointRef(opts.sessionId, opts.seq);
  if (git(['update-ref', ref, commitId]).exitCode !== 0) return null;
  return { ref, commit: commitId, seq: opts.seq, files: [...opts.files] };
}

/**
 * True for a commit id a host may pass to an out-of-band restore
 * (`vg code --restore-checkpoint`). Checkpoint commits are always full or
 * abbreviated hex SHAs (they come from {@link createCheckpoint}); anything else
 * — a ref name, an option-shaped string starting with `-` — is rejected so a
 * hostile or corrupted value can never reach git as something other than data.
 */
export function isValidCheckpointCommit(commit: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(commit);
}

export interface RestoreOutcome {
  restored: string[];
  /** Files that did not exist in the checkpoint and were removed. */
  removed: string[];
  failed: string[];
}

/**
 * Restore files from a checkpoint.
 *
 * Scoped deliberately: only the paths given are touched, never the whole tree.
 * A checkpoint records which files a change wrote, so restoring undoes that
 * change without reverting unrelated work the user did in the meantime — the
 * behaviour someone expects from "undo this edit", and the safe default when
 * the alternative is silently discarding their own edits.
 *
 * A file that the checkpoint does not contain was created after it, so undoing
 * means deleting it.
 */
export function restoreCheckpoint(
  git: GitRunner,
  opts: { commit: string; files: string[] },
): RestoreOutcome {
  const restored: string[] = [];
  const removed: string[] = [];
  const failed: string[] = [];

  for (const file of opts.files) {
    // Did this path exist in the snapshot?
    const probe = git(['cat-file', '-e', `${opts.commit}:${file}`]);
    if (probe.exitCode === 0) {
      const res = git(['checkout', opts.commit, '--', file]);
      if (res.exitCode === 0) restored.push(file);
      else failed.push(file);
      continue;
    }
    // Absent from the snapshot → it was created after; undo means removing it.
    const rm = git(['rm', '-f', '--ignore-unmatch', '--', file]);
    if (rm.exitCode === 0) removed.push(file);
    else failed.push(file);
  }
  return { restored, removed, failed };
}

/** Delete a session's checkpoint refs (e.g. when the session is discarded). */
export function deleteCheckpoints(git: GitRunner, sessionId: string, upTo: number): void {
  for (let seq = 1; seq <= upTo; seq++) {
    git(['update-ref', '-d', checkpointRef(sessionId, seq)]);
  }
}
