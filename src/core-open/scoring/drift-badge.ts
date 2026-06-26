// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * DriftScore badge thresholds and colours — DriftScore v2 (0 = no drift / best,
 * 100 = maximum drift / worst). Lower is better, so green covers low drift.
 * Aligned with dashboard scoreBarColor (green <= 20, amber <= 50, red > 50).
 */

export const DRIFT_SCORE_GREEN_MAX = 20;
export const DRIFT_SCORE_AMBER_MAX = 50;

export type DriftBadgeStatus = 'red' | 'amber' | 'green' | 'unknown';

export const STATUS_COLOURS = {
  red: '#E5484D',
  amber: '#F5A524',
  green: '#30A46C',
  unknown: '#6B7280',
} as const;

export const LABEL_BACKGROUND = '#24292F';

/** Map numeric DriftScore (0 = best, 100 = worst) to badge colour band. */
export function driftBadgeStatusFromScore(score: number | null | undefined): DriftBadgeStatus {
  if (score == null || !Number.isFinite(score)) return 'unknown';
  const s = Math.round(score);
  if (s <= DRIFT_SCORE_GREEN_MAX) return 'green';
  if (s <= DRIFT_SCORE_AMBER_MAX) return 'amber';
  return 'red';
}

/** Display score as 00–100 or "unknown". */
export function formatDriftBadgeScore(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return 'unknown';
  const s = Math.round(Math.min(100, Math.max(0, score)));
  if (s === 100) return '100';
  return String(s).padStart(2, '0');
}

export function statusColour(status: DriftBadgeStatus): string {
  return STATUS_COLOURS[status] ?? STATUS_COLOURS.unknown;
}
