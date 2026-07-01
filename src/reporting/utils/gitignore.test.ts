import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { findGitRoot, ensureGitignored } from './gitignore.js';

describe('gitignore helper', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'vibgrate-gitignore-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const initRepo = () => fs.mkdirSync(path.join(dir, '.git'));
  const readGitignore = () => fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');

  it('does nothing when not inside a git repo (negative case)', () => {
    // No `.git` anywhere under the temp dir.
    const res = ensureGitignored('.vibgrate/credentials.json', dir);
    expect(res.status).toBe('not-a-repo');
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
  });

  it('creates .gitignore when the repo has none', () => {
    initRepo();
    const res = ensureGitignored('.vibgrate/credentials.json', dir);
    expect(res.status).toBe('created');
    expect(readGitignore()).toBe('.vibgrate/credentials.json\n');
  });

  it('appends to an existing .gitignore, fixing a missing trailing newline', () => {
    initRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules', 'utf8'); // no newline
    const res = ensureGitignored('.vibgrate/credentials.json', dir);
    expect(res.status).toBe('added');
    expect(readGitignore()).toBe('node_modules\n.vibgrate/credentials.json\n');
  });

  it('is idempotent — never duplicates an existing entry', () => {
    initRepo();
    expect(ensureGitignored('.vibgrate/credentials.json', dir).status).toBe('created');
    const second = ensureGitignored('.vibgrate/credentials.json', dir);
    expect(second.status).toBe('present');
    expect(readGitignore()).toBe('.vibgrate/credentials.json\n');
    // The line appears exactly once.
    const count = readGitignore().split('\n').filter((l) => l.trim() === '.vibgrate/credentials.json').length;
    expect(count).toBe(1);
  });

  it('treats ./ and trailing-slash variants as already present', () => {
    initRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), './.vibgrate/credentials.json\n', 'utf8');
    expect(ensureGitignored('.vibgrate/credentials.json', dir).status).toBe('present');
  });

  it('finds the git root from a nested subdirectory', () => {
    initRepo();
    const nested = path.join(dir, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBe(path.resolve(dir));
    const res = ensureGitignored('secret.dsn', nested);
    expect(res.status).toBe('created');
    // The .gitignore is written at the repo root, not in the nested dir.
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(nested, '.gitignore'))).toBe(false);
  });

  it('returns null root when there is no repo above the dir', () => {
    expect(findGitRoot(dir)).toBeNull();
  });
});
