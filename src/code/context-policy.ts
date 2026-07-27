/**
 * Context-policy learning cycle (Fusion Runtime Phase 7).
 *
 * schemaVersion: context-policy-patch/0
 *
 * Ranking / capsule policy changes NEVER apply from a single task. They are
 * proposed as a signed, versioned patch after offline benchmark significance,
 * then adopted only by bumping the production pin ({@link CONTEXT_POLICY_VERSION}
 * in run-provenance.ts) in a release PR.
 *
 * This module is pure proposal + verify helpers. It does not write production
 * policy and does not talk to the network.
 */

import * as crypto from 'node:crypto';
import { canonicalize, hashString } from '../engine/hash.js';
import { CONTEXT_POLICY_VERSION } from './run-provenance.js';
import { CAPSULE_RANKING_VERSION } from './capsule.js';

export const CONTEXT_POLICY_PATCH_SCHEMA_VERSION = 'context-policy-patch/0' as const;

export interface BenchmarkSignificance {
  /** ContextBench / fusion pack id used for the measurement. */
  corpusId: string;
  /** Paired arms, e.g. capsule vs metadata. */
  arms: string[];
  /** FCS (first-capsule sufficiency) after the proposed change. */
  fcs?: number | null;
  /** ZNS@1 rate after the proposed change. */
  znsAt1?: number | null;
  /** Minimum sample size that justified significance. */
  nTasks: number;
  /** Free-text summary of the statistical test (no secrets). */
  summary: string;
}

export interface ContextPolicyPatch {
  schemaVersion: typeof CONTEXT_POLICY_PATCH_SCHEMA_VERSION;
  /** Proposed pin, e.g. context-policy@2026.08.0 */
  proposedPolicyVersion: string;
  /** Current production pin this patch is based on. */
  basePolicyVersion: string;
  /** Ranking pin the patch expects (often co-bumped). */
  rankingVersion: string;
  /** What changed in plain language. */
  changeSummary: string;
  significance: BenchmarkSignificance;
  /** blake3 over the canonical patch body (excluding signature). */
  contentHash: string;
  /** Optional Ed25519 signature over contentHash (hex). */
  signature?: {
    keyid: string;
    sig: string;
    publicKeyPem?: string;
  };
}

export interface BuildContextPolicyPatchInput {
  proposedPolicyVersion: string;
  basePolicyVersion?: string;
  rankingVersion?: string;
  changeSummary: string;
  significance: BenchmarkSignificance;
}

/**
 * Build an unsigned policy patch. Pure — does not apply anything.
 * Rejects proposals that would pin from a trivial sample (nTasks < 10).
 */
export function buildContextPolicyPatch(input: BuildContextPolicyPatchInput): ContextPolicyPatch {
  if (!input.proposedPolicyVersion.trim()) {
    throw new Error('proposedPolicyVersion is required');
  }
  if (input.significance.nTasks < 10) {
    throw new Error(
      'context-policy patches require nTasks ≥ 10 (never promote from a single task or tiny sample)',
    );
  }
  const body = {
    schemaVersion: CONTEXT_POLICY_PATCH_SCHEMA_VERSION,
    proposedPolicyVersion: input.proposedPolicyVersion.trim(),
    basePolicyVersion: input.basePolicyVersion ?? CONTEXT_POLICY_VERSION,
    rankingVersion: input.rankingVersion ?? CAPSULE_RANKING_VERSION,
    changeSummary: input.changeSummary.trim(),
    significance: {
      corpusId: input.significance.corpusId,
      arms: [...input.significance.arms].sort(),
      fcs: input.significance.fcs ?? null,
      znsAt1: input.significance.znsAt1 ?? null,
      nTasks: input.significance.nTasks,
      summary: input.significance.summary,
    },
  };
  return {
    ...body,
    contentHash: hashString(canonicalize(body)),
  };
}

/** Sign a patch with an Ed25519 private key (same family as graph attest). */
export function signContextPolicyPatch(
  patch: ContextPolicyPatch,
  privateKey: crypto.KeyObject,
): ContextPolicyPatch {
  const publicKey = crypto.createPublicKey(
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  );
  const keyid = crypto
    .createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 16);
  const sig = crypto.sign(null, Buffer.from(patch.contentHash, 'utf8'), privateKey);
  return {
    ...patch,
    signature: {
      keyid,
      sig: sig.toString('base64'),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
}

export type PolicyPatchVerifyStatus = 'unsigned' | 'valid' | 'invalid' | 'hash-mismatch';

/**
 * Verify content hash and optional signature. Never auto-applies — callers
 * only use this to gate a human release PR that bumps CONTEXT_POLICY_VERSION.
 */
export function verifyContextPolicyPatch(patch: ContextPolicyPatch): {
  status: PolicyPatchVerifyStatus;
  reason: string;
} {
  const { signature, contentHash, ...rest } = patch;
  const expected = hashString(
    canonicalize({
      schemaVersion: rest.schemaVersion,
      proposedPolicyVersion: rest.proposedPolicyVersion,
      basePolicyVersion: rest.basePolicyVersion,
      rankingVersion: rest.rankingVersion,
      changeSummary: rest.changeSummary,
      significance: rest.significance,
    }),
  );
  if (expected !== contentHash) {
    return { status: 'hash-mismatch', reason: 'contentHash does not match canonical body' };
  }
  if (!signature?.sig || !signature.publicKeyPem) {
    return { status: 'unsigned', reason: 'patch has no signature (hash ok)' };
  }
  try {
    const pub = crypto.createPublicKey(signature.publicKeyPem);
    const ok = crypto.verify(null, Buffer.from(contentHash, 'utf8'), pub, Buffer.from(signature.sig, 'base64'));
    if (!ok) return { status: 'invalid', reason: 'signature verification failed' };
    return { status: 'valid', reason: `signed by keyid ${signature.keyid}` };
  } catch (e) {
    return { status: 'invalid', reason: `signature verify error: ${(e as Error).message}` };
  }
}

/**
 * Production adoption gate: a patch may only become the new pin when signed,
 * hash-valid, based on the current pin, and nTasks ≥ 10. Still does not write
 * the pin — that is a deliberate source edit in a release PR.
 */
export function canProposeProductionBump(
  patch: ContextPolicyPatch,
  currentPin: string = CONTEXT_POLICY_VERSION,
): { ok: boolean; reason: string } {
  if (patch.basePolicyVersion !== currentPin) {
    return {
      ok: false,
      reason: `basePolicyVersion ${patch.basePolicyVersion} ≠ current pin ${currentPin}`,
    };
  }
  if (patch.proposedPolicyVersion === currentPin) {
    return { ok: false, reason: 'proposed version equals current pin (no-op)' };
  }
  if (patch.significance.nTasks < 10) {
    return { ok: false, reason: 'nTasks < 10' };
  }
  const v = verifyContextPolicyPatch(patch);
  if (v.status !== 'valid') {
    return { ok: false, reason: `patch not release-ready: ${v.reason}` };
  }
  return {
    ok: true,
    reason: `ready for release PR: bump CONTEXT_POLICY_VERSION to ${patch.proposedPolicyVersion}`,
  };
}
