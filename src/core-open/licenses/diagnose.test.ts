import { describe, expect, it } from 'vitest';
import { generateFindings } from '../scoring/drift-score.js';
import type { ProjectScan } from '../types.js';
import { LICENSE_UNPARSEABLE_CODE, diagnoseLicenseParse, displayLicenseText, manifestRelativePath } from './diagnose.js';
import { normalizeLicense } from './normalize.js';

function nodeProject(overrides: Partial<ProjectScan> = {}): ProjectScan {
  return {
    type: 'node',
    path: '.',
    name: 'app',
    frameworks: [],
    dependencies: [],
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    ...overrides,
  };
}

describe('diagnoseLicenseParse', () => {
  it('names an unparseable license id and the manifest path', () => {
    const diag = diagnoseLicenseParse('NotARealLicense', 'package.json', 'left-pad');
    expect(diag).not.toBeNull();
    expect(diag!.code).toBe(LICENSE_UNPARSEABLE_CODE);
    expect(diag!.path).toBe('package.json');
    expect(diag!.raw).toBe('NotARealLicense');
    expect(diag!.message).toBe(
      'Unparseable license "NotARealLicense" for left-pad at package.json. Use an SPDX identifier or expression such as MIT or Apache-2.0.',
    );
  });

  it('names an unresolved id inside an otherwise valid expression', () => {
    const diag = diagnoseLicenseParse('MIT OR NotARealLicense-9.9', 'apps/web/package.json', 'left-pad');
    expect(diag!.code).toBe(LICENSE_UNPARSEABLE_CODE);
    expect(diag!.message).toContain('"NotARealLicense-9.9"');
    expect(diag!.message).toContain('apps/web/package.json');
    expect(diag!.message).toContain('left-pad');
    expect(diag!.message).not.toContain('\n');
  });

  it('emits one diagnostic when several constituent ids fail', () => {
    const diag = diagnoseLicenseParse('FooBar-1.0 AND BazQux-2.0', 'package.json');
    expect(diag!.message).toContain('"FooBar-1.0"');
    expect(diag!.message).toContain('"BazQux-2.0"');
    expect(diag!.code).toBe(LICENSE_UNPARSEABLE_CODE);
  });

  it('repeats the same code and text for the same string', () => {
    const a = diagnoseLicenseParse('NotARealLicense', 'package.json');
    const b = diagnoseLicenseParse('NotARealLicense', 'package.json');
    expect(a).toEqual(b);
  });

  it('does not dump a license file body or a credential', () => {
    const fileBody = `NotARealLicense\n${'unrelated license file text. '.repeat(40)}UNIQUE_FILE_TAIL`;
    const fromFile = diagnoseLicenseParse(fileBody, 'package.json');
    expect(fromFile!.raw).toBe('NotARealLicense');
    expect(fromFile!.message).not.toContain('UNIQUE_FILE_TAIL');
    expect(fromFile!.message).not.toContain('unrelated license file');

    const blob = `BadLicenseToken ${'xxxx '.repeat(80)}UNIQUE_FILE_TAIL`;
    const fromBlob = diagnoseLicenseParse(blob, 'package.json');
    expect(fromBlob!.raw).toBe(displayLicenseText(blob));
    expect(fromBlob!.raw.endsWith('...')).toBe(true);
    expect(fromBlob!.raw.length).toBeLessThanOrEqual(80);
    expect(fromBlob!.message).not.toContain('UNIQUE_FILE_TAIL');

    const token = 'npm_1234567890abcdefghij';
    const leaked = diagnoseLicenseParse(`NotARealLicense ${token}`, 'package.json');
    expect(leaked!.message).not.toContain(token);
    expect(leaked!.message).toContain('[REDACTED]');
    expect(leaked!.raw).not.toContain(token);
  });

  it('points node projects at package.json and keeps other project paths', () => {
    expect(manifestRelativePath('.', 'node')).toBe('package.json');
    expect(manifestRelativePath('apps/web', 'node')).toBe('apps/web/package.json');
    expect(manifestRelativePath('services/api', 'go')).toBe('services/api');
  });

  it('still parses a valid SPDX id, alias, and expression', () => {
    expect(diagnoseLicenseParse('MIT', 'package.json')).toBeNull();
    expect(diagnoseLicenseParse('Apache-2.0', 'package.json')).toBeNull();
    expect(diagnoseLicenseParse('MIT License', 'package.json')).toBeNull();
    expect(diagnoseLicenseParse('MIT OR Apache-2.0', 'package.json')).toBeNull();
    expect(diagnoseLicenseParse('NOASSERTION', 'package.json')).toBeNull();
    expect(diagnoseLicenseParse('NONE', 'package.json')).toBeNull();
    expect(diagnoseLicenseParse('   ', 'package.json')).toBeNull();
    expect(diagnoseLicenseParse(null, 'package.json')).toBeNull();

    expect(normalizeLicense('MIT')).toMatchObject({
      spdxId: 'MIT',
      matchStatus: 'exact',
      confidence: 1,
      expression: 'MIT',
      components: ['MIT'],
    });
    expect(normalizeLicense('MIT OR Apache-2.0')).toMatchObject({
      spdxId: 'Apache-2.0',
      matchStatus: 'expression',
      expression: 'MIT OR Apache-2.0',
      components: ['MIT', 'Apache-2.0'],
    });
  });

  it('does not treat a fuzzy family match as a parse failure', () => {
    expect(normalizeLicense('custom mit license text').matchStatus).toBe('fuzzy');
    expect(diagnoseLicenseParse('custom mit license text', 'package.json')).toBeNull();
  });
});

describe('scan findings for license ids', () => {
  it('warns on a bad license string and stays quiet for a valid one', () => {
    const findings = generateFindings([
      nodeProject({
        declaredLicense: { raw: 'NotARealLicense', spdxId: null, source: 'manifest', confidence: 0 },
        dependencies: [
          {
            package: 'chalk',
            section: 'dependencies',
            currentSpec: '5.0.0',
            resolvedVersion: '5.0.0',
            latestStable: '5.0.0',
            majorsBehind: 0,
            drift: 'current',
            license: { raw: 'MIT', spdxId: 'MIT', source: 'registry', confidence: 1 },
          },
          {
            package: 'left-pad',
            section: 'dependencies',
            currentSpec: '1.0.0',
            resolvedVersion: '1.0.0',
            latestStable: '1.0.0',
            majorsBehind: 0,
            drift: 'current',
            license: { raw: 'MIT OR NotARealLicense-9.9', spdxId: 'MIT', source: 'registry', confidence: 0.5 },
          },
        ],
      }),
    ]);
    const licenseFindings = findings.filter((f) => f.ruleId === LICENSE_UNPARSEABLE_CODE);
    expect(licenseFindings.map((f) => f.message)).toEqual([
      'Unparseable license "NotARealLicense" for app at package.json. Use an SPDX identifier or expression such as MIT or Apache-2.0.',
      'Unparseable license id "NotARealLicense-9.9" in "MIT OR NotARealLicense-9.9" for left-pad at package.json. Use an SPDX identifier or expression such as MIT or Apache-2.0.',
    ]);
    expect(licenseFindings.every((f) => f.location === 'package.json' && f.level === 'warning')).toBe(true);
    expect(findings.some((f) => f.message.includes('chalk'))).toBe(false);
    expect(generateFindings([nodeProject()])).toEqual([]);
  });
});
