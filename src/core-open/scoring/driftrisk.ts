// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * DriftRisk™ — the executive headline blend of DriftScore (maintainability)
 * and RiskScore (security & business exposure).
 *
 * "DriftRisk" is a trademark of Vibgrate; the algorithm below is open source
 * (Apache-2.0). DriftScore and RiskScore are NOT trademarked.
 *
 * `driftrisk-1.1` — EVIDENCE-TIERED dynamic weighting.
 * ----------------------------------------------------
 * DriftRisk stays a single, sortable 0–100 number, but risk's pull grows with
 * the *RiskScore band*, so a serious security posture emphasises risk instead of
 * being averaged down. Because RiskScore is itself evidence-weighted (CISA-KEV
 * observed exploitation floors it to the critical band; EPSS drives likelihood;
 * CVSS is only a capped severity multiplier — see the RiskScore methodology),
 * tiering DriftRisk on the RiskScore band means DriftRisk emphasises *real*
 * exploitation evidence, not raw CVSS severity. DriftRisk remains a PURE, DERIVED
 * function of the two published axes and never feeds back into either.
 *
 *   band   = riskBand(RiskScore)                         // low | moderate | high | critical
 *   wR     = RISK_WEIGHT_BY_BAND[band]                    // .40 · .50 · .65 · .80
 *   raw    = min(100, 0.55·Drift + wR·Risk + 0.15·min(Drift, Risk))
 *   DriftRisk = min(100, max(raw, RISK_FLOOR_BY_BAND[band]))   // high→55, critical→80
 *
 * Design guarantees:
 *   - MONOTONIC in both axes (drift weight is fixed and positive; the risk weight
 *     only ever grows across bands, and the floor only ever rises), so raising
 *     either score can never lower the headline.
 *   - SORTABLE: a single global function f(Drift, Risk); every repo is ranked by
 *     the same map, so leaderboards remain comparable.
 *   - The floor ladder generalises the v1.0 KEV/Risk-critical override (its top
 *     rung): a live security emergency never reads green because drift is low.
 *
 * Display convention: show DriftRisk *beside* its two constituents
 * (`Drift 40 · Risk 60 · DriftRisk 67`). Use the scalar for ranking/badges; show
 * the Drift/Risk pair for reading. The breakdown must always be reachable.
 */

export const DRIFTRISK_METHODOLOGY_VERSION = 'driftrisk-1.1';

/** Fixed weight on DriftScore (never reallocated — this is what keeps it monotonic). */
export const DRIFTRISK_DRIFT_WEIGHT = 0.55;
/** "Both-are-bad" danger-zone amplifier. */
export const DRIFTRISK_SYNERGY_WEIGHT = 0.15;

export type DriftRiskBand = 'low' | 'moderate' | 'high';
export type RiskBand = 'low' | 'moderate' | 'high' | 'critical';

/** RiskScore bands (aligned with riskscore-1.0: <20 low, <50 moderate, <80 high, ≥80 critical). */
export function riskBand(risk: number): RiskBand {
  if (risk >= 80) return 'critical';
  if (risk >= 50) return 'high';
  if (risk >= 20) return 'moderate';
  return 'low';
}

/**
 * Risk weight by RiskScore band — grows as exploitation evidence strengthens.
 * (Calibration constants; part of the published-but-tunable methodology.)
 */
export const RISK_WEIGHT_BY_BAND: Record<RiskBand, number> = {
  low: 0.40,
  moderate: 0.50,
  high: 0.65,
  critical: 0.80,
};

/** Floor ladder — a minimum DriftRisk guaranteed by risk band (generalises the KEV override). */
export const RISK_FLOOR_BY_BAND: Record<RiskBand, number> = {
  low: 0,
  moderate: 0,
  high: 55,
  critical: 80,
};

export interface DriftRisk {
  /** 0–100 headline; higher = more organisational pressure to act. */
  score: number;
  band: DriftRiskBand;
  /** The DriftScore input (0–100). */
  drift: number;
  /** The RiskScore input (0–100). */
  risk: number;
  /** RiskScore band that drove the weighting/floor. */
  riskBand: RiskBand;
  /** Risk weight applied for this band (explainability). */
  riskWeight: number;
  /** True when the band floor lifted the score above the raw blend. */
  floorApplied: boolean;
  methodologyVersion: string;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function bandOf(score: number): DriftRiskBand {
  if (score <= 30) return 'low';
  if (score <= 60) return 'moderate';
  return 'high';
}

/**
 * Compute the DriftRisk™ score from a DriftScore and RiskScore (both 0–100,
 * higher = worse). Pure and deterministic.
 */
export function computeDriftRisk(drift: number, risk: number): DriftRisk {
  const d = clamp(drift, 0, 100);
  const r = clamp(risk, 0, 100);

  const rBand = riskBand(r);
  const wR = RISK_WEIGHT_BY_BAND[rBand];
  const floor = RISK_FLOOR_BY_BAND[rBand];

  const raw = Math.min(
    100,
    DRIFTRISK_DRIFT_WEIGHT * d + wR * r + DRIFTRISK_SYNERGY_WEIGHT * Math.min(d, r),
  );

  const floorApplied = floor > raw;
  const score = Math.round(clamp(Math.max(raw, floor), 0, 100));

  return {
    score,
    band: bandOf(score),
    drift: Math.round(d),
    risk: Math.round(r),
    riskBand: rBand,
    riskWeight: wR,
    floorApplied,
    methodologyVersion: DRIFTRISK_METHODOLOGY_VERSION,
  };
}
