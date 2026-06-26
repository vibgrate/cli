import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/engine/parse.js';

describe('parse — doc-comment / docstring capture', () => {
  it('captures a JSDoc block above a function, stripping markers and tags', async () => {
    const src = [
      '/**',
      ' * Renders a sortable data table of rows.',
      ' * @param rows the data',
      ' */',
      'export function Table(rows: number[]) { return rows; }',
    ].join('\n');
    const p = await parseSource('t.ts', 'ts', src);
    const doc = p.defs.find((d) => d.name === 'Table')?.doc ?? '';
    expect(doc).toContain('Renders a sortable data table of rows.');
    expect(doc).not.toContain('@param'); // JSDoc tags dropped
    expect(doc).not.toContain('*'); // comment markers stripped
  });

  it('captures a // line comment above a function', async () => {
    const src = ['// Sends the welcome email to a new user.', 'function notify() {}'].join('\n');
    const p = await parseSource('t.ts', 'ts', src);
    expect(p.defs.find((d) => d.name === 'notify')?.doc).toBe('Sends the welcome email to a new user.');
  });

  it('captures a Python docstring (first body string)', async () => {
    const src = ['def run_job():', '    """Execute a queued background job."""', '    return 1'].join('\n');
    const p = await parseSource('t.py', 'py', src);
    expect(p.defs.find((d) => d.name === 'run_job')?.doc).toContain('Execute a queued background job');
  });

  it('returns no doc when none is present, and a blank line detaches a comment', async () => {
    const src = ['// unrelated banner', '', 'function f() {}'].join('\n');
    const p = await parseSource('t.ts', 'ts', src);
    expect(p.defs.find((d) => d.name === 'f')?.doc).toBeUndefined();
  });

  it('is deterministic for the same source', async () => {
    const src = '/** Does a thing. */\nfunction t() {}';
    const a = await parseSource('t.ts', 'ts', src);
    const b = await parseSource('t.ts', 'ts', src);
    expect(a.defs.find((d) => d.name === 't')?.doc).toBe(b.defs.find((d) => d.name === 't')?.doc);
  });
});
