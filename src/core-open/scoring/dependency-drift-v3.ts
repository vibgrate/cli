// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * DriftScore v3 — libyear-primary dependency drift (PROTOTYPE).
 *
 * This is the reworked dependency component proposed in
 * `docs/DRIFTSCORE-V3-SPEC.md`. It is intentionally shipped ALONGSIDE the live
 * `dependencyScore` in `drift-score.ts` (methodology `driftscore-2.0`) so the
 * production score and its 43 tests stay untouched while the v3 formula is
 * validated against real-portfolio fixtures. `computeDriftScore` is NOT changed
 * by this file; wiring is a follow-up (see the spec §"Wiring into v3").
 *
 * Design (per spec, merging the code-level and live-data analyses):
 *   - Per dependency: drift = 0.55·T + 0.45·V, where T is calendar-time drift
 *     (libyears, 25 points/libyear) and V is semver-distance drift. Time is the
 *     backbone; version is the fallback when release dates are absent.
 *   - Floors: an unsupported/EOL major floors drift at 70; an abandoned ("no
 *     pulse") package floors it at 50 — these cannot be averaged away.
 *   - Aggregate: 0.5·mean + 0.3·p95 + 0.2·unsupported_share, with direct/prod
 *     dependencies weighted above transitive/dev in the mean, and the p95 term
 *     surfacing the tail the current mean-only formula hides.
 *   - Data-quality guards for the four real-world breakers observed in
 *     production (canary "latest", version-scheme jumps, squatted builtin stubs,
 *     daily-minor high-cadence packages).
 *   - Provenance: every score is Verified (release-date data present, online OR
 *     from a vendored dated snapshot) or Estimated (version-only, branded `~NN`).
 *     Offline is NOT Estimated when a dated snapshot supplies timestamps.
 *
 * Pure & deterministic; no network, no semver dependency (major parsed by regex
 * so this module runs even where `semver` is not installed).
 */
import type { DependencyRow } from '../types.js';

/** Methodology tag for the v3 dependency component + aggregation. */
export const DRIFT_SCORE_V3_METHODOLOGY_VERSION = 'driftscore-3.0';

// ── Tunable constants (published methodology; calibration is the proprietary
// part). These are the live-data-analysis values relayed for the prototype. ──

/** Points of time-drift per libyear. 4 libyears ⇒ fully penalised (100). */
export const POINTS_PER_LIBYEAR = 25;
/** Blend weight on the time (libyear) component. */
export const TIME_WEIGHT = 0.55;
/** Blend weight on the version (semver-distance) component. */
export const VERSION_WEIGHT = 0.45;
/** An unsupported / EOL major floors per-dependency drift here. */
export const UNSUPPORTED_FLOOR = 70;
/** An abandoned ("no pulse") package floors per-dependency drift here. */
export const ABANDONED_FLOOR = 50;

/** Aggregation weights: 0.5·mean + 0.3·p95 + 0.2·unsupported_share. */
export const AGG_MEAN_WEIGHT = 0.5;
export const AGG_P95_WEIGHT = 0.3;
export const AGG_UNSUPPORTED_SHARE_WEIGHT = 0.2;

/** Mean weighting by dependency kind (blast-radius proxy until the lockfile
 *  graph is threaded through — see spec §"Follow-ups"). */
export const WEIGHT_DIRECT_PROD = 1.0;
export const WEIGHT_DIRECT_DEV = 0.5;
export const WEIGHT_TRANSITIVE = 0.4;

// ── Data-quality guard thresholds ──

/** A "latest" whose major is ≥ this is a canary/placeholder (react-native
 *  1000.0.0), not a real release — the version signal is discarded. */
export const CANARY_MAJOR_THRESHOLD = 900;
/** majorsBehind above this is a version-scheme change (Expo reads 40–57), not
 *  40 breaking majors — the version signal is discarded, time carries. */
export const SCHEME_JUMP_MAX_MAJORS = 20;
/** Time-drift is capped here for high-cadence packages so daily minors
 *  (@aws-sdk/*) don't read as severe drift. */
export const HIGH_CADENCE_TIME_CAP = 50;

/** Deprecated/squatted builtin stubs that resolve as "healthy" but are not real
 *  dependencies — excluded from the denominator entirely. */
export const PLACEHOLDER_STUBS: ReadonlySet<string> = new Set([
  'fs', 'crypto', 'path', 'util', 'os', 'events', 'stream', 'http', 'https',
  'assert', 'buffer', 'punycode', 'querystring', 'url', 'zlib', 'domain',
]);

/** Prefixes whose packages ship on a very high (≈daily) release cadence. */
export const HIGH_CADENCE_PREFIXES: readonly string[] = [
  '@aws-sdk/', 'aws-sdk', '@google-cloud/', '@azure/',
];

// ── Per-dependency context the DependencyRow does not yet carry ──

export interface DependencyDriftContext {
  /** True when this is a direct manifest dependency (default true). */
  direct?: boolean;
  /** True when resolved only as a transitive/lockfile dependency. */
  transitive?: boolean;
  /** Resolved major is past vendor support / EOL (floors drift at 70). */
  unsupported?: boolean;
  /** No release in ~24+ months / registry-flagged abandoned (floors at 50). */
  abandoned?: boolean;
}

export type DriftProvenance = 'verified' | 'estimated';

export interface DependencyDriftResult {
  package: string;
  /** 0–100 per-dependency drift (0 = current, 100 = maximally drifted). */
  drift: number;
  /** Verified (had release-date data) or Estimated (version-only). */
  mode: DriftProvenance;
  /** True when this dep hit the unsupported/EOL floor. */
  unsupported: boolean;
  /** Mean-aggregation weight (direct/prod > transitive/dev). */
  weight: number;
  /** Guards that fired, for explainability. */
  flags: string[];
  /** Excluded from scoring entirely (placeholder stub). */
  excluded: boolean;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Parse the leading integer major from a version string without semver. */
function majorOf(version: string | null): number | null {
  if (!version) return null;
  const m = /^\D*(\d+)/.exec(version);
  return m ? Number(m[1]) : null;
}

function isHighCadence(pkg: string): boolean {
  return HIGH_CADENCE_PREFIXES.some((p) => pkg === p || pkg.startsWith(p));
}

/**
 * Version-distance sub-score V (0–100) from major lag and drift band.
 *
 * NOTE: `DependencyRow` only carries `majorsBehind`, so minor/patch lag is
 * approximated from the `drift` band. This curve is the published shape; the
 * exact constants are the calibration slot for `driftscore_v2.py`. It corrects
 * the `driftscore-2.0` "current bucket" conflation by scoring a minor-behind
 * dependency > 0 rather than folding it into "current".
 */
export function versionDriftPoints(dep: Pick<DependencyRow, 'majorsBehind' | 'drift'>): number {
  const mb = dep.majorsBehind;
  if (mb === null || mb === undefined) return 0;
  if (mb <= 0) {
    // majorsBehind 0: distinguish truly current from minor-behind (was
    // mis-bucketed as "current" in driftscore-2.0).
    return dep.drift === 'current' ? 0 : 15;
  }
  if (mb === 1) return 45;
  if (mb === 2) return 70;
  if (mb === 3) return 85;
  return 100;
}

/** Time-distance sub-score T (0–100) from libyears. */
export function timeDriftPoints(libyears: number | null | undefined): number | null {
  if (libyears === null || libyears === undefined || Number.isNaN(libyears)) return null;
  return clamp(libyears * POINTS_PER_LIBYEAR, 0, 100);
}

/**
 * Compute drift for a single dependency, applying data-quality guards, the
 * time/version blend, and the unsupported/abandoned floors.
 */
export function perDependencyDrift(
  dep: DependencyRow,
  ctx: DependencyDriftContext = {},
): DependencyDriftResult {
  const flags: string[] = [];

  // Guard 3 — squatted / deprecated builtin stub: exclude from the denominator.
  if (PLACEHOLDER_STUBS.has(dep.package)) {
    return {
      package: dep.package, drift: 0, mode: 'estimated', unsupported: false,
      weight: 0, flags: ['placeholder-stub'], excluded: true,
    };
  }

  // Guard 1 — canary "latest" (e.g. react-native 1000.0.0): the version signal
  // is meaningless; discard it and let time carry.
  const latestMajor = majorOf(dep.latestStable);
  let versionReliable = true;
  if (latestMajor !== null && latestMajor >= CANARY_MAJOR_THRESHOLD) {
    versionReliable = false;
    flags.push('canary-latest');
  }

  // Guard 2 — version-scheme jump (e.g. Expo reads 40–57 majors behind): treat
  // as a scheme change, not dozens of breaking majors; discard version signal.
  if (dep.majorsBehind !== null && dep.majorsBehind !== undefined && dep.majorsBehind > SCHEME_JUMP_MAX_MAJORS) {
    versionReliable = false;
    flags.push('scheme-jump');
  }

  // Guard 4 — high-cadence packages (@aws-sdk/*): damp version noise (majors
  // only) and cap the time contribution so daily minors don't dominate.
  const highCadence = isHighCadence(dep.package);
  if (highCadence) flags.push('high-cadence-damped');

  const V = versionReliable ? versionDriftPoints(dep) : 0;
  let T = timeDriftPoints(dep.libyears);
  if (T !== null && highCadence) T = Math.min(T, HIGH_CADENCE_TIME_CAP);

  // Blend. Verified when we had time data; Estimated (version-only) otherwise.
  let base: number;
  let mode: DriftProvenance;
  if (T !== null) {
    mode = 'verified';
    base = versionReliable ? TIME_WEIGHT * T + VERSION_WEIGHT * V : T;
  } else {
    mode = 'estimated';
    base = V; // version-only fallback
  }

  // Floors — surfaced, never averaged away.
  const unsupported = ctx.unsupported === true;
  if (unsupported) { base = Math.max(base, UNSUPPORTED_FLOOR); flags.push('unsupported-floor'); }
  if (ctx.abandoned === true) { base = Math.max(base, ABANDONED_FLOOR); flags.push('abandoned-floor'); }

  // Mean-aggregation weight (blast-radius proxy).
  const weight = ctx.transitive === true
    ? WEIGHT_TRANSITIVE
    : (dep.section === 'devDependencies' ? WEIGHT_DIRECT_DEV : WEIGHT_DIRECT_PROD);

  return {
    package: dep.package,
    drift: clamp(Math.round(base), 0, 100),
    mode,
    unsupported,
    weight,
    flags,
    excluded: false,
  };
}

/** Nearest-rank percentile (0–1) over a numeric array. Empty ⇒ 0. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[clamp(rank - 1, 0, sorted.length - 1)]!;
}

export interface DependencyDriftAggregate {
  /** 0–100 portfolio dependency drift. */
  drift: number;
  /** Weighted mean of per-dependency drift. */
  mean: number;
  /** 95th percentile per-dependency drift (tail surfacing). */
  p95: number;
  /** Fraction (0–1) of scored deps that hit the unsupported floor. */
  unsupportedShare: number;
  /** Verified when any dep carried time data; Estimated otherwise. */
  mode: DriftProvenance;
  /** Deps that were scored (placeholder stubs excluded). */
  scored: number;
  /** Placeholder stubs excluded from the denominator. */
  excluded: number;
  /** Fraction (0–1) of scored deps with Verified (time) data — coverage. */
  coverage: number;
  /** Worst offenders, ranked by drift, for explainability. */
  top: DependencyDriftResult[];
}

/**
 * Aggregate per-dependency drift into a portfolio 0–100 number:
 *   0.5·weightedMean + 0.3·p95 + 0.2·(unsupported_share·100)
 * Returns null when there is nothing scoreable (all excluded / empty).
 */
export function aggregateDependencyDrift(
  deps: DependencyRow[],
  ctxOf?: (dep: DependencyRow) => DependencyDriftContext,
): DependencyDriftAggregate | null {
  const results = deps
    .map((d) => perDependencyDrift(d, ctxOf?.(d)))
    .filter((r) => !r.excluded);
  const excluded = deps.length - results.length;
  if (results.length === 0) return null;

  const weightSum = results.reduce((s, r) => s + r.weight, 0) || 1;
  const weightedMean = results.reduce((s, r) => s + r.drift * r.weight, 0) / weightSum;
  const p95 = percentile(results.map((r) => r.drift), 0.95);
  const unsupportedShare = results.filter((r) => r.unsupported).length / results.length;
  const verified = results.filter((r) => r.mode === 'verified').length;

  const drift = clamp(
    Math.round(
      AGG_MEAN_WEIGHT * weightedMean +
      AGG_P95_WEIGHT * p95 +
      AGG_UNSUPPORTED_SHARE_WEIGHT * (unsupportedShare * 100),
    ),
    0, 100,
  );

  return {
    drift,
    mean: Math.round(weightedMean),
    p95,
    unsupportedShare,
    mode: verified > 0 ? 'verified' : 'estimated',
    scored: results.length,
    excluded,
    coverage: Math.round((verified / results.length) * 100) / 100,
    top: [...results].sort((a, b) => b.drift - a.drift).slice(0, 10),
  };
}

/** Brand a score with its provenance: Estimated scores are prefixed `~`. */
export function formatDriftV3(score: number, mode: DriftProvenance): string {
  const s = clamp(Math.round(score), 0, 100);
  return mode === 'estimated' ? `~${s}` : String(s);
}
