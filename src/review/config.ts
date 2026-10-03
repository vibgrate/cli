/**
 * Review policy configuration (spec §5).
 *
 * The policy is the `review` block of the project config
 * (`.vibgrate/config.yml` or `vibgrate.config.json`). The older
 * `.vibgrate/review.toml` is still read when the config has no `review` block.
 *
 * **Read from the trusted base branch, never the working tree.** A PR that
 * edits the policy must not weaken the policy applied to itself, so when a
 * base ref is given it is read via `git show <base>:<file>`, and only there:
 * a base with no policy means the defaults, never the change's own copy.
 * Without a base, the committed HEAD copy is used, and the working-tree copy
 * only when git has nothing to show (no commits, or not a repository).
 *
 * A base-branch read is a data read: a `.ts`/`.js` project config is code and
 * is never executed here, so its `review` block cannot be used — put review
 * settings in `.vibgrate/config.yml` or `vibgrate.config.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseToml } from '../core-open/utils/toml.js';
import {
  CONFIG_FILES,
  ProjectConfigError,
  isDataConfigFile,
  parseDataConfig,
  projectConfigError,
  readDataConfigSync,
} from '../core-open/config.js';
import type { GitRunner } from './git.js';
import type { ReviewEnforcement } from './schemas.js';

export const REVIEW_CONFIG_PATH = '.vibgrate/review.toml';

export interface ProtectedRules {
  unguarded_entrypoint: boolean;
  known_vulnerable_dependency: boolean;
  validated_taint: boolean;
}

export interface ReviewConfig {
  enforcement: ReviewEnforcement;
  /**
   * The gate level applied when `enforcement = "enforced"`. Inert under
   * `advisory` — that is what makes `enforcement` a real switch rather than a
   * label. `none` reports without ever gating.
   */
  fail_on: 'none' | 'fail' | 'needs_review';
  /** The layering shape the repository declares it wants, if any. */
  target_pattern: string | null;
  /** Layer pairs an author may traverse without it counting as a regression. */
  approved_exceptions: string[];
  protected: ProtectedRules;
  /**
   * High-severity findings at or above this calibrated confidence escalate to
   * the level named by `high_severity_decision`.
   */
  high_confidence_threshold: number;
  high_severity_decision: 'fail' | 'needs_review';
  /** Where the effective config came from — recorded for the human report. */
  source: 'base-branch' | 'head' | 'working-tree' | 'defaults';
  /** The file that supplied it: a project config file, `.vibgrate/review.toml`, or null for defaults. */
  file: string | null;
}

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  enforcement: 'advisory',
  fail_on: 'fail',
  target_pattern: null,
  approved_exceptions: [],
  protected: {
    unguarded_entrypoint: true,
    known_vulnerable_dependency: true,
    validated_taint: true,
  },
  high_confidence_threshold: 0.8,
  high_severity_decision: 'fail',
  source: 'defaults',
  file: null,
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Map the `review` block of the project config (camelCase keys) onto the
 * policy. Unknown keys are ignored, never fatal — the same contract as
 * `review.toml`.
 */
export function reviewConfigFromBlock(
  block: unknown,
  source: ReviewConfig['source'],
  file: string,
): ReviewConfig {
  const review = (block && typeof block === 'object' && !Array.isArray(block) ? block : {}) as Record<string, unknown>;
  const prot = (review.protected ?? {}) as Record<string, unknown>;
  return normalise(
    {
      enforcement: review.enforcement,
      fail_on: review.failOn,
      target_pattern: review.targetPattern,
      approved_exceptions: review.approvedExceptions,
      protected: {
        unguarded_entrypoint: prot.unguardedEntrypoint,
        known_vulnerable_dependency: prot.knownVulnerableDependency,
        validated_taint: prot.validatedTaint,
      },
      high_confidence_threshold: review.highConfidenceThreshold,
      high_severity_decision: review.highSeverityDecision,
    },
    source,
    file,
  );
}

/** Parse a `review.toml` document. Unknown keys are ignored, never fatal. */
export function parseReviewConfig(text: string, source: ReviewConfig['source']): ReviewConfig {
  const doc = parseToml(text);
  if (!doc) return { ...DEFAULT_REVIEW_CONFIG, source, file: REVIEW_CONFIG_PATH };
  return normalise((doc.review ?? {}) as Record<string, unknown>, source, REVIEW_CONFIG_PATH);
}

/** Validate snake_case policy values, falling back to defaults per key. */
function normalise(review: Record<string, unknown>, source: ReviewConfig['source'], file: string): ReviewConfig {
  const prot = (review.protected ?? {}) as Record<string, unknown>;
  const exceptions = Array.isArray(review.approved_exceptions)
    ? (review.approved_exceptions as unknown[]).filter((e): e is string => typeof e === 'string')
    : [];
  const threshold = typeof review.high_confidence_threshold === 'number'
    ? Math.min(1, Math.max(0, review.high_confidence_threshold))
    : DEFAULT_REVIEW_CONFIG.high_confidence_threshold;
  return {
    enforcement: str(review.enforcement, ['advisory', 'enforced'] as const, DEFAULT_REVIEW_CONFIG.enforcement),
    fail_on: str(review.fail_on, ['none', 'fail', 'needs_review'] as const, DEFAULT_REVIEW_CONFIG.fail_on),
    target_pattern: typeof review.target_pattern === 'string' ? review.target_pattern : null,
    approved_exceptions: exceptions,
    protected: {
      unguarded_entrypoint: bool(prot.unguarded_entrypoint, DEFAULT_REVIEW_CONFIG.protected.unguarded_entrypoint),
      known_vulnerable_dependency: bool(
        prot.known_vulnerable_dependency,
        DEFAULT_REVIEW_CONFIG.protected.known_vulnerable_dependency,
      ),
      validated_taint: bool(prot.validated_taint, DEFAULT_REVIEW_CONFIG.protected.validated_taint),
    },
    high_confidence_threshold: threshold,
    high_severity_decision: str(
      review.high_severity_decision,
      ['fail', 'needs_review'] as const,
      DEFAULT_REVIEW_CONFIG.high_severity_decision,
    ),
    source,
    file,
  };
}

/**
 * The project config's `review` block as committed at `ref`, when the config
 * there is data. Returns `undefined` when there is no block to use — no
 * config, a `.ts`/`.js` config, or no `review` key. A data file that does
 * not parse throws {@link ProjectConfigError}.
 */
function reviewBlockAtRef(root: string, ref: string, run: GitRunner): { file: string; block: unknown } | undefined {
  for (const file of CONFIG_FILES) {
    const res = run(['show', `${ref}:${file}`], root);
    if (res.status !== 0) continue;
    // The first config file present is the config — never fall through to a
    // shadowed one, or base and working tree could disagree about which file
    // is in force.
    if (!isDataConfigFile(file)) return undefined;
    const doc = parseDataConfig(res.stdout, file);
    return doc.review === undefined ? undefined : { file, block: doc.review };
  }
  return undefined;
}

/**
 * Load the effective config for this review.
 *
 * With a base: the base ref's committed copy, else the defaults — nothing
 * from the change itself. Without a base: HEAD's committed copy, then the
 * working tree (only when git can't answer at all), then the defaults.
 */
export function loadReviewConfig(
  root: string,
  base: string | undefined,
  run: GitRunner,
): ReviewConfig {
  // At each ref the config's `review` block wins; `review.toml` is the
  // fallback for repositories that have not moved their policy yet.
  const fromRef = (ref: string, source: ReviewConfig['source']): ReviewConfig | null => {
    const block = reviewBlockAtRef(root, ref, run);
    if (block) return reviewConfigFromBlock(block.block, source, block.file);
    const res = run(['show', `${ref}:${REVIEW_CONFIG_PATH}`], root);
    return res.status === 0 && res.stdout.trim() ? parseReviewConfig(res.stdout, source) : null;
  };

  // A broken working-tree config is never "no policy", even when the copy
  // review applies comes from git. Same message `vg doctor` prints.
  const problem = projectConfigError(readDataConfigSync(root));
  if (problem) throw new ProjectConfigError(problem);

  // With a base, the base is the only source. Falling back to HEAD would let a
  // change introduce a weaker policy in a repository whose base has none.

  if (base) return fromRef(base, 'base-branch') ?? { ...DEFAULT_REVIEW_CONFIG };
  const head = fromRef('HEAD', 'head');
  if (head) return head;

  // No git-visible copy (a repo with no commits, or a non-repo). The working
  // tree is the only state there is, and it is not "a PR weakening its own
  // policy" — there is no base to weaken relative to.
  const project = readDataConfigSync(root);
  if (project.file && project.config?.review !== undefined) {
    return reviewConfigFromBlock(project.config.review, 'working-tree', project.file);
  }
  const local = path.join(root, REVIEW_CONFIG_PATH);
  if (fs.existsSync(local)) {
    try {
      return parseReviewConfig(fs.readFileSync(local, 'utf8'), 'working-tree');
    } catch {
      /* fall through to defaults */
    }
  }
  return { ...DEFAULT_REVIEW_CONFIG };
}
