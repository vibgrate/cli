import { describe, it, expect } from 'vitest';
import { unifiedDiff, summarizeDiffs } from './diff.js';

describe('unifiedDiff', () => {
  it('returns empty string when nothing changed', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'x.ts')).toBe('');
  });

  it('renders a single-line change with context and a hunk header', () => {
    const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'x.ts');
    expect(d).toContain('--- a/x.ts');
    expect(d).toContain('+++ b/x.ts');
    expect(d).toContain('-b');
    expect(d).toContain('+B');
    expect(d).toContain(' a'); // context
    expect(d).toContain(' c');
  });

  it('renders a new file against /dev/null', () => {
    const d = unifiedDiff(null, 'hello\nworld\n', 'new.ts');
    expect(d).toContain('--- /dev/null');
    expect(d).toContain('+++ b/new.ts');
    expect(d).toContain('@@ -0,0 +1,2 @@');
    expect(d).toContain('+hello');
  });

  it('renders a deleted file to /dev/null', () => {
    const d = unifiedDiff('bye\n', null, 'old.ts');
    expect(d).toContain('+++ /dev/null');
    expect(d).toContain('-bye');
  });

  it('is deterministic', () => {
    const a = unifiedDiff('1\n2\n3\n', '1\n9\n3\n', 'x.ts');
    const b = unifiedDiff('1\n2\n3\n', '1\n9\n3\n', 'x.ts');
    expect(a).toBe(b);
  });

  it('produces valid hunk line counts', () => {
    const d = unifiedDiff('a\nb\nc\nd\ne\n', 'a\nb\nX\nd\ne\n', 'x.ts');
    const header = d.split('\n').find((l) => l.startsWith('@@'))!;
    // one line replaced with one line, 3 lines of context on each side (clamped)
    expect(header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  });
});

describe('summarizeDiffs', () => {
  it('counts additions and deletions across files', () => {
    const diffs = [
      { file: 'a.ts', diff: unifiedDiff('a\n', 'a\nb\n', 'a.ts') },
      { file: 'b.ts', diff: unifiedDiff('x\ny\n', 'x\n', 'b.ts') },
    ];
    const s = summarizeDiffs(diffs);
    expect(s).toBe('+1 -1 across 2 file(s)');
  });

  it('ignores empty diffs', () => {
    expect(summarizeDiffs([{ file: 'a.ts', diff: '' }])).toBe('+0 -0 across 0 file(s)');
  });
});
