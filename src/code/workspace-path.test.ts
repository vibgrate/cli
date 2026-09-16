import { describe, it, expect } from 'vitest';
import {
  fileExcerpt,
  looksLikeRegexSearch,
  looksLikeRegexSubstitution,
  pathResolveError,
  pathResolveNote,
  resolveWorkspacePath,
} from './workspace-path.js';

const exists = (files: Record<string, string>) => (p: string) => p in files;

describe('resolveWorkspacePath', () => {
  const files = { 'src/greet.ts': 'export function greet() {}', 'src/scan.ts': 'x' };
  const known = Object.keys(files);

  it('keeps an exact existing path', () => {
    const r = resolveWorkspacePath('src/greet.ts', known, exists(files));
    expect(r).toEqual({ status: 'exact', path: 'src/greet.ts' });
  });

  it('case-folds a unique full path (gREET.ts → greet.ts)', () => {
    const r = resolveWorkspacePath('src/gREET.ts', known, exists(files));
    expect(r).toEqual({ status: 'resolved', path: 'src/greet.ts', requested: 'src/gREET.ts' });
    expect(pathResolveNote(r)).toBe('resolved path from src/gREET.ts → src/greet.ts');
  });

  it('resolves a unique basename', () => {
    const r = resolveWorkspacePath('gREET.ts', known, exists(files));
    expect(r).toEqual({ status: 'resolved', path: 'src/greet.ts', requested: 'gREET.ts' });
  });

  it('resolves a unique suffix', () => {
    const r = resolveWorkspacePath(
      'src/greet.ts',
      ['packages/app/src/greet.ts'],
      exists({ 'packages/app/src/greet.ts': 'x' }),
    );
    expect(r).toEqual({ status: 'resolved', path: 'packages/app/src/greet.ts', requested: 'src/greet.ts' });
  });

  it('does not invent a path when the basename is ambiguous', () => {
    const both = { 'a/foo.ts': '1', 'b/foo.ts': '2' };
    const r = resolveWorkspacePath('foo.ts', Object.keys(both), exists(both));
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.candidates).toEqual(['a/foo.ts', 'b/foo.ts']);
    expect(pathResolveError(r)).toMatch(/ambiguous/);
    expect(pathResolveError(r)).toMatch(/a\/foo\.ts/);
  });

  it('returns missing when nothing matches', () => {
    const r = resolveWorkspacePath('nope.ts', known, exists(files));
    expect(r).toEqual({ status: 'missing', path: 'nope.ts' });
  });

  it('trims padded paths and space-squeezes unique fuzzy names', () => {
    // Live Flow (2026-09-16): path:  src/greet.ts  (spaces around); Forge
    // invented src/gre et.ts / src/gre et. ts. Trim first, then unique
    // space-stripped match against the known map.
    expect(resolveWorkspacePath('  src/greet.ts  ', known, exists(files))).toEqual({
      status: 'exact',
      path: 'src/greet.ts',
    });
    expect(resolveWorkspacePath('src/gre et.ts', known, exists(files))).toEqual({
      status: 'resolved',
      path: 'src/greet.ts',
      requested: 'src/gre et.ts',
    });
    expect(resolveWorkspacePath('src/gre et. ts', known, exists(files))).toEqual({
      status: 'resolved',
      path: 'src/greet.ts',
      requested: 'src/gre et. ts',
    });
    const both = { 'a/foo.ts': '1', 'b/foo.ts': '2' };
    const amb = resolveWorkspacePath('fo o.ts', Object.keys(both), exists(both));
    expect(amb.status).toBe('ambiguous');
  });

  it('canonicalizes when exists() is case-insensitive like macOS APFS', () => {
    // Live Flow (2026-09-16): exists("src/gREET.ts") is true on APFS because
    // it opens src/greet.ts. Must still emit resolved → graph spelling.
    const ciExists = (p: string) => Object.keys(files).some((k) => k.toLowerCase() === p.toLowerCase());
    expect(ciExists('src/gREET.ts')).toBe(true);
    const r = resolveWorkspacePath('src/gREET.ts', known, ciExists);
    expect(r).toEqual({ status: 'resolved', path: 'src/greet.ts', requested: 'src/gREET.ts' });
    expect(pathResolveNote(r)).toBe('resolved path from src/gREET.ts → src/greet.ts');
    const base = resolveWorkspacePath('gREET.ts', known, ciExists);
    expect(base).toEqual({ status: 'resolved', path: 'src/greet.ts', requested: 'gREET.ts' });
  });
});

describe('looksLikeRegexSearch', () => {
  it('flags the live Spark SEARCH and leaves ordinary source alone', () => {
    expect(looksLikeRegexSearch('hi \\(\\w+\\)')).toBe(true);
    expect(looksLikeRegexSearch('foo.*bar')).toBe(true);
    expect(looksLikeRegexSearch('const timeout = 0;')).toBe(false);
    expect(looksLikeRegexSearch('return `hi ${name}`;')).toBe(false);
    expect(looksLikeRegexSearch('export function greet(name: string)')).toBe(false);
  });

  it('flags a $1-style regex substitution', () => {
    expect(looksLikeRegexSubstitution('Hello, $1!')).toBe(true);
    expect(looksLikeRegexSubstitution('return "Hello, " + name + "!";')).toBe(false);
  });
});

describe('fileExcerpt', () => {
  it('returns the first 40 lines or a named span', () => {
    const body = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(fileExcerpt('a.ts', body)).toContain('first 5 lines');
    expect(fileExcerpt('a.ts', body, { name: 'greet', start: 2, end: 3 })).toBe('a.ts (greet 2-3):\nline 2\nline 3');
  });
});
