// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * DriftScore badge thresholds and colours (0 = no drift / best, 100 = maximum
 * drift / worst — lower is better, so green covers low drift).
 *
 * driftscore-3.0 band reconciliation (spec §6.5): the badge now uses the SAME
 * boundaries as the score's risk bands and DriftRisk (0–30 low/green,
 * 31–60 moderate/amber, 61–100 high/red). Previously the badge used a stricter
 * 20/50, which disagreed with `DriftScore.riskLevel` for scores in 21–30 and
 * 51–60 — one score, two colours. There is now ONE band system across the
 * score, the badge, the IDE, and DriftRisk.
 */

export const DRIFT_SCORE_GREEN_MAX = 30;
export const DRIFT_SCORE_AMBER_MAX = 60;

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
