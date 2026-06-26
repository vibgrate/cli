import { describe, it, expect, afterEach } from 'vitest';
import { discover, UsageError } from '../src/engine/discover.js';
import { makeProject, cleanup } from './helpers.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('discover', () => {
  it('finds supported files and skips node_modules', async () => {
    const root = project({
      'a.ts': 'x',
      'b.py': 'x',
      'node_modules/dep/index.js': 'x',
      'readme.md': 'x',
    });
    const rels = discover({ root }).map((f) => f.rel);
    expect(rels).toEqual(['a.ts', 'b.py']);
  });

  it('returns results sorted by path (order-independent)', async () => {
    const root = project({ 'z.ts': 'x', 'a.ts': 'x', 'm.ts': 'x' });
    expect(discover({ root }).map((f) => f.rel)).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });

  it('honors extra excludes', async () => {
    const root = project({ 'a.ts': 'x', 'gen/x.ts': 'x' });
    const rels = discover({ root, exclude: ['gen/**'] }).map((f) => f.rel);
    expect(rels).toEqual(['a.ts']);
  });

  it('throws UsageError on an unknown --only language', async () => {
    const root = project({ 'a.ts': 'x' });
    expect(() => discover({ root, only: ['nope'] })).toThrow(UsageError);
  });
});
