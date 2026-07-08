import * as crypto from 'node:crypto';
import { canonicalize } from './hash.js';
import { VERSION } from '../version.js';
import type { Toolchain, VgGraph } from '../schema.js';

/**
 * `vg attest` — a signed, reproducible attestation over the code graph.
 *
 * This is the moat made load-bearing: a consumer can cryptographically verify,
 * offline, that a graph was produced by a named toolchain over a named commit and
 * has not changed since. We sign an in-toto Statement wrapped in a DSSE envelope
 * with Ed25519 (`node:crypto`, zero dependencies) — interoperable with
 * `cosign verify-blob-attestation`. Ed25519 signatures are deterministic
 * (RFC 8032), so the same graph + key produce a byte-identical envelope.
 *
 * The subject digest excludes the graph's volatile `generatedAt`, so it is
 * reproducible across rebuilds of identical content — which is exactly what makes
 * the attestation verifiable rather than a timestamped snapshot.
 */

export const DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const VG_PREDICATE_TYPE = 'https://vibgrate.com/attestation/code-graph/v1';

export interface CommitInfo {
  sha?: string;
  shortSha?: string;
  branch?: string;
  dirty?: boolean; // uncommitted changes vs sha — never verified-clean when true
}

export interface AttestPredicate {
  tool: { name: 'vg'; version: string };
  toolchain?: Toolchain;
  corpusHash: string;
  graphDigest: string; // sha256 of the canonical graph (generatedAt excluded)
  counts: VgGraph['meta']['counts'];
  commit?: CommitInfo;
  sbomDigest?: string; // sha256 of an accompanying SBOM, if attested together
  timestamp?: string; // optional, opt-in (omitted by default for determinism)
}

export interface InTotoStatement {
  _type: string;
  subject: { name: string; digest: { sha256: string } }[];
  predicateType: string;
  predicate: AttestPredicate;
}

export interface DsseSignature {
  keyid: string;
  sig: string; // base64
  publicKey?: string; // PEM, embedded so the envelope self-verifies for integrity
}

export interface DsseEnvelope {
  payloadType: string;
  payload: string; // base64 of the Statement JSON
  signatures: DsseSignature[];
}

export function sha256Hex(input: string | Uint8Array): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * sha256 over the canonical graph with the volatile `generatedAt` excluded, so
 * two builds of identical content attest to the same digest.
 */
export function graphSubjectDigest(graph: VgGraph): string {
  const { generatedAt: _omit, ...rest } = graph;
  return sha256Hex(canonicalize(rest));
}

/** The 16-hex key id: a truncated sha256 over the SPKI DER public key. */
export function keyId(publicKey: crypto.KeyObject): string {
  return sha256Hex(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);
}

export interface StatementInput {
  commit?: CommitInfo;
  sbomDigest?: string;
  timestamp?: string;
}

export function buildStatement(graph: VgGraph, input: StatementInput = {}): InTotoStatement {
  const graphDigest = graphSubjectDigest(graph);
  const predicate: AttestPredicate = {
    tool: { name: 'vg', version: VERSION },
    toolchain: graph.provenance.toolchain,
    corpusHash: graph.provenance.corpusHash,
    graphDigest,
    counts: graph.meta.counts,
  };
  if (input.commit) predicate.commit = input.commit;
  if (input.sbomDigest) predicate.sbomDigest = input.sbomDigest;
  if (input.timestamp) predicate.timestamp = input.timestamp;
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: 'graph.json', digest: { sha256: graphDigest } }],
    predicateType: VG_PREDICATE_TYPE,
    predicate,
  };
}

/**
 * DSSE Pre-Authentication Encoding:
 *   "DSSEv1" SP len(type) SP type SP len(body) SP body
 * with lengths as ASCII decimal byte counts. Signing the PAE (not the raw body)
 * is what binds the payloadType to the signature.
 */
export function dssePae(payloadType: string, body: Uint8Array): Buffer {
  const typeBytes = Buffer.from(payloadType, 'utf8');
  const header = Buffer.from(
    `DSSEv1 ${typeBytes.length} ${payloadType} ${body.length} `,
    'utf8',
  );
  return Buffer.concat([header, Buffer.from(body)]);
}

/** Sign a statement, returning a self-contained DSSE envelope. */
export function signStatement(statement: InTotoStatement, privateKey: crypto.KeyObject): DsseEnvelope {
  const body = Buffer.from(JSON.stringify(statement), 'utf8');
  const pae = dssePae(DSSE_PAYLOAD_TYPE, body);
  const sig = crypto.sign(null, pae, privateKey);
  // Derive the public key from the private key (via its PEM, for @types/node compat).
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

export type AttestStatus = 'verified' | 'signature-valid' | 'failed';

export interface VerifyResult {
  status: AttestStatus;
  signatureValid: boolean;
  signerPinned: boolean; // signature verified against a caller-supplied trusted key
  digestMatches?: boolean; // recomputed graph digest matches the attested one
  dirty?: boolean; // the attested commit had uncommitted changes
  keyid: string;
  reason: string;
  statement: InTotoStatement;
}

/**
 * Verify an envelope. Honest states, never a fabricated pass:
 *   failed          — bad signature, or the on-disk graph no longer matches.
 *   signature-valid — cryptographically intact, but signer not pinned (or dirty).
 *   verified        — pinned signer + matching digest + clean tree.
 */
/** An empty statement for results where the envelope could not even be parsed. */
function emptyStatement(): InTotoStatement {
  return {
    _type: '',
    subject: [],
    predicateType: '',
    predicate: {
      tool: { name: 'vg', version: '' },
      corpusHash: '',
      graphDigest: '',
      counts: { nodes: 0, edges: 0, areas: 0, tests: 0, untested: 0 },
    },
  };
}

function failedResult(reason: string): VerifyResult {
  return {
    status: 'failed',
    signatureValid: false,
    signerPinned: false,
    keyid: '',
    reason,
    statement: emptyStatement(),
  };
}

export function verifyEnvelope(
  env: DsseEnvelope,
  opts: { publicKeyPem?: string; graph?: VgGraph } = {},
): VerifyResult {
  // A `.intoto.jsonl` is attacker-supplied input: every decode/parse/key step
  // must degrade to an honest `failed`, never crash the command.
  let body: Buffer;
  let statement: InTotoStatement;
  try {
    body = Buffer.from(env?.payload ?? '', 'base64');
    const parsed = JSON.parse(body.toString('utf8')) as InTotoStatement;
    if (!parsed || typeof parsed !== 'object' || !parsed.predicate) {
      throw new Error('missing predicate');
    }
    statement = parsed;
  } catch {
    return failedResult('malformed attestation payload (not a valid in-toto statement)');
  }

  const pae = dssePae(env.payloadType, body);
  const sig0 = env.signatures?.[0];
  const keyid = sig0?.keyid ?? '';
  const sig = sig0?.sig ? Buffer.from(sig0.sig, 'base64') : Buffer.alloc(0);

  let signatureValid = false;
  let signerPinned = false;
  try {
    if (sig0 && sig.length) {
      if (opts.publicKeyPem) {
        const pinnedKey = crypto.createPublicKey(opts.publicKeyPem);
        signatureValid = crypto.verify(null, pae, pinnedKey, sig);
        signerPinned = signatureValid;
      } else if (sig0.publicKey) {
        const embeddedKey = crypto.createPublicKey(sig0.publicKey);
        signatureValid = crypto.verify(null, pae, embeddedKey, sig);
      }
    }
  } catch {
    // Malformed key or signature bytes → not a valid signature (not a crash).
    signatureValid = false;
    signerPinned = false;
  }

  const digestMatches = opts.graph
    ? graphSubjectDigest(opts.graph) === statement.predicate.graphDigest
    : undefined;
  const dirty = statement.predicate.commit?.dirty;

  let status: AttestStatus;
  let reason: string;
  if (!signatureValid) {
    status = 'failed';
    reason = sig0 ? 'signature verification failed' : 'no signature in envelope';
  } else if (digestMatches === false) {
    status = 'failed';
    reason = 'graph.json no longer matches the attested digest (content changed since signing)';
  } else if (signerPinned && !dirty) {
    status = 'verified';
    reason =
      digestMatches === true
        ? 'signature valid, signer trusted, graph digest matches'
        : 'signature valid, signer trusted';
  } else {
    status = 'signature-valid';
    reason = dirty
      ? 'signature valid but the attested tree was dirty (uncommitted changes)'
      : 'signature valid but signer not pinned — pass --pub to establish trust';
  }

  return { status, signatureValid, signerPinned, digestMatches, dirty, keyid, reason, statement };
}

export interface GeneratedKeypair {
  privatePem: string;
  publicPem: string;
  keyid: string;
}

/** Mint a fresh Ed25519 keypair for signing attestations. */
export function generateKeypair(): GeneratedKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyid: keyId(publicKey),
  };
}

/** Serialize an envelope as a single-line `.intoto.jsonl` record (deterministic). */
export function serializeEnvelope(env: DsseEnvelope): string {
  return `${JSON.stringify(env)}\n`;
}

export function parseEnvelope(text: string): DsseEnvelope {
  const line = text.trim().split('\n')[0];
  return JSON.parse(line) as DsseEnvelope;
}
