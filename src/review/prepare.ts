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
import { REVIEW_CONFIG_PATH, loadReviewConfig } from './config.js';
import { CONFIG_FILES, ProjectConfigError, isDataConfigFile, parseDataConfig, readDataConfigSync } from '../core-open/config.js';
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
    if (err instanceof ProjectConfigError) throw err;
    return { action: 'skipped', reason: (err as Error).message };
  } finally {
    releaseLock(lock);
  }
}

export interface ReviewPolicyState {
  /** A review policy (config `review` block or `.vibgrate/review.toml`) was found. */
  present: boolean;
  where: 'base-branch' | 'head' | 'working-tree' | null;
}

/**
 * Is a review policy already set up for this repository?
 *
 * Answered by {@link loadReviewConfig} itself, so "present" means exactly
 * "the loader will find something", never merely "a file exists on disk".
 */
export function reviewPolicyState(
  root: string,
  base: string | undefined,
  run: GitRunner,
): ReviewPolicyState {
  const config = loadReviewConfig(root, base, run);
  return config.source === 'defaults'
    ? { present: false, where: null }
    : { present: true, where: config.source };
}

export interface SeedPolicyOptions {
  root: string;
  /**
   * The shape the repository already exhibits
   * (`capsule.patterns.observed_dominant_pattern`). Seeded as the target
   * pattern, so the first review has a declared shape to judge against.
   */
  observedPattern: string | null;
}

export interface SeedPolicyResult {
  written: boolean;
  /** The file the policy was (or would have been) written to. */
  path: string;
  targetPattern: string | null;
}

/**
 * Write the starter review policy — into the project config, so the
 * repository keeps one settings file:
 *
 * - no config yet → create `.vibgrate/config.yml` with a `review` block;
 * - `.vibgrate/config.yml` → append a `review` block (existing text untouched);
 * - `vibgrate.config.json` → add a `review` object;
 * - `vibgrate.config.ts` / `.js` → code is never rewritten, so write the
 *   older `.vibgrate/review.toml`, which is still honoured.
 *
 * Never overwrites a policy that exists anywhere, and never writes a file it
 * cannot read back.
 */
export function seedReviewPolicy(opts: SeedPolicyOptions): SeedPolicyResult {
  const pattern = opts.observedPattern ?? null;
  const skip = (at: string): SeedPolicyResult => ({ written: false, path: at, targetPattern: pattern });

  if (fs.existsSync(path.join(opts.root, REVIEW_CONFIG_PATH))) return skip(REVIEW_CONFIG_PATH);
  const project = readDataConfigSync(opts.root);
  if (project.config?.review !== undefined) return skip(project.file as string);

  if (project.file === null) {
    const file = CONFIG_FILES[0];
    const target = path.join(opts.root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderReviewPolicyYaml(pattern), 'utf8');
    return { written: true, path: file, targetPattern: pattern };
  }

  if (!isDataConfigFile(project.file)) {
    const target = path.join(opts.root, REVIEW_CONFIG_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderReviewPolicy(pattern), 'utf8');
    return { written: true, path: REVIEW_CONFIG_PATH, targetPattern: pattern };
  }

  // A data config that does not parse is the user's to fix; do not touch it.
  if (!project.config) return skip(project.file);

  const target = path.join(opts.root, project.file);
  const current = fs.readFileSync(target, 'utf8');
  const next = project.file.endsWith('.json')
    ? `${JSON.stringify({ ...project.config, review: reviewPolicyBlock(pattern) }, null, 2)}\n`
    : `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}\n${renderReviewPolicyYaml(pattern)}`;

  // Appending to YAML is safe only when the result still parses to the same
  // settings plus `review` (a flow-style document would not).
  try {
    const reread = parseDataConfig(next, project.file);
    const { review, ...rest } = reread;
    if (JSON.stringify(rest) !== JSON.stringify(project.config) || review === undefined) return skip(project.file);
  } catch {
    return skip(project.file);
  }
  fs.writeFileSync(target, next, 'utf8');
  return { written: true, path: project.file, targetPattern: pattern };
}

/** The seeded policy as config data (camelCase), for JSON configs. */
export function reviewPolicyBlock(observedPattern: string | null): Record<string, unknown> {
  return {
    enforcement: 'advisory',
    failOn: 'fail',
    ...(observedPattern ? { targetPattern: observedPattern } : {}),
    approvedExceptions: [],
    protected: { unguardedEntrypoint: true, knownVulnerableDependency: true, validatedTaint: true },
  };
}

/** The seeded `review` block for `.vibgrate/config.yml`. Pure, so its bytes are covered by a test. */
export function renderReviewPolicyYaml(observedPattern: string | null): string {
  const lines = [
    '# Vibgrate Review policy — written by `vg review` on its first run.',
    '# Commit this file: Review reads it from the *base branch*, so a pull',
    '# request cannot weaken the policy that judges it.',
    'review:',
    '  # "advisory" reports without ever gating. Switch to "enforced" when you',
    '  # want failOn to decide the exit code in CI.',
    '  enforcement: advisory',
    '  failOn: fail',
  ];
  if (observedPattern) {
    lines.push(
      '  # Derived from the layering this repository already exhibits. Change it',
      '  # to the shape you want — Review judges changes against this, not against',
      '  # the majority.',
      `  targetPattern: ${JSON.stringify(observedPattern)}`,
    );
  } else {
    lines.push(
      '  # No single layering shape dominates this repository yet, so nothing is',
      '  # declared. Set one (e.g. clean, layered, hexagonal) to have Review',
      '  # judge layer traversals instead of reporting them as unknown.',
      '  # targetPattern: clean',
    );
  }
  lines.push(
    '  # Layer pairs an author may traverse without it counting as a regression.',
    '  approvedExceptions: []',
    '  # Protected findings can never be blessed into a pass.',
    '  protected:',
    '    unguardedEntrypoint: true',
    '    knownVulnerableDependency: true',
    '    validatedTaint: true',
    '',
  );
  return lines.join('\n');
}

/**
 * The seeded `review.toml` — used only when the project config is `.ts`/`.js`
 * (code, which is never rewritten). Pure, so its bytes are covered by a test.
 */
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
