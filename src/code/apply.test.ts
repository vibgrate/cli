import { describe, it, expect } from 'vitest';
import { parseEdits, applyEdit, applyEdits, type SymbolSpan } from './apply.js';

describe('parseEdits', () => {
  it('parses a search/replace block with the file on the preceding line', () => {
    const edits = parseEdits(['src/a.ts', '<<<<<<< SEARCH', 'const x = 1;', '=======', 'const x = 2;', '>>>>>>> REPLACE'].join('\n'));
    expect(edits).toEqual([{ op: 'replace', file: 'src/a.ts', search: 'const x = 1;', replace: 'const x = 2;', anchorSymbol: undefined }]);
  });

  it('ignores code fences around a block', () => {
    const text = ['path/to/b.ts', '```ts', '<<<<<<< SEARCH', 'a', '=======', 'b', '>>>>>>> REPLACE', '```'].join('\n');
    const edits = parseEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ op: 'replace', file: 'path/to/b.ts', search: 'a', replace: 'b' });
  });

  it('parses CREATE and DELETE whole-file ops', () => {
    const text = ['CREATE src/new.ts', 'export const y = 1;', 'END CREATE', 'DELETE src/old.ts'].join('\n');
    expect(parseEdits(text)).toEqual([
      { op: 'create', file: 'src/new.ts', content: 'export const y = 1;' },
      { op: 'delete', file: 'src/old.ts' },
    ]);
  });

  it('parses multiple replace blocks with distinct files', () => {
    const text = [
      'src/a.ts',
      '<<<<<<< SEARCH',
      '1',
      '=======',
      '2',
      '>>>>>>> REPLACE',
      'src/b.ts',
      '<<<<<<< SEARCH',
      '3',
      '=======',
      '4',
      '>>>>>>> REPLACE',
    ].join('\n');
    const edits = parseEdits(text);
    expect(edits.map((e) => e.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('applyEdit — replace', () => {
  const file = 'src/a.ts';
  it('applies an exact match', () => {
    const { content, outcome } = applyEdit('const x = 1;\n', { op: 'replace', file, search: 'const x = 1;', replace: 'const x = 2;' });
    expect(content).toBe('const x = 2;\n');
    expect(outcome.status).toBe('applied');
    expect(outcome.matchedBy).toBe('exact');
  });

  it('applies a whitespace-flexible match (per-line indentation drift)', () => {
    // The current file is indented; the model's SEARCH is dedented, so no exact
    // substring exists — the whitespace-flexible (line-trim) path must catch it.
    const current = 'function f() {\n    return 1;\n}\n';
    const search = 'function f() {\nreturn 1;\n}';
    const { content, outcome } = applyEdit(current, { op: 'replace', file, search, replace: 'function f() {\n  return 2;\n}' });
    expect(outcome.status).toBe('applied');
    expect(outcome.matchedBy).toBe('whitespace');
    expect(content).toBe('function f() {\n  return 2;\n}\n');
  });

  it('reports not-found when the SEARCH text is absent', () => {
    const { outcome, content } = applyEdit('const x = 1;', { op: 'replace', file, search: 'const z = 9;', replace: 'q' });
    expect(outcome.status).toBe('not-found');
    expect(content).toBe('const x = 1;'); // unchanged
    expect(outcome.reason).toContain('not found');
  });

  it('reports ambiguous when SEARCH matches multiple places and no anchor disambiguates', () => {
    const current = 'x\nx\n';
    const { outcome } = applyEdit(current, { op: 'replace', file, search: 'x', replace: 'y' });
    expect(outcome.status).toBe('ambiguous');
    expect(outcome.reason).toContain('2 places');
  });

  it('uses the graph span to disambiguate an ambiguous match', () => {
    const current = 'x\nx\nx\n'; // three identical lines
    const spans: SymbolSpan[] = [{ qualifiedName: 'Foo', file, start: 2, end: 2 }];
    const { content, outcome } = applyEdit(current, { op: 'replace', file, search: 'x', replace: 'y', anchorSymbol: 'Foo' }, spans);
    expect(outcome.status).toBe('applied');
    expect(outcome.matchedBy).toBe('graph-span');
    expect(content).toBe('x\ny\nx\n'); // only the line inside Foo's span changed
  });

  it('is a no-op when SEARCH equals REPLACE', () => {
    const { outcome, content } = applyEdit('a', { op: 'replace', file, search: 'a', replace: 'a' });
    expect(outcome.status).toBe('no-op');
    expect(content).toBe('a');
  });

  it('refuses an empty SEARCH on a non-empty file (ambiguous location)', () => {
    const { outcome } = applyEdit('a', { op: 'replace', file, search: '', replace: 'b' });
    expect(outcome.status).toBe('invalid');
  });

  it('reports not-found for a replace on a missing file', () => {
    const { outcome } = applyEdit(null, { op: 'replace', file, search: 'a', replace: 'b' });
    expect(outcome.status).toBe('not-found');
    expect(outcome.reason).toContain('CREATE');
  });
});

describe('applyEdit — create / delete', () => {
  it('creates a new file', () => {
    const { content, outcome } = applyEdit(null, { op: 'create', file: 'x.ts', content: 'hi' });
    expect(content).toBe('hi');
    expect(outcome.status).toBe('applied');
  });

  it('refuses to overwrite an existing, different file with create', () => {
    const { content, outcome } = applyEdit('old', { op: 'create', file: 'x.ts', content: 'new' });
    expect(outcome.status).toBe('conflict');
    expect(content).toBe('old');
  });

  it('deletes an existing file', () => {
    const { content, outcome } = applyEdit('anything', { op: 'delete', file: 'x.ts' });
    expect(content).toBeNull();
    expect(outcome.status).toBe('applied');
  });

  it('is a no-op to delete a missing file', () => {
    const { outcome } = applyEdit(null, { op: 'delete', file: 'x.ts' });
    expect(outcome.status).toBe('no-op');
  });
});

describe('applyEdits — composition across files', () => {
  it('threads two edits to the same file so they compose', () => {
    const files: Record<string, string> = { 'a.ts': 'const a = 1;\nconst b = 2;\n' };
    const state = applyEdits(
      [
        { op: 'replace', file: 'a.ts', search: 'const a = 1;', replace: 'const a = 10;' },
        { op: 'replace', file: 'a.ts', search: 'const b = 2;', replace: 'const b = 20;' },
      ],
      (f) => files[f] ?? null,
    );
    const entry = state.get('a.ts')!;
    expect(entry.after).toBe('const a = 10;\nconst b = 20;\n');
    expect(entry.outcomes.every((o) => o.status === 'applied')).toBe(true);
  });

  it('is deterministic: identical inputs → identical outcomes', () => {
    const run = () =>
      applyEdits([{ op: 'replace', file: 'a.ts', search: '1', replace: '2' }], () => 'const x = 1;').get('a.ts')!.after;
    expect(run()).toBe(run());
  });
});
