/**
 * The schema verifier — the gate every findings document passes before policy
 * sees it (spec §1, §4.2).
 *
 * It rejects:
 *   - an invalid `vg.review.findings.v1` document
 *   - evidence ids that are not in the capsule (an invented citation)
 *   - a claimed flow with no graph or scanner fact behind it
 *   - the absolute claims `secure`, `no vulnerability`, `safe`, `approved`
 *   - a `decision` field, wherever it came from
 *
 * The verifier exists because a *model* will eventually write into this
 * document. It runs on deterministic scanner output too — a rule that only
 * fires against untrusted input is a rule nobody tests.
 */

import type { AnalysisCapsule, ReviewFinding, ReviewFindings } from './schemas.js';
import { FINDINGS_SCHEMA, TARGET_ALIGNMENTS } from './schemas.js';

export interface VerifyResult {
  schema_valid: boolean;
  evidence_ids_valid: boolean;
  /** Human-readable rejections. Empty when both flags above are true. */
  errors: string[];
}

/**
 * Absolute claims a findings document may never make. Matched as whole phrases
 * so "not safe" and "cannot prove this is secure" are still rejected — the
 * product does not get to assert either polarity of a security proof.
 */
const FORBIDDEN_CLAIMS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\b(is|are|remains?|stays?)\s+secure\b/i, label: 'secure' },
  { pattern: /\bno\s+vulnerabilit(y|ies)\b/i, label: 'no vulnerability' },
  { pattern: /\b(is|are)\s+safe\b/i, label: 'safe' },
  { pattern: /\b(is|are)\s+approved\b/i, label: 'approved' },
  { pattern: /\bvulnerability[- ]free\b/i, label: 'vulnerability-free' },
];

/**
 * Language that asserts runtime behaviour. A finding that claims one must also
 * carry hedging, because this product observes static structure, not execution.
 */
const RUNTIME_CLAIM = /\b(at runtime|when (?:it |this )?runs|in production|will (?:always |never )?(?:throw|fail|return|execute)|executes?)\b/i;
const UNCERTAINTY = /\b(may|might|could|appears?|likely|unlikely|not observed|unverified|no runtime|static(?:ally)?)\b/i;

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

function verifyFinding(
  finding: ReviewFinding,
  domain: 'architecture' | 'security',
  evidenceIds: Set<string>,
  errors: string[],
  invalidEvidence: { value: boolean },
): void {
  const where = `${domain} finding ${finding.id || '(no id)'}`;
  if (typeof finding.id !== 'string' || !finding.id) errors.push(`${where}: missing id`);
  if (typeof finding.kind !== 'string' || !finding.kind) errors.push(`${where}: missing kind`);
  if (!SEVERITIES.has(finding.severity)) errors.push(`${where}: invalid severity "${String(finding.severity)}"`);
  if (typeof finding.confidence !== 'number' || finding.confidence < 0 || finding.confidence > 1) {
    errors.push(`${where}: confidence must be a number in 0..1`);
  }
  if (typeof finding.claim !== 'string' || !finding.claim.trim()) errors.push(`${where}: missing claim`);
  if (!TARGET_ALIGNMENTS.includes(finding.target_alignment)) {
    errors.push(`${where}: invalid target_alignment "${String(finding.target_alignment)}"`);
  }
  if (typeof finding.remediation !== 'string' || !finding.remediation.trim()) {
    errors.push(`${where}: missing remediation`);
  }
  if (!Array.isArray(finding.paths)) errors.push(`${where}: paths must be an array`);

  // A finding with no citation is an assertion, not a finding.
  if (!Array.isArray(finding.evidence_ids) || finding.evidence_ids.length === 0) {
    errors.push(`${where}: claims a flow with no supporting graph or scanner fact`);
    invalidEvidence.value = true;
  } else {
    for (const id of finding.evidence_ids) {
      if (!evidenceIds.has(id)) {
        errors.push(`${where}: cites evidence id "${id}" that is not in the capsule`);
        invalidEvidence.value = true;
      }
    }
  }

  const prose = `${finding.claim ?? ''} ${finding.remediation ?? ''}`;
  for (const { pattern, label } of FORBIDDEN_CLAIMS) {
    if (pattern.test(prose)) errors.push(`${where}: makes the absolute claim "${label}"`);
  }
  if (RUNTIME_CLAIM.test(prose) && !UNCERTAINTY.test(prose)) {
    errors.push(`${where}: asserts runtime behaviour without stating the uncertainty (nothing was executed)`);
  }
}

export function verifyFindings(findings: ReviewFindings, capsule: AnalysisCapsule): VerifyResult {
  const errors: string[] = [];
  const invalidEvidence = { value: false };

  if (findings?.schema_version !== FINDINGS_SCHEMA) {
    errors.push(`expected schema_version ${FINDINGS_SCHEMA}, got ${String(findings?.schema_version)}`);
    return { schema_valid: false, evidence_ids_valid: false, errors };
  }
  // Findings never decide. A `decision` on this document is a layer violation,
  // whether a model wrote it or a future refactor leaked it in.
  if ('decision' in (findings as unknown as Record<string, unknown>)) {
    errors.push('findings carry a `decision` field — only policy may decide');
  }
  if (!Array.isArray(findings.architecture_findings)) errors.push('architecture_findings must be an array');
  if (!Array.isArray(findings.security_findings)) errors.push('security_findings must be an array');
  if (!Array.isArray(findings.unknowns)) errors.push('unknowns must be an array');
  if (!Array.isArray(findings.required_checks)) errors.push('required_checks must be an array');
  if (!Array.isArray(findings.change_class)) errors.push('change_class must be an array');

  const evidenceIds = new Set(capsule.evidence.map((e) => e.id));
  for (const f of findings.architecture_findings ?? []) {
    verifyFinding(f, 'architecture', evidenceIds, errors, invalidEvidence);
  }
  for (const f of findings.security_findings ?? []) {
    verifyFinding(f, 'security', evidenceIds, errors, invalidEvidence);
  }

  // Duplicate ids would make `vg review explain <id>` ambiguous.
  const ids = [...(findings.architecture_findings ?? []), ...(findings.security_findings ?? [])].map((f) => f.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const id of new Set(dupes)) errors.push(`duplicate finding id "${id}"`);

  return {
    schema_valid: errors.length === 0,
    evidence_ids_valid: !invalidEvidence.value,
    errors,
  };
}
