import { describe, it, expect } from 'vitest';
import {
  checkpointRef,
  createCheckpoint,
  restoreCheckpoint,
  deleteCheckpoints,
  isGitRepo,
  isValidCheckpointCommit,
  type GitResult,
} from './checkpoint.js';

/** Records every git invocation and replies from a table of canned answers. */
function fakeGit(answers: Record<string, GitResult> = {}) {
  const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
  const ok = { stdout: '', exitCode: 0 };
  const runner = (args: string[], env?: Record<string, string>): GitResult => {
    calls.push({ args, env });
    for (const [prefix, res] of Object.entries(answers)) {
      if (args.join(' ').startsWith(prefix)) return res;
    }
    return ok;
  };
  return { runner, calls };
}

const defaults = {
  'rev-parse --is-inside-work-tree': { stdout: 'true', exitCode: 0 },
  'write-tree': { stdout: 'tree123\n', exitCode: 0 },
  'rev-parse HEAD': { stdout: 'head456\n', exitCode: 0 },
  'commit-tree': { stdout: 'commit789\n', exitCode: 0 },
};

describe('checkpointRef', () => {
  it('namespaces refs under vibgrate so they never appear in git log', () => {
    expect(checkpointRef('s7a', 2)).toBe('refs/vibgrate/checkpoints/s7a/2');
  });

  it('sanitizes an unsafe session id rather than writing a broken ref', () => {
    expect(checkpointRef('../../evil head', 1)).toBe('refs/vibgrate/checkpoints/evilhead/1');
    expect(checkpointRef('!!!', 1)).toBe('refs/vibgrate/checkpoints/session/1');
  });
});

describe('isValidCheckpointCommit', () => {
  it('accepts abbreviated and full hex SHAs', () => {
    expect(isValidCheckpointCommit('abc1234')).toBe(true);
    expect(isValidCheckpointCommit('ABC1234')).toBe(true);
    expect(isValidCheckpointCommit('a'.repeat(40))).toBe(true);
    expect(isValidCheckpointCommit('0123456789abcdef0123456789abcdef01234567')).toBe(true);
  });

  it('rejects refs, option-shaped strings, and anything git could parse as more than data', () => {
    expect(isValidCheckpointCommit('')).toBe(false);
    expect(isValidCheckpointCommit('HEAD')).toBe(false);
    expect(isValidCheckpointCommit('refs/heads/main')).toBe(false);
    expect(isValidCheckpointCommit('--force')).toBe(false);
    expect(isValidCheckpointCommit('abc123')).toBe(false); // too short to be a checkpoint id
    expect(isValidCheckpointCommit('abc1234; rm -rf')).toBe(false);
    expect(isValidCheckpointCommit('main~1')).toBe(false);
  });
});

describe('createCheckpoint', () => {
  const opts = { sessionId: 's1', seq: 1, files: ['src/a.ts'], indexFile: '/tmp/idx' };

  it('snapshots into a private index and never touches the user’s own', () => {
    const { runner, calls } = fakeGit(defaults);
    const cp = createCheckpoint(runner, opts);
    expect(cp).toEqual({
      ref: 'refs/vibgrate/checkpoints/s1/1',
      commit: 'commit789',
      seq: 1,
      files: ['src/a.ts'],
    });
    // Everything that stages or writes a tree must carry the private index.
    const staging = calls.filter((c) => c.args[0] === 'add' || c.args[0] === 'write-tree');
    expect(staging.length).toBeGreaterThan(0);
    for (const c of staging) expect(c.env?.GIT_INDEX_FILE).toBe('/tmp/idx');
    // The branch is never moved.
    expect(calls.some((c) => c.args[0] === 'commit' || c.args[0] === 'checkout')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'update-ref' && c.args[1].startsWith('refs/vibgrate/'))).toBe(true);
  });

  it('parents the snapshot on HEAD so it is inspectable with ordinary git', () => {
    const { runner, calls } = fakeGit(defaults);
    createCheckpoint(runner, opts);
    const commitTree = calls.find((c) => c.args[0] === 'commit-tree');
    expect(commitTree?.args).toContain('-p');
    expect(commitTree?.args).toContain('head456');
  });

  it('works in a repository with no commits yet (no parent)', () => {
    const { runner, calls } = fakeGit({
      ...defaults,
      'rev-parse HEAD': { stdout: '', exitCode: 128 },
    });
    expect(createCheckpoint(runner, opts)).not.toBeNull();
    const commitTree = calls.find((c) => c.args[0] === 'commit-tree');
    expect(commitTree?.args).not.toContain('-p');
  });

  it('returns null outside a git repo rather than failing the change', () => {
    const { runner } = fakeGit({ 'rev-parse --is-inside-work-tree': { stdout: '', exitCode: 128 } });
    expect(createCheckpoint(runner, opts)).toBeNull();
  });

  it('returns null when any snapshot step fails — a checkpoint never blocks an approved edit', () => {
    for (const failing of ['add -A', 'write-tree', 'commit-tree', 'update-ref']) {
      const { runner } = fakeGit({ ...defaults, [failing]: { stdout: '', exitCode: 1 } });
      expect(createCheckpoint(runner, opts), `${failing} should abort cleanly`).toBeNull();
    }
  });
});

describe('restoreCheckpoint', () => {
  it('restores a file that existed in the snapshot', () => {
    const { runner, calls } = fakeGit({ 'cat-file -e': { stdout: '', exitCode: 0 } });
    const out = restoreCheckpoint(runner, { commit: 'c1', files: ['src/a.ts'] });
    expect(out.restored).toEqual(['src/a.ts']);
    expect(out.removed).toEqual([]);
    expect(calls.some((c) => c.args.join(' ') === 'checkout c1 -- src/a.ts')).toBe(true);
  });

  it('removes a file the change created, since it is absent from the snapshot', () => {
    const { runner } = fakeGit({ 'cat-file -e': { stdout: '', exitCode: 1 } });
    const out = restoreCheckpoint(runner, { commit: 'c1', files: ['src/new.ts'] });
    expect(out.removed).toEqual(['src/new.ts']);
    expect(out.restored).toEqual([]);
  });

  it('touches only the files it was given, never the whole tree', () => {
    const { runner, calls } = fakeGit({ 'cat-file -e': { stdout: '', exitCode: 0 } });
    restoreCheckpoint(runner, { commit: 'c1', files: ['src/a.ts'] });
    const checkouts = calls.filter((c) => c.args[0] === 'checkout');
    for (const c of checkouts) {
      expect(c.args).toContain('--');
      expect(c.args[c.args.length - 1]).toBe('src/a.ts');
    }
    // No sweeping restore that would discard the user's unrelated edits.
    expect(calls.some((c) => c.args.join(' ').includes('checkout c1 -- .'))).toBe(false);
    expect(calls.some((c) => c.args[0] === 'reset')).toBe(false);
  });

  it('reports failures per file instead of aborting the rest', () => {
    const { runner } = fakeGit({
      'cat-file -e': { stdout: '', exitCode: 0 },
      'checkout c1 -- bad.ts': { stdout: '', exitCode: 1 },
    });
    const out = restoreCheckpoint(runner, { commit: 'c1', files: ['bad.ts', 'good.ts'] });
    expect(out.failed).toEqual(['bad.ts']);
    expect(out.restored).toEqual(['good.ts']);
  });
});

describe('deleteCheckpoints', () => {
  it('deletes every ref in the session', () => {
    const { runner, calls } = fakeGit();
    deleteCheckpoints(runner, 's1', 3);
    const deleted = calls.filter((c) => c.args[0] === 'update-ref' && c.args[1] === '-d');
    expect(deleted.map((c) => c.args[2])).toEqual([
      'refs/vibgrate/checkpoints/s1/1',
      'refs/vibgrate/checkpoints/s1/2',
      'refs/vibgrate/checkpoints/s1/3',
    ]);
  });
});

describe('isGitRepo', () => {
  it('is false when git is unavailable or the root is not a work tree', () => {
    const { runner } = fakeGit({ 'rev-parse --is-inside-work-tree': { stdout: '', exitCode: 127 } });
    expect(isGitRepo(runner)).toBe(false);
  });
});
