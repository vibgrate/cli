import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, ExitCode } from '../src/util/exit.js';
import { buildRelease, componentsFromSource } from '../src/reporting/commands/evidence/release.js';
import {
  SbomInputError,
  assertExternalSbom,
  parseSbomJson,
  sbomDisplayPath,
} from '../src/reporting/commands/sbom-input.js';

/**
 * An external SPDX or CycloneDX document that fails validation must fail
 * closed: non-zero exit, the path, the expected format, and what to do next.
 * The message is stable and does not include the document or a home directory.
 */

const SECRET = 'npm_SbomSecretMustNotLeak';
const REGENERATE = 'Regenerate the SBOM, then re-run the command.';
const CYCLONE_EXPECT = 'Expected CycloneDX JSON with bomFormat, specVersion, and version.';
const SPDX_EXPECT = 'Expected SPDX JSON with spdxVersion, SPDXID, and name.';
const JSON_EXPECT =
  'Expected CycloneDX JSON (bomFormat, specVersion, and version) or SPDX JSON (spdxVersion, SPDXID, and name).';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(pkgRoot, 'test/__fixtures__/invalid-sbom');
const cycloneFixture = path.join(fixtures, 'invalid.cdx.json');
const spdxFixture = path.join(fixtures, 'invalid.spdx.json');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-invalid-sbom-'));
  dirs.push(dir);
  return dir;
}

function assertInputError(err: unknown, kind: 'corrupt' | 'schema', message: string): void {
  expect(err).toBeInstanceOf(SbomInputError);
  const load = err as SbomInputError;
  expect(load).toBeInstanceOf(CliError);
  expect(load.name).toBe('SbomInputError');
  expect(load.kind).toBe(kind);
  expect(load.code).toBe(ExitCode.ERROR);
  expect(load.code).not.toBe(0);
  expect(load.message).toBe(message);
  expect(load.message).toContain(REGENERATE);
  expect(load.message).not.toContain(SECRET);
  expect(load.message).not.toContain('/home/');
  expect(load.message).not.toContain('/Users/');
  expect(load.message).not.toContain('Unexpected token');
  expect(load.message).not.toContain('Unexpected end');
  expect(load.message).not.toMatch(/\n\s*at /);
}

describe('sbomDisplayPath', () => {
  it('drops a home-directory prefix and keeps the rest of the path', () => {
    expect(sbomDisplayPath('/home/alice/proj/invalid.cdx.json')).toBe('proj/invalid.cdx.json');
    expect(sbomDisplayPath('/Users/alice/invalid.spdx.json')).toBe('invalid.spdx.json');
    expect(sbomDisplayPath('C:\\Users\\alice\\proj\\invalid.cdx.json')).toBe('proj/invalid.cdx.json');
    expect(sbomDisplayPath('invalid.cdx.json')).toBe('invalid.cdx.json');
    expect(sbomDisplayPath('/tmp/vg/invalid.cdx.json')).toBe('/tmp/vg/invalid.cdx.json');
  });
});

describe('assertExternalSbom', () => {
  const cycloneMessage = (label: string, reason: string): string =>
    `${label}: not a valid CycloneDX document (${reason}). ${CYCLONE_EXPECT} ${REGENERATE}`;
  const spdxMessage = (label: string, reason: string): string =>
    `${label}: not a valid SPDX document (${reason}). ${SPDX_EXPECT} ${REGENERATE}`;

  it('accepts a minimal CycloneDX document and a minimal SPDX document', () => {
    expect(
      assertExternalSbom(
        { bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, components: [{ name: 'left-pad', version: '1.3.0' }] },
        'ok.cdx.json',
      ),
    ).toBe('cyclonedx');
    expect(
      assertExternalSbom(
        { spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT', name: 'app', packages: [{ name: 'left-pad' }] },
        'ok.spdx.json',
      ),
    ).toBe('spdx');
  });

  it('rejects the CycloneDX fixture without echoing the document, and the message is stable', () => {
    const doc = JSON.parse(fs.readFileSync(cycloneFixture, 'utf8')) as unknown;
    const label = '/home/alice/proj/invalid.cdx.json';
    const message = cycloneMessage('proj/invalid.cdx.json', 'missing specVersion');
    let first: unknown;
    let second: unknown;
    try {
      assertExternalSbom(doc, label);
    } catch (err) {
      first = err;
    }
    try {
      assertExternalSbom(doc, label);
    } catch (err) {
      second = err;
    }
    assertInputError(first, 'schema', message);
    expect((second as SbomInputError).message).toBe((first as SbomInputError).message);
    expect(message).not.toContain('not-a-version');
  });

  it('rejects the SPDX fixture without echoing the bad version token', () => {
    const doc = JSON.parse(fs.readFileSync(spdxFixture, 'utf8')) as unknown;
    assertInputError(
      catchAssert(doc, '/Users/alice/invalid.spdx.json'),
      'schema',
      spdxMessage('invalid.spdx.json', 'spdxVersion must be an SPDX version such as SPDX-2.3'),
    );
    expect((catchAssert(doc, 'invalid.spdx.json') as SbomInputError).message).not.toContain('not-a-version');
  });

  it('fails a CycloneDX document when a component is missing name, and does not keep the others', () => {
    const doc = {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      version: 1,
      components: [
        { name: 'kept', version: '1.0.0' },
        { version: '9.9.9', purl: `pkg:npm/${SECRET}@9.9.9` },
      ],
    };
    let caught: unknown;
    try {
      componentsFromSource(doc, 'bom.cdx.json');
    } catch (err) {
      caught = err;
    }
    assertInputError(caught, 'schema', cycloneMessage('bom.cdx.json', 'component 2 is missing name'));
    expect((caught as SbomInputError).message).not.toContain('kept');
  });

  it('fails an SPDX document when a package is missing name', () => {
    const doc = {
      spdxVersion: 'SPDX-2.3',
      SPDXID: 'SPDXRef-DOCUMENT',
      name: 'app',
      packages: [{ versionInfo: '1.0.0', comment: SECRET }],
    };
    assertInputError(
      catchAssert(doc, 'app.spdx.json'),
      'schema',
      spdxMessage('app.spdx.json', 'package 1 is missing name'),
    );
  });

  it('rejects truncated JSON without the parser snippet', () => {
    const text = `{"bomFormat":"CycloneDX","note":"${SECRET}","components":`;
    assertInputError(
      catchParse(text, '/home/alice/trunc.cdx.json'),
      'corrupt',
      `trunc.cdx.json: truncated or not valid JSON. ${JSON_EXPECT} ${REGENERATE}`,
    );
  });
});

function catchAssert(doc: unknown, label: string): unknown {
  try {
    assertExternalSbom(doc, label);
    return undefined;
  } catch (err) {
    return err;
  }
}

function catchParse(text: string, label: string): unknown {
  try {
    parseSbomJson(text, label);
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('buildRelease invalid SBOM', () => {
  const base = {
    productId: 'widget',
    version: '1.0.0',
    distribution: [] as string[],
    frozenAt: '2026-01-01T00:00:00.000Z',
    fromExplicit: true,
  };

  it('fails closed on the CycloneDX fixture and names the path', async () => {
    const dir = temp();
    const file = path.join(dir, 'invalid.cdx.json');
    fs.copyFileSync(cycloneFixture, file);
    await expect(buildRelease({ ...base, from: file })).rejects.toThrow(/invalid\.cdx\.json: not a valid CycloneDX document \(missing specVersion\)/);
    await expect(buildRelease({ ...base, from: file })).rejects.toThrow(new RegExp(REGENERATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('still freezes a valid CycloneDX document', async () => {
    const dir = temp();
    const file = path.join(dir, 'ok.cdx.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        version: 1,
        components: [{ type: 'library', name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0' }],
      }),
    );
    const release = await buildRelease({ ...base, from: file });
    expect(release.components).toEqual([
      { name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0', ecosystem: 'npm' },
    ]);
  });
});

describe('vg evidence release CLI', () => {
  const cli = path.join(pkgRoot, 'src/cli.ts');

  function project(): string {
    const dir = temp();
    fs.mkdirSync(path.join(dir, '.vibgrate', 'evidence'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.vibgrate', 'evidence', 'products.json'),
      JSON.stringify([
        {
          id: 'widget',
          name: 'Widget',
          classification: 'default',
          memberStates: [],
          bindings: [],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );
    return dir;
  }

  function run(dir: string, from: string): { status: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string; error?: Error } {
    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', cli, 'evidence', 'release', 'widget', '1.0.0', '--from', from, '-C', dir],
      {
        cwd: pkgRoot,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          NO_COLOR: '1',
          VIBGRATE_NO_KERNEL: '1',
          VIBGRATE_DSN: '',
          HOME: path.join(dir, 'home'),
        },
      },
    );
    return {
      status: res.status,
      signal: res.signal,
      stderr: res.stderr ?? '',
      stdout: res.stdout ?? '',
      error: res.error,
    };
  }

  function assertCli(dir: string, from: string, parts: string[]): string {
    const first = run(dir, from);
    const second = run(dir, from);
    expect(first.error).toBeUndefined();
    expect(first.signal).toBeNull();
    expect(first.status).toBe(ExitCode.ERROR);
    expect(first.status).not.toBe(0);
    expect(second.stderr).toBe(first.stderr);
    for (const part of parts) expect(first.stderr).toContain(part);
    expect(first.stderr).toContain(`error: `);
    expect(first.stderr).toContain(REGENERATE);
    expect(first.stderr).not.toContain(SECRET);
    expect(first.stderr).not.toContain('/home/');
    expect(first.stderr).not.toContain('/Users/');
    expect(first.stderr).not.toContain(path.join(dir, 'home'));
    expect(first.stderr).not.toContain('Unexpected token');
    expect(first.stderr).not.toContain('SyntaxError');
    expect(first.stderr).not.toMatch(/\bat (?:JSON\.parse|readFile|assertExternalSbom)/);
    expect(first.stdout).not.toContain(SECRET);
    expect(first.stdout).not.toContain('froze');
    return first.stderr;
  }

  it('exits non-zero on the invalid CycloneDX fixture', () => {
    const dir = project();
    const from = path.join(dir, 'invalid.cdx.json');
    fs.copyFileSync(cycloneFixture, from);
    assertCli(dir, from, ['invalid.cdx.json', 'not a valid CycloneDX document', 'missing specVersion', CYCLONE_EXPECT]);
  }, 60_000);

  it('exits non-zero on the invalid SPDX fixture', () => {
    const dir = project();
    const from = path.join(dir, 'invalid.spdx.json');
    fs.copyFileSync(spdxFixture, from);
    const stderr = assertCli(dir, from, [
      'invalid.spdx.json',
      'not a valid SPDX document',
      'spdxVersion must be an SPDX version such as SPDX-2.3',
      SPDX_EXPECT,
    ]);
    expect(stderr).not.toContain('not-a-version');
  }, 60_000);

  it('exits non-zero on truncated JSON and does not print the file', () => {
    const dir = project();
    const from = path.join(dir, 'trunc.cdx.json');
    fs.writeFileSync(from, `{"note":"${SECRET}","bomFormat":"CycloneDX","components":`);
    assertCli(dir, from, ['trunc.cdx.json', 'truncated or not valid JSON', JSON_EXPECT]);
  }, 60_000);
});
