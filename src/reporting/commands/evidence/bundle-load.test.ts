import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DSSE_PAYLOAD_TYPE } from '../../../engine/attest.js';
import { CliError, ExitCode } from '../../../util/exit.js';
import { EvidenceBundleLoadError, loadEvidenceBundle } from './bundle.js';

/**
 * `vg evidence verify` must fail closed on a truncated or schema-broken
 * bundle: a stable operator error, a non-zero exit, and none of the file
 * bytes or environment. That read error is not a serialize/write failure.
 */

const FILE_SECRET = 'ghp_EvidenceFileMustNotLeak';
const ENV_SECRET = 'npm_EvidenceEnvMustNotLeak';
const RESTORE = 'Restore the original bundle, or write a new one with `vg evidence exposure --bundle <dir>`.';
const WRITE_FAILURE = /cannot write|output could not be serialized|choose another --/;

const dirs: string[] = [];

afterEach(() => {
  delete process.env.VG_EVIDENCE_SECRET;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-evidence-load-'));
  dirs.push(dir);
  return dir;
}

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from('{}', 'utf8').toString('base64'),
    signatures: [{ keyid: 'abc', sig: 'AA==' }],
    ...over,
  };
}

function result(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'evidence-1',
    regime: 'cra',
    advisory: { id: 'CVE-2026-0001', sourceProvenance: 'test', kevListed: false },
    overallStatus: 'not-affected',
    products: [],
    meta: {
      evidenceId: 'ev-test',
      dataPackVersion: 'none',
      kernelVersion: 'evidence-1',
      timestamp: { source: 'local-clock', value: '2026-01-01T00:00:00.000Z' },
    },
    ...over,
  };
}

function writeEnvelope(dir: string, body: string): string {
  const file = path.join(dir, 'evidence.intoto.jsonl');
  fs.writeFileSync(file, body);
  return file;
}

function assertLoadError(err: unknown, kind: 'corrupt' | 'schema', message: string): EvidenceBundleLoadError {
  expect(err).toBeInstanceOf(EvidenceBundleLoadError);
  const load = err as EvidenceBundleLoadError;
  expect(load).toBeInstanceOf(CliError);
  expect(load.name).toBe('EvidenceBundleLoadError');
  expect(load.kind).toBe(kind);
  expect(load.code).toBe(ExitCode.ERROR);
  expect(load.code).not.toBe(0);
  expect(load.message).toBe(message);
  expect(load.message).toContain(RESTORE);
  expect(load.message).not.toContain(FILE_SECRET);
  expect(load.message).not.toContain(ENV_SECRET);
  expect(load.message).not.toContain('ghp_');
  expect(load.message).not.toContain('npm_');
  expect(load.message).not.toContain('Unexpected token');
  expect(load.message).not.toContain('Unexpected end');
  expect(load.message).not.toMatch(WRITE_FAILURE);
  expect(load.message).not.toMatch(/\n\s*at /);
  expect(load.stack ?? '').not.toContain(FILE_SECRET);
  return load;
}

function catchLoad(bundlePath: string): unknown {
  process.env.VG_EVIDENCE_SECRET = ENV_SECRET;
  try {
    loadEvidenceBundle(bundlePath);
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('loadEvidenceBundle', () => {
  it('loads a readable envelope and a pretty-printed result', () => {
    const dir = temp();
    const env = envelope();
    writeEnvelope(dir, `${JSON.stringify(env)}\n`);
    fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(result(), null, 2)}\n`);
    const loaded = loadEvidenceBundle(dir);
    expect(loaded.envelope).toEqual(env);
    expect(loaded.result).toMatchObject({ schemaVersion: 'evidence-1', meta: { evidenceId: 'ev-test' } });
    expect(loaded.envelopePath).toBe(path.join(dir, 'evidence.intoto.jsonl'));
  });

  it('rejects a truncated envelope without echoing file or env contents', () => {
    const dir = temp();
    const file = writeEnvelope(
      dir,
      `{"payloadType":"${DSSE_PAYLOAD_TYPE}","note":"${FILE_SECRET}","payload":"`,
    );
    const again = catchLoad(dir);
    const first = catchLoad(file);
    expect(assertLoadError(
      first,
      'corrupt',
      `The evidence envelope is truncated or not valid JSON. ${RESTORE}`,
    ).message).toBe((again as EvidenceBundleLoadError).message);
  });

  it('rejects invalid JSON that is not a truncated prefix', () => {
    const dir = temp();
    writeEnvelope(dir, `not-json ${FILE_SECRET}\n`);
    assertLoadError(
      catchLoad(dir),
      'corrupt',
      `The evidence envelope is truncated or not valid JSON. ${RESTORE}`,
    );
  });

  it('rejects a truncated result.json beside a readable envelope', () => {
    const dir = temp();
    writeEnvelope(dir, `${JSON.stringify(envelope())}\n`);
    fs.writeFileSync(path.join(dir, 'result.json'), `{"schemaVersion":"evidence-1","note":"${FILE_SECRET}"`);
    assertLoadError(
      catchLoad(dir),
      'corrupt',
      `The evidence result is truncated or not valid JSON. ${RESTORE}`,
    );
  });

  it('rejects a schema this version cannot read without echoing the token', () => {
    const dir = temp();
    writeEnvelope(dir, `${JSON.stringify(envelope())}\n`);
    fs.writeFileSync(
      path.join(dir, 'result.json'),
      JSON.stringify(result({ schemaVersion: FILE_SECRET, note: FILE_SECRET })),
    );
    assertLoadError(
      catchLoad(dir),
      'schema',
      `The evidence result uses a schema this version of vg cannot read (this version reads evidence-1). ${RESTORE}`,
    );
  });

  it('names an evidence schema version that is safe to echo', () => {
    const dir = temp();
    writeEnvelope(dir, `${JSON.stringify(envelope())}\n`);
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result({ schemaVersion: 'evidence-2' })));
    assertLoadError(
      catchLoad(dir),
      'schema',
      `The evidence result uses schema \`evidence-2\` (this version reads evidence-1). ${RESTORE}`,
    );
  });

  it('rejects JSON that is not a DSSE envelope', () => {
    const dir = temp();
    writeEnvelope(dir, `${JSON.stringify({ schemaVersion: 'evidence-1', note: FILE_SECRET })}\n`);
    assertLoadError(
      catchLoad(dir),
      'schema',
      `The evidence envelope is not a readable DSSE envelope. ${RESTORE}`,
    );
  });

  it('rejects an evidence-1 document that is missing the result shape', () => {
    const dir = temp();
    writeEnvelope(dir, `${JSON.stringify(envelope())}\n`);
    fs.writeFileSync(path.join(dir, 'result.json'), `{"schemaVersion":"evidence-1","note":"${FILE_SECRET}"}`);
    assertLoadError(
      catchLoad(dir),
      'schema',
      `The evidence result is not a readable evidence result. ${RESTORE}`,
    );
  });

  it('reports a missing bundle as not found, without a read error', () => {
    const dir = temp();
    const missing = path.join(dir, 'missing-bundle');
    let caught: unknown;
    try {
      loadEvidenceBundle(missing);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect(caught).not.toBeInstanceOf(EvidenceBundleLoadError);
    const err = caught as CliError;
    expect(err.code).toBe(ExitCode.NOT_FOUND);
    expect(err.message).toBe(`no evidence.intoto.jsonl at ${missing}`);
    expect(err.message).not.toContain('ENOENT');
    expect(err.message).not.toMatch(WRITE_FAILURE);
  });
});

describe('vg evidence verify CLI', () => {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const cli = path.join(pkgRoot, 'src/cli.ts');

  function run(bundlePath: string): { status: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string; error?: Error } {
    const res = spawnSync(process.execPath, ['--import', 'tsx', cli, 'evidence', 'verify', bundlePath], {
      cwd: pkgRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        NO_COLOR: '1',
        VIBGRATE_NO_KERNEL: '1',
        VIBGRATE_DSN: '',
        VG_EVIDENCE_SECRET: ENV_SECRET,
      },
    });
    return {
      status: res.status,
      signal: res.signal,
      stderr: res.stderr ?? '',
      stdout: res.stdout ?? '',
      error: res.error,
    };
  }

  function assertCli(bundlePath: string, message: string): void {
    const res = run(bundlePath);
    expect(res.error).toBeUndefined();
    expect(res.signal).toBeNull();
    expect(res.status).toBe(ExitCode.ERROR);
    expect(res.stderr).toContain(`error: ${message}`);
    expect(res.stderr).not.toContain(FILE_SECRET);
    expect(res.stderr).not.toContain(ENV_SECRET);
    expect(res.stderr).not.toContain('Unexpected token');
    expect(res.stderr).not.toContain('Unexpected end');
    expect(res.stderr).not.toContain('SyntaxError');
    expect(res.stderr).not.toMatch(/\bat (?:JSON\.parse|readFile|loadEvidenceBundle)/);
    expect(res.stderr).not.toMatch(WRITE_FAILURE);
    expect(res.stdout).not.toContain(FILE_SECRET);
    expect(res.stdout).not.toContain(ENV_SECRET);
    expect(res.stdout).not.toMatch(/\b(VERIFIED|UNVERIFIED|FAILED)\b/);
  }

  it('exits non-zero on a truncated bundle and does not print a stack', () => {
    const dir = temp();
    writeEnvelope(dir, `{"note":"${FILE_SECRET}","payload":`);
    assertCli(dir, `The evidence envelope is truncated or not valid JSON. ${RESTORE}`);
  }, 60_000);

  it('exits non-zero on invalid JSON', () => {
    const dir = temp();
    writeEnvelope(dir, `{not json, "token":"${FILE_SECRET}"}`);
    assertCli(dir, `The evidence envelope is truncated or not valid JSON. ${RESTORE}`);
  }, 60_000);

  it('exits non-zero on a schema this version cannot read', () => {
    const dir = temp();
    writeEnvelope(dir, `${JSON.stringify(envelope())}\n`);
    fs.writeFileSync(
      path.join(dir, 'result.json'),
      JSON.stringify(result({ schemaVersion: 'evidence-2', leak: FILE_SECRET })),
    );
    assertCli(
      dir,
      `The evidence result uses schema \`evidence-2\` (this version reads evidence-1). ${RESTORE}`,
    );
  }, 60_000);
});
