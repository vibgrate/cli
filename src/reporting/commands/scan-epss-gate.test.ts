// `vg scan --fail-on-epss` is a CI gate: exit 2 when any advisory EPSS score
// is at or above the threshold. A missing score is not 0. The flag replaces
// failOnEpss in the project config. The stderr line and the JUnit case match.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { scanCommand } from './scan.js';
import { CliError, ExitCode } from '../../util/exit.js';

describe('scan --fail-on-epss', () => {
  let dir: string;
  let stderr: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-epss-gate-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'epss-gate-fixture', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
    );
    fs.writeFileSync(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({
        name: 'epss-gate-fixture',
        lockfileVersion: 3,
        packages: {
          '': { name: 'epss-gate-fixture', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } },
          'node_modules/left-pad': { version: '1.3.0' },
        },
      }),
    );
    vi.stubEnv('VIBGRATE_DSN', '');
    vi.stubEnv('VIBGRATE_NO_KERNEL', '1');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('EPSS gate must not contact a network');
    }));
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

  function writeManifest(vulns: Array<Record<string, unknown>>): string {
    const manifest = path.join(dir, 'package-versions.json');
    fs.writeFileSync(manifest, JSON.stringify({
      npm: { 'left-pad': { latest: '1.3.0', versions: ['1.3.0'], vulns } },
    }));
    return manifest;
  }

  const scored = [
    { id: 'GHSA-hot', severity: 'high', epss: 0.9, ranges: [{ introduced: '0', fixed: '9.0.0' }] },
    { id: 'GHSA-cold', severity: 'high', ranges: [{ introduced: '0', fixed: '9.0.0' }] },
    { id: 'GHSA-zero', severity: 'low', epss: 0, ranges: [{ introduced: '0', fixed: '9.0.0' }] },
  ];

  const run = (args: string[]) =>
    scanCommand.parseAsync(['node', 'scan', dir, '--offline', '--no-daemon', '--no-graph', '--quiet', ...args]);

  it('exits 2 when an advisory EPSS score is at or above the threshold', async () => {
    const manifest = writeManifest(scored);
    const junit = path.join(dir, 'epss.junit.xml');
    await expect(run([
      '--vulns', '--package-manifest', manifest, '--fail-on-epss', '0.5', '--junit', junit,
    ])).rejects.toThrow('process.exit(2) called');
    expect(stderr).toContain('Failing: 1 advisory at or above EPSS 0.5.');
    expect(stderr).toContain('npm left-pad@1.3.0  GHSA-hot  EPSS 0.9');
    expect(stderr).not.toContain('GHSA-cold');
    expect(stderr).not.toContain('GHSA-zero');
    const xml = fs.readFileSync(junit, 'utf8');
    expect(xml).toContain('name="fail-on-epss"');
    expect(xml).toContain('type="gate"');
    expect(xml).toContain('Failing: 1 advisory at or above EPSS 0.5.');
    expect(xml).toContain('GHSA-hot');
    expect(xml).not.toContain('timestamp');
  }, 60_000);

  it('does not treat a missing score as 0, and a present 0 fails at threshold 0', async () => {
    const missingOnly = writeManifest([
      { id: 'GHSA-absent', severity: 'critical', ranges: [{ introduced: '0', fixed: '9.0.0' }] },
    ]);
    const junit = path.join(dir, 'absent.junit.xml');
    await run(['--vulns', '--package-manifest', missingOnly, '--fail-on-epss', '0', '--junit', junit]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderr).toContain('EPSS is absent; --fail-on-epss 0 was not compared.');
    expect(stderr).not.toContain('Failing:');
    expect(fs.readFileSync(junit, 'utf8')).toContain('message="EPSS is absent; --fail-on-epss 0 was not compared."');

    stderr = '';
    const withZero = writeManifest([
      { id: 'GHSA-zero', severity: 'low', epss: 0, ranges: [{ introduced: '0', fixed: '9.0.0' }] },
    ]);
    const zeroJunit = path.join(dir, 'zero.junit.xml');
    await expect(run([
      '--vulns', '--package-manifest', withZero, '--fail-on-epss', '0', '--junit', zeroJunit,
    ])).rejects.toThrow('process.exit(2) called');
    expect(stderr).toContain('Failing: 1 advisory at or above EPSS 0.');
    expect(fs.readFileSync(zeroJunit, 'utf8')).toContain('GHSA-zero');
  }, 60_000);

  it('lets the flag replace failOnEpss in the project config', async () => {
    const manifest = writeManifest(scored);
    fs.mkdirSync(path.join(dir, '.vibgrate'));
    fs.writeFileSync(path.join(dir, '.vibgrate', 'config.yml'), 'failOnEpss: 0.5\n');

    await run(['--vulns', '--package-manifest', manifest, '--fail-on-epss', '0.99']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderr).not.toContain('Failing:');

    stderr = '';
    await expect(run(['--vulns', '--package-manifest', manifest])).rejects.toThrow('process.exit(2) called');
    expect(stderr).toContain('Failing: 1 advisory at or above EPSS 0.5.');
    expect(stderr).toContain('GHSA-hot');
  }, 60_000);

  it('skips the gate when vulnerability detection did not run', async () => {
    const junit = path.join(dir, 'novulns.junit.xml');
    await run(['--fail-on-epss', '0.1', '--junit', junit]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderr).toContain('EPSS is absent; --fail-on-epss 0.1 was not compared.');
    const xml = fs.readFileSync(junit, 'utf8');
    expect(xml).toContain('<skipped message="EPSS is absent; --fail-on-epss 0.1 was not compared."/>');
    expect(xml).not.toContain('<failure');
  }, 60_000);

  function manyScored(count: number, start = 0): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, i) => ({
      id: `GHSA-${String(start + i).padStart(3, '0')}`,
      severity: 'high',
      epss: 0.9,
      ranges: [{ introduced: '0', fixed: '9.0.0' }],
    }));
  }

  function advisoryRows(stream: string): string[] {
    return stream
      .split('\n')
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''))
      .filter((line) => /^  npm left-pad@1\.3\.0  GHSA-/.test(line));
  }

  it('caps breached advisory rows at 50 and prints the "… N more" line', async () => {
    const manifest = writeManifest(manyScored(53));
    await expect(run([
      '--vulns', '--package-manifest', manifest, '--fail-on-epss', '0.5',
    ])).rejects.toThrow('process.exit(2) called');
    const rows = advisoryRows(stderr);
    expect(rows).toHaveLength(50);
    expect(rows[0]).toContain('GHSA-000');
    expect(rows[49]).toContain('GHSA-049');
    expect(stderr).toContain('… 3 more');
    expect(stderr).not.toContain('GHSA-050');
  }, 60_000);

  it('prints exactly 50 rows and no overflow line at the cap', async () => {
    const manifest = writeManifest(manyScored(50));
    await expect(run([
      '--vulns', '--package-manifest', manifest, '--fail-on-epss', '0.5',
    ])).rejects.toThrow('process.exit(2) called');
    const rows = advisoryRows(stderr);
    expect(rows).toHaveLength(50);
    expect(rows[0]).toContain('GHSA-000');
    expect(rows[49]).toContain('GHSA-049');
    expect(stderr).not.toMatch(/… \d+ more/);
  }, 60_000);

  it('prints rows in the same stable order as evaluateEpssGate breached refs', async () => {
    const manifest = writeManifest(manyScored(50));
    await expect(run([
      '--vulns', '--package-manifest', manifest, '--fail-on-epss', '0.5',
    ])).rejects.toThrow('process.exit(2) called');
    const rows = advisoryRows(stderr);
    const ids = rows.map((row) => row.match(/GHSA-\d{3}/)![0]);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => `GHSA-${String(i).padStart(3, '0')}`));
  }, 60_000);

  it('rejects a threshold outside 0 to 1 before scanning', async () => {
    await expect(run(['--fail-on-epss', '2'])).rejects.toMatchObject({
      code: ExitCode.ERROR,
      message: '--fail-on-epss must be a number from 0 to 1.',
    });
    await expect(run(['--fail-on-epss', 'no'])).rejects.toBeInstanceOf(CliError);
    expect(fs.existsSync(path.join(dir, '.vibgrate'))).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
