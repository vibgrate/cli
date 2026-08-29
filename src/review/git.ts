/**
 * The change set `vg review` reasons about.
 *
 * Two modes (spec §3):
 *   - default          → dirty tree + index vs HEAD
 *   - `--base <ref>`   → merge-base(HEAD, ref) … HEAD
 *
 * Everything here is read-only git plumbing. It never mutates the worktree and
 * never throws on a non-repo — the caller turns "not a git repository" into a
 * clean exit-6 message rather than a stack trace.
 */

import { spawnSync } from 'node:child_process';
import { digestString } from './schemas.js';

export type GitRunner = (args: string[], cwd: string) => { stdout: string; status: number };

export interface ChangedFile {
  path: string;
  op: 'added' | 'modified' | 'removed' | 'renamed';
  addedLines: number;
  removedLines: number;
  /** 1-based line ranges touched on the *new* side. Empty for a deletion. */
  hunks: { start: number; end: number }[];
}

export interface ChangeSet {
  /**
   * The repository root. Every `path` below is relative to *this*, not to the
   * directory `vg` was invoked from — git reports repo-relative paths, so
   * resolving them against `--cwd` in a subdirectory silently reads the wrong
   * files (or none).
   */
  topLevel: string;
  baseSha: string;
  headSha: string;
  mergeBase: string | null;
  ref: string | null;
  dirty: boolean;
  dirtyTreeHash: string | null;
  files: ChangedFile[];
  remote: string | null;
}

/** The real `git` runner. Exported so auto-prep can reuse it. */
export function defaultRun(args: string[], cwd: string): { stdout: string; status: number } {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: res.stdout ?? '', status: res.status ?? 1 };
}

export function isGitRepo(root: string, run: GitRunner = defaultRun): boolean {
  return run(['rev-parse', '--git-dir'], root).status === 0;
}

/** The repository root, or `root` when git cannot answer. */
export function gitTopLevel(root: string, run: GitRunner = defaultRun): string {
  const res = run(['rev-parse', '--show-toplevel'], root);
  const top = res.stdout.trim();
  return res.status === 0 && top ? top : root;
}

/**
 * Strip credentials from a remote URL before it ever reaches a receipt.
 * `https://user:token@github.com/acme/x.git` → `github.com/acme/x`.
 */
export function normalizeRemote(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  const scp = raw.match(/^[^@/]+@([^:]+):(.+)$/); // git@github.com:acme/x.git
  if (scp) return `${scp[1]}/${scp[2]}`.replace(/\.git$/, '');
  const m = raw.match(/^[a-z+]+:\/\/(?:[^@/]*@)?([^/]+)\/(.+)$/i);
  if (m) return `${m[1]}/${m[2]}`.replace(/\.git$/, '');
  return raw.replace(/\.git$/, '');
}

/**
 * Repo key: a stable, non-reversible identity for the repository. Derived from
 * the normalized remote when there is one, else from the resolved root path —
 * so two clones of the same repo agree, and a repo with no remote still gets a
 * key that is stable on that machine.
 */
export function repoKey(remote: string | null, root: string): string {
  return digestString(`vg.review.repo\0${remote ?? `local:${root}`}`);
}

function parseNumstat(out: string): Map<string, { added: number; removed: number; op: ChangedFile['op'] }> {
  const map = new Map<string, { added: number; removed: number; op: ChangedFile['op'] }>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]);
    const removed = parts[1] === '-' ? 0 : Number(parts[1]);
    // A rename is emitted as `added\tremoved\told\tnew`.
    const path = parts.length >= 4 ? parts[3] : parts[2];
    const op: ChangedFile['op'] =
      parts.length >= 4 ? 'renamed' : removed > 0 && added === 0 ? 'modified' : 'modified';
    map.set(path, { added, removed, op });
  }
  return map;
}

function opFromStatusLetters(letters: string): ChangedFile['op'] {
  if (letters.includes('R')) return 'renamed';
  if (letters.includes('A') || letters.includes('?')) return 'added';
  if (letters.includes('D')) return 'removed';
  return 'modified';
}

/**
 * `git status --porcelain`: two status columns, a space, then the path
 * (`R  old -> new`). Space-delimited and fixed-width.
 */
function parsePorcelainStatus(out: string): Map<string, ChangedFile['op']> {
  const map = new Map<string, ChangedFile['op']>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const letters = line.slice(0, 2);
    const rest = line.slice(3);
    const raw = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest;
    map.set(raw.replace(/^"|"$/g, ''), opFromStatusLetters(letters));
  }
  return map;
}

/**
 * `git diff --name-status`: a status letter (`R100` for a rename), then TAB,
 * then the path — and for a rename, `old\tnew`. A different shape from
 * porcelain entirely; parsing one with the other's rules truncates every path.
 */
function parseDiffNameStatus(out: string): Map<string, ChangedFile['op']> {
  const map = new Map<string, ChangedFile['op']>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const letters = parts[0];
    const path = parts.length >= 3 ? parts[2] : parts[1];
    map.set(path.replace(/^"|"$/g, ''), opFromStatusLetters(letters));
  }
  return map;
}

/** New-side hunk ranges from a unified diff, keyed by path. */
function parseHunks(diff: string): Map<string, { start: number; end: number }[]> {
  const map = new Map<string, { start: number; end: number }[]>();
  let current: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      current = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (current && !map.has(current)) map.set(current, []);
      continue;
    }
    if (current && line.startsWith('@@')) {
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        if (count > 0) map.get(current)!.push({ start, end: start + count - 1 });
      }
    }
  }
  return map;
}

/**
 * Base-side contents of changed files (`git show <baseSha>:path`).
 *
 * Only the change set is read — this is what lets Review tell a new import
 * from occupancy without building a second graph. Added files are omitted
 * (there is no before-image). A miss is a missing map entry, never empty
 * string: empty would look like "the file existed and referenced nothing".
 */
export function readBaseFileTexts(change: ChangeSet, run: GitRunner = defaultRun): Map<string, string> {
  const out = new Map<string, string>();
  const base = change.baseSha;
  if (!base) return out;
  for (const file of change.files) {
    if (file.op === 'added') continue;
    const spec = `${base}:${file.path.replace(/\\/g, '/')}`;
    const res = run(['show', spec], change.topLevel);
    if (res.status === 0 && res.stdout.length <= 2 * 1024 * 1024) {
      out.set(file.path.replace(/\\/g, '/'), res.stdout);
    }
  }
  return out;
}

/**
 * Collect the change set. `base` selects merge-base mode; omitting it reviews
 * the working tree + index against HEAD.
 */
export function collectChangeSet(
  root: string,
  base: string | undefined,
  run: GitRunner = defaultRun,
): ChangeSet {
  const topLevel = gitTopLevel(root, run);
  const headSha = run(['rev-parse', 'HEAD'], root).stdout.trim();
  const refRaw = run(['rev-parse', '--abbrev-ref', 'HEAD'], root).stdout.trim();
  const ref = !refRaw || refRaw === 'HEAD' ? null : `refs/heads/${refRaw}`;
  const remoteRaw = run(['config', '--get', 'remote.origin.url'], root);
  const remote = remoteRaw.status === 0 ? normalizeRemote(remoteRaw.stdout) : null;

  if (base) {
    const mb = run(['merge-base', 'HEAD', base], root);
    const mergeBase = mb.status === 0 ? mb.stdout.trim() : null;
    const baseSha = mergeBase ?? run(['rev-parse', base], root).stdout.trim();
    const numstat = parseNumstat(run(['diff', '--numstat', '-M', `${baseSha}..HEAD`], root).stdout);
    const status = parseDiffNameStatus(run(['diff', '--name-status', '-M', `${baseSha}..HEAD`], root).stdout);
    const hunks = parseHunks(run(['diff', '-U0', '-M', `${baseSha}..HEAD`], root).stdout);
    return {
      topLevel,
      baseSha,
      headSha,
      mergeBase,
      ref,
      dirty: false,
      dirtyTreeHash: null,
      files: mergeFiles(numstat, status, hunks),
      remote,
    };
  }

  // Working tree + index vs HEAD. `--name-status` over both staged and unstaged
  // so a partially-staged change is reviewed as one change set.
  const numstat = parseNumstat(run(['diff', '--numstat', '-M', 'HEAD'], root).stdout);
  const status = parsePorcelainStatus(run(['status', '--porcelain', '-uall'], root).stdout);
  const hunks = parseHunks(run(['diff', '-U0', '-M', 'HEAD'], root).stdout);
  const files = mergeFiles(numstat, status, hunks);
  const dirty = files.length > 0;
  return {
    topLevel,
    baseSha: headSha,
    headSha,
    mergeBase: null,
    ref,
    dirty,
    // Identifies *which* dirty state was reviewed, so two reviews of the same
    // uncommitted work dedupe and a later edit produces a new receipt.
    dirtyTreeHash: dirty ? dirtyTreeHash(files) : null,
    files,
    remote,
  };
}

/**
 * Paths that are never part of a change under review: vg's own artifact
 * directory, and dependency/build output. A repo that has not gitignored
 * `.vibgrate/` would otherwise have every review dominated by cache churn.
 */
const NOT_REVIEWABLE = /(^|\/)(\.vibgrate|node_modules|dist|build|out|target|bin|obj|coverage|\.next|\.turbo|vendor)\//;

export function isReviewable(path: string): boolean {
  return !NOT_REVIEWABLE.test(path.replace(/\\/g, '/'));
}

function mergeFiles(
  numstat: Map<string, { added: number; removed: number; op: ChangedFile['op'] }>,
  status: Map<string, ChangedFile['op']>,
  hunks: Map<string, { start: number; end: number }[]>,
): ChangedFile[] {
  const paths = new Set<string>([...numstat.keys(), ...status.keys()]);
  const files: ChangedFile[] = [];
  for (const path of paths) {
    const n = numstat.get(path);
    files.push({
      path,
      op: status.get(path) ?? n?.op ?? 'modified',
      addedLines: n?.added ?? 0,
      removedLines: n?.removed ?? 0,
      hunks: hunks.get(path) ?? [],
    });
  }
  // Deterministic order — the capsule and every digest downstream depend on it.
  return files
    .filter((f) => isReviewable(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A digest over the change set's shape — not its contents. Never source text. */
export function dirtyTreeHash(files: ChangedFile[]): string {
  return digestString(
    files
      .map((f) => `${f.path}\0${f.op}\0${f.addedLines}\0${f.removedLines}\0${f.hunks.map((h) => `${h.start}-${h.end}`).join(',')}`)
      .join('\n'),
  );
}

/**
 * Days since each tracked file was last committed, from one bounded `git log`
 * pass (not one process per file — that is O(files) subprocesses and dominates
 * the runtime on any real repository).
 *
 * Feeds the dominance vote's temporal weighting, which is what stops a large
 * abandoned wing from out-voting the code people actually work in. Files with
 * no commit inside the window are simply absent, and the vote treats an unknown
 * age as neutral rather than old.
 */
export function fileRecencyDays(
  root: string,
  opts: { sinceDays?: number; now?: number } = {},
  run: GitRunner = defaultRun,
): Map<string, number> {
  const sinceDays = opts.sinceDays ?? 730;
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const out = new Map<string, number>();
  const res = run(
    ['log', `--since=${sinceDays}.days.ago`, '--name-only', '--pretty=format:%ct', '--no-merges'],
    root,
  );
  if (res.status !== 0) return out;

  let currentTs: number | null = null;
  for (const line of res.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\d{9,}$/.test(trimmed)) {
      currentTs = Number(trimmed);
      continue;
    }
    if (currentTs === null) continue;
    // git lists newest commits first, so the first sighting of a path is its
    // most recent touch — later (older) sightings must not overwrite it.
    if (out.has(trimmed)) continue;
    out.set(trimmed, Math.max(0, (nowSec - currentTs) / 86400));
  }
  return out;
}
