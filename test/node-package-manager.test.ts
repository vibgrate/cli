import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanNodeProjects } from '../src/core-open/scanners/node-scanner.js';
import { NpmCache } from '../src/core-open/scanners/npm-cache.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const BUN_TEXT_LOCK = JSON.stringify({
  lockfileVersion: 1,
  workspaces: { '': { name: 'bun-app' } },
  packages: {},
});

const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibgrate-node-pm-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

async function packageManagerOf(dir: string): Promise<string | undefined> {
  const projects = await scanNodeProjects(dir, new NpmCache(dir, new Semaphore(1), undefined, true));
  return projects.find((p) => p.path === '.')?.packageManager;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Node package manager detection from lockfiles', () => {
  it('detects bun from the text bun.lock alone', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'bun-app', version: '1.0.0' }),
      'bun.lock': BUN_TEXT_LOCK,
    });
    expect(await packageManagerOf(dir)).toBe('bun');
  });

  it('still detects bun from the binary bun.lockb', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'bun-app', version: '1.0.0' }),
      'bun.lockb': '',
    });
    expect(await packageManagerOf(dir)).toBe('bun');
  });

  it('lets the packageManager field win over bun.lock', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'bun-app', version: '1.0.0', packageManager: 'yarn@4.5.0' }),
      'bun.lock': BUN_TEXT_LOCK,
    });
    expect(await packageManagerOf(dir)).toBe('yarn');
  });
});
