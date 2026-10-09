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
import { rethrowOutputWrite, serializeJsonOutput, writeOutputFileSync } from '../../../util/output-file.js';
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

const EVIDENCE_RESULT_SCHEMA = 'evidence-1';
const RESTORE_BUNDLE =
  'Restore the original bundle, or write a new one with `vg evidence exposure --bundle <dir>`.';

/**
 * An evidence bundle on disk cannot be loaded for `vg evidence verify`.
 *
 * This is a read failure: the file is truncated, not JSON, or not a schema
 * this version can read. It is not a failure to serialize or write a bundle.
 * The message names what failed and how to restore the bundle. It never
 * includes file contents, environment values, or other secret material.
 * `code` is {@link ExitCode.ERROR} so the command exits non-zero.
 */
export class EvidenceBundleLoadError extends CliError {
  readonly isEvidenceBundleLoadError = true;
  readonly kind: 'corrupt' | 'schema';

  constructor(message: string, kind: 'corrupt' | 'schema') {
    super(message, ExitCode.ERROR);
    this.name = 'EvidenceBundleLoadError';
    this.kind = kind;
  }
}

export interface LoadedEvidenceBundle {
  /** Absolute path of the DSSE envelope that was read. */
  envelopePath: string;
  envelope: DsseEnvelope;
  /** Present when a sibling result.json was read and accepted. */
  result?: ExposureResult;
}

/**
 * Load the envelope (and result.json, when it sits beside the envelope) for
 * `vg evidence verify`.
 *
 * `bundlePath` may be a bundle directory or the envelope file itself. A
 * missing bundle is {@link CliError} with {@link ExitCode.NOT_FOUND}. A
 * present file that cannot be read, is truncated or not JSON, or is not a
 * schema this version can read throws {@link EvidenceBundleLoadError}.
 * The same bytes always produce the same error.
 */
export function loadEvidenceBundle(bundlePath: string): LoadedEvidenceBundle {
  const abs = path.resolve(bundlePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    if (nodeCode(err) === 'ENOENT') {
      throw new CliError(`no evidence.intoto.jsonl at ${bundlePath}`, ExitCode.NOT_FOUND);
    }
    throw new EvidenceBundleLoadError(unreadableMessage('bundle'), 'corrupt');
  }

  const envelopePath = stat.isDirectory() ? path.join(abs, 'evidence.intoto.jsonl') : abs;
  if (!fs.existsSync(envelopePath)) {
    throw new CliError(`no evidence.intoto.jsonl at ${bundlePath}`, ExitCode.NOT_FOUND);
  }

  const envelope = assertEnvelope(parseBundleJson(readUtf8(envelopePath, 'envelope'), 'envelope'));
  const resultPath = path.join(path.dirname(envelopePath), 'result.json');
  const result = fs.existsSync(resultPath)
    ? assertResult(parseBundleJson(readUtf8(resultPath, 'result'), 'result'))
    : undefined;
  return { envelopePath, envelope, result };
}

function nodeCode(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

function readUtf8(file: string, which: 'envelope' | 'result'): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    throw new EvidenceBundleLoadError(unreadableMessage(which), 'corrupt');
  }
}

/** Envelope files are JSONL: only the first record is the DSSE document. */
function firstJsonLine(text: string): string {
  const trimmed = text.trim();
  const newline = trimmed.indexOf('\n');
  const line = newline === -1 ? trimmed : trimmed.slice(0, newline);
  return line.trim();
}

function parseBundleJson(text: string, which: 'envelope' | 'result'): unknown {
  const body = which === 'envelope' ? firstJsonLine(text) : text.trim();
  if (!body) throw new EvidenceBundleLoadError(corruptMessage(which), 'corrupt');
  try {
    return JSON.parse(body);
  } catch {
    throw new EvidenceBundleLoadError(corruptMessage(which), 'corrupt');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A schema token we are willing to echo. Anything else stays out of the message. */
function echoableEvidenceSchema(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 16) return null;
  return /^evidence-\d{1,4}$/.test(value) ? value : null;
}

function assertEnvelope(value: unknown): DsseEnvelope {
  if (
    !isPlainObject(value) ||
    value.payloadType !== DSSE_PAYLOAD_TYPE ||
    typeof value.payload !== 'string' ||
    value.payload.length === 0 ||
    !isSignatureList(value.signatures)
  ) {
    throw new EvidenceBundleLoadError(envelopeShapeMessage(), 'schema');
  }
  return value as unknown as DsseEnvelope;
}

function isSignatureList(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const sig of value) {
    if (!isPlainObject(sig)) return false;
    if (typeof sig.keyid !== 'string' || typeof sig.sig !== 'string') return false;
    if (sig.publicKey !== undefined && typeof sig.publicKey !== 'string') return false;
  }
  return true;
}

function assertResult(value: unknown): ExposureResult {
  if (!isPlainObject(value)) {
    throw new EvidenceBundleLoadError(resultShapeMessage(), 'schema');
  }
  if (value.schemaVersion !== EVIDENCE_RESULT_SCHEMA) {
    throw new EvidenceBundleLoadError(resultSchemaMessage(value.schemaVersion), 'schema');
  }
  if (!isReadableResult(value)) {
    throw new EvidenceBundleLoadError(resultShapeMessage(), 'schema');
  }
  return value as unknown as ExposureResult;
}

function isReadableResult(value: Record<string, unknown>): boolean {
  return (
    typeof value.regime === 'string' &&
    isPlainObject(value.advisory) &&
    typeof value.overallStatus === 'string' &&
    Array.isArray(value.products) &&
    isPlainObject(value.meta)
  );
}

function corruptMessage(which: 'envelope' | 'result'): string {
  const subject = which === 'envelope' ? 'evidence envelope' : 'evidence result';
  return `The ${subject} is truncated or not valid JSON. ${RESTORE_BUNDLE}`;
}

function unreadableMessage(which: 'bundle' | 'envelope' | 'result'): string {
  const subject =
    which === 'bundle' ? 'evidence bundle' : which === 'envelope' ? 'evidence envelope' : 'evidence result';
  return `The ${subject} could not be read. ${RESTORE_BUNDLE}`;
}

function envelopeShapeMessage(): string {
  return `The evidence envelope is not a readable DSSE envelope. ${RESTORE_BUNDLE}`;
}

function resultShapeMessage(): string {
  return `The evidence result is not a readable evidence result. ${RESTORE_BUNDLE}`;
}

function resultSchemaMessage(version: unknown): string {
  const echoed = echoableEvidenceSchema(version);
  const got = echoed ? `schema \`${echoed}\`` : 'a schema this version of vg cannot read';
  return `The evidence result uses ${got} (this version reads ${EVIDENCE_RESULT_SCHEMA}). ${RESTORE_BUNDLE}`;
}

const DEFAULT_KEY = 'attest-key.pem';

/**
 * Resolve the Ed25519 signing key, minting a default one on first use (loud).
 * Shared by `vg evidence` and `vg review` — one key, one place, one story.
 */
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
    throw new CliError(`signing requires an Ed25519 key, but ${keyPath} is ${key.asymmetricKeyType ?? 'unknown'}`, ExitCode.USAGE_ERROR);
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
  const bundleOut = { flag: '--bundle' };
  try {
    fs.mkdirSync(path.join(dir, 'inputs', 'releases'), { recursive: true });
  } catch (err) {
    rethrowOutputWrite(dir, err, bundleOut);
  }

  const write = (rel: string, data: unknown) => {
    const file = path.join(dir, rel);
    writeOutputFileSync(file, `${serializeJsonOutput(file, data, { ...bundleOut, space: 2 })}\n`, bundleOut);
  };

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
    const envFile = path.join(dir, 'evidence.intoto.jsonl');
    writeOutputFileSync(envFile, `${serializeJsonOutput(envFile, input.envelope, bundleOut)}\n`, bundleOut);
  }

  if (input.timestampToken) {
    writeOutputFileSync(path.join(dir, 'timestamp.tsr'), input.timestampToken, bundleOut);
  }

  writeOutputFileSync(path.join(dir, 'VERIFY.md'), verifyDoc(input), bundleOut);
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
