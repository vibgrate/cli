/**
 * `.vibgrate/review.toml` — the review policy configuration (spec §5).
 *
 * **Read from the trusted base branch, never the working tree.** A PR that
 * edits `review.toml` must not weaken the policy applied to itself, so when a
 * base ref is available the file is read via `git show <base>:.vibgrate/review.toml`.
 * The working-tree copy is used only when there is no base (a local
 * `vg review` against HEAD, where HEAD *is* the trusted state) — and even then
 * the committed HEAD copy wins over an uncommitted edit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseToml } from '../core-open/utils/toml.js';
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
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Parse a `review.toml` document. Unknown keys are ignored, never fatal. */
export function parseReviewConfig(text: string, source: ReviewConfig['source']): ReviewConfig {
  const doc = parseToml(text);
  if (!doc) return { ...DEFAULT_REVIEW_CONFIG, source };
  const review = (doc.review ?? {}) as Record<string, unknown>;
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
  };
}

/**
 * Load the effective config for this review.
 *
 * Order: the base ref's committed copy (trusted), then HEAD's committed copy,
 * then the working tree (only when git can't answer at all), then defaults.
 */
export function loadReviewConfig(
  root: string,
  base: string | undefined,
  run: GitRunner,
): ReviewConfig {
  const fromRef = (ref: string): string | null => {
    const res = run(['show', `${ref}:${REVIEW_CONFIG_PATH}`], root);
    return res.status === 0 && res.stdout.trim() ? res.stdout : null;
  };

  if (base) {
    const text = fromRef(base);
    if (text) return parseReviewConfig(text, 'base-branch');
  }
  const head = fromRef('HEAD');
  if (head) return parseReviewConfig(head, 'head');

  // No git-visible copy (a repo with no commits, or a non-repo). The working
  // tree is the only state there is, and it is not "a PR weakening its own
  // policy" — there is no base to weaken relative to.
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
