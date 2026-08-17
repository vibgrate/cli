/**
 * Locale codec round-trips.
 *
 * The property that matters is `decode(encode(x)) === x` for any flat catalog.
 * `vg locale pull` writes over files in a working tree, so a lossy codec would
 * silently rewrite content the user never asked to change — and they would only
 * find out in a code review, or not at all.
 */
import { describe, it, expect } from 'vitest';
import {
  codecFor,
  flatten,
  isPlannedFormat,
  isSupportedFormat,
  LocaleNestConflictError,
  nest,
  sortKeys,
  SUPPORTED_FORMATS,
  type FlatCatalog,
} from './formats.js';

const SAMPLE: FlatCatalog = {
  'app.title': 'My App',
  'app.subtitle': 'Welcome back',
  'checkout.submit': 'Submit',
  'checkout.cancel': 'Cancel',
  standalone: 'Top level',
};

describe.each(SUPPORTED_FORMATS)('codec %s', (format) => {
  const codec = codecFor(format);

  it('round-trips a flat catalog without losing or altering a value', () => {
    expect(codec.decode(codec.encode(SAMPLE))).toEqual(SAMPLE);
  });

  it('round-trips an empty catalog', () => {
    expect(codec.decode(codec.encode({}))).toEqual({});
  });

  it('treats an empty file as an empty catalog rather than throwing', () => {
    expect(codec.decode('')).toEqual({});
    expect(codec.decode('   ')).toEqual({});
  });

  it('preserves values that look like other types', () => {
    // A translation of "true" or "42" is still a string; coercing it would
    // corrupt the file on the next write.
    const tricky: FlatCatalog = { a: 'true', b: '42', c: 'null', d: '' };
    expect(codec.decode(codec.encode(tricky))).toEqual(tricky);
  });

  it('preserves unicode and newlines inside values', () => {
    const tricky: FlatCatalog = {
      'a.b': 'Bonjour, ça va ?',
      'a.c': 'line one\nline two',
      'a.d': '日本語のテキスト',
    };
    expect(codec.decode(codec.encode(tricky))).toEqual(tricky);
  });

  it('writes deterministically, so pulling twice produces no spurious diff', () => {
    const shuffled: FlatCatalog = {
      'checkout.submit': 'Submit',
      'app.title': 'My App',
      standalone: 'Top level',
      'app.subtitle': 'Welcome back',
      'checkout.cancel': 'Cancel',
    };
    expect(codec.encode(shuffled)).toBe(codec.encode(SAMPLE));
  });
});

describe('nest / flatten', () => {
  it('expands dotted keys into a tree and back', () => {
    const nested = nest({ 'a.b.c': 'x', 'a.b.d': 'y', e: 'z' });
    expect(nested).toEqual({ a: { b: { c: 'x', d: 'y' } }, e: 'z' });
    expect(flatten(nested)).toEqual({ 'a.b.c': 'x', 'a.b.d': 'y', e: 'z' });
  });

  it('refuses to nest when a key is both a value and a group, naming both keys', () => {
    // `a` is a string and `a.b` wants to nest under it. Nested JSON cannot hold
    // both, and every way of "handling" it silently drops one — so the user is
    // told, and pointed at the format that does work.
    expect(() => nest({ a: 'leaf', 'a.b': 'child' })).toThrow(LocaleNestConflictError);
    expect(() => nest({ a: 'leaf', 'a.b': 'child' })).toThrow(/flat/);
  });

  it('refuses in the other insertion order too, rather than overwriting the group', () => {
    // Regression: an earlier implementation wrote the leaf into the same slot as
    // the group here, silently discarding every key nested under it.
    expect(() => nest({ 'a.b': 'child', a: 'leaf' })).toThrow(LocaleNestConflictError);
  });

  it('stores a conflicting pair losslessly in the flat format', () => {
    const codec = codecFor('flat');
    const conflicting = { a: 'leaf', 'a.b': 'child' };
    expect(codec.decode(codec.encode(conflicting))).toEqual(conflicting);
  });

  it('preserves an array value as JSON instead of destroying it', () => {
    // Arrays are not a key/value shape, but some catalogues carry them for
    // plural forms. Flattening them away would delete the author's data.
    const flat = flatten({ items: ['one', 'two'] });
    expect(flat.items).toBe('["one","two"]');
  });

  it('renders null and undefined leaves as empty strings rather than "null"', () => {
    expect(flatten({ a: null, b: undefined })).toEqual({ a: '', b: '' });
  });
});

describe('sortKeys', () => {
  it('orders keys so writes are byte-stable', () => {
    expect(Object.keys(sortKeys({ b: '1', a: '2', c: '3' }))).toEqual(['a', 'b', 'c']);
  });
});

describe('codecFor', () => {
  it('resolves every supported format', () => {
    for (const format of SUPPORTED_FORMATS) expect(codecFor(format).id).toBeTruthy();
  });

  it('distinguishes a planned format from a typo', () => {
    // "Not yet" and "not a thing" need different messages: the first is a
    // roadmap question, the second is a mistake in the command the user typed.
    expect(isPlannedFormat('xliff')).toBe(true);
    expect(isSupportedFormat('xliff')).toBe(false);
    expect(() => codecFor('xliff')).toThrow(/not available in this release yet/i);
    expect(() => codecFor('jsonn')).toThrow(/Unknown format/i);
  });

  it('names what is available in both error messages', () => {
    expect(() => codecFor('po')).toThrow(/json/);
    expect(() => codecFor('nonsense')).toThrow(/Planned/);
  });
});
