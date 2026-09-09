import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CAPSULE_SCHEMA,
  FINDINGS_SCHEMA,
  RECEIPT_SCHEMA,
  RECEIPT_SIGNATURE_PAYLOAD_TYPE,
  receiptDigest,
  type ReviewReceipt,
} from './schemas.js';
import { signReceipt, verifyReceipt } from './sign.js';
// Static, not `await import(...)` inside a test: loading the CLI entry is slow
// under a full parallel run and must not count against a test's timeout.
import { buildProgram, dispatch } from '../cli.js';

// ── fixtures ────────────────────────────────────────────────────────────────

function receipt(overrides: Partial<ReviewReceipt> = {}): ReviewReceipt {
  const r: ReviewReceipt = {
    schema_version: RECEIPT_SCHEMA,
    receipt_id: 'rvw_TEST',
    created_at: '2026-09-09T10:00:00.000Z',
    workspace_id: null,
    repo: { name: 'acme/ledger', remote: 'github.com/acme/ledger', repo_key: 'sha256:' + 'a'.repeat(64) },
    git: {
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      merge_base: null,
      ref: 'refs/heads/main',
      dirty: false,
      dirty_tree_hash: null,
    },
    decision: 'fail',
    enforcement: 'advisory',
    quick_path: false,
    change_class: ['security'],
    counts: { architecture: 0, security: 1, protected: 1, unknowns: 0 },
    findings: {
      schema_version: FINDINGS_SCHEMA,
      change_class: ['security'],
      architecture_findings: [],
      security_findings: [
        {
          id: 'sec-01',
          kind: 'unguarded_entrypoint',
          severity: 'high',
          confidence: 0.9,
          claim: 'New entrypoint with no authorization call.',
          evidence_ids: ['role:handler:1'],
          target_alignment: 'regression',
          remediation: 'Add an authorization check.',
          paths: ['src/api/admin.ts'],
          protected_finding: true,
        },
      ],
      unknowns: [],
      required_checks: [],
    },
    versions: {
      cli: '0.0.0-test',
      graph_schema: 'vg-graph/1.1',
      policy: 'vg-policy-0.1.0',
      model: 'none',
      quantization: null,
      capsule_schema: CAPSULE_SCHEMA,
    },
    digests: { capsule: 'sha256:' + '1'.repeat(64), findings: 'sha256:' + '2'.repeat(64), evidence: 'sha256:' + '3'.repeat(64), receipt: '' },
    verification: { protected_false_bless: false, schema_valid: true, evidence_ids_valid: true },
    signature: null,
    ...overrides,
  };
  r.digests.receipt = receiptDigest(r);
  return r;
}

const signer = crypto.generateKeyPairSync('ed25519');
const signerPub = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const stranger = crypto.generateKeyPairSync('ed25519');
const strangerPub = stranger.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** A deep copy through JSON — what a verifier actually holds after `--out`. */
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ── signing ─────────────────────────────────────────────────────────────────

describe('signReceipt', () => {
  it('produces a non-null detached Ed25519 signature over digests.receipt', () => {
    const signed = signReceipt(receipt(), signer.privateKey);
    expect(signed.signature).not.toBeNull();
    expect(signed.signature).toMatchObject({ alg: 'ed25519', payload_type: RECEIPT_SIGNATURE_PAYLOAD_TYPE });
    expect(signed.signature!.keyid).toMatch(/^[0-9a-f]{16}$/);
    expect(Buffer.from(signed.signature!.sig, 'base64')).toHaveLength(64);
    expect(signed.signature!.public_key).toContain('BEGIN PUBLIC KEY');
  });

  it('leaves the digest-covered content untouched — signing never changes what was decided', () => {
    const unsigned = receipt();
    const signed = signReceipt(unsigned, signer.privateKey);
    expect(signed.digests.receipt).toBe(unsigned.digests.receipt);
    expect(receiptDigest(signed)).toBe(unsigned.digests.receipt);
    expect(signed.decision).toBe(unsigned.decision);
  });

  it('is deterministic: the same receipt and key give byte-identical output', () => {
    const a = JSON.stringify(signReceipt(receipt(), signer.privateKey));
    const b = JSON.stringify(signReceipt(receipt(), signer.privateKey));
    expect(a).toBe(b);
  });

  it('re-seals a stale digest before signing, so the signature can never cover a lie', () => {
    const stale = receipt();
    stale.decision = 'pass'; // edited after sealing
    const signed = signReceipt(stale, signer.privateKey);
    expect(signed.digests.receipt).toBe(receiptDigest(signed));
    expect(verifyReceipt(roundTrip(signed), { publicKeyPem: signerPub }).status).toBe('verified');
  });
});

// ── verifying ───────────────────────────────────────────────────────────────

describe('verifyReceipt', () => {
  it('round-trips: verified with the pinned key, unverified without one', () => {
    const signed = roundTrip(signReceipt(receipt(), signer.privateKey));
    const pinned = verifyReceipt(signed, { publicKeyPem: signerPub });
    expect(pinned.status).toBe('verified');
    expect(pinned).toMatchObject({ signed: true, signatureValid: true, signerPinned: true, digestMatches: true });
    expect(pinned.keyid).toBe(signed.signature!.keyid);
    expect(pinned.receiptId).toBe('rvw_TEST');
    expect(pinned.decision).toBe('fail');

    const unpinned = verifyReceipt(signed);
    expect(unpinned.status).toBe('unverified');
    expect(unpinned).toMatchObject({ signed: true, signatureValid: true, signerPinned: false, digestMatches: true });
    expect(unpinned.reason).toContain('--pub');
  });

  it('fails a receipt whose decision was edited after signing', () => {
    const tampered = roundTrip(signReceipt(receipt(), signer.privateKey));
    tampered.decision = 'pass';
    const v = verifyReceipt(tampered, { publicKeyPem: signerPub });
    expect(v.status).toBe('failed');
    expect(v.digestMatches).toBe(false);
    expect(v.reason).toContain('modified after');
  });

  it('fails a tampered receipt even when the digest was recomputed to hide the edit', () => {
    const tampered = roundTrip(signReceipt(receipt(), signer.privateKey));
    tampered.counts.protected = 0;
    tampered.digests.receipt = receiptDigest(tampered);
    const v = verifyReceipt(tampered, { publicKeyPem: signerPub });
    expect(v.status).toBe('failed');
    expect(v.digestMatches).toBe(true);
    expect(v.signatureValid).toBe(false);
    // Without a pinned key the embedded public key still exposes the forgery.
    expect(verifyReceipt(tampered).status).toBe('failed');
  });

  it('fails against the wrong pinned key, and never reports the signer as pinned', () => {
    const signed = roundTrip(signReceipt(receipt(), signer.privateKey));
    const v = verifyReceipt(signed, { publicKeyPem: strangerPub });
    expect(v.status).toBe('failed');
    expect(v.signerPinned).toBe(false);
    expect(v.reason).toContain('pinned key');
  });

  it('fails when the embedded public key is swapped for another signer', () => {
    const signed = roundTrip(signReceipt(receipt(), signer.privateKey));
    signed.signature!.public_key = strangerPub;
    expect(verifyReceipt(signed).status).toBe('failed');
  });

  it('reports an unsigned but intact receipt as unverified — never verified', () => {
    const v = verifyReceipt(roundTrip(receipt()));
    expect(v.status).toBe('unverified');
    expect(v.signed).toBe(false);
    expect(v.digestMatches).toBe(true);
    // Pinning a key cannot promote an unsigned receipt.
    expect(verifyReceipt(roundTrip(receipt()), { publicKeyPem: signerPub }).status).toBe('unverified');
  });

  it('fails an unsigned receipt whose contents no longer match its digest', () => {
    const tampered = roundTrip(receipt());
    tampered.decision = 'pass';
    expect(verifyReceipt(tampered).status).toBe('failed');
  });

  it('degrades to failed on malformed input instead of crashing', () => {
    expect(verifyReceipt(null).status).toBe('failed');
    expect(verifyReceipt('not a receipt').status).toBe('failed');
    expect(verifyReceipt({ schemaVersion: '1.0' }).status).toBe('failed');
    const bad = roundTrip(signReceipt(receipt(), signer.privateKey));
    bad.signature!.sig = 'not-base64-of-a-signature';
    expect(verifyReceipt(bad, { publicKeyPem: signerPub }).status).toBe('failed');
    bad.signature!.public_key = '-----BEGIN PUBLIC KEY-----\ngarbage\n-----END PUBLIC KEY-----\n';
    expect(verifyReceipt(bad).status).toBe('failed');
    const legacy = { ...roundTrip(receipt()), signature: 'a-string-from-nowhere' } as unknown as ReviewReceipt;
    expect(verifyReceipt(legacy).status).toBe('failed');
  });

  it('binds the payload type: a signature replayed under another type does not verify', () => {
    const signed = roundTrip(signReceipt(receipt(), signer.privateKey));
    (signed.signature as { payload_type: string }).payload_type = 'application/vnd.in-toto+json';
    expect(verifyReceipt(signed, { publicKeyPem: signerPub }).status).toBe('failed');
  });
});

// ── CLI surface ─────────────────────────────────────────────────────────────

describe('vg review verify command surface', () => {
  it('registers `vg review verify <receipt> [--pub <key>]`', () => {
    const review = buildProgram().commands.find((c) => c.name() === 'review')!;
    const verify = review.commands.find((c) => c.name() === 'verify');
    expect(verify).toBeDefined();
    expect(verify!.options.map((o) => o.long)).toContain('--pub');
  });

  it('exposes --sign-key and --no-sign with the attribute names the handler reads', () => {
    const review = buildProgram().commands.find((c) => c.name() === 'review')!;
    expect(review.options.find((o) => o.long === '--sign-key')!.attributeName()).toBe('signKey');
    expect(review.options.find((o) => o.long === '--no-sign')!.attributeName()).toBe('sign');
  });

  it('routes `vg review verify receipt.json` to review, not to ask', () => {
    expect(dispatch(['review', 'verify', 'receipt.json'], '/repo')).toEqual(['review', 'verify', 'receipt.json']);
  });
});
