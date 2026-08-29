/**
 * Vibgrate Review — the three wire schemas.
 *
 * These TypeScript shapes are normative for:
 *   - `vg.analysis.capsule.v1`  — the bounded evidence packet (internal; never
 *     uploaded by default)
 *   - `vg.review.findings.v1`   — what scanners (and, later, a local model)
 *     produce. **No `decision` field** — findings never decide.
 *   - `vg.review.receipt.v1`    — the public machine result: the `--format json`
 *     document and the Cloud ingest payload. `decision` is written *only* here,
 *     and only by policy.
 *
 * Layer ownership (spec §1) is enforced by the type system as far as it can be:
 * a `ReviewFindings` value has nowhere to put a decision, so a model that
 * emits one is rejected by {@link verifyFindings} rather than silently obeyed.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalize } from '../engine/hash.js';

export const CAPSULE_SCHEMA = 'vg.analysis.capsule.v1' as const;
export const FINDINGS_SCHEMA = 'vg.review.findings.v1' as const;
export const RECEIPT_SCHEMA = 'vg.review.receipt.v1' as const;

/** The policy module version stamped into every receipt (`versions.policy`). */
export const REVIEW_POLICY_VERSION = 'vg-policy-0.1.0' as const;

// ─── Capsule ────────────────────────────────────────────────────────────────

/** Capsule budget profile. Interactive is narrower than a PR/CI run. */
export type CapsuleProfile = 'interactive-narrow' | 'ci-wide';

/**
 * Token budgets (spec §4.1). These are medians for the compiled capsule, with a
 * hard cap that the compiler trims to regardless of profile.
 */
export const CAPSULE_BUDGETS: Record<CapsuleProfile, { median: number; cap: number }> = {
  'interactive-narrow': { median: 3_000, cap: 16_000 },
  'ci-wide': { median: 10_000, cap: 16_000 },
};

/** At most this many role-equivalent peers per role (spec §4.1). */
export const MAX_ROLE_PEERS = 5;

export type EvidenceKind =
  | 'graph_edge'
  | 'graph_node'
  | 'role'
  | 'policy'
  | 'dependency'
  | 'source_span';

export interface CapsuleEvidence {
  /** Stable, capsule-local id — `edge:1842`, `role:handler:17`, `policy:layering:4`. */
  id: string;
  kind: EvidenceKind;
  path?: string;
  start_line?: number;
  end_line?: number;
  /**
   * A deterministic fact policy may not let a model bless away: an unguarded
   * entrypoint, a validated taint flow, a known-vulnerable dependency.
   */
  protected_finding: boolean;
  /** Free-form, bounded detail (never source text). */
  note?: string;
}

export interface CapsuleIdentity {
  repo_pseudonym: string;
  language: string;
  graph_schema: string;
  analyzer_versions: { graph: string; scanners: string };
  profile: CapsuleProfile;
}

export interface CapsuleChangeSymbol {
  /** Graph node id, when the changed span resolved to one. */
  node_id?: string;
  name: string;
  kind: string;
  path: string;
  start_line: number;
  end_line: number;
}

export type ChangeOp = 'added' | 'modified' | 'removed' | 'renamed';

export interface CapsuleChangeEdge {
  /** Capsule evidence id for the edge. */
  evidence_id: string;
  kind: string;
  from_path: string;
  to_path: string;
  from_layer?: string;
  to_layer?: string;
}

export interface CapsuleChange {
  base_sha: string;
  head_sha: string;
  dirty: boolean;
  dirty_tree_hash: string | null;
  symbols: CapsuleChangeSymbol[];
  ops: { path: string; op: ChangeOp; added_lines: number; removed_lines: number }[];
  added_edges: CapsuleChangeEdge[];
  removed_edges: CapsuleChangeEdge[];
  contract_changes: { path: string; symbol: string; before: string; after: string }[];
}

export interface CapsuleRole {
  /** Capsule evidence id (`role:handler:17`). */
  evidence_id: string;
  path: string;
  role: string;
  layer: string;
  confidence: number;
  /** Whether this file is inside the change set. */
  changed: boolean;
}

export interface CapsuleArea {
  id: number;
  label: string;
  size: number;
  changed_members: number;
}

export interface CapsulePatterns {
  /** The layering shape the repository actually exhibits, when one dominates. */
  observed_dominant_pattern: string | null;
  /** The shape the repository *said* it wants (`.vibgrate/review.toml`). */
  declared_target_pattern: string | null;
  approved_exceptions: string[];
  legacy_pattern: string | null;
  /**
   * True when neither an observed majority nor a declared target could be
   * established. Mandatory even when false — majority is never silently
   * treated as correctness (spec §4.1).
   */
  unknown: boolean;
}

export interface CapsulePath {
  /** Capsule evidence id for the traversal. */
  evidence_id: string;
  from: string;
  to: string;
  hops: string[];
  /** Whether a guard (auth check, validation) was observed along the path. */
  guarded: boolean | null;
}

export interface CapsuleSecurityFact {
  evidence_id: string;
  kind: 'unguarded_entrypoint' | 'validated_taint' | 'known_vulnerable_dependency' | 'guard_removed';
  path: string;
  detail: string;
  protected_finding: boolean;
}

export interface CapsulePolicyFact {
  evidence_id: string;
  id: string;
  rule: string;
  source: 'review.toml' | 'derived';
}

export interface CapsuleVerificationFact {
  evidence_id: string;
  kind: 'test_covering_change' | 'no_test_covering_change';
  path: string;
  detail: string;
}

export interface AnalysisCapsule {
  schema_version: typeof CAPSULE_SCHEMA;
  identity: CapsuleIdentity;
  change: CapsuleChange;
  roles: CapsuleRole[];
  areas: CapsuleArea[];
  patterns: CapsulePatterns;
  paths: CapsulePath[];
  security: CapsuleSecurityFact[];
  policies: CapsulePolicyFact[];
  verification: CapsuleVerificationFact[];
  evidence: CapsuleEvidence[];
}

// ─── Findings ───────────────────────────────────────────────────────────────

export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export type TargetAlignment =
  | 'regression'
  | 'target'
  | 'legacy_consistent'
  | 'approved_exception'
  | 'unknown';

export const TARGET_ALIGNMENTS: readonly TargetAlignment[] = [
  'regression',
  'target',
  'legacy_consistent',
  'approved_exception',
  'unknown',
];

export interface ReviewFinding {
  id: string;
  kind: string;
  severity: FindingSeverity;
  /** 0..1. Calibrated for deterministic scanners; model-supplied otherwise. */
  confidence: number;
  claim: string;
  /** Must all resolve against the capsule's `evidence[]`. */
  evidence_ids: string[];
  target_alignment: TargetAlignment;
  remediation: string;
  paths: string[];
  /**
   * Mirror of the protected flag on this finding's evidence. Present on the
   * finding so a receipt consumer never has to re-derive it from the capsule
   * (which is not uploaded).
   */
  protected_finding?: boolean;
  /** Which producer emitted it — deterministic scanners, or the local model. */
  source?: 'scanner' | 'model';
}

export type ChangeClass = 'architecture' | 'security' | 'none';

export interface ReviewFindings {
  schema_version: typeof FINDINGS_SCHEMA;
  change_class: ChangeClass[];
  architecture_findings: ReviewFinding[];
  security_findings: ReviewFinding[];
  unknowns: string[];
  required_checks: string[];
}

// ─── Receipt ────────────────────────────────────────────────────────────────

export type ReviewDecision = 'pass' | 'needs_review' | 'fail' | 'undetermined';

export const REVIEW_DECISIONS: readonly ReviewDecision[] = [
  'pass',
  'needs_review',
  'fail',
  'undetermined',
];

export type ReviewEnforcement = 'advisory' | 'enforced';

export interface ReviewReceipt {
  schema_version: typeof RECEIPT_SCHEMA;
  receipt_id: string;
  created_at: string;
  workspace_id: string | null;
  repo: { name: string | null; remote: string | null; repo_key: string };
  git: {
    base_sha: string;
    head_sha: string;
    merge_base: string | null;
    ref: string | null;
    dirty: boolean;
    dirty_tree_hash: string | null;
  };
  decision: ReviewDecision;
  enforcement: ReviewEnforcement;
  quick_path: boolean;
  change_class: ChangeClass[];
  counts: {
    architecture: number;
    security: number;
    protected: number;
    unknowns: number;
  };
  findings: ReviewFindings;
  versions: {
    cli: string;
    graph_schema: string;
    policy: string;
    model: string;
    quantization: string | null;
    capsule_schema: typeof CAPSULE_SCHEMA;
  };
  digests: {
    capsule: string;
    findings: string;
    evidence: string;
    receipt: string;
  };
  verification: {
    /**
     * True only if policy was asked to emit `pass` while an unresolved
     * protected fact was present. It never is — the invariant holds — so this
     * field exists to prove the check ran, not to record a permitted state.
     */
    protected_false_bless: boolean;
    schema_valid: boolean;
    evidence_ids_valid: boolean;
  };
  signature: string | null;
}

/** The Cloud ingest envelope (spec §6.1). */
export interface ReviewIngestEnvelope {
  kind: 'review';
  schema_version: typeof RECEIPT_SCHEMA;
  workspace_id: string | null;
  pushed_at: string;
  cli_version: string;
  receipt: ReviewReceipt;
}

// ─── Digests ────────────────────────────────────────────────────────────────

/** `sha256:<hex>` over the canonical JSON of a value. */
export function digest(value: unknown): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalize(value))))}`;
}

/** `sha256:<hex>` over a raw UTF-8 string (paths, tree listings, remotes). */
export function digestString(input: string): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(input)))}`;
}

/**
 * The receipt digest covers every field *except* `digests.receipt` and
 * `signature`, so a verifier can recompute it from the receipt it holds.
 */
export function receiptDigest(receipt: ReviewReceipt): string {
  const { digests, signature: _signature, ...rest } = receipt;
  const { receipt: _self, ...digestsWithoutSelf } = digests;
  return digest({ ...rest, digests: digestsWithoutSelf });
}

/**
 * Lineage fingerprint for a finding (spec §6.2). Deliberately *not* an identity
 * across repositories — it exists so ingest can say "this commit introduced it"
 * and "that commit resolved it".
 */
export function findingFingerprint(finding: ReviewFinding): string {
  const primaryPath = [...finding.paths].sort()[0] ?? '';
  const normalizedClaim = finding.claim.trim().replace(/\s+/g, ' ').toLowerCase();
  return digestString(`${finding.kind}\0${primaryPath}\0${normalizedClaim}`);
}

/**
 * A ULID-ish receipt id: `rvw_` + Crockford-base32 of the timestamp and a
 * caller-supplied entropy source. The entropy is injectable so tests (and
 * `--generated-at`) can produce byte-identical receipts.
 */
export function receiptId(createdAtMs: number, entropy: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = '';
  let ms = Math.max(0, Math.floor(createdAtMs));
  for (let i = 0; i < 10; i++) {
    time = alphabet[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  const tail = bytesToHex(sha256(new TextEncoder().encode(entropy)))
    .slice(0, 16)
    .toUpperCase()
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, '0');
  return `rvw_${time}${tail}`;
}
