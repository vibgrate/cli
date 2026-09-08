import { describe, expect, it } from 'vitest';
import { accuracyGuard, adjustWeightsForQuery, anchorBudget, baseWeights, extractAnchors, informationScore, isAnchorLine, itemHash, selectAnchors, strategyForPattern } from './anchors.js';

describe('array anchors', () => {
  it('maps patterns to strategies and weights', () => {
    expect(strategyForPattern('search_results')).toBe('front_heavy');
    expect(strategyForPattern('logs')).toBe('back_heavy');
    expect(baseWeights('balanced')).toEqual({ front: 0.45, middle: 0.1, back: 0.45 });
    expect(baseWeights('front_heavy')).toEqual({ front: 0.75, middle: 0.1, back: 0.15 });
  });
  it('shifts weights for recency / historical queries', () => {
    const w = baseWeights('distributed');
    const recent = adjustWeightsForQuery(w, 'show me the latest failures');
    expect(recent.back).toBeGreaterThan(w.back);
    const old = adjustWeightsForQuery(w, 'what was the first error');
    expect(old.front).toBeGreaterThan(w.front);
    expect(adjustWeightsForQuery(w, 'first and latest')).toEqual(w);
    expect(adjustWeightsForQuery(w, undefined)).toEqual(w);
  });
  it('computes the budget with the 3..12 clamp', () => {
    expect(anchorBudget(10, 15)).toBe(0);
    expect(anchorBudget(100, 15)).toBe(3);
    expect(anchorBudget(1000, 100)).toBe(12);
    expect(anchorBudget(20, 15)).toBe(3);
  });
  it('selects front/back positions and dedups identical items', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, v: i % 10 }));
    const a = selectAnchors(items, 15, 'generic');
    expect(a.size).toBeGreaterThanOrEqual(3);
    expect([...a].some((i) => i < 34)).toBe(true);
    expect([...a].some((i) => i >= 66)).toBe(true);
    expect(selectAnchors(items.slice(0, 5), 15)).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(selectAnchors([], 15).size).toBe(0);
    const dups = Array.from({ length: 40 }, () => ({ same: true }));
    expect(selectAnchors(dups, 10).size).toBeLessThanOrEqual(2);
    expect(selectAnchors(items, 15, 'logs', 'latest')).toEqual(selectAnchors(items, 15, 'logs', 'latest'));
  });
  it('scores information density', () => {
    const all = [{ a: 1, b: 'x' }, { a: 1, b: 'x' }, { a: 1, b: 'x' }, { a: 2, b: 'y', err: 'boom' }];
    expect(informationScore(all[3], all)).toBeGreaterThan(informationScore(all[0], all));
    expect(informationScore('nope', all)).toBe(0);
    expect(itemHash({ b: 1, a: 2 })).toBe(itemHash({ a: 2, b: 1 }));
  });
});

describe('line anchors', () => {
  const text = `INFO started\nERROR Database connection timeout after 30s\nTraceback (most recent call last):\nValueError: bad input\ncommit 0123456789abcdef0123456789abcdef01234567\nsee https://example.com/a/b?x=1 and 550e8400-e29b-41d4-a716-446655440000\ntook 250ms at src/app.ts:42\ntest_login_fails FAILED`;
  it('extracts errors and ids deterministically', () => {
    const a = extractAnchors(text);
    expect(a.errors).toContain('ValueError');
    expect(a.errors).toContain('connection'); // longest identifier on the ERROR line
    expect(a.errors).toContain('test_login_fails');
    expect(a.errors[0]).toBe('connection'); // textual order: first error anchor is on the first error line
    expect(a.errors[a.errors.length - 1]).toBe('test_login_fails');
    expect(a.ids).toContain('0123456789abcdef0123456789abcdef01234567');
    expect(a.ids).toContain('https://example.com/a/b?x=1');
    expect(a.ids).toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(a.ids).toContain('250ms');
    expect(a.ids).toContain('src/app.ts:42');
    expect(extractAnchors(text)).toEqual(a);
    expect(extractAnchors('')).toEqual({ errors: [], ids: [] });
    expect(isAnchorLine('ERROR x')).toBe(true);
    expect(isAnchorLine('all good')).toBe(false);
  });
  it('guards strictly when unrecoverable and by first/last error when recoverable', () => {
    expect(accuracyGuard(text, text, { recoverable: false }).ok).toBe(true);
    const dropped = text.replace('ValueError: bad input\n', '').replace('250ms', '');
    const strict = accuracyGuard(text, dropped, { recoverable: false });
    expect(strict.ok).toBe(false);
    expect(strict.missingErrors).toContain('ValueError');
    expect(strict.missingIds).toContain('250ms');
    const loose = accuracyGuard(text, dropped, { recoverable: true });
    expect(loose.ok).toBe(true);
    const noErrors = 'nothing'; // both first and last error anchors gone
    expect(accuracyGuard(text, noErrors, { recoverable: true }).ok).toBe(false);
    expect(accuracyGuard(text, text.toUpperCase(), { recoverable: false }).ok).toBe(true);
  });
  it('is bounded on huge inputs', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `ERROR thing${i} failed with 0123456789ab${i}`).join('\n');
    const a = extractAnchors(big);
    expect(a.errors.length).toBeLessThanOrEqual(128);
    expect(a.ids.length).toBeLessThanOrEqual(256);
    const line = `ERROR ${'x'.repeat(1_000_000)}`;
    const t0 = Date.now();
    extractAnchors(line);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
