import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectKey, resolveProject, sanitizeIdentity } from './project.js';
import { NO_PROJECT } from './types.js';

describe('projectKey', () => {
  it('is stable, sanitised and hashed', () => {
    const k1 = projectKey('/home/user/My Repo!');
    const k2 = projectKey('/home/user/My Repo!/');
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^My-Repo-[0-9a-f]{16}$/);
    expect(projectKey('/other/My Repo!')).not.toBe(k1);
    expect(projectKey('')).toBe(NO_PROJECT);
  });

  it('resolves symlinked roots to one key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-proj-'));
    try {
      const real = path.join(dir, 'real');
      fs.mkdirSync(real);
      const link = path.join(dir, 'link');
      fs.symlinkSync(real, link);
      expect(projectKey(link)).toBe(projectKey(real));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizeIdentity keeps [A-Za-z0-9._-], collapses runs, trims, caps at 64', () => {
    expect(sanitizeIdentity('a b--c')).toBe('a-b--c');
    expect(sanitizeIdentity('...x...')).toBe('x');
    expect(sanitizeIdentity('!!!')).toBe('root');
    expect(sanitizeIdentity('y'.repeat(100))).toHaveLength(64);
  });
});

describe('resolveProject', () => {
  it('prefers explicit root, then env, then git; fails closed otherwise', () => {
    const git = (args: string[], cwd: string): string | null => (args[0] === 'rev-parse' ? `${cwd}/toplevel\n` : null);
    expect(resolveProject('/x', { git, root: '/explicit' })).toMatchObject({ root: path.resolve('/explicit'), resolved: true, source: 'explicit' });
    expect(resolveProject('/x', { git, env: { VG_MEMORY_PROJECT_ROOT: '/from-env' } })).toMatchObject({ root: path.resolve('/from-env'), source: 'env' });
    expect(resolveProject('/x', { git, env: {} })).toMatchObject({ root: '/x/toplevel', source: 'git', resolved: true });
    expect(resolveProject('/x', { git: () => null, env: {} })).toEqual({ root: null, key: NO_PROJECT, resolved: false, source: 'none' });
    expect(resolveProject('/x', { git: () => '\n', env: {} }).resolved).toBe(false);
  });
});
