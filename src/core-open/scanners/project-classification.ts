// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { ProjectClassification, ProjectScan, BillingSummary } from '../types.js';

/**
 * Project-classification thresholds ("micro-project pricing").
 *
 * Every scanned package is placed in one of four tiers — `'nano'`, `'micro'`,
 * `'small'` or `'standard'` — based on three measured signals: source-file
 * count, source byte size (lockfiles, generated code and vendored directories
 * excluded) and declared dependency count.
 *
 * A package qualifies for a tier when it satisfies **any two of the three**
 * limits for that tier. The "any 2 of 3" rule means a single chatty test
 * folder or one extra dependency cannot, on its own, push a genuinely small
 * service into a higher (more expensive) tier — which both reflects reality
 * and removes the incentive to game a single metric.
 *
 * The bands are evaluated smallest-first, so a package is billed at the lowest
 * tier it qualifies for:
 *
 * - `nano`     — 1/{@link NANO_BILLING_RATIO} of a standard project (default 1/25)
 * - `micro`    — 1/{@link MICRO_BILLING_RATIO} of a standard project (default 1/10)
 * - `small`    — 1/{@link SMALL_BILLING_RATIO} of a standard project (default 1/3)
 * - `standard` — a full billable project (1)
 *
 * The tiers nest strictly (every nano limit ≤ the matching micro limit ≤ the
 * small limit), so a package that meets two nano criteria always also meets the
 * matching two micro criteria — the smallest-first evaluation simply bills it at
 * the cheapest tier it earns.
 */

// ── Nano tier (smallest, billed at 1/25) ──

/** A nano project has fewer than this many source files. */
export const NANO_MAX_FILES = 10;

/** A nano project's source files total fewer than this many bytes (1 MB). */
export const NANO_MAX_SIZE_BYTES = 1_048_576;

/** A nano project has fewer than this many dependencies. */
export const NANO_MAX_DEPENDENCIES = 5;

// ── Micro tier (billed at 1/10) ──

/** A micro project has fewer than this many source files. */
export const MICRO_MAX_FILES = 20;

/** A micro project's source files total fewer than this many bytes (2.5 MB). */
export const MICRO_MAX_SIZE_BYTES = 2_621_440;

/** A micro project has fewer than this many dependencies. */
export const MICRO_MAX_DEPENDENCIES = 10;

// ── Small tier (middle band, billed at 1/3) ──

/** A small project has fewer than this many source files. */
export const SMALL_MAX_FILES = 30;

/** A small project's source files total fewer than this many bytes (5 MB). */
export const SMALL_MAX_SIZE_BYTES = 5_242_880;

/** A small project has fewer than this many dependencies. */
export const SMALL_MAX_DEPENDENCIES = 25;

// ── Billing ratios ──

/** How many nano projects are billed as one standard project. */
export const NANO_BILLING_RATIO = 25;

/** How many micro projects are billed as one standard project. */
export const MICRO_BILLING_RATIO = 10;

/** How many small projects are billed as one standard project. */
export const SMALL_BILLING_RATIO = 3;

/** A standard project is always billed as exactly one project. */
export const STANDARD_BILLING_RATIO = 1;

/** Metrics required to classify a project. */
export interface ProjectClassificationInput {
  /** Number of source files in the project directory (lockfiles/vendored excluded). */
  fileCount?: number;
  /** Total byte size of the source files under the project directory (lockfiles/vendored excluded). */
  sizeBytes?: number;
  /** Number of dependencies located in the package manager. */
  dependencyCount?: number;
}

/**
 * Count how many of the three tier criteria a project satisfies.
 *
 * Each metric only counts toward the total when it is a present, valid
 * measurement within the limit. A file count must be ≥ 1 and a size must be
 * > 0 — a measured package always contains at least its own manifest, so a
 * zero there means the metric could not be resolved (an unresolved path)
 * rather than a genuinely tiny package. A dependency count of 0 is valid (a
 * package may legitimately have no dependencies). Missing metrics simply do
 * not count, which — under the "any 2 of 3" rule — keeps a package robust to a
 * single unmeasured signal without ever being inflated by one.
 */
function criteriaSatisfied(
  input: ProjectClassificationInput,
  maxFiles: number,
  maxSizeBytes: number,
  maxDependencies: number,
): number {
  let met = 0;
  if (input.fileCount !== undefined && input.fileCount >= 1 && input.fileCount < maxFiles) met++;
  if (input.sizeBytes !== undefined && input.sizeBytes > 0 && input.sizeBytes < maxSizeBytes) met++;
  if (input.dependencyCount !== undefined && input.dependencyCount < maxDependencies) met++;
  return met;
}

/**
 * Classify a project as `'nano'`, `'micro'`, `'small'` or `'standard'`.
 *
 * Bands are evaluated smallest-first; a project is assigned the lowest tier
 * whose limits it satisfies for any two of the three criteria. A project with
 * no usable metrics (e.g. `classifyProject({})`) falls through to `'standard'`,
 * so an unresolved or unmeasured package is always billed at the full rate.
 */
export function classifyProject(input: ProjectClassificationInput): ProjectClassification {
  if (criteriaSatisfied(input, NANO_MAX_FILES, NANO_MAX_SIZE_BYTES, NANO_MAX_DEPENDENCIES) >= 2) {
    return 'nano';
  }
  if (criteriaSatisfied(input, MICRO_MAX_FILES, MICRO_MAX_SIZE_BYTES, MICRO_MAX_DEPENDENCIES) >= 2) {
    return 'micro';
  }
  if (criteriaSatisfied(input, SMALL_MAX_FILES, SMALL_MAX_SIZE_BYTES, SMALL_MAX_DEPENDENCIES) >= 2) {
    return 'small';
  }
  return 'standard';
}

/**
 * Normalise a classification value, mapping the legacy two-tier names emitted
 * by older CLI builds onto the current three-tier scheme and defaulting any
 * unknown/absent value to `'standard'` (the conservative, full-rate tier).
 *
 * - `'function'` (legacy) → `'micro'` (the old smallest tier billed at 1/10;
 *   mapped to micro rather than nano so historical artifacts keep their rate)
 * - `'project'` (legacy) / unknown / undefined → `'standard'`
 */
export function normalizeClassification(value: string | null | undefined): ProjectClassification {
  switch (value) {
    case 'nano':
      return 'nano';
    case 'micro':
    case 'function':
      return 'micro';
    case 'small':
      return 'small';
    default:
      return 'standard';
  }
}

/**
 * The billing weight of a single project of the given classification, expressed
 * as a fraction of one standard billable project.
 */
export function classificationBillingWeight(classification: ProjectClassification): number {
  switch (classification) {
    case 'nano':
      return 1 / NANO_BILLING_RATIO;
    case 'micro':
      return 1 / MICRO_BILLING_RATIO;
    case 'small':
      return 1 / SMALL_BILLING_RATIO;
    default:
      return 1;
  }
}

/**
 * Roll project classifications up into a billing summary.
 *
 * Each standard project counts as 1 billable unit, each small project as
 * 1/{@link SMALL_BILLING_RATIO}, each micro project as
 * 1/{@link MICRO_BILLING_RATIO} and each nano project as
 * 1/{@link NANO_BILLING_RATIO}. `billableProjectsRaw` is the exact fractional
 * sum (for transparency and the estimator), while `billableProjects` — the
 * headline figure a customer is billed for — is **always rounded down to the
 * nearest integer**.
 *
 * Note: billing fraction is never risk fraction. Every project, including
 * nano and micro projects, still rolls up fully into drift scores and the
 * portfolio view; only the billing weight is reduced.
 */
export function summarizeBilling(projects: ProjectScan[]): BillingSummary {
  let nanoCount = 0;
  let microCount = 0;
  let smallCount = 0;
  let standardCount = 0;
  for (const project of projects) {
    switch (normalizeClassification(project.classification)) {
      case 'nano':
        nanoCount++;
        break;
      case 'micro':
        microCount++;
        break;
      case 'small':
        smallCount++;
        break;
      default:
        standardCount++;
        break;
    }
  }

  const billableProjectsRaw =
    standardCount +
    smallCount / SMALL_BILLING_RATIO +
    microCount / MICRO_BILLING_RATIO +
    nanoCount / NANO_BILLING_RATIO;

  return {
    nanoCount,
    microCount,
    smallCount,
    standardCount,
    totalScanned: nanoCount + microCount + smallCount + standardCount,
    nanoBillingRatio: NANO_BILLING_RATIO,
    microBillingRatio: MICRO_BILLING_RATIO,
    smallBillingRatio: SMALL_BILLING_RATIO,
    billableProjectsRaw: Math.round(billableProjectsRaw * 100) / 100,
    billableProjects: Math.floor(billableProjectsRaw),
  };
}
