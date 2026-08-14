import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  applyWorktreePatch,
  createSessionWorktree,
  listSessionWorktrees,
  looksLikeWorktreeId,
  removeSessionWorktree,
  worktreeDiffToBase,
  worktreesDir,
  type GitRunner,
} from './worktree-session.js';

/** A scripted git: answers by matching the argv prefix, records calls. */
function fakeGit(
  script: Array<{ match: string[]; stdout?: string; exitCode?: number }>,
): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push(args);
    for (const s of script) {
      if (s.match.every((m, i) => args[i] === m)) {
        return { stdout: s.stdout ?? '', exitCode: s.exitCode ?? 0 };
      }
    }
    return { stdout: `unscripted: git ${args.join(' ')}`, exitCode: 1 };
  };
  return { git, calls };
}

describe('worktree-session', () => {
  const root = '/repo';

  it('validates worktree ids (never a path fragment)', () => {
    expect(looksLikeWorktreeId('wtabc123')).toBe(true);
    expect(looksLikeWorktreeId('wt' + 'a'.repeat(16))).toBe(true);
    expect(looksLikeWorktreeId('../escape')).toBe(false);
    expect(looksLikeWorktreeId('wt')).toBe(false);
    expect(looksLikeWorktreeId('sabc123')).toBe(false);
    expect(looksLikeWorktreeId('wtABC')).toBe(false);
  });

  it('creates a detached worktree at HEAD, records the base, and reports path + base', () => {
    const { git, calls } = fakeGit([
      { match: ['rev-parse', 'HEAD'], stdout: 'deadbeefcafe\n' },
      { match: ['worktree', 'add'] },
      { match: ['-C'] },
    ]);
    const wt = createSessionWorktree(git, root, 'wtabc123');
    const wtPath = path.join(worktreesDir(root), 'wtabc123');
    expect(wt).toEqual({
      id: 'wtabc123',
      path: path.join(root, '.vibgrate', 'worktrees', 'wtabc123'),
      base: 'deadbeefcafe',
    });
    expect(calls[1]).toEqual(['worktree', 'add', '--detach', wtPath, 'deadbeefcafe']);
    // The base is recorded in the worktree's config so commits inside the
    // worktree cannot drift the diff/apply anchor.
    expect(calls[2]).toEqual(['-C', wtPath, 'config', 'vibgrate.worktreeBase', 'deadbeefcafe']);
  });

  it('fails closed without a commit to base on, and on git failure', () => {
    const noHead = fakeGit([{ match: ['rev-parse', 'HEAD'], stdout: '', exitCode: 128 }]);
    expect(createSessionWorktree(noHead.git, root, 'wtabc123')).toHaveProperty('error');
    const addFails = fakeGit([
      { match: ['rev-parse', 'HEAD'], stdout: 'abc\n' },
      { match: ['worktree', 'add'], stdout: 'fatal: exists', exitCode: 128 },
    ]);
    expect(createSessionWorktree(addFails.git, root, 'wtabc123')).toHaveProperty('error');
    expect(createSessionWorktree(fakeGit([]).git, root, 'not-an-id')).toEqual({
      error: 'invalid worktree id: not-an-id',
    });
  });

  it('lists only worktrees under .vibgrate/worktrees with minted ids', () => {
    const porcelain = [
      `worktree ${root}`,
      'HEAD 1111111',
      'branch refs/heads/main',
      '',
      `worktree ${path.join(worktreesDir(root), 'wtabc123')}`,
      'HEAD 2222222',
      'detached',
      '',
      `worktree ${path.join(root, 'elsewhere')}`,
      'HEAD 3333333',
      '',
      `worktree ${path.join(worktreesDir(root), 'not-minted')}`,
      'HEAD 4444444',
      '',
    ].join('\n');
    const { git } = fakeGit([
      { match: ['worktree', 'list', '--porcelain'], stdout: porcelain },
      // No recorded base in this fixture — falls back to the porcelain HEAD.
      { match: ['-C'], exitCode: 1 },
    ]);
    expect(listSessionWorktrees(git, root)).toEqual([
      { id: 'wtabc123', path: path.join(worktreesDir(root), 'wtabc123'), base: '2222222' },
    ]);
  });

  it('prefers the recorded creation base over the worktree HEAD (commits inside must stay in the delta)', () => {
    const wtPath = path.join(worktreesDir(root), 'wtabc123');
    const porcelain = ['worktree ' + wtPath, 'HEAD movedhead', 'detached', ''].join('\n');
    const { git } = fakeGit([
      { match: ['worktree', 'list', '--porcelain'], stdout: porcelain },
      { match: ['-C', wtPath, 'config', 'vibgrate.worktreeBase'], stdout: 'creationbase\n' },
    ]);
    expect(listSessionWorktrees(git, root)).toEqual([
      { id: 'wtabc123', path: wtPath, base: 'creationbase' },
    ]);
  });

  it('matches worktrees even when git reports forward-slash paths (Windows)', () => {
    const wtPath = path.join(worktreesDir(root), 'wtabc123');
    const porcelain = ['worktree ' + wtPath.replace(/\\/g, '/'), 'HEAD abc', ''].join('\n');
    const { git } = fakeGit([
      { match: ['worktree', 'list', '--porcelain'], stdout: porcelain },
      { match: ['-C'], exitCode: 1 },
    ]);
    expect(listSessionWorktrees(git, root)).toHaveLength(1);
  });

  it('diffs vs base after staging (untracked files included), empty delta short-circuits', () => {
    const wtPath = path.join(worktreesDir(root), 'wtabc123');
    const { git, calls } = fakeGit([
      { match: ['-C', wtPath, 'add', '-A'] },
      { match: ['-C', wtPath, 'diff', '--cached', '--name-only', 'base1'], stdout: 'src/a.ts\nnew.txt\n' },
      { match: ['-C', wtPath, 'diff', '--cached', '--binary', 'base1'], stdout: 'PATCH-BODY' },
    ]);
    expect(worktreeDiffToBase(git, wtPath, 'base1')).toEqual({
      patch: 'PATCH-BODY',
      files: ['src/a.ts', 'new.txt'],
    });
    expect(calls[0]).toEqual(['-C', wtPath, 'add', '-A']);

    const empty = fakeGit([
      { match: ['-C', wtPath, 'add', '-A'] },
      { match: ['-C', wtPath, 'diff', '--cached', '--name-only', 'base1'], stdout: '\n' },
    ]);
    expect(worktreeDiffToBase(empty.git, wtPath, 'base1')).toEqual({ patch: '', files: [] });
  });

  it('applies via git apply --3way and reports failure verbatim', () => {
    const ok = fakeGit([{ match: ['-C', root, 'apply', '--3way'] }]);
    expect(applyWorktreePatch(ok.git, root, '/tmp/p.patch', ['a.ts'])).toEqual({
      applied: true,
      files: ['a.ts'],
    });
    expect(ok.calls[0]).toEqual(['-C', root, 'apply', '--3way', '--whitespace=nowarn', '/tmp/p.patch']);
    const bad = fakeGit([
      { match: ['-C', root, 'apply', '--3way'], stdout: 'error: patch failed', exitCode: 1 },
    ]);
    expect(applyWorktreePatch(bad.git, root, '/tmp/p.patch', ['a.ts'])).toEqual({
      applied: false,
      files: ['a.ts'],
      error: 'error: patch failed',
    });
  });

  it('removes with --force and validates the id first', () => {
    const { git, calls } = fakeGit([{ match: ['worktree', 'remove'] }]);
    expect(removeSessionWorktree(git, root, 'wtabc123')).toEqual({ removed: true });
    expect(calls[0]).toEqual([
      'worktree',
      'remove',
      '--force',
      path.join(worktreesDir(root), 'wtabc123'),
    ]);
    expect(removeSessionWorktree(fakeGit([]).git, root, '../etc')).toEqual({
      removed: false,
      error: 'invalid worktree id: ../etc',
    });
  });
});
