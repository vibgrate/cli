import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureCodeMap,
  renderReviewPolicy,
  reviewPolicyState,
  seedReviewPolicy,
} from './prepare.js';
import { parseReviewConfig } from './config.js';
import type { GitRunner } from './git.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-prepare-'));
}

/** A git runner that answers `show <ref>:<path>` from an in-memory map. */
function fakeGit(refs: Record<string, string>): GitRunner {
  return (args) => {
    if (args[0] === 'show' && refs[args[1]!] !== undefined) {
      return { stdout: refs[args[1]!]!, status: 0 };
    }
    return { stdout: '', status: 128 };
  };
}

describe('reviewPolicyState', () => {
  it('finds a policy on the base branch first', () => {
    const root = tmpRoot();
    const state = reviewPolicyState(
      root,
      'origin/main',
      fakeGit({ 'origin/main:.vibgrate/review.toml': '[review]\n', 'HEAD:.vibgrate/review.toml': '[review]\n' }),
    );
    expect(state).toEqual({ present: true, where: 'base-branch' });
  });

  it('falls back to HEAD, then the working tree', () => {
    const root = tmpRoot();
    expect(reviewPolicyState(root, undefined, fakeGit({ 'HEAD:.vibgrate/review.toml': '[review]\n' })).where)
      .toBe('head');

    fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vibgrate/review.toml'), '[review]\n');
    expect(reviewPolicyState(root, undefined, fakeGit({})).where).toBe('working-tree');
  });

  it('reports absent when nothing is committed and nothing is on disk', () => {
    expect(reviewPolicyState(tmpRoot(), undefined, fakeGit({}))).toEqual({ present: false, where: null });
  });

  it('treats an empty committed file as absent — the loader would too', () => {
    expect(reviewPolicyState(tmpRoot(), undefined, fakeGit({ 'HEAD:.vibgrate/review.toml': '   \n' })).present)
      .toBe(false);
  });
});

describe('seedReviewPolicy', () => {
  it('writes a parseable, advisory policy carrying the derived pattern', () => {
    const root = tmpRoot();
    const result = seedReviewPolicy({ root, observedPattern: 'clean' });

    expect(result).toEqual({ written: true, path: '.vibgrate/review.toml', targetPattern: 'clean' });
    const text = fs.readFileSync(path.join(root, '.vibgrate/review.toml'), 'utf8');
    const config = parseReviewConfig(text, 'working-tree');
    expect(config.target_pattern).toBe('clean');
    // The seed must never turn a green CI job red on its own.
    expect(config.enforcement).toBe('advisory');
    expect(config.protected).toEqual({
      unguarded_entrypoint: true,
      known_vulnerable_dependency: true,
      validated_taint: true,
    });
  });

  it('leaves target_pattern undeclared when no shape dominates', () => {
    const root = tmpRoot();
    seedReviewPolicy({ root, observedPattern: null });
    const config = parseReviewConfig(fs.readFileSync(path.join(root, '.vibgrate/review.toml'), 'utf8'), 'working-tree');
    expect(config.target_pattern).toBeNull();
  });

  it('never overwrites a policy that is already there', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vibgrate/review.toml'), '[review]\nenforcement = "enforced"\n');

    expect(seedReviewPolicy({ root, observedPattern: 'clean' }).written).toBe(false);
    expect(fs.readFileSync(path.join(root, '.vibgrate/review.toml'), 'utf8')).toContain('enforced');
  });

  it('renders a commented target_pattern rather than an invented one', () => {
    expect(renderReviewPolicy(null)).toContain('# target_pattern = "clean"');
    expect(renderReviewPolicy('hexagonal')).toContain('target_pattern = "hexagonal"');
  });
});

describe('ensureCodeMap', () => {
  it('skips the build when --no-auto-build is set, and says why', async () => {
    const result = await ensureCodeMap({ root: tmpRoot(), autoBuild: false, quiet: true });
    expect(result).toEqual({ action: 'skipped', reason: 'auto-build disabled' });
  });

  it('never builds over an explicit --graph path', async () => {
    const result = await ensureCodeMap({
      root: tmpRoot(),
      graphPath: path.join(tmpRoot(), 'missing.json'),
      quiet: true,
    });
    expect(result.action).toBe('skipped');
    expect(result.reason).toContain('--graph');
  });

  it('builds a map for a repository that has never been mapped', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src/index.ts'),
      'export function hello(name: string): string {\n  return `hi ${name}`;\n}\n',
    );
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));

    const seen: number[] = [];
    const result = await ensureCodeMap({ root, quiet: true, onProgress: (done) => seen.push(done) });

    expect(result.action).toBe('built');
    expect(result.files).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0); // progress is reported even when the bar is silent
  }, 60_000);
});
