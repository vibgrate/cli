import { describe, expect, it } from 'vitest';
import { bestLosslessFold, collapseRuns, compactLossless, diffStripIndex, expandRuns, foldRepeatedBlocks, hasLosslessFold, pathHeading, pathUnheading, searchDirHeading, searchDirUnheading, searchHeading, searchUnheading, stripAnsi, unfold, unfoldRepeatedBlocks } from './lossless.js';

const ADVERSARIAL = [
  '',
  '\n',
  'a\nb\n',
  'a\r\nb\r\nb\r\n',
  'x \nx \nx \n',
  '  \n  \n  \n',
  'ünï\nünï\n数据\n数据\n数据',
  'a\n\n\n\nb',
  '... (repeated 3 times)\nfoo\nfoo',
  'foo\nfoo\n... (repeated 2 times)',
  '... (repeats 3 lines from 3 lines back)\n1\n2\n3',
  'src/a.ts:1:x\nsrc/a.ts:2:y\nsrc/a.ts\n3:z',
  'dir/\nbase:1:x\nbase:2:y',
  'a/b/c.txt\na/b/d.txt\nd.txt\ne/\n',
  '2026-09-02 14:30:00 [FATAL] x\n2026-09-02 14:31:00 [FATAL] y',
];

describe('runs', () => {
  it('collapses and expands byte-exactly on adversarial inputs', () => {
    for (const t of ADVERSARIAL) expect(expandRuns(collapseRuns(t))).toBe(t);
    expect(collapseRuns('a\na\na\nb\nb')).toBe('a\n... (repeated 3 times)\nb\n... (repeated 2 times)');
    expect(collapseRuns('a\na\n')).toBe('a\n... (repeated 2 times)\n');
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
  it('folds repeated blocks with the documented bounds and unfolds exactly', () => {
    const stanza = 'name: web\nimage: web:1.0\nports:\n  - 8080\nenv:\n  - LOG=info\n';
    const doc = `${stanza}---\n${stanza}---\n${stanza}`;
    const folded = foldRepeatedBlocks(doc);
    expect(folded).toContain('... (repeats 6 lines from 7 lines back)');
    expect(unfoldRepeatedBlocks(folded)).toBe(doc);
    expect(foldRepeatedBlocks('a\nb\nc\na\nb')).toBe('a\nb\nc\na\nb');
    for (const t of ADVERSARIAL) expect(unfoldRepeatedBlocks(foldRepeatedBlocks(t))).toBe(t);
    const huge = Array.from({ length: 20_001 }, (_, i) => `l${i % 5}`).join('\n');
    expect(foldRepeatedBlocks(huge)).toBe(huge);
  });
});

describe('search headings', () => {
  const grep = 'src/a.ts:1:foo\nsrc/a.ts:2:bar\nsrc/b.ts:7:baz\nsrc/b.ts:9:qux\nplain line\nsrc/a.ts:3:again';
  it('folds by file and by directory with exact inverses', () => {
    const h = searchHeading(grep);
    expect(h).toBe('src/a.ts\n1:foo\n2:bar\nsrc/b.ts\n7:baz\n9:qux\nplain line\nsrc/a.ts\n3:again');
    expect(searchUnheading(h)).toBe(grep);
    const d = searchDirHeading(grep);
    expect(d).toBe('src/\na.ts:1:foo\na.ts:2:bar\nb.ts:7:baz\nb.ts:9:qux\nplain line\nsrc/\na.ts:3:again');
    expect(searchDirUnheading(d)).toBe(grep);
    for (const t of ADVERSARIAL) expect(unfold(compactLossless(t, 'search'), 'search')).toBe(t);
  });
  it('never folds timestamped log rows', () => {
    const log = '2026-09-02 14:30:00 [FATAL] x\n2026-09-02 14:31:00 [FATAL] y';
    expect(searchHeading(log)).toBe(log);
    expect(compactLossless(log, 'search')).toBe(log);
  });
  it('compactLossless picks the smaller verified fold', () => {
    const perFile = Array.from({ length: 10 }, (_, i) => `src/deep/dir/file${i}.ts:${i}:x`).join('\n');
    const out = compactLossless(perFile, 'search');
    expect(out.length).toBeLessThan(perFile.length);
    expect(unfold(out, 'search')).toBe(perFile);
  });
});

describe('paths and diff', () => {
  it('folds path listings and unfolds exactly', () => {
    const list = 'src/a.ts\nsrc/b.ts\nsrc/lib/c.ts\n\nsrc/lib/d.ts\ndocs/x.md';
    const h = pathHeading(list);
    expect(h).toBe('src/\na.ts\nb.ts\nsrc/lib/\nc.ts\n\nsrc/lib/\nd.ts\ndocs/\nx.md');
    expect(pathUnheading(h)).toBe(list);
    expect(pathHeading('only/one.ts')).toBe('only/one.ts');
    expect(unfold(h, 'paths')).toBe(list);
    // `compactLossless` only keeps a fold that is strictly smaller. On this
    // listing the heading costs exactly what the repeated prefixes save, so the
    // original is returned; a listing with several files per directory wins.
    expect(compactLossless(list, 'paths')).toBe(list);
    const deep = 'src/components/a.ts\nsrc/components/b.ts\nsrc/components/c.ts\ndocs/x.md';
    const folded = compactLossless(deep, 'paths');
    expect(folded.length).toBeLessThan(deep.length);
    expect(unfold(folded, 'paths')).toBe(deep);
    // a stray no-slash line under an active header would be re-prefixed on unfold → the fold is rejected
    const mixed = 'src/a.ts\nsrc/b.ts\nstray';
    expect(pathUnheading(pathHeading(mixed))).not.toBe(mixed);
    expect(compactLossless(mixed, 'paths')).toBe(mixed);
  });
  it('strips diff index lines only', () => {
    const diff = 'diff --git a/x b/x\nindex abc123..def456 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
    expect(diffStripIndex(diff)).toBe('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
    expect(compactLossless(diff, 'diff')).toBe(diffStripIndex(diff));
    expect(unfold(diffStripIndex(diff), 'diff')).toBe(diffStripIndex(diff));
  });
});

describe('compactLossless / bestLosslessFold', () => {
  it('handles every kind, verifies round-trips and never inflates', () => {
    const log = '\x1b[32mok\x1b[0m\n\x1b[32mok\x1b[0m\n\x1b[32mok\x1b[0m\nfail';
    expect(compactLossless(log, 'log')).toBe('ok\n... (repeated 3 times)\nfail');
    expect(unfold(compactLossless(log, 'log'), 'log')).toBe(stripAnsi(log));
    expect(compactLossless('a\nb', 'text')).toBe('a\nb');
    expect(compactLossless('', 'log')).toBe('');
    expect(compactLossless('x\nx', 'unknown-kind')).toBe('x\nx');
    // A run marker costs ~24 characters, so collapsing three short lines would
    // inflate — the fold is refused and the original comes back untouched.
    expect(compactLossless('k: v\nk: v\nk: v\n', 'config')).toBe('k: v\nk: v\nk: v\n');
    const line = '  retention_days: 30    # keep scan-class data for a month';
    const cfg = `${line}\n${line}\n${line}\n`;
    const c = compactLossless(cfg, 'config');
    expect(c).toBe(`${line}\n... (repeated 3 times)\n`);
    expect(c.length).toBeLessThan(cfg.length);
    expect(unfold(c, 'config')).toBe(cfg);
    for (const t of ADVERSARIAL) for (const kind of ['log', 'search', 'paths', 'text', 'config'] as const) expect(unfold(compactLossless(t, kind), kind) === (kind === 'log' ? stripAnsi(t) : t)).toBe(true);
  });
  it('unfold leaves content that only looks folded exactly as it was', () => {
    // Real tool output can contain our own marker text, or a bare `dir/` line.
    // Unfolding is verified by re-folding, so none of these are rewritten.
    const literalRun = 'foo\nfoo\n... (repeated 2 times)';
    for (const kind of ['log', 'text', 'config'] as const) expect(unfold(literalRun, kind)).toBe(literalRun);
    const literalHeading = 'dir/\nbase:1:x\nbase:2:y';
    expect(unfold(literalHeading, 'paths')).toBe(literalHeading);
    expect(unfold('plain\ntext\n', 'log')).toBe('plain\ntext\n');
    // …while a genuine fold still round-trips.
    const noisy = 'WARN  retrying connection to cache-02.internal (attempt timed out)';
    const log = `${noisy}\n${noisy}\n${noisy}\n${noisy}\ndone`;
    const folded = compactLossless(log, 'log');
    expect(folded).toBe(`${noisy}\n... (repeated 4 times)\ndone`);
    expect(unfold(folded, 'log')).toBe(log);
  });
  it('keeps the single best fold and excludes diff unless allowed', () => {
    const grep = Array.from({ length: 8 }, (_, i) => `src/a.ts:${i}:line ${i}`).join('\n');
    expect(bestLosslessFold(grep)).toMatchObject({ kind: 'search' });
    expect(hasLosslessFold(grep)).toBe(true);
    expect(bestLosslessFold('unique\nlines\nonly')).toBeNull();
    const withIndex = 'index abc..def\nnothing else here\nreally';
    expect(bestLosslessFold(withIndex)).toBeNull();
    expect(bestLosslessFold(withIndex, { allowDiff: true })).toMatchObject({ kind: 'diff' });
  });
  it('is linear on a 1 MB line and deterministic', () => {
    const big = `${'z'.repeat(1_000_000)}\n${'z'.repeat(1_000_000)}`;
    const t0 = Date.now();
    const out = compactLossless(big, 'text');
    expect(out).toBe(`${'z'.repeat(1_000_000)}\n... (repeated 2 times)`);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(bestLosslessFold(big)).toEqual(bestLosslessFold(big));
  });
});
