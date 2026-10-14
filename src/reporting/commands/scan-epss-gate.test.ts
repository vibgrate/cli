// `vg scan --fail-on-epss` is a CI gate on advisory EPSS. An omitted score is
// not 0. Offline scores come from --package-manifest and nowhere else.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { scanCommand } from './scan.js';
import { CliError, ExitCode } from '../../util/exit.js';
import { ConfigFileError } from '../../core-open/config.js';

const LOCK = {
  name: 't',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 't', dependencies: { 'left-pad': '1.3.0' } },
    'node_modules/left-pad': { version: '1.3.0' },
  },
};

function manifest(vulns: unknown[]): string {
  return JSON.stringify({
    npm: {
      'left-pad': {
        latest: '1.3.0',
        versions: ['1.3.0'],
        vulns,
      },
    },
  });
}

const HOT = { id: 'GHSA-hot', severity: 'low', epss: 0.9, ranges: [{ introduced: '0', fixed: '9.9.9' }] };
const COLD = { id: 'GHSA-cold', severity: 'critical', ranges: [{ introduced: '0', fixed: '9.9.9' }] };

describe('scan --fail-on-epss', () => {
  let dir: string;
  let stderr: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-epss-gate-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 't',
      version: '1.0.0',
      dependencies: { 'left-pad': '1.3.0' },
    }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(LOCK));
    vi.stubEnv('VIBGRATE_DSN', '');
    vi.stubEnv('VIBGRATE_NO_KERNEL', '1');
    vi.stubEnv('NO_COLOR', '1');
    fetchSpy = vi.fn(async () => {
      throw new Error('offline EPSS gate must not fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    stderr = '';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr += args.join(' ') + '\n';
    });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: string[]) =>
    scanCommand.parseAsync(['node', 'scan', dir, '--offline', '--no-daemon', '--no-graph', '--quiet', ...args]);

  function writeManifest(vulns: unknown[]): string {
    const file = path.join(dir, 'package-versions.json');
    fs.writeFileSync(file, manifest(vulns));
    return file;
  }

  it('exits 2 when a present EPSS is at or above the threshold, and records the JUnit case', async () => {
    const manifestFile = writeManifest([HOT, COLD]);
    const junit = path.join(dir, 'epss.junit.xml');
    await expect(run([
      '--vulns',
      '--package-manifest', manifestFile,
      '--fail-on-epss', '0.8',
      '--junit', junit,
    ])).rejects.toThrow('process.exit(2) called');
    expect(stderr).toContain('Failing: 1 advisory with EPSS at or above --fail-on-epss 0.8.');
    expect(stderr).toContain('npm left-pad@1.3.0  GHSA-hot  epss 0.9');
    expect(stderr).not.toContain('GHSA-cold');
    const xml = fs.readFileSync(junit, 'utf8');
    expect(xml).toContain('name="epss"');
    expect(xml).toContain('Failing: 1 advisory with EPSS at or above --fail-on-epss 0.8.');
    expect(xml).toContain('npm left-pad@1.3.0  GHSA-hot  epss 0.9');
    expect(xml).not.toContain('GHSA-cold');
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 60_000);

  it('passes when every present EPSS is below the threshold', async () => {
    const manifestFile = writeManifest([HOT, COLD]);
    const junit = path.join(dir, 'epss.junit.xml');
    await run([
      '--vulns',
      '--package-manifest', manifestFile,
      '--fail-on-epss', '0.95',
      '--junit', junit,
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderr).not.toContain('Failing:');
    const xml = fs.readFileSync(junit, 'utf8');
    expect(xml).toContain('<testcase classname="vg.gates" name="epss" time="0"/>');
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 60_000);

  it('does not fail when the only advisory omits EPSS', async () => {
    const manifestFile = writeManifest([COLD]);
    await run(['--vulns', '--package-manifest', manifestFile, '--fail-on-epss', '0']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderr).not.toContain('Failing:');
    expect(stderr).not.toContain('was not compared');
  }, 60_000);

  it('does not compare the gate when vulnerability scanning did not run', async () => {
    writeManifest([HOT]);
    await run(['--fail-on-epss', '0.1', '--package-manifest', path.join(dir, 'package-versions.json')]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderr).toContain('EPSS scores are absent; --fail-on-epss 0.1 was not compared.');
  }, 60_000);

  it('rejects an invalid threshold before scanning', async () => {
    for (const value of ['1.5', 'nope']) {
      stderr = '';
      const error = await run(['--fail-on-epss', value]).then(
        () => {
          throw new Error(`expected ${value} to fail`);
        },
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({
        code: ExitCode.USAGE_ERROR,
        message: '--fail-on-epss must be a number from 0 to 1.',
      });
      expect(fs.existsSync(path.join(dir, '.vibgrate'))).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();
    }
  });

  it('uses failOnEpss from config and lets the flag replace it', async () => {
    const manifestFile = writeManifest([HOT]);
    fs.mkdirSync(path.join(dir, '.vibgrate'));
    fs.writeFileSync(path.join(dir, '.vibgrate', 'config.yml'), 'failOnEpss: 0.8\n');

    await expect(run(['--vulns', '--package-manifest', manifestFile])).rejects.toThrow('process.exit(2) called');
    expect(stderr).toContain('Failing: 1 advisory with EPSS at or above failOnEpss 0.8.');

    stderr = '';
    await run(['--vulns', '--package-manifest', manifestFile, '--fail-on-epss', '0.95']);
    expect(stderr).not.toContain('Failing:');
  }, 60_000);

  it('does not let the flag hide an invalid failOnEpss config value', async () => {
    writeManifest([HOT]);
    fs.mkdirSync(path.join(dir, '.vibgrate'));
    fs.writeFileSync(path.join(dir, '.vibgrate', 'config.yml'), 'failOnEpss: 1.5\n');
    const error = await run([
      '--vulns',
      '--package-manifest', path.join(dir, 'package-versions.json'),
      '--fail-on-epss', '0.5',
    ]).then(
      () => {
        throw new Error('expected an invalid config to fail');
      },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ConfigFileError);
    expect((error as Error).message).toContain('`failOnEpss` must be a number from 0 to 1');
    expect((error as Error).message).not.toContain('1.5');
  }, 60_000);
});
