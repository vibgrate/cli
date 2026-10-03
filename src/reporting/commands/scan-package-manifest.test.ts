// `vg scan --package-manifest` must fail closed before any scan work when the
// path is missing, unreadable, or not a usable package-version manifest.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanCommand } from './scan.js';
import { main } from '../../cli.js';
import { CliError } from '../../util/exit.js';

const HINT = 'Pass a JSON or ZIP package-version manifest to --package-manifest.';
const SECRET_BODY = 'file-body-secret-9f3a';
const SECRET_NEARBY = 'nearby-secret-9f3a';
const SECRET_ENV = 'env-secret-9f3a';

function expected(filePath: string, why: 'does not exist' | 'is not readable' | 'is not a package-version manifest'): string {
  return `--package-manifest ${JSON.stringify(filePath)} ${why}. ${HINT}`;
}

describe('vg scan --package-manifest fails closed', () => {
  const dirs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    logSpy?.mockRestore();
    errorSpy?.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const dir of dirs.splice(0)) {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function project(): { dir: string; outPath: string } {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-scan-manifest-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', dependencies: {} }));
    fs.writeFileSync(path.join(dir, `${SECRET_NEARBY}.txt`), SECRET_BODY);
    vi.stubEnv('VG_PKG_MANIFEST_SECRET', SECRET_ENV);
    vi.stubEnv('VIBGRATE_DSN', '');
    vi.stubEnv('NO_COLOR', '1');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { dir, outPath: path.join(dir, 'scan-out.json') };
  }

  function printed(): string {
    return [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
  }

  async function runScan(dir: string, outPath: string, manifestPath: string, extra: string[] = []): Promise<unknown> {
    try {
      await scanCommand.parseAsync(
        [dir, '--offline', '--no-graph', '--quiet', '--format', 'json', '--out', outPath, '--package-manifest', manifestPath, ...extra],
        { from: 'user' },
      );
      return undefined;
    } catch (err) {
      return err;
    }
  }

  function assertFailedClosed(
    err: unknown,
    dir: string,
    outPath: string,
    manifestPath: string,
    why: 'does not exist' | 'is not readable' | 'is not a package-version manifest',
  ): void {
    expect(err).toBeInstanceOf(CliError);
    const error = err as CliError;
    expect(error.code).toBe(1);
    expect(error.message).toBe(expected(manifestPath, why));
    const output = `${error.message}\n${printed()}`;
    expect(output).not.toContain(SECRET_BODY);
    expect(output).not.toContain(SECRET_NEARBY);
    expect(output).not.toContain(SECRET_ENV);
    expect(output).not.toContain(homedir());
    expect(output).not.toContain('vibgrate-manifest-');
    expect(output).not.toContain('unzip');
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(path.join(dir, '.vibgrate'))).toBe(false);
  }

  it('stops before the scan when the path is missing', async () => {
    const { dir, outPath } = project();
    const manifestPath = path.join(dir, 'missing.json');
    const err = await runScan(dir, outPath, manifestPath);
    assertFailedClosed(err, dir, outPath, manifestPath, 'does not exist');
  });

  it('stops before the scan when the path is not readable', async () => {
    const { dir, outPath } = project();
    const manifestPath = path.join(dir, 'secret.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ note: SECRET_BODY, npm: { react: { latest: '1.0.0' } } }));
    fs.chmodSync(manifestPath, 0);
    const err = await runScan(dir, outPath, manifestPath);
    assertFailedClosed(err, dir, outPath, manifestPath, 'is not readable');
  });

  it('stops before the scan when the path is a directory', async () => {
    const { dir, outPath } = project();
    const manifestPath = path.join(dir, 'not-a-file');
    fs.mkdirSync(manifestPath);
    fs.writeFileSync(path.join(manifestPath, `${SECRET_NEARBY}.json`), SECRET_BODY);
    const err = await runScan(dir, outPath, manifestPath);
    assertFailedClosed(err, dir, outPath, manifestPath, 'is not a package-version manifest');
  });

  it('stops before the scan when the path is invalid JSON', async () => {
    const { dir, outPath } = project();
    const manifestPath = path.join(dir, 'broken.json');
    fs.writeFileSync(manifestPath, `{not json ${SECRET_BODY}`);
    const err = await runScan(dir, outPath, manifestPath);
    assertFailedClosed(err, dir, outPath, manifestPath, 'is not a package-version manifest');
  });

  it('stops before the scan when JSON is not a package-version manifest', async () => {
    const { dir, outPath } = project();
    const manifestPath = path.join(dir, 'other.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ name: 'app', version: '1.0.0', note: SECRET_BODY }));
    const err = await runScan(dir, outPath, manifestPath);
    assertFailedClosed(err, dir, outPath, manifestPath, 'is not a package-version manifest');
  });

  it('stops before the scan when a ZIP has no package-version manifest entry', async () => {
    const { dir, outPath } = project();
    const noteName = `${SECRET_NEARBY}.txt`;
    const zipPath = path.join(dir, 'bundle.zip');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SECRET_BODY }));
    execFileSync('zip', ['-q', zipPath, noteName, 'manifest.json'], { cwd: dir });
    const err = await runScan(dir, outPath, zipPath);
    assertFailedClosed(err, dir, outPath, zipPath, 'is not a package-version manifest');
  });

  it('prints a stable error and exits non-zero for a missing manifest', async () => {
    const { dir, outPath } = project();
    const manifestPath = path.join(dir, 'missing.json');
    let stderr = '';
    const capture = (into: { text: string }) => (chunk: unknown, encoding?: unknown, cb?: unknown) => {
      into.text += String(chunk ?? '');
      const callback = typeof encoding === 'function' ? encoding : cb;
      if (typeof callback === 'function') callback();
      return true;
    };
    const stderrBox = { text: '' };
    const writeErr = vi.spyOn(process.stderr, 'write').mockImplementation(capture(stderrBox) as never);
    const writeOut = vi.spyOn(process.stdout, 'write').mockImplementation(capture({ text: '' }) as never);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    vi.stubEnv('VIBGRATE_NO_KERNEL', '1');

    let code = 0;
    try {
      await main(['node', 'vg', 'scan', dir, '--offline', '--no-graph', '--quiet', '--format', 'json', '--out', outPath, '--package-manifest', manifestPath]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const match = /^exit:(\d+)$/.exec(message);
      if (!match) throw err;
      code = Number(match[1]);
    } finally {
      writeErr.mockRestore();
      writeOut.mockRestore();
      exitSpy.mockRestore();
    }

    stderr = stderrBox.text;
    expect(code).toBe(1);
    expect(stderr).toBe(`error: ${expected(manifestPath, 'does not exist')}\n`);
    expect(stderr).not.toContain(SECRET_BODY);
    expect(stderr).not.toContain(SECRET_NEARBY);
    expect(stderr).not.toContain(SECRET_ENV);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(fs.existsSync(path.join(dir, '.vibgrate'))).toBe(false);
  });

  it('scans a readable JSON package-version manifest', async () => {
    const { dir, outPath } = project();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'manifest-ok', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
    );
    const manifestPath = path.join(dir, 'versions.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        npm: {
          'left-pad': {
            latest: '1.3.0',
            versions: ['1.3.0'],
            vulns: [
              {
                id: 'GHSA-manifest-fixture',
                summary: 'Fixture advisory',
                severity: 'moderate',
                ranges: [{ introduced: '0', fixed: '1.3.1' }],
              },
            ],
          },
        },
      }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('unexpected network access during offline scan');
    }));

    const err = await runScan(dir, outPath, manifestPath, ['--vulns']);
    expect(err).toBeUndefined();
    expect(fs.existsSync(outPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(outPath, 'utf8')) as {
      extended?: { vulnerabilities?: { source?: string; totalAdvisories?: number } };
      findings?: Array<{ message?: string }>;
    };
    expect(report.extended?.vulnerabilities).toMatchObject({ source: 'manifest', totalAdvisories: 1 });
    expect(report.findings?.some((finding) => finding.message?.includes('GHSA-manifest-fixture'))).toBe(true);
  });

  it('scans a readable ZIP package-version manifest', async () => {
    const { dir, outPath } = project();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'manifest-ok', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
    );
    const stage = fs.mkdtempSync(path.join(tmpdir(), 'vg-scan-zip-'));
    dirs.push(stage);
    const manifestPath = path.join(stage, 'versions.zip');
    fs.writeFileSync(
      path.join(stage, 'package-versions.json'),
      JSON.stringify({
        npm: {
          'left-pad': {
            latest: '1.3.0',
            versions: ['1.3.0'],
            vulns: [
              {
                id: 'GHSA-manifest-fixture',
                summary: 'Fixture advisory',
                severity: 'moderate',
                ranges: [{ introduced: '0', fixed: '1.3.1' }],
              },
            ],
          },
        },
      }),
    );
    execFileSync('zip', ['-q', manifestPath, 'package-versions.json'], { cwd: stage });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('unexpected network access during offline scan');
    }));

    const err = await runScan(dir, outPath, manifestPath, ['--vulns']);
    expect(err).toBeUndefined();
    expect(fs.existsSync(outPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(outPath, 'utf8')) as {
      extended?: { vulnerabilities?: { source?: string } };
    };
    expect(report.extended?.vulnerabilities).toMatchObject({ source: 'manifest', totalAdvisories: 1 });
  });
});
