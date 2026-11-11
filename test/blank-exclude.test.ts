import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { discover, mergeExcludes, readConfigExcludes } from '../src/engine/discover.js';
import { assertLockfilesValid, LockfileSyntaxError } from '../src/engine/lockfile-guard.js';
import { compileGlobs } from '../src/core-open/utils/glob.js';
import { compileGlobs as reportingCompileGlobs } from '../src/reporting/utils/glob.js';
import { FileCache } from '../src/core-open/utils/fs.js';
import { makeProject, cleanup } from './helpers.js';

/** Patterns that must never be treated as "ignore everything". */
const BLANKS = ['', ' ', '  ', '\t', '\n', '\r', ' \n', ' \r', '\r\n', '\n\n'];

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function posix(p: string): string {
  return p.split(path.sep).join('/');
}

describe('blank exclude and ignore patterns', () => {
  it('does not let an empty or whitespace-only exclude hide the tree', () => {
    const root = project({
      'a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
      'gen/c.ts': 'export const c = 1;\n',
    });
    expect(discover({ root, exclude: [''] }).map((f) => f.rel)).toEqual(['a.ts', 'gen/c.ts', 'src/b.ts']);
    expect(discover({ root, exclude: BLANKS }).map((f) => f.rel)).toEqual(['a.ts', 'gen/c.ts', 'src/b.ts']);
    // A real pattern beside the blanks still applies.
    expect(discover({ root, exclude: [...BLANKS, 'gen/**'] }).map((f) => f.rel)).toEqual(['a.ts', 'src/b.ts']);
  });

  it('does not let a carriage-return-only .gitignore hide the tree', () => {
    const root = project({
      'a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
      '.gitignore': '\r',
    });
    expect(discover({ root }).map((f) => f.rel)).toEqual(['a.ts', 'src/b.ts']);
  });

  it('keeps real gitignore rules when a blank CR line is present', () => {
    const root = project({
      'a.ts': 'export const a = 1;\n',
      'gen/c.ts': 'export const c = 1;\n',
      '.gitignore': 'gen/**\n\r',
    });
    expect(discover({ root }).map((f) => f.rel)).toEqual(['a.ts']);
  });

  it('does not let a carriage-return-only .gitignore hide lockfiles or source', () => {
    const truncated = '{"lockfileVersion":3,"packages":{';
    const valid = JSON.stringify({
      name: 'ok',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'ok', version: '1.0.0' } },
    });
    const source = project({
      '.gitignore': '\r',
      'package-lock.json': valid,
      'src/a.ts': 'export const a = 1;\n',
    });
    expect(discover({ root: source }).map((f) => f.rel)).toEqual(['src/a.ts']);
    expect(() => assertLockfilesValid(source)).not.toThrow();

    // The lockfile walk used to compile a bare CR as "match every path".
    const hidden = project({
      '.gitignore': '\r',
      'package-lock.json': truncated,
      'src/a.ts': 'export const a = 1;\n',
    });
    expect(() => assertLockfilesValid(hidden)).toThrow(LockfileSyntaxError);

    // A bare CR after a real rule must not become a match-everything pattern.
    const ruled = project({
      '.gitignore': 'scratch/\n\r',
      'scratch/package-lock.json': truncated,
      'package-lock.json': valid,
      'src/a.ts': 'export const a = 1;\n',
    });
    expect(discover({ root: ruled }).map((f) => f.rel)).toEqual(['src/a.ts']);
    expect(() => assertLockfilesValid(ruled)).not.toThrow();
  });

  it('drops blank entries when merging config and flag excludes', () => {
    const root = project({
      'vibgrate.config.json': JSON.stringify({ exclude: ['', ' ', '\n', 'skip/**', 'skip/**'] }),
    });
    expect(readConfigExcludes(root)).toEqual(['skip/**', 'skip/**']);
    expect(mergeExcludes(root, ['', '\r', 'tmp/**', 'skip/**'])).toEqual(['skip/**', 'tmp/**']);
  });

  it('compiles blank globs as no exclude, and keeps real ones', () => {
    for (const compile of [compileGlobs, reportingCompileGlobs]) {
      expect(compile(BLANKS)).toBeNull();
      const match = compile([...BLANKS, 'gen/**'])!;
      expect(match('a.ts')).toBe(false);
      expect(match('src/b.ts')).toBe(false);
      expect(match('gen/c.ts')).toBe(true);
    }
  });

  it('does not let a blank exclude or a blank .gitignore skip the scan walk', async () => {
    const root = project({
      'a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
      'gen/c.ts': 'export const c = 1;\n',
      '.gitignore': '\r',
    });
    const cache = new FileCache();
    cache.setExcludePatterns([...BLANKS, 'gen/**']);
    const entries = await cache.walkDir(root);
    const rels = entries.filter((e) => e.isFile).map((e) => posix(e.relPath));
    expect(rels).toContain('a.ts');
    expect(rels).toContain('src/b.ts');
    expect(rels).not.toContain('gen/c.ts');
  });
});
