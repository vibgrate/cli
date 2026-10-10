// `vg scan --package-manifest` must fail closed before a scan when the file
// is missing, unreadable, or not a package-version manifest.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError, ExitCode } from '../../util/exit.js';
import {
  ZIP_MANIFEST_MAX_ENTRIES,
  archiveLimitMessage,
} from '../../core-open/utils/zip-manifest.js';
import { scanCommand } from './scan.js';

const BODY_SENTINEL = 'manifest-body-sentinel-9f3a2c';
const NEARBY_SENTINEL = 'nearby-file-sentinel-77ab';
const ENV_SENTINEL = 'env-sentinel-manifest-4c1e';
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('scan --package-manifest fail closed', () => {
  let dir: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-manifest-scan-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, '.env'), `TOKEN=${NEARBY_SENTINEL}\n`);
    vi.stubEnv('VIBGRATE_DSN', '');
    vi.stubEnv('VIBGRATE_NO_KERNEL', '1');
    vi.stubEnv('VIBGRATE_MANIFEST_SENTINEL', ENV_SENTINEL);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllEnvs();
    // A mode-0 manifest is still unlinkable while its directory is writable.
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: string[]) =>
    scanCommand.parseAsync(['node', 'scan', dir, '--offline', '--no-daemon', '--no-graph', '--quiet', '--vulns', ...args]);

  function assertClosed(message: string): void {
    expect(message).not.toContain(BODY_SENTINEL);
    expect(message).not.toContain(NEARBY_SENTINEL);
    expect(message).not.toContain(ENV_SENTINEL);
    expect(message).not.toContain('ENOENT');
    expect(message).not.toContain('EACCES');
    expect(fs.existsSync(path.join(dir, '.vibgrate'))).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  }

  it('exits with an actionable error when the manifest is missing', async () => {
    const missing = path.join(dir, 'missing-package-versions.json');
    const error = await run(['--package-manifest', missing]).then(
      () => {
        throw new Error('expected a missing manifest to fail the scan');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      code: ExitCode.ERROR,
      message: `Package manifest not found: ${missing}. Pass a readable JSON or ZIP package-version manifest to --package-manifest.`,
    });
    assertClosed((error as Error).message);
  });

  it('exits with an actionable error when the manifest is not readable', async () => {
    const manifest = path.join(dir, 'package-versions.json');
    fs.writeFileSync(manifest, `{"npm":{},"note":"${BODY_SENTINEL}"}`);
    fs.chmodSync(manifest, 0);

    const error = await run(['--package-manifest', manifest]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      code: ExitCode.ERROR,
      message: `Package manifest is not readable: ${manifest}. Check permissions and pass a readable JSON or ZIP package-version manifest to --package-manifest.`,
    });
    assertClosed((error as Error).message);
  });

  it('exits with an actionable error when the manifest is not usable', async () => {
    const manifest = path.join(dir, 'package-versions.json');
    fs.writeFileSync(manifest, `not-json ${BODY_SENTINEL}`);

    const error = await run(['--package-manifest', manifest]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      code: ExitCode.ERROR,
      message: `Package manifest is not usable: ${manifest}. Expected a JSON object of package versions, or a ZIP containing package-versions.json, manifest.json, or index.json.`,
    });
    assertClosed((error as Error).message);
  });

  it('exits with an actionable error when a ZIP manifest exceeds the entry limit', async () => {
    const zipPath = path.join(dir, 'package-versions.zip');
    fs.writeFileSync(zipPath, overEntryZip(Buffer.from(BODY_SENTINEL)));
    const expected = archiveLimitMessage(zipPath, 'entries', ZIP_MANIFEST_MAX_ENTRIES, ZIP_MANIFEST_MAX_ENTRIES + 1);

    const error = await run(['--package-manifest', zipPath]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: ExitCode.ERROR, message: expected });
    assertClosed((error as Error).message);
    expect((error as Error).message).toContain(`${ZIP_MANIFEST_MAX_ENTRIES}-entry limit`);
    expect((error as Error).message).toContain(zipPath);
  });

  it('still scans when the manifest is a usable JSON file', async () => {
    const manifest = path.join(dir, 'package-versions.json');
    const out = path.join(dir, 'scan.json');
    fs.writeFileSync(manifest, JSON.stringify({ npm: { react: { latest: '19.0.0', versions: ['19.0.0'] } } }));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await run(['--package-manifest', manifest, '--format', 'json', '--out', out]);
      expect(fs.existsSync(out)).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  }, 60_000);
});

describe('scan --package-manifest process exit', () => {
  it('prints the stable error and exits non-zero for a missing manifest', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-manifest-exit-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, '.env'), `TOKEN=${NEARBY_SENTINEL}\n`);
    const missing = path.join(dir, 'missing-package-versions.json');
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');

    try {
      const res = spawnSync(
        process.execPath,
        [tsx, path.join(PACKAGE_ROOT, 'src/cli.ts'), 'scan', dir, '--offline', '--no-daemon', '--no-graph', '--quiet', '--vulns', '--package-manifest', missing],
        {
          cwd: dir,
          encoding: 'utf8',
          env: {
            ...process.env,
            NO_COLOR: '1',
            VIBGRATE_DSN: '',
            VIBGRATE_NO_KERNEL: '1',
            VIBGRATE_MANIFEST_SENTINEL: ENV_SENTINEL,
          },
        },
      );

      expect(res.status).toBe(ExitCode.ERROR);
      const stderr = res.stderr ?? '';
      expect(stderr).toContain(`error: Package manifest not found: ${missing}. Pass a readable JSON or ZIP package-version manifest to --package-manifest.`);
      expect(stderr).not.toContain(BODY_SENTINEL);
      expect(stderr).not.toContain(NEARBY_SENTINEL);
      expect(stderr).not.toContain(ENV_SENTINEL);
      expect(stderr).not.toContain('ENOENT');
      expect(stderr).not.toMatch(/\n\s+at /);
      expect(fs.existsSync(path.join(dir, '.vibgrate'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('prints the entry-limit error and exits non-zero for an over-limit ZIP', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-manifest-zip-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, '.env'), `TOKEN=${NEARBY_SENTINEL}\n`);
    const zipPath = path.join(dir, 'package-versions.zip');
    fs.writeFileSync(zipPath, overEntryZip(Buffer.from(BODY_SENTINEL)));
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');

    try {
      const res = spawnSync(
        process.execPath,
        [tsx, path.join(PACKAGE_ROOT, 'src/cli.ts'), 'scan', dir, '--offline', '--no-daemon', '--no-graph', '--quiet', '--vulns', '--package-manifest', zipPath],
        {
          cwd: dir,
          encoding: 'utf8',
          env: {
            ...process.env,
            NO_COLOR: '1',
            VIBGRATE_DSN: '',
            VIBGRATE_NO_KERNEL: '1',
            VIBGRATE_MANIFEST_SENTINEL: ENV_SENTINEL,
          },
        },
      );

      expect(res.status).toBe(ExitCode.ERROR);
      const stderr = res.stderr ?? '';
      // cwd is the project, so the archive path in the message is relative.
      expect(stderr).toContain(
        `error: Package manifest is not usable: package-versions.zip. The archive exceeds the ${ZIP_MANIFEST_MAX_ENTRIES}-entry limit (${ZIP_MANIFEST_MAX_ENTRIES + 1} entries). Pass a JSON package-version manifest to --package-manifest.`,
      );
      expect(stderr).not.toContain(BODY_SENTINEL);
      expect(stderr).not.toContain(NEARBY_SENTINEL);
      expect(stderr).not.toContain(ENV_SENTINEL);
      expect(stderr).not.toMatch(/\n\s+at /);
      expect(fs.existsSync(path.join(dir, '.vibgrate'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/** Tiny ZIP whose central directory claims one more entry than the manifest bound. */
function overEntryZip(body: Buffer): Buffer {
  const name = Buffer.from('package-versions.json');
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
    u32(body.length), u32(body.length), u16(name.length), u16(0), name, body,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
    u32(body.length), u32(body.length), u16(name.length), u16(0), u16(0),
    u16(0), u16(0), u32(0), u32(0), name,
  ]);
  const count = ZIP_MANIFEST_MAX_ENTRIES + 1;
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(count), u16(count),
    u32(central.length), u32(local.length), u16(0),
  ]);
  return Buffer.concat([local, central, eocd]);
}
