import { describe, it, expect, afterEach } from 'vitest';
import {
  activeGraphSlotKey,
  branchGraphSnapshotId,
  clearDetectGitRefCache,
  detectGitRef,
  type GitRunner,
} from './git-ref.js';

afterEach(() => {
  clearDetectGitRefCache();
});

describe('branchGraphSnapshotId', () => {
  it('maps branch names to safe path segments', () => {
    expect(branchGraphSnapshotId('main')).toBe('branch-main');
    expect(branchGraphSnapshotId('feature/foo')).toBe('branch-feature__foo');
    expect(branchGraphSnapshotId('  ')).toBe('current');
  });

  it('maps full SHAs to sha- keys', () => {
    const sha = 'a'.repeat(40);
    expect(branchGraphSnapshotId(sha)).toBe(`sha-${sha}`);
  });
});

describe('detectGitRef', () => {
  it('returns branch when rev-parse yields a name', () => {
    const run: GitRunner = (args) => {
      if (args.includes('--abbrev-ref')) return { stdout: 'main\n', status: 0 };
      return { stdout: '', status: 1 };
    };
    expect(detectGitRef('/repo', run)).toEqual({ ref: 'main', kind: 'branch' });
  });

  it('returns detached SHA when on HEAD', () => {
    const sha = 'b'.repeat(40);
    const run: GitRunner = (args) => {
      if (args.includes('--abbrev-ref')) return { stdout: 'HEAD\n', status: 0 };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${sha}\n`, status: 0 };
      return { stdout: '', status: 1 };
    };
    expect(detectGitRef('/repo', run)).toEqual({ ref: sha, kind: 'detached' });
  });

  it('returns none when git fails', () => {
    const run: GitRunner = () => ({ stdout: '', status: 128 });
    expect(detectGitRef('/repo', run)).toEqual({ ref: '', kind: 'none' });
  });

  it('does not cache when a custom runner is supplied (tests stay deterministic)', () => {
    let calls = 0;
    const run: GitRunner = (args) => {
      calls += 1;
      if (args.includes('--abbrev-ref')) return { stdout: `b${calls}\n`, status: 0 };
      return { stdout: '', status: 1 };
    };
    expect(detectGitRef('/repo', run).ref).toBe('b1');
    expect(detectGitRef('/repo', run).ref).toBe('b2');
    expect(calls).toBe(2);
  });
});

describe('activeGraphSlotKey', () => {
  it('is stable', () => {
    expect(activeGraphSlotKey('abc', 'main')).toBe('abc::main');
  });
});
