/**
 * Invalid SPDX / CycloneDX input must fail closed.
 *
 * The fixtures are deliberately not schema-valid. One component in each
 * document is well-formed so a parser that skipped the bad row would still
 * return a component. The command must exit non-zero instead, with the same
 * message on every run, and without the document body.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evidenceCommand } from '../src/reporting/commands/evidence/index.js';
import { buildRelease, componentsFromSource } from '../src/reporting/commands/evidence/release.js';
import { saveProducts } from '../src/reporting/commands/evidence/state.js';
import { SbomInputError } from '../src/reporting/commands/evidence/sbom-input.js';
import { ExitCode } from '../src/util/exit.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/sbom-invalid');
const CDX = path.join(FIXTURES, 'missing-component-name.cdx.json');
const SPDX = path.join(FIXTURES, 'missing-package-name.spdx.json');
const TRUNCATED = path.join(FIXTURES, 'truncated.spdx.json');

const SECRET_CDX = 'ghp_exampleExampleExampleExample';
const SECRET_SPDX = 'npm_1234567890abcdef1234567890';

const base = {
  productId: 'widget',
  version: '1.0.0',
  distribution: ['DE'],
  frozenAt: '2026-01-01T00:00:00.000Z',
  fromExplicit: true,
};

function assertClosed(message: string): void {
  expect(message).not.toContain(SECRET_CDX);
  expect(message).not.toContain(SECRET_SPDX);
  expect(message).not.toContain('/home/');
  expect(message).not.toContain('/Users/');
  expect(message).not.toContain('Unexpected token');
  expect(message).not.toContain('SyntaxError');
}

describe('invalid SBOM input', () => {
  it('rejects a CycloneDX fixture that omits a required component name', async () => {
    const first = await buildRelease({ ...base, from: CDX }).then(
      () => {
        throw new Error('expected the invalid CycloneDX fixture to fail');
      },
      (err: unknown) => err,
    );
    const second = await buildRelease({ ...base, from: CDX }).then(
      () => {
        throw new Error('expected the invalid CycloneDX fixture to fail');
      },
      (err: unknown) => err,
    );

    expect(first).toBeInstanceOf(SbomInputError);
    expect(second).toBeInstanceOf(SbomInputError);
    const message = (first as SbomInputError).message;
    expect((second as SbomInputError).message).toBe(message);
    expect((first as SbomInputError).code).toBe(ExitCode.USAGE_ERROR);
    expect(message).toContain('missing-component-name.cdx.json');
    expect(message).toContain('invalid CycloneDX SBOM');
    expect(message).toContain('components[1] is missing required field "name"');
    expect(message).toContain('bomFormat "CycloneDX"');
    expect(message).toContain('re-run the command');
    assertClosed(message);
  });

  it('rejects an SPDX fixture that omits a required package name', async () => {
    const err = await buildRelease({ ...base, from: SPDX }).then(
      () => {
        throw new Error('expected the invalid SPDX fixture to fail');
      },
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(SbomInputError);
    const message = (err as SbomInputError).message;
    expect((err as SbomInputError).code).toBe(ExitCode.USAGE_ERROR);
    expect(message).toContain('missing-package-name.spdx.json');
    expect(message).toContain('invalid SPDX SBOM');
    expect(message).toContain('packages[1] is missing required field "name"');
    expect(message).toContain('SPDX 2.x');
    expect(message).toContain('re-run the command');
    assertClosed(message);
  });

  it('rejects a truncated SBOM file without quoting its body', async () => {
    const err = await buildRelease({ ...base, from: TRUNCATED }).then(
      () => {
        throw new Error('expected truncated JSON to fail');
      },
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(SbomInputError);
    const message = (err as SbomInputError).message;
    expect((err as SbomInputError).code).toBe(ExitCode.USAGE_ERROR);
    expect(message).toContain('truncated.spdx.json');
    expect(message).toContain('not valid JSON');
    expect(message).toContain('CycloneDX or SPDX');
    assertClosed(message);
  });

  it('does not keep a valid sibling when another component fails the schema', () => {
    const data = JSON.parse(fs.readFileSync(CDX, 'utf8')) as unknown;
    expect(() => componentsFromSource(data, '/home/alice/work/missing-component-name.cdx.json')).toThrow(SbomInputError);
    let message = '';
    try {
      componentsFromSource(data, '/home/alice/work/missing-component-name.cdx.json');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('work/missing-component-name.cdx.json');
    expect(message).not.toContain('/home/alice');
    expect(message).not.toContain('left-pad');
    assertClosed(message);
  });

  it('still freezes a schema-valid CycloneDX document, skipping only an unversioned component', () => {
    const parsed = componentsFromSource(
      {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        version: 1,
        components: [
          { type: 'library', name: 'no-version' },
          { type: 'library', name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0' },
        ],
      },
      'ok.cdx.json',
    );
    expect(parsed).toEqual({
      attested: false,
      components: [{ name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0', ecosystem: 'npm' }],
    });
  });

  it('exits 5 from vg evidence release and does not freeze a manifest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sbom-invalid-'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await saveProducts(dir, [
        {
          id: 'widget',
          name: 'Widget',
          classification: 'default',
          memberStates: [],
          bindings: [],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      const err = await evidenceCommand
        .parseAsync(['release', 'widget', '1.0.0', '-C', dir, '--from', CDX], { from: 'user' })
        .then(
          () => {
            throw new Error('expected vg evidence release to fail');
          },
          (caught: unknown) => caught,
        );
      expect(err).toBeInstanceOf(SbomInputError);
      expect((err as SbomInputError).code).toBe(ExitCode.USAGE_ERROR);
      assertClosed((err as SbomInputError).message);
      expect(fs.existsSync(path.join(dir, '.vibgrate', 'evidence', 'releases'))).toBe(false);
      const printed = [...errorSpy.mock.calls, ...logSpy.mock.calls].flat().join('\n');
      expect(printed).not.toContain(SECRET_CDX);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
