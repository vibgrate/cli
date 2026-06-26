import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addLibrary, loadCatalog, resolveLib, driftFor, libId, parseGitSource } from '../src/engine/lib.js';
import { ASSISTANTS } from '../src/install/registry.js';
import { makeProject, cleanup } from './helpers.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('vg lib catalog', () => {
  it('ingests a local doc and records the lockfile version', async () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { leftpad: '^1.3.0' } }),
      'node_modules/leftpad/package.json': JSON.stringify({ name: 'leftpad', version: '1.3.0' }),
      'LEFTPAD.md': '# leftpad\nUsage docs.',
    });
    const entry = await addLibrary('LEFTPAD.md', { root, name: 'leftpad' });
    expect(entry.version).toBe('1.3.0');
    expect(fs.existsSync(path.join(root, entry.docFile))).toBe(true);

    const catalog = loadCatalog(root);
    expect(resolveLib(catalog, 'leftpad')?.id).toBe('leftpad');
  });

  it('annotates drift when the installed version moves ahead', async () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { leftpad: '^1.3.0' } }),
      'node_modules/leftpad/package.json': JSON.stringify({ name: 'leftpad', version: '1.3.0' }),
      'D.md': 'docs',
    });
    const entry = await addLibrary('D.md', { root, name: 'leftpad', version: '1.3.0' });
    expect(driftFor(root, entry).drift).toBe('current');
    fs.writeFileSync(path.join(root, 'node_modules/leftpad/package.json'), JSON.stringify({ name: 'leftpad', version: '2.0.0' }));
    expect(driftFor(root, { ...entry }).drift).toBe('behind');
  });

  it('refuses network fetch without --online', async () => {
    const root = project({ 'package.json': '{}' });
    await expect(addLibrary('https://example.com/llms.txt', { root, name: 'x' })).rejects.toThrow(/offline/);
  });

  it('normalizes ids', () => {
    expect(libId('@scope/My_Lib')).toBe('scope-my-lib');
  });
});

describe('vg lib git source', () => {
  it('classifies git sources deterministically (and leaves plain URLs alone)', () => {
    expect(parseGitSource('git+https://github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
    expect(parseGitSource('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');
    expect(parseGitSource('https://github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
    expect(parseGitSource('https://example.com/docs/llms.txt')).toBeNull();
    expect(parseGitSource('./local/path')).toBeNull();
  });

  it('refuses to clone without --online', async () => {
    const root = project({ 'package.json': '{}' });
    await expect(addLibrary('git+https://github.com/org/repo.git', { root, name: 'x' })).rejects.toThrow(/offline/);
  });

  it('clones a git repo and ingests its README (hermetic, local file:// remote)', async () => {
    // A real git repo on disk, cloned over file:// — exercises the clone path with no network.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-git-remote-'));
    dirs.push(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'ignore' });
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'README.md'), '# coollib\nVersion-correct usage docs.');
    git('add', '.');
    git('commit', '-q', '-m', 'init');

    const root = project({ 'package.json': '{}' });
    const entry = await addLibrary(`git+file://${repo}`, { root, name: 'coollib', allowNetwork: true });
    expect(entry.source.type).toBe('git');
    expect(fs.readFileSync(path.join(root, entry.docFile), 'utf8')).toContain('Version-correct usage docs.');
    expect(resolveLib(loadCatalog(root), 'coollib')?.id).toBe('coollib');
  });
});

describe('install breadth', () => {
  it('supports 20+ assistants with unique ids', () => {
    expect(ASSISTANTS.length).toBeGreaterThanOrEqual(20);
    const ids = ASSISTANTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every assistant has at least a skill or a nudge', () => {
    for (const a of ASSISTANTS) expect(Boolean(a.skill || a.nudge || a.mcp)).toBe(true);
  });
});
