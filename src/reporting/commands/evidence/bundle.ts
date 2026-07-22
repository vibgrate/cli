// ── Evidence bundle: build, sign (DSSE/Ed25519), verify offline ──
//
// Reuses the code-graph signing spine (engine/attest.ts primitives): an in-toto
// Statement in a DSSE envelope, Ed25519 over the PAE, embedded public key so the
// envelope self-verifies for integrity, and honest trust states — a bundle we
// cannot cryptographically check is `unverified`, never a fabricated pass.
//
// Build-gap (tracked): RFC 3161 timestamping. The bundle records its timestamp
// as `local-clock`, never dressed as a trusted TSA token.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { dssePae, DSSE_PAYLOAD_TYPE, keyId, generateKeypair, type DsseEnvelope } from '../../../engine/attest.js';
import { CliError, ExitCode } from '../../../util/exit.js';
import { exposureSubjectDigest } from './exposure.js';
import type { Advisory, ExposureResult, Regime, Release } from './types.js';

export const EVIDENCE_PREDICATE_TYPE = 'https://vibgrate.com/attestation/regulatory-evidence/v1';
export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';

export interface EvidencePredicate {
  tool: { name: 'vg'; version: string };
  regime: string;
  advisoryId: string;
  overallStatus: string;
  evidenceId: string;
  resultDigest: string;
  kernelVersion: string;
}

export interface EvidenceStatement {
  _type: string;
  subject: { name: string; digest: { sha256: string } }[];
  predicateType: string;
  predicate: EvidencePredicate;
}

export function buildEvidenceStatement(result: ExposureResult, version: string): EvidenceStatement {
  const resultDigest = exposureSubjectDigest(result);
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: 'result.json', digest: { sha256: resultDigest } }],
    predicateType: EVIDENCE_PREDICATE_TYPE,
    predicate: {
      tool: { name: 'vg', version },
      regime: result.regime,
      advisoryId: result.advisory.id,
      overallStatus: result.overallStatus,
      evidenceId: result.meta.evidenceId,
      resultDigest,
      kernelVersion: result.meta.kernelVersion,
    },
  };
}

export function signEvidenceStatement(statement: EvidenceStatement, privateKey: crypto.KeyObject): DsseEnvelope {
  const body = Buffer.from(JSON.stringify(statement), 'utf8');
  const pae = dssePae(DSSE_PAYLOAD_TYPE, body);
  const sig = crypto.sign(null, pae, privateKey);
  const publicKey = crypto.createPublicKey(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: body.toString('base64'),
    signatures: [
      {
        keyid: keyId(publicKey),
        sig: sig.toString('base64'),
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    ],
  };
}

export type EvidenceVerifyStatus = 'verified' | 'unverified' | 'failed';

export interface EvidenceVerifyResult {
  status: EvidenceVerifyStatus;
  signatureValid: boolean;
  signerPinned: boolean;
  digestMatches?: boolean;
  reason: string;
  evidenceId?: string;
  regime?: string;
  advisoryId?: string;
  overallStatus?: string;
}

/**
 * Verify a DSSE evidence envelope, optionally against the accompanying
 * result.json. Honest states: `verified` only when the signature checks AND the
 * signer is pinned (trusted) AND the result digest matches; `failed` on a bad
 * signature or a result that no longer matches; `unverified` when it is
 * cryptographically intact but the signer is not pinned.
 */
export function verifyEvidenceEnvelope(
  env: DsseEnvelope,
  opts: { publicKeyPem?: string; result?: ExposureResult } = {},
): EvidenceVerifyResult {
  let statement: EvidenceStatement;
  let body: Buffer;
  try {
    body = Buffer.from(env?.payload ?? '', 'base64');
    const parsed = JSON.parse(body.toString('utf8')) as EvidenceStatement;
    if (!parsed || typeof parsed !== 'object' || !parsed.predicate) throw new Error('missing predicate');
    statement = parsed;
  } catch {
    return { status: 'failed', signatureValid: false, signerPinned: false, reason: 'malformed evidence envelope (not a valid in-toto statement)' };
  }

  const pae = dssePae(env.payloadType, body);
  const sig0 = env.signatures?.[0];
  const sig = sig0?.sig ? Buffer.from(sig0.sig, 'base64') : Buffer.alloc(0);
  let signatureValid = false;
  let signerPinned = false;
  try {
    if (sig0 && sig.length) {
      if (opts.publicKeyPem) {
        const pinned = crypto.createPublicKey(opts.publicKeyPem);
        signatureValid = crypto.verify(null, pae, pinned, sig);
        signerPinned = signatureValid;
      } else if (sig0.publicKey) {
        const embedded = crypto.createPublicKey(sig0.publicKey);
        signatureValid = crypto.verify(null, pae, embedded, sig);
      }
    }
  } catch {
    signatureValid = false;
    signerPinned = false;
  }

  const digestMatches = opts.result ? exposureSubjectDigest(opts.result) === statement.predicate.resultDigest : undefined;

  let status: EvidenceVerifyStatus;
  let reason: string;
  if (!signatureValid) {
    status = 'failed';
    reason = sig0 ? 'signature verification failed' : 'no signature in envelope';
  } else if (digestMatches === false) {
    status = 'failed';
    reason = 'result.json no longer matches the signed digest (content changed since signing)';
  } else if (signerPinned) {
    status = 'verified';
    reason = digestMatches === true ? 'signature valid, signer trusted, result digest matches' : 'signature valid, signer trusted';
  } else {
    status = 'unverified';
    reason = 'signature valid but signer not pinned — pass --pub with the published Vibgrate trust root to establish trust';
  }

  return {
    status,
    signatureValid,
    signerPinned,
    digestMatches,
    reason,
    evidenceId: statement.predicate.evidenceId,
    regime: statement.predicate.regime,
    advisoryId: statement.predicate.advisoryId,
    overallStatus: statement.predicate.overallStatus,
  };
}

const DEFAULT_KEY = 'attest-key.pem';

/** Resolve the Ed25519 signing key, minting a default one on first use (loud). */
export function resolveSigningKey(root: string, explicit?: string): { key: crypto.KeyObject; keyPath: string; minted: boolean } {
  const chosen = explicit ?? process.env.VG_ATTEST_KEY;
  const keyPath = chosen ? path.resolve(chosen) : path.join(root, '.vibgrate', DEFAULT_KEY);
  let minted = false;
  if (!fs.existsSync(keyPath)) {
    if (chosen) throw new CliError(`signing key not found: ${chosen}`, ExitCode.USAGE_ERROR);
    const kp = generateKeypair();
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, kp.privatePem, { mode: 0o600 });
    fs.writeFileSync(`${keyPath}.pub`, kp.publicPem);
    minted = true;
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  } catch {
    throw new CliError(`could not read an Ed25519 private key from ${keyPath}`, ExitCode.USAGE_ERROR);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new CliError(`evidence signing requires an Ed25519 key, but ${keyPath} is ${key.asymmetricKeyType ?? 'unknown'}`, ExitCode.USAGE_ERROR);
  }
  return { key, keyPath, minted };
}

export interface WriteBundleInput {
  outDir: string;
  result: ExposureResult;
  advisory: Advisory;
  releases: Release[];
  regime: Regime;
  envelope?: DsseEnvelope;
  /** RFC 3161 TimeStampResp bytes over the result digest, if a TSA was used. */
  timestampToken?: Buffer;
  cliVersion: string;
}

/** Write a self-contained, third-party-verifiable evidence bundle to disk. */
export function writeBundle(input: WriteBundleInput): string {
  const dir = input.outDir;
  fs.mkdirSync(path.join(dir, 'inputs', 'releases'), { recursive: true });

  const write = (rel: string, data: unknown) =>
    fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(data, null, 2)}\n`);

  write('result.json', input.result);
  write(path.join('inputs', 'advisory.json'), input.advisory);
  for (const rel of input.releases) {
    const safe = `${rel.productId}@${rel.version}`.replace(/[^A-Za-z0-9._@-]/g, '_');
    write(path.join('inputs', 'releases', `${safe}.json`), rel);
  }
  write(path.join('inputs', 'datapack.lock'), { dataPackVersion: input.result.meta.dataPackVersion, kernelVersion: input.result.meta.kernelVersion });

  // Every field in the deterministic answer is machine-derived. No model, no
  // human entry in this path — provenance says so explicitly.
  write('provenance.json', {
    method: 'deterministic',
    modelDrafted: [],
    humanEntered: [],
    note: 'Every value in result.json is computed deterministically from the frozen manifests and the advisory. No language model contributed to any figure.',
  });

  write('manifest.json', {
    asserts: 'exposure determination for a single advisory against frozen release manifests',
    regime: { id: input.regime.id, name: input.regime.name, jurisdiction: input.regime.jurisdiction },
    tool: { name: 'vg', version: input.cliVersion },
    evidenceId: input.result.meta.evidenceId,
    timestamp: input.result.meta.timestamp,
    disclaimer: input.regime.disclaimer,
  });

  if (input.envelope) {
    fs.writeFileSync(path.join(dir, 'evidence.intoto.jsonl'), `${JSON.stringify(input.envelope)}\n`);
  }

  if (input.timestampToken) {
    fs.writeFileSync(path.join(dir, 'timestamp.tsr'), input.timestampToken);
  }

  fs.writeFileSync(path.join(dir, 'VERIFY.md'), verifyDoc(input));
  return dir;
}

function verifyDoc(input: WriteBundleInput): string {
  const signed = Boolean(input.envelope);
  return [
    '# Verifying this evidence bundle',
    '',
    'This bundle is self-contained. A third party can verify it **offline**, with no',
    'Vibgrate account and no network connection.',
    '',
    '## With the Vibgrate CLI',
    '',
    '```',
    'vg evidence verify <this-directory>',
    '```',
    '',
    signed
      ? 'The command recomputes the canonical digest of `result.json` (excluding the\nvolatile `meta` block), reconstructs the DSSE Pre-Authentication Encoding, and\nverifies the Ed25519 signature in `evidence.intoto.jsonl`. Pass `--pub <key.pem>`\nwith the published Vibgrate trust root to move the result from `unverified` to\n`verified`.'
      : 'This bundle was written **unsigned** (no signing key was available). It records\nthe deterministic answer but carries no signature — treat it as `unverified`.',
    '',
    '## What the trust states mean',
    '',
    '- `verified` — the signature checks **and** the signer is trusted **and** the',
    '  result digest matches. Nothing has changed since signing.',
    '- `unverified` — cryptographically intact but the signer is not pinned, or the',
    '  bundle is unsigned. We never fabricate a pass.',
    '- `failed` — the signature is bad or `result.json` no longer matches its digest.',
    '',
    input.timestampToken
      ? `Timestamp: an RFC 3161 token is included as \`timestamp.tsr\` (trusted time\n${input.result.meta.timestamp.value}). Verify it fully with your TSA's CA:\n\`\`\`\nopenssl ts -verify -in timestamp.tsr -data result.json -CAfile <tsa-ca.pem>\n\`\`\`\n\`vg evidence verify\` confirms the token's imprint binds to result.json and\nsurfaces the trusted time; it does not re-verify the TSA signature chain.`
      : `Timestamp source: \`${input.result.meta.timestamp.source}\` — this bundle carries no RFC 3161 token (pass \`--tsa <url>\` to add one).`,
    '',
    input.regime.disclaimer,
    '',
  ].join('\n');
}
