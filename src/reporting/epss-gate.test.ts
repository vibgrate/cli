import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDataConfig } from '../core-open/config.js';
import { CliError, ExitCode } from '../util/exit.js';
import {
  judgeEpssGate,
  parseConfiguredFailOnEpss,
  parseFailOnEpssFlag,
  type EpssGatePackage,
} from './epss-gate.js';

const docs = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../DOCS.md'), 'utf8');

const hot: EpssGatePackage = {
  ecosystem: 'npm',
  package: 'left-pad',
  version: '1.3.0',
  advisories: [
    { id: 'GHSA-hot', epss: 0.9 },
    { id: 'GHSA-cold' },
    { id: 'GHSA-null', epss: null },
  ],
};

describe('parseFailOnEpssFlag', () => {
  it('accepts the closed interval [0, 1]', () => {
    expect(parseFailOnEpssFlag(undefined)).toBeUndefined();
    expect(parseFailOnEpssFlag('0')).toBe(0);
    expect(parseFailOnEpssFlag('1')).toBe(1);
    expect(parseFailOnEpssFlag('0.8')).toBe(0.8);
    expect(parseFailOnEpssFlag(' 0.80 ')).toBe(0.8);
  });

  it('rejects values outside the interval and non-numeric text as a usage error', () => {
    for (const value of ['1.5', '-0.1', 'nope', '', '0.8abc', 'Infinity']) {
      expect(() => parseFailOnEpssFlag(value)).toThrow(CliError);
      try {
        parseFailOnEpssFlag(value);
      } catch (err) {
        expect(err).toMatchObject({
          code: ExitCode.USAGE_ERROR,
          message: '--fail-on-epss must be a number from 0 to 1.',
        });
      }
    }
  });
});

describe('parseConfiguredFailOnEpss', () => {
  it('reads a probability and ignores an absent key', () => {
    expect(parseConfiguredFailOnEpss(undefined, '.vibgrate/config.yml')).toBeUndefined();
    expect(parseConfiguredFailOnEpss(0, '.vibgrate/config.yml')).toBe(0);
    expect(parseConfiguredFailOnEpss(1, '.vibgrate/config.yml')).toBe(1);
  });

  it('names the file and the key, and does not echo the value', () => {
    expect(() => parseConfiguredFailOnEpss('1.5', '.vibgrate/config.yml')).toThrow(CliError);
    try {
      parseConfiguredFailOnEpss('1.5', '.vibgrate/config.yml');
    } catch (err) {
      expect(err).toMatchObject({
        code: ExitCode.ERROR,
        message: '.vibgrate/config.yml: `failOnEpss` must be a number from 0 to 1. Fix that key and run the command again.',
      });
      expect((err as Error).message).not.toContain('1.5');
    }
  });
});

describe('failOnEpss config schema', () => {
  it('accepts 0 and 1 and rejects a number outside that interval', () => {
    expect(parseDataConfig('failOnEpss: 0\n', '.vibgrate/config.yml')).toMatchObject({ failOnEpss: 0 });
    expect(parseDataConfig('failOnEpss: 1\n', '.vibgrate/config.yml')).toMatchObject({ failOnEpss: 1 });
    expect(() => parseDataConfig('failOnEpss: 1.5\n', '.vibgrate/config.yml')).toThrow(
      '.vibgrate/config.yml: `failOnEpss` must be a number from 0 to 1, for example failOnEpss: 0.1 (line 1). Fix that key and run the command again.',
    );
    expect(() => parseDataConfig('{"failOnEpss":"0.8"}\n', 'vibgrate.config.json')).toThrow(/`failOnEpss` must be a number from 0 to 1/);
  });
});

describe('judgeEpssGate', () => {
  it('fails at the threshold and passes below it', () => {
    const over = judgeEpssGate({
      threshold: 0.8,
      source: 'flag',
      scanned: true,
      vulnerabilities: { source: 'manifest', packages: [hot] },
    });
    expect(over).toMatchObject({
      exitCode: 2,
      status: 'failure',
      message: 'Failing: 1 advisory with EPSS at or above --fail-on-epss 0.8.',
      rows: ['npm left-pad@1.3.0  GHSA-hot  epss 0.9'],
    });

    const under = judgeEpssGate({
      threshold: 0.95,
      source: 'flag',
      scanned: true,
      vulnerabilities: { source: 'manifest', packages: [hot] },
    });
    expect(under).toEqual({ exitCode: 0, status: 'pass', message: null, rows: [] });

    const equal = judgeEpssGate({
      threshold: 0.9,
      source: 'flag',
      scanned: true,
      vulnerabilities: { source: 'manifest', packages: [hot] },
    });
    expect(equal.exitCode).toBe(2);
  });

  it('does not treat an omitted score as 0, and does compare a present 0', () => {
    const omitted = judgeEpssGate({
      threshold: 0,
      source: 'flag',
      scanned: true,
      vulnerabilities: {
        source: 'manifest',
        packages: [{
          ecosystem: 'npm',
          package: 'left-pad',
          version: '1.3.0',
          advisories: [{ id: 'GHSA-cold' }, { id: 'GHSA-null', epss: null }],
        }],
      },
    });
    expect(omitted).toEqual({ exitCode: 0, status: 'pass', message: null, rows: [] });

    const zero = judgeEpssGate({
      threshold: 0,
      source: 'flag',
      scanned: true,
      vulnerabilities: {
        source: 'osv',
        packages: [{
          ecosystem: 'npm',
          package: 'left-pad',
          version: '1.3.0',
          advisories: [{ id: 'GHSA-zero', epss: 0 }],
        }],
      },
    });
    expect(zero.exitCode).toBe(2);
    expect(zero.rows).toEqual(['npm left-pad@1.3.0  GHSA-zero  epss 0']);
  });

  it('skips when the vulnerability scan did not run or could not be checked', () => {
    expect(judgeEpssGate({ threshold: 0.8, source: 'flag', scanned: false })).toMatchObject({
      exitCode: 0,
      status: 'skipped',
      message: 'EPSS scores are absent; --fail-on-epss 0.8 was not compared.',
    });
    expect(judgeEpssGate({
      threshold: 0.8,
      source: 'config',
      scanned: true,
      vulnerabilities: { source: 'unreachable', packages: [] },
    })).toMatchObject({
      exitCode: 0,
      status: 'skipped',
      message: 'EPSS scores are absent; failOnEpss 0.8 was not compared.',
    });
    expect(judgeEpssGate({
      threshold: 0.8,
      source: 'flag',
      scanned: true,
      vulnerabilities: { source: 'none', packages: [] },
    })).toEqual({ exitCode: 0, status: 'pass', message: null, rows: [] });
  });

  it('sorts failing advisories independently of input order', () => {
    const packages: EpssGatePackage[] = [
      {
        ecosystem: 'pypi',
        package: 'zzz',
        version: '1.0.0',
        advisories: [{ id: 'GHSA-z', epss: 0.95 }],
      },
      {
        ecosystem: 'npm',
        package: 'left-pad',
        version: '1.3.0',
        advisories: [
          { id: 'GHSA-b', epss: 0.91 },
          { id: 'GHSA-a', epss: 0.5 },
        ],
      },
    ];
    const forward = judgeEpssGate({
      threshold: 0.8,
      source: 'config',
      scanned: true,
      vulnerabilities: { source: 'manifest', packages },
    });
    const reversed = judgeEpssGate({
      threshold: 0.8,
      source: 'config',
      scanned: true,
      vulnerabilities: { source: 'manifest', packages: [...packages].reverse() },
    });
    expect(forward.rows).toEqual([
      'npm left-pad@1.3.0  GHSA-b  epss 0.91',
      'pypi zzz@1.0.0  GHSA-z  epss 0.95',
    ]);
    expect(reversed).toEqual(forward);
    expect(forward.message).toBe('Failing: 2 advisories with EPSS at or above failOnEpss 0.8.');
  });
});

describe('EPSS gate docs', () => {
  it('states the flag, the exit codes, and that an omitted score is not 0', () => {
    expect(docs).toContain('--fail-on-epss');
    expect(docs).toContain('failOnEpss');
    expect(docs).toContain('An omitted EPSS score is not compared, and it is not treated as 0.');
    expect(docs).toContain('vg scan --vulns --offline --package-manifest ./package-versions.json --fail-on-epss 0.8');
    expect(docs).toContain('The case name is `epss`.');
  });
});
