/**
 * Receipt signing — a detached Ed25519 signature over `digests.receipt`.
 *
 * One key story across the CLI: the same `.vibgrate/attest-key.pem` (or
 * `VG_ATTEST_KEY`) that `vg build --attest` and `vg evidence` sign with, the same
 * DSSE Pre-Authentication Encoding from `engine/attest.ts`, and the same honest
 * trust states as `vg evidence verify` — a receipt we cannot tie to a pinned
 * signer is `unverified`, never a fabricated pass.
 *
 * The message is the receipt digest, not the receipt. `receiptDigest()` already
 * covers every field except itself and `signature`, so signing the digest binds
 * the whole document while keeping the signed bytes short and canonical.
 * Ed25519 is deterministic (RFC 8032): the same receipt and key produce the same
 * signature, so `--generated-at` byte-determinism survives signing.
 */

import * as crypto from 'node:crypto';
import { dssePae, keyId } from '../engine/attest.js';
import { resolveSigningKey } from '../reporting/commands/evidence/bundle.js';
import {
  RECEIPT_SCHEMA,
  RECEIPT_SIGNATURE_PAYLOAD_TYPE,
  receiptDigest,
  type ReviewReceipt,
  type ReviewSignature,
} from './schemas.js';

/**
 * Resolve the signing key exactly the way Vibgrate Evidence does — explicit
 * path, then `$VG_ATTEST_KEY`, then `.vibgrate/attest-key.pem`, minted on first
 * use. Re-exported so the command surface has one import for "the key".
 */
export const resolveReviewSigningKey = resolveSigningKey;

/**
 * Seal and sign a receipt. Recomputes `digests.receipt` first so the signature
 * can never cover a stale digest, then signs the DSSE PAE of that digest.
 */
export function signReceipt(receipt: ReviewReceipt, privateKey: crypto.KeyObject): ReviewReceipt {
  const digest = receiptDigest(receipt);
  const pae = dssePae(RECEIPT_SIGNATURE_PAYLOAD_TYPE, Buffer.from(digest, 'utf8'));
  const sig = crypto.sign(null, pae, privateKey);
  // Derive the public key via PEM (as engine/attest.ts does, for @types/node compat).
  const publicKey = crypto.createPublicKey(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const signature: ReviewSignature = {
    alg: 'ed25519',
    payload_type: RECEIPT_SIGNATURE_PAYLOAD_TYPE,
    keyid: keyId(publicKey),
    sig: sig.toString('base64'),
    public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  return { ...receipt, digests: { ...receipt.digests, receipt: digest }, signature };
}

export type ReviewVerifyStatus = 'verified' | 'unverified' | 'failed';

export interface ReviewVerifyResult {
  status: ReviewVerifyStatus;
  /** The receipt carries a signature at all. */
  signed: boolean;
  signatureValid: boolean;
  /** The signature verified against a caller-supplied (trusted) key. */
  signerPinned: boolean;
  /** `digests.receipt` recomputes to the same value over the document as held. */
  digestMatches: boolean;
  keyid: string | null;
  reason: string;
  receiptId?: string;
  decision?: string;
  createdAt?: string;
  headSha?: string;
}

function failed(reason: string, partial: Partial<ReviewVerifyResult> = {}): ReviewVerifyResult {
  return {
    status: 'failed',
    signed: false,
    signatureValid: false,
    signerPinned: false,
    digestMatches: false,
    keyid: null,
    reason,
    ...partial,
  };
}

/**
 * Verify a receipt offline. Honest states, mirroring `vg evidence verify`:
 *
 *   verified    — signature valid, signer pinned via `--pub`, digest matches.
 *   unverified  — nothing is provably wrong, but trust is not established:
 *                 the signer is not pinned, or the receipt is unsigned.
 *   failed      — the digest no longer matches the contents, or the signature
 *                 does not verify (forged, altered, or a different key).
 *
 * The input is attacker-supplied: every parse and crypto step degrades to an
 * honest `failed`, never a crash.
 */
export function verifyReceipt(input: unknown, opts: { publicKeyPem?: string } = {}): ReviewVerifyResult {
  if (!input || typeof input !== 'object') {
    return failed('not a review receipt (expected a JSON object)');
  }
  const receipt = input as ReviewReceipt;
  if (receipt.schema_version !== RECEIPT_SCHEMA) {
    return failed(`not a ${RECEIPT_SCHEMA} document (schema_version is ${JSON.stringify(receipt.schema_version ?? null)})`);
  }
  const claimed = receipt.digests?.receipt;
  const identity: Partial<ReviewVerifyResult> = {
    receiptId: receipt.receipt_id,
    decision: receipt.decision,
    createdAt: receipt.created_at,
    headSha: receipt.git?.head_sha,
  };
  if (typeof claimed !== 'string' || !claimed) {
    return failed('receipt carries no digests.receipt — it was never sealed', identity);
  }

  let digestMatches = false;
  try {
    digestMatches = receiptDigest(receipt) === claimed;
  } catch {
    digestMatches = false;
  }

  const signature = receipt.signature;
  const signed = signature !== null && signature !== undefined;
  let signatureValid = false;
  let signerPinned = false;
  let keyid: string | null = null;
  let malformed = false;

  if (signed) {
    try {
      if (
        typeof signature !== 'object'
        || signature.alg !== 'ed25519'
        || typeof signature.payload_type !== 'string'
        || typeof signature.sig !== 'string'
      ) {
        throw new Error('malformed signature');
      }
      keyid = typeof signature.keyid === 'string' ? signature.keyid : null;
      const pae = dssePae(signature.payload_type, Buffer.from(claimed, 'utf8'));
      const sig = Buffer.from(signature.sig, 'base64');
      if (sig.length === 0) throw new Error('empty signature');
      if (opts.publicKeyPem) {
        const pinned = crypto.createPublicKey(opts.publicKeyPem);
        signatureValid = crypto.verify(null, pae, pinned, sig);
        signerPinned = signatureValid;
      } else if (typeof signature.public_key === 'string' && signature.public_key) {
        const embedded = crypto.createPublicKey(signature.public_key);
        signatureValid = crypto.verify(null, pae, embedded, sig);
      }
    } catch {
      // Malformed key or signature bytes → not a valid signature (not a crash).
      signatureValid = false;
      signerPinned = false;
      malformed = true;
    }
  }

  const base: ReviewVerifyResult = {
    status: 'failed',
    signed,
    signatureValid,
    signerPinned,
    digestMatches,
    keyid,
    reason: '',
    ...identity,
  };

  if (signed && !signatureValid) {
    return {
      ...base,
      status: 'failed',
      reason: malformed
        ? 'signature is malformed (not a detached Ed25519 signature over digests.receipt)'
        : opts.publicKeyPem
          ? 'signature does not verify against the pinned key — signed by a different key, or altered after signing'
          : 'signature verification failed — the receipt was altered after signing',
    };
  }
  if (!digestMatches) {
    return {
      ...base,
      status: 'failed',
      reason: 'receipt digest does not match its contents — the receipt was modified after `vg review` produced it',
    };
  }
  if (!signed) {
    return {
      ...base,
      status: 'unverified',
      reason: 'digest matches, but the receipt is unsigned — nothing establishes who produced it (run `vg review` without --no-sign)',
    };
  }
  if (signerPinned) {
    return { ...base, status: 'verified', reason: 'signature valid, signer trusted, receipt digest matches' };
  }
  return {
    ...base,
    status: 'unverified',
    reason: 'signature valid but signer not pinned — pass --pub <key.pem> with the signer\'s public key to establish trust',
  };
}
