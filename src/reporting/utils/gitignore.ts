/**
 * Keep credential files out of version control automatically.
 *
 * `login` stores a DSN (a credential) and `dsn create --write` writes one to a
 * file. GUARDRAILS §1.1 ("secrets are git-ignored and never committed") makes
 * keeping those files out of git a hard requirement — so rather than relying on
 * the user to remember, the CLI adds the file to the project `.gitignore` for
 * them. This module locates the git work tree and appends the entry idempotently,
 * creating `.gitignore` when the repo doesn't have one yet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Walk up from `startDir` to the git work-tree root — the nearest ancestor that
 * contains a `.git` entry (a directory for a normal clone, a file for a worktree
 * or submodule). Returns `null` when there is no git repo above `startDir`.
 */
export function findGitRoot(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  // Walk up until we hit a `.git`, or run out of parents.
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export type GitignoreStatus = 'added' | 'created' | 'present' | 'not-a-repo';

export interface GitignoreResult {
  /**
   * - `created`  — `.gitignore` did not exist and was created with the entry.
   * - `added`    — the entry was appended to an existing `.gitignore`.
   * - `present`  — the entry was already there; nothing was written.
   * - `not-a-repo` — `startDir` is not inside a git work tree; nothing was done.
   */
  status: GitignoreStatus;
  entry: string;
  /** The `.gitignore` that was (or would have been) touched; absent when not a repo. */
  gitignorePath?: string;
}

/** Normalize a `.gitignore` line for comparison: trim, drop `./` and trailing `/`. */
function normalizeEntry(line: string): string {
  return line.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Ensure `entry` is listed in the git repo's root `.gitignore`.
 *
 * Defense-in-depth for credential files (see module docstring). The behaviour is:
 *  - Not inside a git work tree → `not-a-repo`, no filesystem change. Git isn't
 *    tracking anything here, so there is nothing to protect against.
 *  - `.gitignore` missing → it is created containing the entry (`created`).
 *  - Entry already present (exact match, ignoring `./` and trailing `/`) →
 *    `present`, no write. The operation is idempotent — running `login` twice
 *    never duplicates the line.
 *  - Otherwise the entry is appended (`added`), preserving existing content and
 *    fixing a missing trailing newline first.
 */
export function ensureGitignored(
  entry: string,
  startDir: string = process.cwd(),
): GitignoreResult {
  const root = findGitRoot(startDir);
  if (!root) return { status: 'not-a-repo', entry };

  const gitignorePath = path.join(root, '.gitignore');
  const target = normalizeEntry(entry);

  let existing = '';
  let fileExisted = true;
  try {
    existing = fs.readFileSync(gitignorePath, 'utf8');
  } catch {
    fileExisted = false;
  }

  const alreadyPresent = existing
    .split(/\r?\n/)
    .some((line) => normalizeEntry(line) === target);
  if (alreadyPresent) return { status: 'present', entry, gitignorePath };

  // Keep the file tidy: ensure the prior content ends with a newline before we
  // append, so we never glue our entry onto an existing last line.
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
  fs.appendFileSync(gitignorePath, `${needsLeadingNewline ? '\n' : ''}${entry}\n`, 'utf8');

  return { status: fileExisted ? 'added' : 'created', entry, gitignorePath };
}
