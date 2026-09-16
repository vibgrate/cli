import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isIgnoredPath,
  loadReviewPacks,
  parseIgnoreMarkdown,
  parseMergeMarkdown,
} from './packs.js';

const dirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-packs-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseIgnoreMarkdown', () => {
  it('reads globs and skips headings', () => {
    const ignore = parseIgnoreMarkdown('# Ignore\n\n- vendor/**\n\nsrc/generated.ts\n');
    expect(ignore.patterns).toEqual(['vendor/**', 'src/generated.ts']);
    expect(isIgnoredPath('vendor/a.ts', ignore)).toBe(true);
    expect(isIgnoredPath('src/a.ts', ignore)).toBe(false);
  });
});

describe('parseMergeMarkdown', () => {
  it('reads require-human', () => {
    const merge = parseMergeMarkdown('---\nrequire-human:\n  - secrets/**\n---\nDocs only.\n');
    expect(merge.enabled).toBe(true);
    expect(merge.requireHuman).toEqual(['secrets/**']);
  });
});

describe('loadReviewPacks', () => {
  it('returns loaded:false when the tree is absent', () => {
    expect(loadReviewPacks(tmp(), ['src/a.ts']).loaded).toBe(false);
  });

  it('runs a CLI-channel check and skips a GitHub-only check with a reason', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.vibgrate/review/checks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vibgrate/review/ignore.md'), '- vendor/**\n');
    fs.writeFileSync(
      path.join(root, '.vibgrate/review/checks/web.md'),
      '---\ntitle: Web Review\nchannels: both\n---\nLook at web files.\n',
    );
    fs.writeFileSync(
      path.join(root, '.vibgrate/review/checks/hosted.md'),
      '---\ntitle: Hosted only\nchannels: github\n---\nGitHub channel.\n',
    );
    const report = loadReviewPacks(root, ['src/web.ts']);
    expect(report.loaded).toBe(true);
    expect(report.ignore.patterns).toEqual(['vendor/**']);
    const web = report.checks.find((c) => c.id === 'web');
    const hosted = report.checks.find((c) => c.id === 'hosted');
    expect(web?.ran).toBe(true);
    expect(hosted?.ran).toBe(false);
    expect(hosted?.reason).toBe('channel_github');
  });

  it('skips with file_scope when include does not match', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.vibgrate/review/checks'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.vibgrate/review/checks/docs.md'),
      '---\ntitle: Docs\ninclude:\n  - docs/**\n---\nDocs.\n',
    );
    const report = loadReviewPacks(root, ['src/a.ts']);
    expect(report.checks[0]?.ran).toBe(false);
    expect(report.checks[0]?.reason).toBe('file_scope');
  });

  it('evaluates merge.md against the change set', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.vibgrate/review'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vibgrate/review/merge.md'), '---\nenabled: true\n---\nDocs only.\n');
    const docs = loadReviewPacks(root, ['README.md']);
    expect(docs.mergeDecision).toBe('approve');
    const self = loadReviewPacks(root, ['.vibgrate/review/merge.md']);
    expect(self.mergeDecision).toBe('refuse');
  });
});
