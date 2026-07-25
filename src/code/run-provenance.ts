/**
 * Run provenance (Fusion Runtime Phase 7).
 *
 * schemaVersion: run-provenance/0
 *
 * Every finished agent run records a content-hashed, policy-versioned summary:
 * which Model Execution Profile and security tier ran, which graph corpus and
 * ranking policy fed the capsule, and blake3 hashes of every mutation
 * (before/after/diff). Pure and deterministic — identical inputs always yield
 * the same provenance record. Learning / ranking changes only ship as a new
 * pinned `context-policy@YYYY.MM.*` string after benchmark significance.
 */

import { hashString, canonicalize } from '../engine/hash.js';
import { CAPSULE_RANKING_VERSION } from './capsule.js';
import type { FileChange } from './types.js';

export const RUN_PROVENANCE_SCHEMA_VERSION = 'run-provenance/0' as const;

/**
 * Pinned context / ranking / governance policy id for this release train.
 * Bump only with maintainer sign-off after ContextBench significance — never
 * from a single task outcome.
 */
export const CONTEXT_POLICY_VERSION = 'context-policy@2026.07.0' as const;

export type MutationOp = 'edit' | 'create' | 'delete';

export interface MutationProvenance {
  file: string;
  op: MutationOp;
  /** blake3 of pre-image content; null for creates. */
  beforeHash: string | null;
  /** blake3 of post-image content; null for deletes. */
  afterHash: string | null;
  /** blake3 of the unified diff text (empty string → null). */
  diffHash: string | null;
}

export interface VerificationStepProvenance {
  /** Ladder step kind or "command". */
  kind: string;
  /** Command string when present. */
  command?: string | null;
  passed: boolean;
  /** blake3 of truncated diagnostic/stdout when present. */
  diagnosticHash?: string | null;
}

export interface RunProvenance {
  schemaVersion: typeof RUN_PROVENANCE_SCHEMA_VERSION;
  policyVersion: string;
  rankingVersion: string | null;
  modelProfileId: string | null;
  securityTier: string | null;
  graphCorpusHash: string | null;
  mutations: MutationProvenance[];
  /**
   * blake3 over the canonical mutations array — stable fingerprint of what
   * the run wrote (empty mutations → hash of `[]`).
   */
  mutationsRootHash: string;
  /** Optional verification ladder / command outcomes for this run. */
  verification?: VerificationStepProvenance[];
  /** blake3 over canonical verification array when present. */
  verificationRootHash?: string | null;
}

export interface BuildRunProvenanceInput {
  modelProfileId?: string | null;
  securityTier?: string | null;
  graphCorpusHash?: string | null;
  rankingVersion?: string | null;
  policyVersion?: string | null;
  changes?: FileChange[];
  verification?: Array<{
    kind: string;
    command?: string | null;
    passed: boolean;
    diagnostic?: string | null;
  }>;
}

/** Infer create/edit/delete from before/after nullability. */
export function mutationOp(before: string | null, after: string | null): MutationOp {
  if (before === null && after !== null) return 'create';
  if (before !== null && after === null) return 'delete';
  return 'edit';
}

/** Content-hash one FileChange into a MutationProvenance entry. */
export function hashMutation(change: FileChange): MutationProvenance {
  const op = mutationOp(change.before, change.after);
  return {
    file: change.file,
    op,
    beforeHash: change.before === null ? null : hashString(change.before),
    afterHash: change.after === null ? null : hashString(change.after),
    diffHash: change.diff ? hashString(change.diff) : null,
  };
}

/**
 * Build a full run-provenance/0 record. Mutations are sorted by file path for
 * stability; root hash covers the sorted list only.
 */
export function buildRunProvenance(input: BuildRunProvenanceInput = {}): RunProvenance {
  const mutations = (input.changes ?? [])
    .map(hashMutation)
    .sort((a, b) => a.file.localeCompare(b.file) || a.op.localeCompare(b.op));
  const verification: VerificationStepProvenance[] | undefined = input.verification?.length
    ? input.verification
        .map((v) => ({
          kind: v.kind,
          command: v.command ?? null,
          passed: !!v.passed,
          diagnosticHash: v.diagnostic ? hashString(v.diagnostic.slice(0, 4000)) : null,
        }))
        .sort(
          (a, b) =>
            a.kind.localeCompare(b.kind) ||
            (a.command ?? '').localeCompare(b.command ?? '') ||
            Number(a.passed) - Number(b.passed),
        )
    : undefined;
  return {
    schemaVersion: RUN_PROVENANCE_SCHEMA_VERSION,
    policyVersion: input.policyVersion ?? CONTEXT_POLICY_VERSION,
    rankingVersion: input.rankingVersion ?? CAPSULE_RANKING_VERSION,
    modelProfileId: input.modelProfileId ?? null,
    securityTier: input.securityTier ?? null,
    graphCorpusHash: input.graphCorpusHash ?? null,
    mutations,
    mutationsRootHash: hashString(canonicalize(mutations)),
    ...(verification
      ? {
          verification,
          verificationRootHash: hashString(canonicalize(verification)),
        }
      : { verificationRootHash: null }),
  };
}
