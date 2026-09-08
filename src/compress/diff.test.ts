import { describe, expect, it } from 'vitest';
import { compressDiff, DEFAULT_DIFF_CONFIG, DiffCompressor, formatDiffOutput, parseDiff, reduceContext, scoreHunks, selectHunks } from './diff.js';
import { baseRequest, MemorySink } from './__fixtures__/sink.js';
import { unifiedDiff } from './__fixtures__/samples.js';

describe('parsing a unified diff', () => {
  it('splits the preamble, the files and their hunks', () => {
    const parsed = parseDiff(unifiedDiff(2, 3, 4).split('\n'));
    expect(parsed.files).toHaveLength(2);
    // the commit header before the first `diff --git` is preamble, not a file
    expect(parsed.preDiffLines.join('\n')).toContain('commit ');
    expect(parsed.files[0]).toMatchObject({
      header: 'diff --git a/src/file0.ts b/src/file0.ts',
      oldFile: '--- a/src/file0.ts',
      newFile: '+++ b/src/file0.ts',
      isBinary: false,
      isNewFile: false,
      isDeletedFile: false,
    });
    expect(parsed.files[0].hunks).toHaveLength(3);
    expect(parsed.files[0].hunks[0]).toMatchObject({ additions: 2, deletions: 1, contextLines: 8 });
  });

  it('recognises new, deleted and binary files', () => {
    const created = parseDiff(['diff --git a/new.ts b/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1 @@', '+hello'].slice());
    expect(created.files[0]).toMatchObject({ isNewFile: true, isDeletedFile: false });
    const removed = parseDiff(['diff --git a/old.ts b/old.ts', 'deleted file mode 100644', '--- a/old.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye']);
    expect(removed.files[0]).toMatchObject({ isDeletedFile: true });
    const binary = parseDiff(['diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ']);
    expect(binary.files[0]).toMatchObject({ isBinary: true });
    expect(binary.files[0].hunks).toHaveLength(0);
  });
});

describe('hunk scoring and trimming', () => {
  it('scores hunks that change more, or touch risky words, higher', () => {
    const parsed = parseDiff(unifiedDiff(1, 4, 3).split('\n'));
    const [file] = parsed.files;
    file.hunks[2].lines.push('+  // FIXME: this can panic on a null session token');
    scoreHunks(parsed.files, 'session token');
    expect(file.hunks[2].score).toBeGreaterThan(file.hunks[0].score);
    // every hunk gets a score, none negative
    for (const h of file.hunks) expect(h.score).toBeGreaterThanOrEqual(0);
  });

  it('keeps at most `maxPerFile` hunks, reporting what it dropped', () => {
    const parsed = parseDiff(unifiedDiff(1, 12, 3).split('\n'));
    scoreHunks(parsed.files, '');
    const { selected, dropped } = selectHunks(parsed.files[0].hunks, 4);
    expect(selected).toHaveLength(4);
    expect(dropped).toHaveLength(8);
    // selection is by score, output stays in file order
    const headers = selected.map((h) => h.header);
    expect(headers).toEqual([...headers].sort((a, b) => parsed.files[0].hunks.indexOf(parsed.files[0].hunks.find((x) => x.header === a)!) - parsed.files[0].hunks.indexOf(parsed.files[0].hunks.find((x) => x.header === b)!)));
  });

  it('trims context around a change without touching the change itself', () => {
    const parsed = parseDiff(unifiedDiff(1, 1, 6).split('\n'));
    const hunk = parsed.files[0].hunks[0];
    const before = hunk.lines.filter((l) => l.startsWith('+') || l.startsWith('-'));
    const trimmed = reduceContext(hunk, 1);
    expect(trimmed.lines.length).toBeLessThan(hunk.lines.length);
    // every added and removed line survives, in order
    expect(trimmed.lines.filter((l) => l.startsWith('+') || l.startsWith('-'))).toEqual(before);
    expect(trimmed.contextLines).toBeLessThanOrEqual(hunk.contextLines);
  });
});

describe('DiffCompressor', () => {
  it('shrinks a large diff and says what it dropped', () => {
    const content = unifiedDiff(3, 12, 6);
    const r = new DiffCompressor().compress(baseRequest(content, { ccr: new MemorySink(), injectMarker: true }));
    expect(r.strategy).toBe('diff');
    expect(r.chain).toEqual(['diff']);
    expect(r.info).toMatch(/^diff\(\d+->\d+ files, \d+->\d+ hunks\)$/);
    expect(r.content.length).toBeLessThan(content.length);
    // the file headers stay so the change is still attributable
    expect(r.content).toContain('diff --git a/src/file0.ts b/src/file0.ts');
    expect(r.content).toContain('@@');
  });

  it('is deterministic, and leaves small or non-diff content alone', () => {
    const content = unifiedDiff(2, 4, 4);
    expect(new DiffCompressor().compress(baseRequest(content))).toEqual(new DiffCompressor().compress(baseRequest(content)));
    expect(compressDiff('not a diff at all', '', DEFAULT_DIFF_CONFIG)).toBeNull();
    for (const other of ['', 'prose']) {
      const r = new DiffCompressor().compress(baseRequest(other));
      expect(r.strategy).toBe('passthrough');
      expect(r.content).toBe(other);
    }
  });

  it('formats totals from the parts it was given', () => {
    const parsed = parseDiff(unifiedDiff(1, 2, 2).split('\n'));
    const out = formatDiffOutput(parsed.preDiffLines, parsed.files, { additions: 4, deletions: 2, hunksRemoved: 3 });
    expect(out).toContain('diff --git');
    expect(out).toMatch(/3 hunks?/);
  });
});
