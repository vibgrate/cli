import { describe, it, expect } from 'vitest';
import { activeGraphSlotKey, branchGraphSnapshotId, detectGitRef, type GitRunner } from './git-ref.js';

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
});

describe('activeGraphSlotKey', () => {
  it('is stable', () => {
    expect(activeGraphSlotKey('abc', 'main')).toBe('abc::main');
  });
});
