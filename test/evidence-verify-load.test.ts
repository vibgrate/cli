import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { main } from '../src/cli.js';
import { DSSE_PAYLOAD_TYPE } from '../src/engine/attest.js';
import {
  EvidenceBundleLoadError,
  buildEvidenceStatement,
  loadEvidenceBundle,
  signEvidenceStatement,
  verifyEvidenceEnvelope,
} from '../src/reporting/commands/evidence/bundle.js';
import type { ExposureResult } from '../src/reporting/commands/evidence/types.js';
import { CliError, ExitCode } from '../src/util/exit.js';

/**
 * A truncated, invalid, or schema-broken evidence bundle must fail as an
 * operator error: what went wrong, how to restore it, non-zero exit, and
 * none of the file's bytes.
 */

// Distinct file bytes. A token-shaped value here trips the secret scan.
const SECRET = 'placeholder-file-contents-must-not-leak';
const RESTORE = 'Restore the bundle, or re-create it with `vg evidence exposure --bundle`';
const EVIDENCE_PREDICATE = 'https://vibgrate.com/attestation/regulatory-evidence/v1';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  delete process.env.VG_EVIDENCE_VERIFY_TEST;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-evidence-verify-'));
  dirs.push(dir);
  return dir;
}

function resultFixture(): ExposureResult {
  return {
    schemaVersion: 'evidence-1',
    regime: 'cra',
    advisory: { id: 'CVE-2026-1000', sourceProvenance: 'local', kevListed: false },
    overallStatus: 'not-affected',
    products: [],
    meta: {
      evidenceId: 'ev_fixture',
      dataPackVersion: 'none',
      kernelVersion: 'test',
      timestamp: { source: 'local-clock', value: '2026-01-01T00:00:00.000Z' },
    },
  };
}

function signedBundle(dir: string, result: ExposureResult = resultFixture()): { pubPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const envelope = signEvidenceStatement(buildEvidenceStatement(result, '1.0.0'), privateKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence.intoto.jsonl'), `${JSON.stringify(envelope)}\n`);
  fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return { pubPem };
}

function writeEnvelope(dir: string, body: string, resultBody?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence.intoto.jsonl'), body);
  if (resultBody !== undefined) fs.writeFileSync(path.join(dir, 'result.json'), resultBody);
}

function assertSafe(err: EvidenceBundleLoadError): void {
  expect(err).toBeInstanceOf(EvidenceBundleLoadError);
  expect(err).toBeInstanceOf(CliError);
  expect(err.name).toBe('EvidenceBundleLoadError');
  expect(err.code).toBe(ExitCode.ERROR);
  expect(err.code).not.toBe(0);
  expect(err.message).toContain(RESTORE);
  expect(err.message).not.toContain(SECRET);
  expect(err.message).not.toContain('ghp_');
  expect(err.message).not.toContain('Unexpected token');
  expect(err.message).not.toContain('Unexpected end');
  expect(err.message).not.toContain('SyntaxError');
  expect(err.message).not.toMatch(/\n/);
  expect(process.env.VG_EVIDENCE_VERIFY_TEST).toBe(SECRET);
  expect(err.message).not.toContain('VG_EVIDENCE_VERIFY_TEST');
}

function catchLoad(bundlePath: string): EvidenceBundleLoadError {
  process.env.VG_EVIDENCE_VERIFY_TEST = SECRET;
  let caught: unknown;
  try {
    loadEvidenceBundle(bundlePath);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(EvidenceBundleLoadError);
  const err = caught as EvidenceBundleLoadError;
  assertSafe(err);
  return err;
}

function envelopeShell(statement: unknown): string {
  return `${JSON.stringify({
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(JSON.stringify(statement), 'utf8').toString('base64'),
    signatures: [],
  })}\n`;
}

describe('loadEvidenceBundle', () => {
  it('loads a signed bundle and verifies it when the signer is pinned', () => {
    const dir = tempDir();
    const { pubPem } = signedBundle(dir);
    const loaded = loadEvidenceBundle(dir);
    expect(loaded.result?.schemaVersion).toBe('evidence-1');
    expect(verifyEvidenceEnvelope(loaded.envelope, { publicKeyPem: pubPem, result: loaded.result }).status).toBe('verified');
  });

  it('still reports failed when a readable result no longer matches the signed digest', () => {
    const dir = tempDir();
    const result = resultFixture();
    const { pubPem } = signedBundle(dir, result);
    const tampered: ExposureResult = { ...result, overallStatus: 'affected' };
    fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(tampered, null, 2)}\n`);
    const loaded = loadEvidenceBundle(dir);
    expect(verifyEvidenceEnvelope(loaded.envelope, { publicKeyPem: pubPem, result: loaded.result }).status).toBe('failed');
  });

  it('rejects a truncated envelope without echoing file contents', () => {
    const dir = tempDir();
    signedBundle(dir);
    const file = path.join(dir, 'evidence.intoto.jsonl');
    const full = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, `${full.slice(0, Math.max(8, Math.floor(full.length / 2)))}${SECRET}`);
    const err = catchLoad(dir);
    expect(err.kind).toBe('corrupt');
    expect(err.message).toMatch(/evidence envelope is truncated or not valid JSON/);
  });

  it('rejects invalid JSON without echoing file contents', () => {
    const dir = tempDir();
    writeEnvelope(dir, `not-json ${SECRET}\n`);
    const err = catchLoad(path.join(dir, 'evidence.intoto.jsonl'));
    expect(err.kind).toBe('corrupt');
    expect(err.message).toMatch(/evidence envelope is truncated or not valid JSON/);
  });

  it('rejects a schema this vg cannot read without echoing the document', () => {
    const dir = tempDir();
    writeEnvelope(dir, envelopeShell({
      _type: 'https://in-toto.io/Statement/v1',
      predicateType: 'https://vibgrate.com/attestation/code-graph/v1',
      predicate: { note: SECRET },
      leaked: SECRET,
    }));
    const err = catchLoad(dir);
    expect(err.kind).toBe('schema');
    expect(err.message).toContain('https://vibgrate.com/attestation/code-graph/v1');
    expect(err.message).toContain(EVIDENCE_PREDICATE);
  });

  it('does not echo a predicate type that is not an attestation token', () => {
    const dir = tempDir();
    writeEnvelope(dir, envelopeShell({
      _type: 'https://in-toto.io/Statement/v1',
      predicateType: SECRET,
      predicate: { note: SECRET },
    }));
    const err = catchLoad(dir);
    expect(err.kind).toBe('schema');
    expect(err.message).toMatch(/cannot read/);
    expect(err.message).not.toContain('schema `');
  });

  it('rejects a truncated result.json beside a readable envelope', () => {
    const dir = tempDir();
    signedBundle(dir);
    const resultPath = path.join(dir, 'result.json');
    const full = fs.readFileSync(resultPath, 'utf8');
    fs.writeFileSync(resultPath, `${full.slice(0, Math.floor(full.length / 2))}${SECRET}`);
    const err = catchLoad(dir);
    expect(err.kind).toBe('corrupt');
    expect(err.message).toMatch(/evidence result is truncated or not valid JSON/);
  });

  it('rejects a result schema this vg cannot read', () => {
    const dir = tempDir();
    signedBundle(dir);
    fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify({
      schemaVersion: 'evidence-0',
      note: SECRET,
      overallStatus: 'affected',
    })}\n`);
    const err = catchLoad(dir);
    expect(err.kind).toBe('schema');
    expect(err.message).toContain('schema `evidence-0`');
    expect(err.message).toContain('evidence-1');
  });

  it('reports a missing bundle as not found, not a load failure', () => {
    const dir = tempDir();
    const missing = path.join(dir, 'absent');
    expect(() => loadEvidenceBundle(missing)).toThrow(CliError);
    try {
      loadEvidenceBundle(missing);
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect(err).not.toBeInstanceOf(EvidenceBundleLoadError);
      expect((err as CliError).code).toBe(ExitCode.NOT_FOUND);
      expect((err as CliError).message).toMatch(/no evidence\.intoto\.jsonl/);
      expect((err as CliError).message).not.toContain('ENOENT');
    }
  });
});

describe('vg evidence verify', () => {
  async function runVerify(args: string[]): Promise<{ exits: number[]; stderr: string; stdout: string }> {
    const exits: number[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write');
    const logSpy = vi.spyOn(console, 'log');
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code ?? -1);
      return undefined as never;
    }) as typeof process.exit);
    const strip = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, '');

    await main(['node', 'vg', 'evidence', 'verify', ...args]);
    await new Promise((resolve) => setImmediate(resolve));
    const stderr = strip(errSpy.mock.calls.map((call) => String(call[0])).join(''));
    const stdout = strip(logSpy.mock.calls.map((call) => call.map((part) => String(part)).join(' ')).join('\n'));
    return { exits, stderr, stdout };
  }

  it('exits non-zero from the CLI entry on a truncated bundle, without a stack', async () => {
    const dir = tempDir();
    writeEnvelope(dir, `{"payload":"${SECRET}"`);
    const { exits, stderr } = await runVerify([dir]);
    expect(exits).toEqual([ExitCode.ERROR]);
    expect(stderr).toContain('error:');
    expect(stderr).toContain(RESTORE);
    expect(stderr).toContain('truncated or not valid JSON');
    expect(stderr).not.toContain(SECRET);
    expect(stderr).not.toContain('Unexpected token');
    expect(stderr).not.toContain('SyntaxError');
    expect(stderr).not.toContain('re-run with --json');
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it('exits non-zero on invalid JSON and on a schema mismatch', async () => {
    const dir = tempDir();
    writeEnvelope(dir, `not-json ${SECRET}\n`);
    const invalid = await runVerify([path.join(dir, 'evidence.intoto.jsonl')]);
    expect(invalid.exits).toEqual([ExitCode.ERROR]);
    expect(invalid.stderr).toContain('truncated or not valid JSON');
    expect(invalid.stderr).not.toContain(SECRET);
    expect(invalid.stderr).not.toMatch(/\n\s+at /);

    const schemaDir = tempDir();
    writeEnvelope(schemaDir, envelopeShell({
      _type: 'https://in-toto.io/Statement/v9',
      leaked: SECRET,
    }));
    const schema = await runVerify([schemaDir]);
    expect(schema.exits).toEqual([ExitCode.ERROR]);
    expect(schema.stderr).toContain('schema `https://in-toto.io/Statement/v9`');
    expect(schema.stderr).toContain(RESTORE);
    expect(schema.stderr).not.toContain(SECRET);
    expect(schema.stderr).not.toContain('SyntaxError');
    expect(schema.stderr).not.toMatch(/\n\s+at /);
  });

  it('still prints an honest unverified state for a readable bundle', async () => {
    const dir = tempDir();
    signedBundle(dir);
    const { exits, stdout, stderr } = await runVerify([dir]);
    expect(exits).toEqual([]);
    expect(stdout).toMatch(/UNVERIFIED/);
    expect(stderr).not.toContain(SECRET);
    expect(process.exitCode).toBe(ExitCode.GATE_FAILED);
  });
});
