// Owned by the public CLI. Guards the host side of the security packs
// (docs/CLI-SECURITY-PACKS-PLAN.md §2.1): with no Architecture module present,
// `vg scan --iac` leaves `extended.security` ABSENT (never `[]`), says which
// module is missing, and `--fail-on iac-finding` exits 2 — never 0. Also that a
// bad `--fail-on` value is a usage error before anything is scanned.
//
// Lives here (not under src/core-open, which the vendor sync wipes) so it
// survives re-vendoring.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { scanCommand } from './scan.js';
import { resetHaileProviderCache } from '../../engine/haile/haile-provider.js';
import { CliError, ExitCode } from '../../util/exit.js';

describe('scan --iac without the Architecture module', () => {
  let dir: string;
  let stderr: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-iac-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', dependencies: {} }));
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = () => 1;\n');
    fs.mkdirSync(path.join(dir, 'infra'));
    fs.writeFileSync(path.join(dir, 'infra', 's3.tf'), 'resource "aws_s3_bucket" "logs" {\n  acl = "public-read"\n}\n');
    // No module, no network, no daemon: the seam reads as absent.
    vi.stubEnv('VIBGRATE_DSN', '');
    vi.stubEnv('VIBGRATE_NO_KERNEL', '1');
    resetHaileProviderCache();
    stderr = '';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      stderr += a.join(' ') + '\n';
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
    vi.unstubAllEnvs();
    resetHaileProviderCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: string[]) =>
    scanCommand.parseAsync(['node', 'scan', dir, '--offline', '--no-daemon', ...args]);

  it('leaves extended.security absent and names the missing module', async () => {
    const out = path.join(dir, 'scan.json');
    await run(['--iac', '--format', 'json', '--out', out]);
    const artifact = JSON.parse(fs.readFileSync(out, 'utf8')) as { extended?: { security?: unknown } };
    // Absent, not an empty section: nothing evaluated the tree.
    expect(artifact.extended?.security).toBeUndefined();
    expect(stderr).toContain('iac-cis-v1: the Architecture module is not installed');
    expect(stderr).toContain('no infrastructure findings were evaluated');
    // The scan itself is unaffected and the map was still built.
    expect(fs.existsSync(path.join(dir, '.vibgrate', 'graph.json'))).toBe(true);
  }, 60_000);

  it('says --offline skipped provisioning when no module is installed and the kernel is not disabled', async () => {
    // No kernel opt-out and an empty modules dir: the only reason nothing was
    // provisioned is --offline, and the message must say exactly that.
    vi.stubEnv('VIBGRATE_NO_KERNEL', '');
    const modules = fs.mkdtempSync(path.join(tmpdir(), 'vg-iac-modules-'));
    vi.stubEnv('VIBGRATE_MODULE_DIR', modules);
    resetHaileProviderCache();
    try {
      await run(['--iac']);
      expect(stderr).toContain('--offline skipped provisioning');
      expect(stderr).toContain('vg module install arch');
    } finally {
      fs.rmSync(modules, { recursive: true, force: true });
    }
  }, 60_000);

  it('exits 2 on --fail-on iac-finding rather than passing an unevaluated tree', async () => {
    await expect(run(['--iac', '--quiet', '--fail-on', 'iac-finding'])).rejects.toThrow('process.exit(2) called');
    expect(stderr).toContain('--fail-on iac-finding: no infrastructure findings were evaluated');
  }, 60_000);

  it('exits 2 when the gate is requested without the code map', async () => {
    await expect(run(['--iac', '--quiet', '--no-graph', '--fail-on', 'iac-finding'])).rejects.toThrow('process.exit(2) called');
    expect(stderr).toContain('--iac needs the code map');
  }, 60_000);

  it('rejects a bad --fail-on value as a usage error before scanning', async () => {
    await expect(run(['--fail-on', 'bogus'])).rejects.toMatchObject({ code: ExitCode.USAGE_ERROR });
    await expect(run(['--fail-on', 'warn,error'])).rejects.toBeInstanceOf(CliError);
    expect(fs.existsSync(path.join(dir, '.vibgrate'))).toBe(false);
  });
});
