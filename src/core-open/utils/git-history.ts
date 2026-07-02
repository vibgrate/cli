// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { execFile } from 'node:child_process';
import * as path from 'node:path';

/**
 * Git history primitives (gated, graceful, deterministic).
 *
 * `vcs.ts` is a pure-filesystem reader: it can name the current HEAD/branch/remote
 * but cannot see *history*. Dependency attribution ("who introduced this package /
 * this vulnerable version, and when") is inherently temporal, so it needs the
 * commit graph. This module is the one place that shells out to the `git` CLI to
 * read that history.
 *
 * Rules this module follows:
 * - **Gated.** Everything degrades to "history unavailable" (empty/null) when the
 *   `git` binary is missing or the path is not inside a work tree. It never throws
 *   to the caller, so callers can treat attribution as best-effort enrichment.
 * - **Safe.** Commands run via `execFile` with an argument array — never a shell
 *   string — so branch names, paths, and refs cannot inject. Output is bounded by
 *   a byte cap and a timeout, and `git` is run with prompts/pager/optional-locks
 *   disabled so it can never hang waiting on a terminal.
 * - **Deterministic.** Author identity and dates are read from the commit objects
 *   (`%an`/`%ae`/`%aI`), never from the wall clock. Given a fixed repo state the
 *   output is byte-stable.
 *
 * Paths passed to {@link fileCommits}/{@link fileAtCommit} are interpreted
 * relative to the repository top level (resolved via `git rev-parse
 * --show-toplevel`) using POSIX separators, matching git's own pathspec handling.
 */

/** How long any single `git` invocation may run before it is killed (ms). */
const GIT_TIMEOUT_MS = 15_000;
/** Upper bound on a single `git` invocation's stdout. Lockfile blobs can be MBs. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** Default cap on how far back history is walked, to bound cost on deep repos. */
export const DEFAULT_MAX_COMMITS = 500;

/** A commit that touched a tracked path, with author attribution. */
export interface GitCommitRef {
  /** Full 40-hex commit SHA. */
  sha: string;
  /** Abbreviated SHA as git chose to print it (`%h`). */
  shortSha: string;
  /** Commit author name (`%an`). */
  authorName: string;
  /** Commit author email (`%ae`). */
  authorEmail: string;
  /** Author date in strict ISO-8601 (`%aI`) — from the commit, never wall-clock. */
  date: string;
  /** Commit subject / summary line (`%s`). */
  subject: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

/** ASCII unit separator — delimits fields within one `git log` record. */
const FIELD_SEP = '\x1f';

/**
 * Run a single `git` command. Resolves to `{ ok: false }` on any failure (binary
 * missing, non-zero exit, timeout, buffer overflow) — never rejects.
 */
function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          // Never block on credential/auth prompts, a pager, or lock contention.
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_PAGER: 'cat',
        },
      },
      (err, stdout) => {
        if (err) resolve({ ok: false, stdout: '' });
        else resolve({ ok: true, stdout: typeof stdout === 'string' ? stdout : String(stdout) });
      },
    );
  });
}

/** Cache of resolved repository top levels, keyed by the absolute query path. */
const toplevelCache = new Map<string, string | null>();

/** Normalize a path to POSIX separators for git pathspecs. */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Resolve the repository top level that contains `root`, or `null` when git is
 * unavailable or `root` is not inside a work tree. Memoized per absolute path.
 */
export async function resolveToplevel(root: string): Promise<string | null> {
  const key = path.resolve(root);
  const cached = toplevelCache.get(key);
  if (cached !== undefined) return cached;
  const res = await runGit(key, ['rev-parse', '--show-toplevel']);
  const top = res.ok ? res.stdout.trim() || null : null;
  toplevelCache.set(key, top);
  return top;
}

/**
 * Whether git history is readable for `root` — i.e. the `git` binary exists and
 * `root` is inside a work tree.
 */
export async function gitHistoryAvailable(root: string): Promise<boolean> {
  return (await resolveToplevel(root)) !== null;
}

/** Resolve the current HEAD commit SHA, or `null` (no git / unborn branch). */
export async function resolveHead(root: string): Promise<string | null> {
  const top = await resolveToplevel(root);
  if (!top) return null;
  const res = await runGit(top, ['rev-parse', 'HEAD']);
  return res.ok ? res.stdout.trim() || null : null;
}

/**
 * Commits that touched `relPath`, oldest → newest. Follows renames, so a file's
 * history survives a move. Returns `[]` when git is unavailable or the path has
 * no history.
 *
 * @param relPath repository-top-relative path (POSIX or native separators accepted)
 * @param opts.maxCommits cap on commits returned (most-recent N), default {@link DEFAULT_MAX_COMMITS}
 */
export async function fileCommits(
  root: string,
  relPath: string,
  opts: { maxCommits?: number } = {},
): Promise<GitCommitRef[]> {
  const top = await resolveToplevel(root);
  if (!top) return [];
  const max = Math.max(1, opts.maxCommits ?? DEFAULT_MAX_COMMITS);
  // %x1f between fields; one commit per line (subject is single-line, names have no newlines).
  const format = ['%H', '%h', '%an', '%ae', '%aI', '%s'].join('%x1f');
  // Walk newest-first so `--max-count` keeps the most-recent N, then reverse to
  // chronological order in JS. We deliberately do *not* pass git's `--reverse`:
  // combined with `--follow` it drops pre-rename history, so a renamed file would
  // lose the commits before its move.
  const res = await runGit(top, [
    'log',
    `--max-count=${max}`,
    '--follow',
    `--format=${format}`,
    '--',
    toPosix(relPath),
  ]);
  if (!res.ok) return [];
  const commits: GitCommitRef[] = [];
  for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    const f = line.split(FIELD_SEP);
    if (f.length < 6) continue;
    commits.push({
      sha: f[0],
      shortSha: f[1],
      authorName: f[2],
      authorEmail: f[3],
      date: f[4],
      subject: f[5],
    });
  }
  // git emits newest-first; callers want oldest → newest.
  commits.reverse();
  return commits;
}

/**
 * Contents of `relPath` as of commit `sha`, or `null` when git is unavailable,
 * the SHA is malformed, or the path did not exist at that commit.
 *
 * @param relPath repository-top-relative path (POSIX or native separators accepted)
 */
export async function fileAtCommit(root: string, sha: string, relPath: string): Promise<string | null> {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return null;
  const top = await resolveToplevel(root);
  if (!top) return null;
  const res = await runGit(top, ['show', `${sha}:${toPosix(relPath)}`]);
  return res.ok ? res.stdout : null;
}

/**
 * Whether the working tree has uncommitted changes relative to HEAD — i.e. the
 * scanned files may differ from the recorded commit SHA.
 *
 * Returns:
 * - `true`  when `git status --porcelain` reports any change (modified/staged
 *   tracked files, or untracked non-ignored files),
 * - `false` when the tree is clean (output empty), so the scan corresponds to
 *   the committed SHA,
 * - `undefined` when we cannot tell (git missing, not a work tree, timeout).
 *
 * This is what lets a downstream commit-signature check honestly claim the
 * *scanned* code is the signed commit: a signature only attests to the committed
 * tree, so a dirty working tree must not read as "verified". Uses `--porcelain`
 * (stable, machine format) and respects `.gitignore`, matching what the scanner
 * itself treats as source.
 */
export async function workingTreeDirty(root: string): Promise<boolean | undefined> {
  const top = await resolveToplevel(root);
  if (!top) return undefined;
  const res = await runGit(top, ['status', '--porcelain', '--untracked-files=normal']);
  if (!res.ok) return undefined;
  return res.stdout.trim().length > 0;
}

/** Test-only: clear the memoized top-level lookups so each case starts clean. */
export function __resetGitHistoryCaches(): void {
  toplevelCache.clear();
}
