// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { CvssDiagnostic, VulnSeverity } from '../types.js';
import { redactSecrets } from '../utils/redact.js';
import { WarningCodes } from '../../warnings/codes.js';

/**
 * Minimal, dependency-free CVSS v3.0/v3.1 base-score calculator.
 *
 * Advisories (OSV/GHSA) carry severity as a CVSS *vector string*, not a number.
 * To order findings and apply CRA severity thresholds we need the numeric base
 * score, so this implements the official base-score formula. It is deterministic
 * and offline. Temporal/environmental metrics are ignored (base score only).
 *
 * A vector that fails to parse is not a missing score and not a score of zero.
 * {@link parseCvssVector} keeps the three apart: `parsed` (including 0),
 * `missing` (no vector supplied), and `invalid` (a vector was supplied and
 * could not be scored, with a stable diagnostic).
 */

/** Stable code for every CVSS vector that was present but did not parse. */
export const CVSS_VECTOR_PARSE_FAILED = 'cvss-vector-parse-failed' as const;

/**
 * Outcome of reading a CVSS vector.
 * - `parsed` — a v3.0/v3.1 base score, including 0 when there is no impact.
 * - `missing` — null, undefined, or blank. No score was supplied.
 * - `invalid` — a non-blank vector that is not a scoreable v3 base vector.
 */
export type CvssParseResult =
  | { status: 'parsed'; score: number }
  | { status: 'missing' }
  | { status: 'invalid'; diagnostic: CvssDiagnostic };

const NEXT_STEP =
  'Replace it with a CVSS:3.0 or CVSS:3.1 base vector, or omit the vector and supply a numeric base score.';

const PREVIEW_MAX = 80;

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

function preview(vector: string): string {
  const redacted = redactSecrets(vector.trim()).replace(/\s+/g, ' ');
  if (redacted.length <= PREVIEW_MAX) return redacted;
  return `${redacted.slice(0, PREVIEW_MAX - 3)}...`;
}

function invalid(reason: string): CvssParseResult {
  const message = redactSecrets(
    `${WarningCodes.CVSS_UNPARSEABLE}: CVSS vector failed to parse (${CVSS_VECTOR_PARSE_FAILED}): ${reason}. ${NEXT_STEP}`,
  );
  return {
    status: 'invalid',
    diagnostic: { code: CVSS_VECTOR_PARSE_FAILED, warnCode: WarningCodes.CVSS_UNPARSEABLE, message },
  };
}

function readMetrics(parts: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const part of parts) {
    const [k, v] = part.split(':');
    if (k && v) m[k.toUpperCase()] = v.toUpperCase();
  }
  return m;
}

function metricProblem(
  metrics: Record<string, string>,
  key: string,
  allowed: Record<string, number>,
  expected: string,
): string | null {
  const value = metrics[key];
  if (value === undefined) return `${key} is missing (expected ${expected})`;
  if (allowed[value] === undefined) return `${key} is "${value}" (expected ${expected})`;
  return null;
}

/** Problems in canonical base-metric order, so the same vector always yields the same text. */
function baseMetricProblems(metrics: Record<string, string>): string[] {
  const problems: string[] = [];
  const add = (problem: string | null) => {
    if (problem) problems.push(problem);
  };
  add(metricProblem(metrics, 'AV', AV, 'N, A, L, or P'));
  add(metricProblem(metrics, 'AC', AC, 'L or H'));
  add(metricProblem(metrics, 'PR', metrics.S === 'C' ? PR_CHANGED : PR_UNCHANGED, 'N, L, or H'));
  add(metricProblem(metrics, 'UI', UI, 'N or R'));
  if (metrics.S === undefined) problems.push('S is missing (expected U or C)');
  else if (metrics.S !== 'U' && metrics.S !== 'C') problems.push(`S is "${metrics.S}" (expected U or C)`);
  add(metricProblem(metrics, 'C', CIA, 'H, L, or N'));
  add(metricProblem(metrics, 'I', CIA, 'H, L, or N'));
  add(metricProblem(metrics, 'A', CIA, 'H, L, or N'));
  return problems;
}

function baseScore(metrics: Record<string, string>): number {
  const scopeChanged = metrics.S === 'C';
  const av = AV[metrics.AV]!;
  const ac = AC[metrics.AC]!;
  const ui = UI[metrics.UI]!;
  const pr = (scopeChanged ? PR_CHANGED : PR_UNCHANGED)[metrics.PR]!;
  const c = CIA[metrics.C]!;
  const integ = CIA[metrics.I]!;
  const a = CIA[metrics.A]!;

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
 * Read a CVSS vector into a parsed score, a missing score, or a parse failure.
 * The same input always produces the same result. Credential-shaped text in a
 * failed vector is redacted before it is placed in the diagnostic.
 */
export function parseCvssVector(vector: string | null | undefined): CvssParseResult {
  if (vector == null || typeof vector !== 'string') return { status: 'missing' };
  const trimmed = vector.trim();
  if (!trimmed) return { status: 'missing' };

  const parts = trimmed.split('/');
  const version = parts[0] ?? '';
  if (!/^CVSS:3\.[01]$/i.test(version)) {
    if (/^CVSS:\d/i.test(version)) {
      return invalid(
        `${version.toUpperCase()} is not a scored version (only CVSS:3.0 and CVSS:3.1 base vectors are scored)`,
      );
    }
    return invalid(`"${preview(trimmed)}" is not a CVSS:3.0 or CVSS:3.1 base vector`);
  }

  const metrics = readMetrics(parts.slice(1));
  const problems = baseMetricProblems(metrics);
  if (problems.length > 0) {
    return invalid(`base metrics are incomplete or outside the CVSS v3 spec (${problems.join('; ')})`);
  }
  return { status: 'parsed', score: baseScore(metrics) };
}

/**
 * Compute the CVSS v3 base score (0–10) from a vector string, or null when the
 * vector is missing or not a parseable v3 base vector.
 *
 * Null here does **not** distinguish those two cases. Call {@link parseCvssVector}
 * when a failed vector must stay distinct from a missing score.
 */
export function cvssV3BaseScore(vector: string | null | undefined): number | null {
  const parsed = parseCvssVector(vector);
  return parsed.status === 'parsed' ? parsed.score : null;
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
