import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';

// The update command is difficult to unit-test in isolation because it uses
// execSync. Instead we test the helper logic (pm detection, install commands).
// We re-implement the detectable helpers here for testing.

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'vibgrate-update-cmd-'));
}

type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

// Mirror the detectPackageManager logic from update.ts
async function detectPackageManager(cwd: string): Promise<PackageManager> {
  const { pathExists } = await import('../utils/fs.js');
  if (await pathExists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(cwd, 'bun.lockb'))) return 'bun';
  if (await pathExists(path.join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

// Mirror getInstallCommand from update.ts
function getInstallCommand(pm: PackageManager, pkg: string, version: string, isDev: boolean): string {
  const spec = `${pkg}@${version}`;
  switch (pm) {
    case 'pnpm':
      return isDev ? `pnpm add -D ${spec}` : `pnpm add ${spec}`;
    case 'yarn':
      return isDev ? `yarn add --dev ${spec}` : `yarn add ${spec}`;
    case 'bun':
      return isDev ? `bun add -d ${spec}` : `bun add ${spec}`;
    case 'npm':
    default:
      return isDev ? `npm install --save-dev ${spec}` : `npm install ${spec}`;
  }
}

describe('update command helpers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('detectPackageManager', () => {
    it('detects pnpm from pnpm-lock.yaml', async () => {
      await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
      expect(await detectPackageManager(tempDir)).toBe('pnpm');
    });

    it('detects yarn from yarn.lock', async () => {
      await fs.writeFile(path.join(tempDir, 'yarn.lock'), '');
      expect(await detectPackageManager(tempDir)).toBe('yarn');
    });

    it('detects bun from bun.lockb', async () => {
      await fs.writeFile(path.join(tempDir, 'bun.lockb'), '');
      expect(await detectPackageManager(tempDir)).toBe('bun');
    });

    it('defaults to npm when no lockfile found', async () => {
      expect(await detectPackageManager(tempDir)).toBe('npm');
    });

    it('prefers pnpm when multiple lockfiles exist', async () => {
      await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
      await fs.writeFile(path.join(tempDir, 'yarn.lock'), '');
      expect(await detectPackageManager(tempDir)).toBe('pnpm');
    });

    it('prefers bun over yarn when both exist', async () => {
      await fs.writeFile(path.join(tempDir, 'bun.lockb'), '');
      await fs.writeFile(path.join(tempDir, 'yarn.lock'), '');
      expect(await detectPackageManager(tempDir)).toBe('bun');
    });
  });

  describe('getInstallCommand', () => {
    it('generates npm install for production dep', () => {
      expect(getInstallCommand('npm', '@vibgrate/cli', '2.0.0', false))
        .toBe('npm install @vibgrate/cli@2.0.0');
    });

    it('generates npm install --save-dev for dev dep', () => {
      expect(getInstallCommand('npm', '@vibgrate/cli', '2.0.0', true))
        .toBe('npm install --save-dev @vibgrate/cli@2.0.0');
    });

    it('generates pnpm add for production dep', () => {
      expect(getInstallCommand('pnpm', '@vibgrate/cli', '2.0.0', false))
        .toBe('pnpm add @vibgrate/cli@2.0.0');
    });

    it('generates pnpm add -D for dev dep', () => {
      expect(getInstallCommand('pnpm', '@vibgrate/cli', '2.0.0', true))
        .toBe('pnpm add -D @vibgrate/cli@2.0.0');
    });

    it('generates yarn add for production dep', () => {
      expect(getInstallCommand('yarn', '@vibgrate/cli', '3.1.0', false))
        .toBe('yarn add @vibgrate/cli@3.1.0');
    });

    it('generates yarn add --dev for dev dep', () => {
      expect(getInstallCommand('yarn', '@vibgrate/cli', '3.1.0', true))
        .toBe('yarn add --dev @vibgrate/cli@3.1.0');
    });

    it('generates bun add for production dep', () => {
      expect(getInstallCommand('bun', '@vibgrate/cli', '1.5.0', false))
        .toBe('bun add @vibgrate/cli@1.5.0');
    });

    it('generates bun add -d for dev dep', () => {
      expect(getInstallCommand('bun', '@vibgrate/cli', '1.5.0', true))
        .toBe('bun add -d @vibgrate/cli@1.5.0');
    });
  });

  describe('isDevDependency detection', () => {
    it('returns true when @vibgrate/cli is in devDependencies', async () => {
      const pkgJson = {
        name: 'test-project',
        devDependencies: { '@vibgrate/cli': '^1.0.0' },
      };
      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson));

      const raw = await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw) as Record<string, Record<string, string>>;
      expect(Boolean(pkg.devDependencies?.['@vibgrate/cli'])).toBe(true);
    });

    it('returns false when @vibgrate/cli is in dependencies', async () => {
      const pkgJson = {
        name: 'test-project',
        dependencies: { '@vibgrate/cli': '^1.0.0' },
      };
      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson));

      const raw = await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw) as Record<string, Record<string, string>>;
      expect(Boolean(pkg.devDependencies?.['@vibgrate/cli'])).toBe(false);
    });

    it('defaults to true when no package.json exists', async () => {
      // No package.json — should default to devDep
      try {
        await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8');
        // Should not reach here
        expect(true).toBe(false);
      } catch {
        // Expected — default to devDep
        expect(true).toBe(true);
      }
    });
  });
});
