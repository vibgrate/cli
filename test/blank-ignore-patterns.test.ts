import { describe, it, expect, afterEach } from 'vitest';
import { discover, mergeExcludes } from '../src/engine/discover.js';
import { FileCache } from '../src/core-open/utils/fs.js';
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

const SOURCE = {
  'a.ts': 'export const a = 1;\n',
  'gen/b.ts': 'export const b = 1;\n',
};

function discovered(root: string, exclude?: string[]): string[] {
  return discover({ root, ...(exclude ? { exclude } : {}) }).map((f) => f.rel);
}

async function walked(root: string, exclude?: string[]): Promise<string[]> {
  const cache = new FileCache();
  if (exclude) cache.setExcludePatterns(exclude);
  const entries = await cache.walkDir(root);
  return entries
    .filter((e) => e.isFile)
    .map((e) => e.relPath.split('\\').join('/'))
    .sort();
}

describe('blank ignore and exclude patterns', () => {
  describe('build discovery', () => {
    it('does not let an empty exclude hide the tree', () => {
      const root = project(SOURCE);
      expect(discovered(root, [''])).toEqual(['a.ts', 'gen/b.ts']);
    });

    it('does not let a whitespace-only exclude hide the tree', () => {
      const root = project(SOURCE);
      expect(discovered(root, ['   ', '\t', '\r', '\n', ' \r'])).toEqual(['a.ts', 'gen/b.ts']);
    });

    it('does not let a carriage-return-only ignore file hide the tree', () => {
      const root = project({ ...SOURCE, '.gitignore': '\r' });
      expect(discovered(root)).toEqual(['a.ts', 'gen/b.ts']);
    });

    it('still applies a real pattern that sits beside a blank one', () => {
      const byExclude = project(SOURCE);
      expect(discovered(byExclude, ['', '   ', '\r', 'gen/**'])).toEqual(['a.ts']);

      const byIgnore = project({ ...SOURCE, '.gitignore': 'gen/**\n\r' });
      expect(discovered(byIgnore)).toEqual(['a.ts']);

      const byConfig = project({
        ...SOURCE,
        'vibgrate.config.json': JSON.stringify({ exclude: ['', ' \t ', '\r', 'gen/**'] }),
      });
      expect(mergeExcludes(byConfig)).toEqual(['gen/**']);
      expect(discovered(byConfig, mergeExcludes(byConfig))).toEqual(['a.ts']);
    });
  });

  describe('scan walk', () => {
    it('does not let an empty exclude hide the tree', async () => {
      const root = project({ 'a.txt': 'a', 'gen/b.txt': 'b' });
      const names = await walked(root, ['']);
      expect(names).toContain('a.txt');
      expect(names).toContain('gen/b.txt');
    });

    it('does not let a whitespace-only exclude hide the tree', async () => {
      const root = project({ 'a.txt': 'a', 'gen/b.txt': 'b' });
      const names = await walked(root, ['   ', '\t', '\r', '\n', ' \r']);
      expect(names).toContain('a.txt');
      expect(names).toContain('gen/b.txt');
    });

    it('does not let a carriage-return-only ignore file hide the tree', async () => {
      const root = project({ 'a.txt': 'a', 'gen/b.txt': 'b', '.gitignore': '\r' });
      const names = await walked(root);
      expect(names).toContain('a.txt');
      expect(names).toContain('gen/b.txt');
    });

    it('still applies a real pattern that sits beside a blank one', async () => {
      const byExclude = project({ 'a.txt': 'a', 'gen/b.txt': 'b' });
      const excluded = await walked(byExclude, ['', '   ', '\r', 'gen']);
      expect(excluded).toContain('a.txt');
      expect(excluded).not.toContain('gen/b.txt');

      const byIgnore = project({ 'a.txt': 'a', 'gen/b.txt': 'b', '.gitignore': 'gen/\n\r' });
      const ignored = await walked(byIgnore);
      expect(ignored).toContain('a.txt');
      expect(ignored).not.toContain('gen/b.txt');
    });
  });
});
