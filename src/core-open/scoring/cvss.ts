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
 * and offline. Temporal/environmental metrics are ignored (base score only).
 * A vector that is present but not a v3 base vector does not yield a score —
 * {@link parseCvssV3} reports that separately from a vector that was never supplied.
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
 * Outcome of reading a CVSS / severity vector.
 *
 * `score` is the v3 base score when the vector parsed, including a real zero
 * when impact is none. It is null both when no vector was supplied and when a
 * vector was supplied but could not be parsed — `diagnostic` is set only in
 * the second case, so a parse failure is never reported as an absent score
 * or as zero.
 */
export interface CvssParseResult {
  score: number | null;
  diagnostic?: string;
}

const PARSE_NEXT_STEP =
  'Replace the vector with a CVSS v3.0 or v3.1 base vector such as CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N, or remove the vector and set a qualitative severity (low, moderate, high, or critical).';

/** User-facing parse failure. Never includes the supplied value. */
function cvssDiagnostic(reason: string): string {
  return `CVSS vector could not be parsed (${reason}). No base score was derived from it. ${PARSE_NEXT_STEP}`;
}

/**
 * Why a non-blank string did not score. Structural only: metric names and the
 * version we accept. The raw value is never copied in, so a vector field that
 * actually holds unrelated text cannot leak into the diagnostic.
 */
function cvssFailureReason(vector: string): string {
  const trimmed = vector.trim();
  if (/[\r\n]/.test(vector) || trimmed.length > 180) {
    return 'it is not a single CVSS v3.0 or v3.1 base vector';
  }
  const parts = trimmed.split('/');
  if (!/^CVSS:3\.[01]$/i.test(parts[0] ?? '')) {
    return 'it does not start with CVSS:3.0 or CVSS:3.1';
  }
  const m: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const [k, v] = part.split(':');
    if (k && v) m[k.toUpperCase()] = v.toUpperCase();
  }
  const scopeChanged = m.S === 'C';
  const bad: string[] = [];
  if (AV[m.AV] === undefined) bad.push('AV');
  if (AC[m.AC] === undefined) bad.push('AC');
  if (UI[m.UI] === undefined) bad.push('UI');
  if ((scopeChanged ? PR_CHANGED : PR_UNCHANGED)[m.PR] === undefined) bad.push('PR');
  if (CIA[m.C] === undefined) bad.push('C');
  if (CIA[m.I] === undefined) bad.push('I');
  if (CIA[m.A] === undefined) bad.push('A');
  if (bad.length) return `required base metric ${bad.join(', ')} is missing or not a CVSS v3 value`;
  return 'it is not a CVSS v3.0 or v3.1 base vector';
}

/** Score a string that has already passed the present-and-string check. Same formula as before. */
function computeCvssV3BaseScore(vector: string): number | null {
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

/**
 * Parse a CVSS v3.0/v3.1 base vector.
 *
 * - No vector (`null`, `undefined`, `''`, whitespace) → `{ score: null }` and
 *   no diagnostic. An absent score stays absent.
 * - A vector that parses → `{ score }` with the same base score as before,
 *   including `0` when every impact metric is None.
 * - Anything else that was supplied → `{ score: null, diagnostic }`. The
 *   diagnostic names the parse failure and the next step. It does not quote
 *   the supplied value.
 */
export function parseCvssV3(vector: unknown): CvssParseResult {
  if (vector == null) return { score: null };
  if (typeof vector !== 'string') {
    return { score: null, diagnostic: cvssDiagnostic('it was not a CVSS vector string') };
  }
  if (!vector.trim()) return { score: null };
  const score = computeCvssV3BaseScore(vector);
  if (score != null) return { score };
  return { score: null, diagnostic: cvssDiagnostic(cvssFailureReason(vector)) };
}

/**
 * Compute the CVSS v3 base score (0–10) from a vector string, or null when the
 * vector is absent or not a parseable v3 base vector. Null does not distinguish
 * those two cases — use {@link parseCvssV3} when a parse failure must not be
 * reported as a missing score.
 */
export function cvssV3BaseScore(vector: string | null | undefined): number | null {
  return parseCvssV3(vector).score;
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
