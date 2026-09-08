import { describe, expect, it } from 'vitest';
import { extractHashes, findMarkers, hasMarkers, isValidHash, makeDroppedSentinel, makeMarker, normalizeHash, retrieveHint, stripMarkers } from './markers.js';
import { isAlreadyCompressed } from '../types.js';

const H24 = 'abcdef0123456789abcdef01';
const H12 = 'abcdef012345';

describe('markers', () => {
  it('formats the row-offload marker with the 12-char hash', () => {
    expect(makeMarker('rows', H24, 100)).toBe(`<<vg-ccr:${H12} 100_rows_offloaded>>`);
  });

  it('formats generic block markers', () => {
    expect(makeMarker('lines', H12, 42)).toBe(`<<vg-ccr:${H12},lines,42>>`);
    expect(makeMarker('bytes', H24, 4500)).toBe(`<<vg-ccr:${H12},bytes,4500>>`);
    expect(makeMarker('chars', H24, 7, { tool: 'Bash' })).toBe(`<<vg-ccr:${H12},chars,7,tool=Bash>>`);
    expect(makeMarker('items', H24, 9)).toBe(`<<vg-ccr:${H12},items,9>>`);
  });

  it('formats the JSON sentinel row', () => {
    expect(makeDroppedSentinel(H24, 5)).toBe(`{"_vg_dropped":5,"hash":"${H12}"}`);
  });

  it('formats retrieval hints', () => {
    expect(retrieveHint(H24, { originalTokens: 1200, compressedTokens: 80 })).toBe(`Retrieve original: hash=${H24} (1200 → 80 tokens)`);
    expect(retrieveHint(H24, { originalTokens: 1200, compressedTokens: 80, toolName: 'Grep' })).toBe(`Retrieve original: hash=${H24} (1200 → 80 tokens, tool=Grep)`);
    expect(retrieveHint(H24, { originalTokens: 10, compressedTokens: 5, partial: true })).toBe(`Retrieve more: hash=${H24} (10 → 5 tokens)`);
  });

  it('finds every marker family with offsets, deduplicating hashes in order', () => {
    const text = `keep\n${makeMarker('rows', H24, 3)} and ${makeMarker('lines', 'fedcba987654', 2)}\n${makeDroppedSentinel(H24, 3)}\n${retrieveHint(H24, { originalTokens: 9, compressedTokens: 2 })}`;
    const found = findMarkers(text);
    expect(found.map((m) => m.kind)).toEqual(['rows', 'lines', 'sentinel', 'hint']);
    expect(found[0]).toMatchObject({ hash: H12, count: 3, start: 5 });
    expect(text.slice(found[0].start, found[0].end)).toBe(found[0].raw);
    expect(extractHashes(text)).toEqual([H12, 'fedcba987654', H24]);
    expect(hasMarkers('plain')).toBe(false);
  });

  it('strips markers and whole-line hints', () => {
    const body = 'line one\nline two';
    const text = `${body}\n${makeMarker('rows', H24, 3)}\n${retrieveHint(H24, { originalTokens: 9, compressedTokens: 2, toolName: 'x' })}`;
    expect(stripMarkers(text)).toBe(`${body}\n`);
    expect(stripMarkers('no markers here')).toBe('no markers here');
  });

  it('validates hashes strictly (12 or 24 hex) and lowercases', () => {
    expect(isValidHash(H12)).toBe(true);
    expect(isValidHash(H24.toUpperCase())).toBe(true);
    expect(isValidHash('abcdef')).toBe(false);
    expect(isValidHash('zzzzzzzzzzzz')).toBe(false);
    expect(normalizeHash(H24.toUpperCase())).toBe(H24);
    expect(normalizeHash(42)).toBeNull();
  });

  it('is recognised as already compressed by types.ts', () => {
    expect(isAlreadyCompressed(makeMarker('rows', H24, 1))).toBe(true);
    expect(isAlreadyCompressed('<<ccr:abc>>')).toBe(false);
  });

  it('is linear on adversarial input', () => {
    const bad = `${'<<vg-ccr:'.repeat(2000)}${'a'.repeat(5000)}`;
    const t0 = Date.now();
    findMarkers(bad);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
