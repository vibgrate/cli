import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPackageVersionManifest, PackageVersionManifestError } from './package-version-manifest.js';

const HINT = 'Pass a JSON or ZIP package-version manifest to --package-manifest.';
const SECRET_BODY = 'file-body-secret-9f3a';
const SECRET_NEARBY = 'nearby-secret-9f3a';
const SECRET_ENV = 'env-secret-9f3a';

function expected(filePath: string, why: 'does not exist' | 'is not readable' | 'is not a package-version manifest'): string {
  return `--package-manifest ${JSON.stringify(filePath)} ${why}. ${HINT}`;
}

describe('package version manifest loader', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) {
      await chmod(dir, 0o755).catch(() => {});
      await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }));
    }
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vg-manifest-'));
    dirs.push(dir);
    await writeFile(path.join(dir, `${SECRET_NEARBY}.txt`), SECRET_BODY);
    vi.stubEnv('VG_PKG_MANIFEST_SECRET', SECRET_ENV);
    return dir;
  }

  function assertClosed(err: unknown, filePath: string, why: 'does not exist' | 'is not readable' | 'is not a package-version manifest'): void {
    expect(err).toBeInstanceOf(PackageVersionManifestError);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toBe(expected(filePath, why));
    expect(message).not.toContain(SECRET_BODY);
    expect(message).not.toContain(SECRET_NEARBY);
    expect(message).not.toContain(SECRET_ENV);
    expect(message).not.toContain(os.homedir());
    expect(message).not.toContain('vibgrate-manifest-');
    expect(message).not.toContain('unzip');
  }

  it('loads JSON manifest files', async () => {
    const dir = await tempDir();
    const manifestPath = path.join(dir, 'package-versions.json');
    await writeFile(manifestPath, JSON.stringify({ npm: { react: { latest: '19.0.0', versions: ['18.3.1', '19.0.0'] } } }));

    const manifest = await loadPackageVersionManifest(manifestPath);
    expect(manifest.npm?.react?.latest).toBe('19.0.0');
  });

  it('loads a ZIP package-version manifest entry', async () => {
    const dir = await tempDir();
    const jsonPath = path.join(dir, 'package-versions.json');
    const zipPath = path.join(dir, 'versions.zip');
    await writeFile(jsonPath, JSON.stringify({ npm: { react: { latest: '19.0.0', versions: ['19.0.0'] } } }));
    execFileSync('zip', ['-q', zipPath, 'package-versions.json'], { cwd: dir });

    const manifest = await loadPackageVersionManifest(zipPath);
    expect(manifest.npm?.react?.latest).toBe('19.0.0');
  });

  it('rejects a missing path', async () => {
    const dir = await tempDir();
    const manifestPath = path.join(dir, 'missing.json');
    await expect(loadPackageVersionManifest(manifestPath)).rejects.toSatisfy((err: unknown) => {
      assertClosed(err, manifestPath, 'does not exist');
      return true;
    });
  });

  it('rejects an unreadable path', async () => {
    const dir = await tempDir();
    const manifestPath = path.join(dir, 'secret.json');
    await writeFile(manifestPath, JSON.stringify({ note: SECRET_BODY, npm: { react: { latest: '1.0.0' } } }));
    await chmod(manifestPath, 0);
    await expect(loadPackageVersionManifest(manifestPath)).rejects.toSatisfy((err: unknown) => {
      assertClosed(err, manifestPath, 'is not readable');
      return true;
    });
  });

  it('rejects a directory', async () => {
    const dir = await tempDir();
    const manifestPath = path.join(dir, 'not-a-file');
    await import('node:fs/promises').then((fs) => fs.mkdir(manifestPath));
    await writeFile(path.join(manifestPath, `${SECRET_NEARBY}.json`), SECRET_BODY);
    await expect(loadPackageVersionManifest(manifestPath)).rejects.toSatisfy((err: unknown) => {
      assertClosed(err, manifestPath, 'is not a package-version manifest');
      return true;
    });
  });

  it('rejects invalid JSON', async () => {
    const dir = await tempDir();
    const manifestPath = path.join(dir, 'broken.json');
    await writeFile(manifestPath, `{not json ${SECRET_BODY}`);
    await expect(loadPackageVersionManifest(manifestPath)).rejects.toSatisfy((err: unknown) => {
      assertClosed(err, manifestPath, 'is not a package-version manifest');
      return true;
    });
  });

  it('rejects JSON that is not a package-version manifest', async () => {
    const dir = await tempDir();
    const manifestPath = path.join(dir, 'package.json');
    await writeFile(manifestPath, JSON.stringify({ name: 'app', version: '1.0.0', note: SECRET_BODY, dependencies: {} }));
    await expect(loadPackageVersionManifest(manifestPath)).rejects.toSatisfy((err: unknown) => {
      assertClosed(err, manifestPath, 'is not a package-version manifest');
      return true;
    });
  });

  it('rejects a ZIP without a package-version manifest entry', async () => {
    const dir = await tempDir();
    const noteName = `${SECRET_NEARBY}.txt`;
    const zipPath = path.join(dir, 'bundle.zip');
    await writeFile(path.join(dir, noteName), SECRET_BODY);
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ name: SECRET_BODY }));
    execFileSync('zip', ['-q', zipPath, noteName, 'manifest.json'], { cwd: dir });
    await expect(loadPackageVersionManifest(zipPath)).rejects.toSatisfy((err: unknown) => {
      assertClosed(err, zipPath, 'is not a package-version manifest');
      return true;
    });
  });

  it('rejects a ZIP that is not a zip archive', async () => {
    const dir = await tempDir();
    const zipPath = path.join(dir, 'not-a-zip.zip');
    await writeFile(zipPath, `not a zip ${SECRET_BODY}`);
    await expect(loadPackageVersionManifest(zipPath)).rejects.toSatisfy((err: unknown) => {
      assertClosed(err, zipPath, 'is not a package-version manifest');
      return true;
    });
  });
});
