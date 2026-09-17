/**
 * Cite existing capsule verification (and already-emitted scan / attest)
 * facts on a Review finding. Does not invent a receipt system — only ids
 * the capsule already holds are attached.
 */

import type { AnalysisCapsule, ReviewFinding } from './schemas.js';

/** Pack/producer metadata for architecture-policy rows. Not a second kind. */
export const ARCH_PRODUCER = 'architecture' as const;

export function normalizeFindingPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Key fragments: no whitespace (spaces would make the finding_key unstable). */
export function keyPart(value: string): string {
  return value.trim().replace(/\s+/g, '');
}

/**
 * Stable `id` / finding_key for an architecture-policy row.
 * Reuses the architecture pack's `rule` string when the scanner has one
 * (`layered:skip:routing→data-access`, `clean:domain→data-access`, …);
 * otherwise the scanner's own rule id (`peer_deviation`, …).
 * Repo-relative path. No head SHA. No spaces.
 */
export function archFindingKey(ruleId: string, path: string, extra?: string): string {
  const rule = keyPart(ruleId) || 'rule';
  const file = keyPart(normalizeFindingPath(path));
  const tail = extra ? `:${keyPart(normalizeFindingPath(extra))}` : '';
  return `arch:${rule}:${file}${tail}`;
}

/**
 * Existing capsule facts that already function as verification receipts.
 * Capsule `verification[]` first; then scan/attest evidence already present.
 */
export function collectVerificationReceiptIds(capsule: AnalysisCapsule, paths: string[]): string[] {
  const wanted = new Set(paths.map(normalizeFindingPath).filter(Boolean));
  const ids: string[] = [];
  const push = (id: string): void => {
    if (!id || ids.includes(id)) return;
    ids.push(id);
  };

  for (const fact of capsule.verification) {
    if (wanted.size > 0 && !wanted.has(normalizeFindingPath(fact.path))) continue;
    ensureVerificationEvidence(capsule, fact);
    push(fact.evidence_id);
  }

  for (const evidence of capsule.evidence) {
    if (!isExistingReceiptId(evidence.id)) continue;
    if (wanted.size > 0 && evidence.path && !wanted.has(normalizeFindingPath(evidence.path))) continue;
    if (wanted.size > 0 && !evidence.path) continue;
    push(evidence.id);
  }

  return ids.sort((a, b) => a.localeCompare(b));
}

function isExistingReceiptId(id: string): boolean {
  return id.startsWith('verify:') || id.startsWith('attest:') || id.startsWith('scan:');
}

/**
 * Mirror a capsule verification fact into `evidence[]` when it is missing.
 * The id and note are the fact's own — this is not a new receipt.
 */
function ensureVerificationEvidence(
  capsule: AnalysisCapsule,
  fact: AnalysisCapsule['verification'][number],
): void {
  if (capsule.evidence.some((e) => e.id === fact.evidence_id)) return;
  capsule.evidence.push({
    id: fact.evidence_id,
    kind: 'graph_node',
    path: normalizeFindingPath(fact.path),
    protected_finding: false,
    note: fact.detail,
  });
}

/** Attach existing verification receipts onto a finding. No-op when none exist. */
export function attachVerificationReceipts(
  finding: ReviewFinding,
  capsule: AnalysisCapsule,
): ReviewFinding {
  const extra = collectVerificationReceiptIds(capsule, finding.paths);
  if (extra.length === 0) {
    return finding.receipts?.length ? finding : { ...finding, receipts: [] };
  }
  const evidenceIds = [...finding.evidence_ids];
  for (const id of extra) {
    if (!evidenceIds.includes(id)) evidenceIds.push(id);
  }
  const receipts = [...new Set([...(finding.receipts ?? []), ...extra])].sort((a, b) =>
    a.localeCompare(b),
  );
  return { ...finding, evidence_ids: evidenceIds, receipts };
}

export function isArchitectureFinding(finding: ReviewFinding): boolean {
  if (finding.producer === ARCH_PRODUCER) return finding.kind === 'correctness';
  return finding.kind === 'correctness' && finding.id.startsWith('arch:');
}
