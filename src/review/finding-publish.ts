/**
 * Publishable correctness rows for a GitHub App ingest.
 *
 * The App's `vg.review.findings.app.v1` currently types `kind` as
 * `dependency_drift` | `correctness`. This mapper emits a parallel JSON shape
 * the App can parse without importing the public CLI:
 *
 *   id / finding_key     — stable (`blast:…` / `arch:{rule}:{path}`)
 *   kind                 — `correctness` (never a second top-level kind)
 *   scanner_kind         — `blast_radius` | `architecture` (producer metadata)
 *   receipts             — existing capsule verification / scan / attest ids
 *   suggested_fix        — always null here; no computed PatchIR
 *
 * Blast-radius facts have no deterministic edit (unlike a declared-dependency
 * bump). Architecture-policy rows likewise have no computed patch here.
 * `proposeFindingFix` is a model-backed dry-run, not a patch we invent.
 */

import { BLAST_PRODUCER, CORRECTNESS_KIND } from './impact-findings.js';
import { ARCH_PRODUCER, isArchitectureFinding } from './finding-receipts.js';
import type { FindingSeverity, ReviewFinding, ReviewFindings } from './schemas.js';

export { CORRECTNESS_KIND };
export const BLAST_SCANNER_KIND = BLAST_PRODUCER;
export const ARCH_SCANNER_KIND = ARCH_PRODUCER;
export const REVIEW_CHECK_ID = 'vibgrate/review' as const;

export type SuggestedFixStatus = 'skipped_no_patch';
export type PublishScannerKind = typeof BLAST_SCANNER_KIND | typeof ARCH_SCANNER_KIND;
export type PublishSeverity = 'low' | 'medium' | 'high';

export interface CorrectnessPublishRow {
  /** Same value as `finding_key` — App ledgers store `finding.id` as the key. */
  id: string;
  finding_key: string;
  kind: typeof CORRECTNESS_KIND;
  /** Pack/producer metadata — not a second top-level kind. */
  scanner_kind: PublishScannerKind;
  review_check: typeof REVIEW_CHECK_ID;
  /** Blast-radius is low|medium; architecture may be high when the pack already uses that scale. */
  severity: PublishSeverity;
  confidence: number;
  claim: string;
  paths: string[];
  source: 'scanner';
  /** Existing capsule verification / scan / attest evidence ids. Empty when none exist. */
  receipts: string[];
  evidence_ids: string[];
  suggested_fix: null;
  suggested_fix_status: SuggestedFixStatus;
  suggested_fix_note: string;
}

const BLAST_SKIP_NOTE =
  'No automatic patch — blast-radius facts have no computed edit. `vg review propose` is a model-backed dry-run, not a deterministic bump.';

const ARCH_SKIP_NOTE =
  'No automatic patch — architecture-policy facts have no computed edit. `vg review propose` is a model-backed dry-run, not a deterministic bump.';

/** Clamp blast-radius so a publish row never carries high/critical (version-lag critical is out of scope). */
export function publishSeverity(severity: FindingSeverity): 'low' | 'medium' {
  return severity === 'medium' ? 'medium' : 'low';
}

/** Architecture pack scale is low|medium|high. Never invent critical. */
export function publishArchSeverity(severity: FindingSeverity): PublishSeverity {
  if (severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

export function isBlastRadiusFinding(finding: ReviewFinding): boolean {
  if (finding.kind !== CORRECTNESS_KIND) return false;
  if (finding.producer === BLAST_SCANNER_KIND) return true;
  return finding.id.startsWith('blast:');
}

export function isPublishableCorrectnessFinding(finding: ReviewFinding): boolean {
  return isBlastRadiusFinding(finding) || isArchitectureFinding(finding);
}

/**
 * Map Review findings to App-ingestible correctness rows: blast-radius and
 * architecture-policy scanner rows. Other kinds stay on the CLI findings document.
 */
export function exportCorrectnessPublishRows(findings: ReviewFindings | ReviewFinding[]): CorrectnessPublishRow[] {
  const list = Array.isArray(findings)
    ? findings
    : [...findings.architecture_findings, ...findings.security_findings];
  const rows: CorrectnessPublishRow[] = [];
  for (const finding of list) {
    if (!isPublishableCorrectnessFinding(finding)) continue;
    const blast = isBlastRadiusFinding(finding);
    const key = finding.id.trim() || finding.finding_key?.trim() || '';
    if (!key || /\s/.test(key)) continue;
    if (blast && !key.startsWith('blast:')) continue;
    if (!blast && !key.startsWith('arch:')) continue;
    const receipts = [...(finding.receipts ?? [])].sort((a, b) => a.localeCompare(b));
    rows.push({
      id: key,
      finding_key: key,
      kind: CORRECTNESS_KIND,
      scanner_kind: blast ? BLAST_SCANNER_KIND : ARCH_SCANNER_KIND,
      review_check: REVIEW_CHECK_ID,
      severity: blast ? publishSeverity(finding.severity) : publishArchSeverity(finding.severity),
      confidence: finding.confidence,
      claim: finding.claim,
      paths: [...finding.paths],
      source: 'scanner',
      receipts,
      evidence_ids: [...finding.evidence_ids],
      suggested_fix: null,
      suggested_fix_status: 'skipped_no_patch',
      suggested_fix_note: blast ? BLAST_SKIP_NOTE : ARCH_SKIP_NOTE,
    });
  }
  return rows.sort((a, b) => a.finding_key.localeCompare(b.finding_key));
}
