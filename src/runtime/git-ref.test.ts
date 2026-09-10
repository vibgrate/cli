import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  activeGraphSlotKey,
  branchGraphSnapshotId,
  clearDetectGitRefCache,
  detectGitRef,
  headFingerprint,
  type GitRunner,
} from './git-ref.js';

afterEach(() => {
  clearDetectGitRefCache();
});

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gitref-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

describe('detectGitRef sees a checkout live (no restart, no manual cache clear)', () => {
  it('follows branch switches and detached checkouts through the cached path', () => {
    const dir = tempRepo();
    try {
      expect(detectGitRef(dir)).toEqual({ ref: 'main', kind: 'branch' });
      // Second call is the cached path — must still answer `main`.
      expect(detectGitRef(dir).ref).toBe('main');

      git(dir, 'checkout', '-q', '-b', 'feature/x');
      expect(detectGitRef(dir)).toEqual({ ref: 'feature/x', kind: 'branch' });

      git(dir, 'checkout', '-q', '--detach');
      const sha = git(dir, 'rev-parse', 'HEAD');
      expect(detectGitRef(dir)).toEqual({ ref: sha, kind: 'detached' });

      git(dir, 'checkout', '-q', 'main');
      expect(detectGitRef(dir).ref).toBe('main');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('works from a subdirectory of the checkout', () => {
    const dir = tempRepo();
    try {
      const sub = path.join(dir, 'packages', 'app');
      fs.mkdirSync(sub, { recursive: true });
      expect(detectGitRef(sub).ref).toBe('main');
      git(dir, 'checkout', '-q', '-b', 'sub');
      expect(detectGitRef(sub).ref).toBe('sub');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('headFingerprint follows a linked worktree pointer file and is empty outside git', () => {
    const dir = tempRepo();
    const wt = path.join(os.tmpdir(), `vg-gitref-wt-${process.pid}-${Date.now()}`);
    try {
      git(dir, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
      expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);
      expect(headFingerprint(wt)).toContain('refs/heads/wt-branch');
      expect(headFingerprint(dir)).toContain('refs/heads/main');
      expect(detectGitRef(wt).ref).toBe('wt-branch');
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gitref-plain-'));
    try {
      // Only meaningful when the temp dir itself is not inside a repository.
      if (!fs.existsSync(path.join(os.tmpdir(), '.git'))) expect(headFingerprint(plain)).toBe('');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
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
