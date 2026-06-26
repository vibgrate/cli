// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Libyear-based dependency-freshness helpers.
 *
 * A "libyear" is the calendar time between the version a project uses and the
 * latest available stable release (Cox et al., "Measuring Dependency Freshness
 * in Software Systems", ICSE 2015; https://libyear.com/). It expresses drift in
 * *time* rather than in *major-version count*, which is more comparable across
 * ecosystems with different release cadences.
 *
 * These functions are pure and offline-safe. They operate on release-date data
 * that is sourced from the package registry (online) or an offline
 * package-version manifest — never from a Vibgrate server-side service. When no
 * dates are available the helpers return null and the freshness signal is simply
 * omitted, so DriftScore remains fully computable offline.
 */

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365.25;

/**
 * Compute the calendar age, in days, between the resolved version and the latest
 * stable version, using a version → ISO-date map. Returns null when either date
 * is missing or unparseable. Negative results (clock skew / resolved newer than
 * "latest") are clamped to 0.
 */
export function ageDaysBetween(
  resolvedVersion: string | null,
  latestStable: string | null,
  releaseDates: Record<string, string> | undefined,
): number | null {
  if (!resolvedVersion || !latestStable || !releaseDates) return null;
  const resolvedIso = releaseDates[resolvedVersion];
  const latestIso = releaseDates[latestStable];
  if (!resolvedIso || !latestIso) return null;

  const resolvedMs = Date.parse(resolvedIso);
  const latestMs = Date.parse(latestIso);
  if (Number.isNaN(resolvedMs) || Number.isNaN(latestMs)) return null;

  const days = (latestMs - resolvedMs) / MS_PER_DAY;
  return days > 0 ? days : 0;
}

/** Convert a day-count to libyears. */
export function daysToLibyears(days: number | null): number | null {
  if (days === null) return null;
  return days / DAYS_PER_YEAR;
}

export interface LibyearAggregate {
  /** Sum of per-dependency libyears. */
  total: number;
  /** Worst single-dependency libyears. */
  max: number;
  /** Number of dependencies that had computable release-date data. */
  measured: number;
}

/** Aggregate a list of per-dependency libyear values (nulls ignored). */
export function aggregateLibyears(values: (number | null | undefined)[]): LibyearAggregate | null {
  let total = 0;
  let max = 0;
  let measured = 0;
  for (const v of values) {
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    total += v;
    if (v > max) max = v;
    measured++;
  }
  if (measured === 0) return null;
  return { total, max, measured };
}

/**
 * Map a libyear aggregate to a 0–100 freshness sub-score (higher = fresher).
 *
 * Blends the average staleness (weighted 0.7) with the worst single dependency
 * (weighted 0.3) so that a single very-stale dependency is surfaced rather than
 * hidden by a healthy average — mirroring the framework-component design.
 *
 * Calibration constants are intentionally simple expert weights; they are part
 * of the published methodology's "expert-weighted" tier (not empirically
 * anchored), and are versioned with the DriftScore methodology.
 */
export function freshnessScoreFromLibyears(agg: LibyearAggregate | null): number | null {
  if (!agg || agg.measured === 0) return null;
  const avg = agg.total / agg.measured;
  const avgPenalty = Math.min(avg * 20, 100); // ~5 avg libyears => fully penalised
  const maxPenalty = Math.min(agg.max * 10, 100); // ~10 worst libyears => fully penalised
  const score = 100 - (avgPenalty * 0.7 + maxPenalty * 0.3);
  return Math.max(0, Math.min(100, Math.round(score)));
}
