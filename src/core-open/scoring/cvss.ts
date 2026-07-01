// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { VulnSeverity } from '../types.js';

/**
 * Minimal, dependency-free CVSS v3.0/v3.1 base-score calculator.
 *
 * Advisories (OSV/GHSA) carry severity as a CVSS *vector string*, not a number.
 * To order findings and apply CRA severity thresholds we need the numeric base
 * score, so this implements the official base-score formula. It is deterministic
 * and offline. Temporal/environmental metrics are ignored (base score only);
 * non-v3 vectors (e.g. CVSS v2) return null rather than guessing.
 */

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
// Privileges Required depends on Scope (changed scope raises L/H weights).
const PR_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/** CVSS v3.1 roundup: smallest one-decimal value ≥ x (float-safe). */
function roundup(x: number): number {
  const i = Math.round(x * 100000);
  if (i % 10000 === 0) return i / 100000;
  return (Math.floor(i / 10000) + 1) / 10;
}

/**
 * Compute the CVSS v3 base score (0–10) from a vector string, or null when the
 * vector is not a parseable v3 base vector.
 */
export function cvssV3BaseScore(vector: string | null | undefined): number | null {
  if (!vector || typeof vector !== 'string') return null;
  const parts = vector.trim().split('/');
  if (!parts.length) return null;
  if (!/^CVSS:3\.[01]$/i.test(parts[0])) return null;

  const m: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const [k, v] = part.split(':');
    if (k && v) m[k.toUpperCase()] = v.toUpperCase();
  }

  const scopeChanged = m.S === 'C';
  const av = AV[m.AV];
  const ac = AC[m.AC];
  const ui = UI[m.UI];
  const pr = (scopeChanged ? PR_CHANGED : PR_UNCHANGED)[m.PR];
  const c = CIA[m.C];
  const integ = CIA[m.I];
  const a = CIA[m.A];
  if ([av, ac, ui, pr, c, integ, a].some((v) => v === undefined)) return null;

  const iss = 1 - (1 - c) * (1 - integ) * (1 - a);
  const impact = scopeChanged
    ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
    : 6.42 * iss;
  if (impact <= 0) return 0;

  const exploitability = 8.22 * av * ac * pr * ui;
  const raw = scopeChanged
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);
  return roundup(raw);
}

/** Map a CVSS v3 base score to its qualitative severity band. */
export function severityFromCvss(score: number): VulnSeverity {
  if (score >= 9.0) return 'critical';
  if (score >= 7.0) return 'high';
  if (score >= 4.0) return 'moderate';
  if (score > 0) return 'low';
  return 'unknown';
}

/** Ordinal rank for a severity (higher = worse) — for sorting/aggregation. */
export function severityRank(s: VulnSeverity): number {
  switch (s) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'moderate':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
}

/** Normalize a free-text severity label (e.g. GHSA "MODERATE") to a VulnSeverity. */
export function normalizeSeverityLabel(label: string | null | undefined): VulnSeverity {
  switch ((label ?? '').trim().toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'moderate':
    case 'medium':
      return 'moderate';
    case 'low':
      return 'low';
    default:
      return 'unknown';
  }
}
