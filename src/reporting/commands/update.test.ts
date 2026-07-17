import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  detectGlobalInstall,
  detectPackageManager,
  detectWorkspaceRoot,
  findGlobalInstall,
  getInstallCommand,
  getLocalDependencyState,
} from './update.js';

// The update command is difficult to unit-test end-to-end because it shells out
// via execSync. Instead we test the exported helper logic (pm detection,
// workspace-root detection, install-command construction).

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'vibgrate-update-cmd-'));
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

  describe('detectWorkspaceRoot', () => {
    it('detects a pnpm workspace root from pnpm-workspace.yaml', async () => {
      await fs.writeFile(path.join(tempDir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      expect(await detectWorkspaceRoot(tempDir)).toBe(true);
    });

    it('detects a workspace root from a package.json workspaces array', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      );
      expect(await detectWorkspaceRoot(tempDir)).toBe(true);
    });

    it('detects a workspace root from a package.json workspaces object', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
      );
      expect(await detectWorkspaceRoot(tempDir)).toBe(true);
    });

    it('returns false for a plain project with no workspace markers', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'app', dependencies: { '@vibgrate/cli': '^1.0.0' } }),
      );
      expect(await detectWorkspaceRoot(tempDir)).toBe(false);
    });

    it('returns false when there is no package.json and no workspace file', async () => {
      expect(await detectWorkspaceRoot(tempDir)).toBe(false);
    });

    it('returns false when package.json is malformed', async () => {
      await fs.writeFile(path.join(tempDir, 'package.json'), '{ not valid json');
      expect(await detectWorkspaceRoot(tempDir)).toBe(false);
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

    it('adds -w for a pnpm workspace-root production dep', () => {
      expect(getInstallCommand('pnpm', '@vibgrate/cli', '2.0.0', false, { workspaceRoot: true }))
        .toBe('pnpm add -w @vibgrate/cli@2.0.0');
    });

    it('adds -w for a pnpm workspace-root dev dep', () => {
      expect(getInstallCommand('pnpm', '@vibgrate/cli', '2.0.0', true, { workspaceRoot: true }))
        .toBe('pnpm add -w -D @vibgrate/cli@2.0.0');
    });

    it('does not add -w for non-pnpm managers even at a workspace root', () => {
      expect(getInstallCommand('npm', '@vibgrate/cli', '2.0.0', true, { workspaceRoot: true }))
        .toBe('npm install --save-dev @vibgrate/cli@2.0.0');
      expect(getInstallCommand('yarn', '@vibgrate/cli', '2.0.0', false, { workspaceRoot: true }))
        .toBe('yarn add @vibgrate/cli@2.0.0');
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

  describe('getLocalDependencyState', () => {
    it("returns 'dev' when @vibgrate/cli is in devDependencies", async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', devDependencies: { '@vibgrate/cli': '^1.0.0' } }),
      );
      expect(await getLocalDependencyState(tempDir)).toBe('dev');
    });

    it("returns 'prod' when @vibgrate/cli is in dependencies", async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', dependencies: { '@vibgrate/cli': '^1.0.0' } }),
      );
      expect(await getLocalDependencyState(tempDir)).toBe('prod');
    });

    it("prefers 'dev' when declared in both sections", async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'test-project',
          dependencies: { '@vibgrate/cli': '^1.0.0' },
          devDependencies: { '@vibgrate/cli': '^1.0.0' },
        }),
      );
      expect(await getLocalDependencyState(tempDir)).toBe('dev');
    });

    it('returns null when the package is not declared', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test-project', dependencies: { lodash: '^4.0.0' } }),
      );
      expect(await getLocalDependencyState(tempDir)).toBe(null);
    });

    it('returns null when no package.json exists', async () => {
      expect(await getLocalDependencyState(tempDir)).toBe(null);
    });

    it('returns null when package.json is malformed', async () => {
      await fs.writeFile(path.join(tempDir, 'package.json'), '{ not valid json');
      expect(await getLocalDependencyState(tempDir)).toBe(null);
    });
  });

  describe('detectGlobalInstall', () => {
    it('detects an npm global install from a node_modules path outside the project', () => {
      expect(
        detectGlobalInstall('/usr/local/lib/node_modules/@vibgrate/cli/dist/cli.js', '/home/me/project'),
      ).toBe('npm');
    });

    it('resolves the global bin symlink before inspecting the path', async () => {
      // Reproduce a real global layout: bin/vg is a symlink into lib/node_modules.
      const target = path.join(tempDir, 'lib', 'node_modules', '@vibgrate', 'cli', 'dist', 'cli.js');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, '');
      const bin = path.join(tempDir, 'bin', 'vg');
      await fs.mkdir(path.dirname(bin), { recursive: true });
      await fs.symlink(target, bin);
      expect(detectGlobalInstall(bin, '/home/me/project')).toBe('npm');
    });

    it('detects a pnpm global install', () => {
      expect(
        detectGlobalInstall(
          '/home/me/.local/share/pnpm/global/5/node_modules/@vibgrate/cli/dist/cli.js',
          '/home/me/project',
        ),
      ).toBe('pnpm');
    });

    it('returns null for a local install inside the project node_modules', () => {
      expect(
        detectGlobalInstall('/home/me/project/node_modules/@vibgrate/cli/dist/cli.js', '/home/me/project'),
      ).toBe(null);
    });

    it('returns null for an npx cache run', () => {
      expect(
        detectGlobalInstall('/home/me/.npm/_npx/abc123/node_modules/@vibgrate/cli/dist/cli.js', '/home/me/project'),
      ).toBe(null);
    });

    it('returns null for a path with no node_modules segment', () => {
      expect(detectGlobalInstall('/usr/local/bin/vg-standalone', '/home/me/project')).toBe(null);
    });

    it('returns null for an empty exec path', () => {
      expect(detectGlobalInstall('', '/home/me/project')).toBe(null);
    });
  });

  describe('findGlobalInstall', () => {
    it('finds the package in the npm global root', async () => {
      const npmRoot = path.join(tempDir, 'npm-global', 'node_modules');
      await fs.mkdir(path.join(npmRoot, '@vibgrate', 'cli'), { recursive: true });
      const run = (cmd: string): string => {
        if (cmd === 'npm root -g') return `${npmRoot}\n`;
        throw new Error(`not installed: ${cmd}`);
      };
      expect(await findGlobalInstall('@vibgrate/cli', run)).toBe('npm');
    });

    it('falls through to pnpm when npm does not have the package', async () => {
      const npmRoot = path.join(tempDir, 'npm-global', 'node_modules');
      const pnpmRoot = path.join(tempDir, 'pnpm-global', 'node_modules');
      await fs.mkdir(npmRoot, { recursive: true });
      await fs.mkdir(path.join(pnpmRoot, '@vibgrate', 'cli'), { recursive: true });
      const run = (cmd: string): string => {
        if (cmd === 'npm root -g') return npmRoot;
        if (cmd === 'pnpm root -g') return pnpmRoot;
        throw new Error(`not installed: ${cmd}`);
      };
      expect(await findGlobalInstall('@vibgrate/cli', run)).toBe('pnpm');
    });

    it('checks the yarn global dir under node_modules', async () => {
      const yarnDir = path.join(tempDir, 'yarn-global');
      await fs.mkdir(path.join(yarnDir, 'node_modules', '@vibgrate', 'cli'), { recursive: true });
      const run = (cmd: string): string => {
        if (cmd === 'yarn global dir') return yarnDir;
        throw new Error(`not installed: ${cmd}`);
      };
      expect(await findGlobalInstall('@vibgrate/cli', run)).toBe('yarn');
    });

    it('returns null when no package manager has a global copy', async () => {
      const run = (): string => {
        throw new Error('not installed');
      };
      expect(await findGlobalInstall('@vibgrate/cli', run)).toBe(null);
    });
  });
});
