/**
 * `vg review` auto-prep — make the two things Review depends on exist, instead
 * of failing and telling the user to go run something else first.
 *
 * Review has exactly two prerequisites:
 *
 *   1. **The code map** (Vibgrate Graph). Every architectural claim Review
 *      makes is read off it; without one `runReview` exits 6 on purpose
 *      ("missing" is never "pass"). Historically the user had to run `vg`
 *      first, and a stale map had to be refreshed by hand — which is why the
 *      simulator scenarios carry an explicit `vg build --quiet` pre-step.
 *      {@link ensureCodeMap} builds it when it is absent and refreshes it
 *      incrementally when the tree drifted, behind one progress bar.
 *
 *   2. **The review policy** (`.vibgrate/review.toml`). Absent, Review falls
 *      back to `DEFAULT_REVIEW_CONFIG` and can only *derive* a layering shape,
 *      so it reports "no layering rules are enforced for this repository"
 *      rather than judging a regression. {@link seedReviewPolicy} writes the
 *      file once, seeded with the shape the repository already exhibits.
 *
 * Two rules keep this safe to run implicitly:
 *
 * - **No surprise artifacts.** The build writes the map (global store by
 *   default) and the freshness snapshot — never `GRAPH_REPORT.md` or
 *   `graph.html`, which only an explicit `vg build` produces.
 * - **No surprise gate.** The seeded policy is `enforcement = "advisory"`, so
 *   writing it can never turn a passing CI job red. Seeding is also skipped
 *   for `--base` runs, so a PR review never mutates the tree it is reviewing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildGraph } from '../engine/build.js';
import { mergeExcludes } from '../engine/discover.js';
import { writeArtifacts } from '../engine/artifacts.js';
import { writeSnapshot } from '../engine/freshness.js';
import { loadGraph } from '../engine/load.js';
import { refreshIfStale } from '../engine/refresh.js';
import { acquireLock, releaseLock } from '../engine/lock.js';
import { cacheDir } from '../engine/cache.js';
import { ProgressBar } from '../util/progress.js';
import { REVIEW_CONFIG_PATH } from './config.js';
import type { GitRunner } from './git.js';

/** Matches `refresh.ts` — one lock, so a refresh and an auto-build never race. */
const PREPARE_LOCK_STALE_MS = 10 * 60 * 1000;

export type PrepareAction =
  /** A map was already there and matched the tree. */
  | 'up-to-date'
  /** No map existed — one was built. */
  | 'built'
  /** A map existed but the tree had drifted — rebuilt incrementally. */
  | 'refreshed'
  /** Auto-build was declined (`--no-auto-build`) or could not run. */
  | 'skipped';

export interface EnsureCodeMapResult {
  action: PrepareAction;
  /** Corpus size, when this call built or refreshed the map. */
  files?: number;
  ms?: number;
  /** Why the map was left alone, when `action === 'skipped'`. */
  reason?: string;
}

export interface EnsureCodeMapOptions {
  root: string;
  /** `--graph <file>`; an explicit path is never auto-built over. */
  graphPath?: string;
  /** `--no-auto-build` — restore the old "exit 6 and tell the user" behaviour. */
  autoBuild?: boolean;
  /** Suppress the progress bar and the summary line (`--quiet` / `--json`). */
  quiet?: boolean;
  /** Injected by tests so the bar never writes to a real terminal. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Make sure a usable code map exists for `root`, building or refreshing it as
 * needed. The caller still handles a null map afterwards — this narrows the
 * cases where that happens, it does not promise to eliminate them.
 */
export async function ensureCodeMap(opts: EnsureCodeMapOptions): Promise<EnsureCodeMapResult> {
  const { root, graphPath } = opts;
  const haveMap = loadGraph(root, graphPath) !== null;

  if (opts.autoBuild === false) {
    return { action: haveMap ? 'up-to-date' : 'skipped', reason: haveMap ? undefined : 'auto-build disabled' };
  }
  // `--graph <file>` names a specific artifact the user is pointing at. Building
  // "the map for this repo" would answer a different question than the one asked.
  if (graphPath) {
    return { action: haveMap ? 'up-to-date' : 'skipped', reason: haveMap ? undefined : 'an explicit --graph path was given' };
  }

  const bar = opts.quiet ? undefined : new ProgressBar('mapping the repository');
  const onParseProgress = (done: number, total: number): void => {
    opts.onProgress?.(done, total);
    bar?.update(done, total);
  };

  try {
    if (haveMap) {
      const outcome = await refreshIfStale(root, { onParseProgress });
      if (outcome.status === 'refreshed') {
        return { action: 'refreshed', files: outcome.totalFiles, ms: outcome.ms };
      }
      // `fresh` needs nothing. `no-snapshot` means the map was built elsewhere
      // (a committed `.vibgrate/graph.json`, another machine) so the build
      // scope is unknown and guessing it would be worse than using the map we
      // have. `locked` means another vg process is already rebuilding.
      if (outcome.status === 'error') {
        return { action: 'skipped', reason: outcome.message };
      }
      return { action: 'up-to-date' };
    }
    return await firstBuild(root, onParseProgress);
  } finally {
    bar?.done();
  }
}

/**
 * The cold path: nothing has ever been mapped here. Deliberately *not*
 * `runBuild` — that is the `vg build` command surface (logo, report, HTML,
 * instruction refresh, embedding warm). Auto-prep owes the user a map and a
 * freshness snapshot, and nothing else in their working tree.
 */
async function firstBuild(
  root: string,
  onParseProgress: (done: number, total: number) => void,
): Promise<EnsureCodeMapResult> {
  const lock = path.join(cacheDir(root), 'refresh.lock');
  if (!acquireLock(lock, PREPARE_LOCK_STALE_MS)) {
    return { action: 'skipped', reason: 'another vg process is building the map' };
  }
  const start = Date.now();
  try {
    const exclude = mergeExcludes(root, undefined);
    const result = await buildGraph({ root, exclude, onParseProgress });
    writeArtifacts(result.graph, { root, html: false, report: false });
    writeSnapshot(root, result.graph.provenance.corpusHash, result.fileStats, { exclude });
    return { action: 'built', files: result.totalFiles, ms: Date.now() - start };
  } catch (err) {
    return { action: 'skipped', reason: (err as Error).message };
  } finally {
    releaseLock(lock);
  }
}

export interface ReviewPolicyState {
  /** A committed or working-tree `.vibgrate/review.toml` was found. */
  present: boolean;
  where: 'base-branch' | 'head' | 'working-tree' | null;
}

/**
 * Is a review policy already set up for this repository?
 *
 * Mirrors {@link import('./config.js').loadReviewConfig}'s search order, so
 * "present" here means exactly "that loader will find something", never merely
 * "a file exists on disk".
 */
export function reviewPolicyState(
  root: string,
  base: string | undefined,
  run: GitRunner,
): ReviewPolicyState {
  const inRef = (ref: string): boolean => {
    const res = run(['show', `${ref}:${REVIEW_CONFIG_PATH}`], root);
    return res.status === 0 && res.stdout.trim().length > 0;
  };
  if (base && inRef(base)) return { present: true, where: 'base-branch' };
  if (inRef('HEAD')) return { present: true, where: 'head' };
  if (fs.existsSync(path.join(root, REVIEW_CONFIG_PATH))) {
    return { present: true, where: 'working-tree' };
  }
  return { present: false, where: null };
}

export interface SeedPolicyOptions {
  root: string;
  /**
   * The shape the repository already exhibits
   * (`capsule.patterns.observed_dominant_pattern`). Seeded as `target_pattern`
   * when present — a *declared* target is what lets Review call a layer
   * traversal a regression instead of an unknown.
   */
  observedPattern?: string | null;
}

export interface SeedPolicyResult {
  written: boolean;
  path: string;
  targetPattern: string | null;
}

/**
 * Write the starter `.vibgrate/review.toml`. Never overwrites: the caller
 * checks {@link reviewPolicyState} first, and this re-checks the file on disk
 * so a concurrent run cannot clobber a hand-edited policy.
 */
export function seedReviewPolicy(opts: SeedPolicyOptions): SeedPolicyResult {
  const target = path.join(opts.root, REVIEW_CONFIG_PATH);
  const pattern = opts.observedPattern ?? null;
  if (fs.existsSync(target)) return { written: false, path: REVIEW_CONFIG_PATH, targetPattern: pattern };

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderReviewPolicy(pattern), 'utf8');
  return { written: true, path: REVIEW_CONFIG_PATH, targetPattern: pattern };
}

/** The seeded policy document. Pure, so its bytes are covered by a test. */
export function renderReviewPolicy(observedPattern: string | null): string {
  const lines = [
    '# Vibgrate Review policy — written by `vg review` on its first run.',
    '# Commit this file: Review reads it from the *base branch*, so a pull',
    '# request cannot weaken the policy that judges it.',
    '',
    '[review]',
    '# "advisory" reports without ever gating. Switch to "enforced" when you',
    '# want `fail_on` to decide the exit code in CI.',
    'enforcement = "advisory"',
    'fail_on = "fail"',
    '',
  ];
  if (observedPattern) {
    lines.push(
      `# Derived from the layering this repository already exhibits. Change it`,
      `# to the shape you want — Review judges changes against this, not against`,
      `# the majority.`,
      `target_pattern = "${observedPattern}"`,
    );
  } else {
    lines.push(
      '# No single layering shape dominates this repository yet, so nothing is',
      '# declared. Set one (e.g. "clean", "layered", "hexagonal") to have Review',
      '# judge layer traversals instead of reporting them as unknown.',
      '# target_pattern = "clean"',
    );
  }
  lines.push(
    '',
    '# Layer pairs an author may traverse without it counting as a regression.',
    'approved_exceptions = []',
    '',
    '# Protected findings can never be blessed into a pass.',
    '[review.protected]',
    'unguarded_entrypoint = true',
    'known_vulnerable_dependency = true',
    'validated_taint = true',
    '',
  );
  return `${lines.join('\n')}`;
}
