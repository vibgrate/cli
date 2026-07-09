import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { scanSecurityPosture } from './security-posture.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'vibgrate-secposture-test-'));
}

describe('scanSecurityPosture', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ── Empty directory ──

  it('returns clean result for empty directory', async () => {
    const result = await scanSecurityPosture(tempDir);
    expect(result.lockfilePresent).toBe(false);
    expect(result.multipleLockfileTypes).toBe(false);
    expect(result.gitignoreCoversEnv).toBe(false);
    expect(result.gitignoreCoversNodeModules).toBe(false);
    expect(result.envFilesTracked).toBe(false);
    expect(result.lockfileTypes).toEqual([]);
  });

  // ── Lockfile detection ──

  it('detects pnpm lockfile', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
    const result = await scanSecurityPosture(tempDir);
    expect(result.lockfilePresent).toBe(true);
    expect(result.lockfileTypes).toContain('pnpm');
  });

  it('detects npm lockfile', async () => {
    await fs.writeFile(path.join(tempDir, 'package-lock.json'), '{}');
    const result = await scanSecurityPosture(tempDir);
    expect(result.lockfilePresent).toBe(true);
    expect(result.lockfileTypes).toContain('npm');
  });

  it('detects yarn lockfile', async () => {
    await fs.writeFile(path.join(tempDir, 'yarn.lock'), '');
    const result = await scanSecurityPosture(tempDir);
    expect(result.lockfilePresent).toBe(true);
    expect(result.lockfileTypes).toContain('yarn');
  });

  it('detects bun lockfile', async () => {
    await fs.writeFile(path.join(tempDir, 'bun.lockb'), '');
    const result = await scanSecurityPosture(tempDir);
    expect(result.lockfilePresent).toBe(true);
    expect(result.lockfileTypes).toContain('bun');
  });

  it('detects nuget lockfile', async () => {
    await fs.writeFile(path.join(tempDir, 'packages.lock.json'), '{}');
    const result = await scanSecurityPosture(tempDir);
    expect(result.lockfilePresent).toBe(true);
    expect(result.lockfileTypes).toContain('nuget');
  });

  it('detects multiple lockfiles', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
    await fs.writeFile(path.join(tempDir, 'yarn.lock'), '');
    const result = await scanSecurityPosture(tempDir);
    expect(result.lockfilePresent).toBe(true);
    expect(result.multipleLockfileTypes).toBe(true);
    expect(result.lockfileTypes).toContain('pnpm');
    expect(result.lockfileTypes).toContain('yarn');
  });

  it('does not flag multiple when only one lockfile exists', async () => {
    await fs.writeFile(path.join(tempDir, 'package-lock.json'), '{}');
    const result = await scanSecurityPosture(tempDir);
    expect(result.multipleLockfileTypes).toBe(false);
  });

  it('sorts lockfile types alphabetically', async () => {
    await fs.writeFile(path.join(tempDir, 'yarn.lock'), '');
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
    await fs.writeFile(path.join(tempDir, 'package-lock.json'), '{}');
    const result = await scanSecurityPosture(tempDir);
    expect(result.lockfileTypes).toEqual(['npm', 'pnpm', 'yarn']);
  });

  // ── .gitignore env coverage ──

  it('detects .gitignore covers .env', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), '.env\nnode_modules');
    const result = await scanSecurityPosture(tempDir);
    expect(result.gitignoreCoversEnv).toBe(true);
  });

  it('detects .env* glob pattern', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), '.env*\n');
    const result = await scanSecurityPosture(tempDir);
    expect(result.gitignoreCoversEnv).toBe(true);
  });

  it('detects .env.* pattern', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), '.env.*\n');
    const result = await scanSecurityPosture(tempDir);
    expect(result.gitignoreCoversEnv).toBe(true);
  });

  it('detects *.env pattern', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), '*.env\n');
    const result = await scanSecurityPosture(tempDir);
    expect(result.gitignoreCoversEnv).toBe(true);
  });

  it('does not flag env coverage for unrelated patterns', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'dist/\nbuild/\n');
    const result = await scanSecurityPosture(tempDir);
    expect(result.gitignoreCoversEnv).toBe(false);
  });

  // ── .gitignore node_modules coverage ──

  it('detects node_modules in .gitignore', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'node_modules\n');
    const result = await scanSecurityPosture(tempDir);
    expect(result.gitignoreCoversNodeModules).toBe(true);
  });

  it('detects node_modules/ with trailing slash', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'node_modules/\n');
    const result = await scanSecurityPosture(tempDir);
    expect(result.gitignoreCoversNodeModules).toBe(true);
  });

  it('detects /node_modules with leading slash', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), '/node_modules\n');
    const result = await scanSecurityPosture(tempDir);
    expect(result.gitignoreCoversNodeModules).toBe(true);
  });

  it('does not flag node_modules when not in gitignore', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'dist/\n');
    const result = await scanSecurityPosture(tempDir);
    expect(result.gitignoreCoversNodeModules).toBe(false);
  });

  // ── .env files tracked ──

  it('flags .env files as tracked when not in gitignore', async () => {
    await fs.writeFile(path.join(tempDir, '.env'), 'SECRET=123');
    const result = await scanSecurityPosture(tempDir);
    expect(result.envFilesTracked).toBe(true);
  });

  it('flags .env.local as tracked when not in gitignore', async () => {
    await fs.writeFile(path.join(tempDir, '.env.local'), 'SECRET=abc');
    const result = await scanSecurityPosture(tempDir);
    expect(result.envFilesTracked).toBe(true);
  });

  it('does not flag env files when .gitignore covers them', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), '.env\n');
    await fs.writeFile(path.join(tempDir, '.env'), 'SECRET=123');
    const result = await scanSecurityPosture(tempDir);
    expect(result.envFilesTracked).toBe(false);
  });

  it('does not flag env tracked when no env files exist', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'dist/\n');
    const result = await scanSecurityPosture(tempDir);
    expect(result.envFilesTracked).toBe(false);
  });

  // ── Combined scenarios ──

  it('handles well-configured project', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
    await fs.writeFile(path.join(tempDir, '.gitignore'), '.env\nnode_modules/\ndist/\n');
    await fs.writeFile(path.join(tempDir, '.env'), 'DB=postgres://localhost');
    const result = await scanSecurityPosture(tempDir);
    expect(result.lockfilePresent).toBe(true);
    expect(result.multipleLockfileTypes).toBe(false);
    expect(result.gitignoreCoversEnv).toBe(true);
    expect(result.gitignoreCoversNodeModules).toBe(true);
    expect(result.envFilesTracked).toBe(false);
  });

  it('handles poorly configured project', async () => {
    // No lockfile, no gitignore, env files present
    await fs.writeFile(path.join(tempDir, '.env'), 'SECRET=leaked');
    await fs.writeFile(path.join(tempDir, '.env.production'), 'PROD_KEY=oops');
    const result = await scanSecurityPosture(tempDir);
    expect(result.lockfilePresent).toBe(false);
    expect(result.gitignoreCoversEnv).toBe(false);
    expect(result.gitignoreCoversNodeModules).toBe(false);
    expect(result.envFilesTracked).toBe(true);
  });

  it('handles missing .gitignore gracefully', async () => {
    await fs.writeFile(path.join(tempDir, 'package.json'), '{}');
    const result = await scanSecurityPosture(tempDir);
    expect(result.gitignoreCoversEnv).toBe(false);
    expect(result.gitignoreCoversNodeModules).toBe(false);
  });
});
