import { describe, expect, it } from 'vitest';
import { adaptiveThreshold, BM25Scorer, buildRelevanceQuery, compactToolArgs, extractKeywords, extractQueryAnchors, itemMatchesAnchors, otsuThreshold, planRelevanceSplit, scoreRelevance, segment, tokenize } from './relevance.js';

describe('tokenize', () => {
  it('keeps UUIDs and long numbers whole, lowercases', () => {
    // The BM25 tokenizer keeps every term — common words are handled by IDF, not
    // by a stopword list (that is `extractKeywords`, below).
    expect(tokenize('Find 550E8400-e29b-41d4-a716-446655440000 and id 12345 in Foo_bar')).toEqual([
      'find',
      '550e8400-e29b-41d4-a716-446655440000',
      'and',
      'id',
      '12345',
      'in',
      'foo_bar',
    ]);
    expect(tokenize('')).toEqual([]);
  });
});

describe('BM25Scorer', () => {
  const s = new BM25Scorer();
  it('scores single docs with neutral idf and batches with real idf', () => {
    const one = s.score('alice bob carol', 'alice');
    expect(one.score).toBeGreaterThan(0);
    expect(one.matched).toEqual(['alice']);
    expect(s.score('nothing here', 'alice').score).toBe(0);
    const batch = s.scoreBatch(['alice went home', 'bob went home', 'carol stayed'], 'alice home');
    expect(batch[0].score).toBeGreaterThan(batch[1].score);
    expect(batch[2].score).toBe(0);
    expect(batch[0].matched).toEqual(['alice', 'home']);
  });
  it('adds the long-token bonus and caps at 1', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(s.score(`row ${uuid}`, uuid).score).toBeGreaterThanOrEqual(0.3);
    expect(s.score(`${uuid} `.repeat(50), uuid).score).toBeLessThanOrEqual(1);
  });
  it('applies the sparse floors in scoreRelevance', () => {
    const r = scoreRelevance(['alice bob', 'alice', 'zzz'], 'alice bob');
    expect(r[0].score).toBeGreaterThanOrEqual(0.5);
    expect(r[1].score).toBeGreaterThanOrEqual(0.3);
    expect(r[2].score).toBe(0);
    expect(scoreRelevance(['x'], '')).toEqual([{ score: 0, matched: [] }]);
  });
});

describe('query anchors and keywords', () => {
  it('extracts uuids, numeric ids, hostnames, quoted strings and emails', () => {
    const a = extractQueryAnchors(`look at 550E8400-E29B-41D4-A716-446655440000 user 12345 on api.example.com e.g. 'retry-loop' mail Bob@Example.com 123`);
    expect(a).toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(a).toContain('12345');
    expect(a).toContain('api.example.com');
    expect(a).toContain('retry-loop');
    expect(a).toContain('bob@example.com');
    expect(a).not.toContain('e.g');
    expect(a).not.toContain('123');
    expect(extractQueryAnchors('')).toEqual([]);
  });
  it('matches items in both python-ish and json forms', () => {
    expect(itemMatchesAnchors({ name: 'Alice', ok: true }, ['alice'])).toBe(true);
    expect(itemMatchesAnchors({ host: 'api.example.com' }, ['api.example.com'])).toBe(true);
    expect(itemMatchesAnchors({ a: 1 }, [])).toBe(false);
  });
  it('builds queries and extracts keywords', () => {
    expect(buildRelevanceQuery('  fix the bug ', 'Grep', 'pattern=foo')).toBe('fix the bug\nGrep pattern=foo');
    expect(buildRelevanceQuery('', '', '')).toBe('');
    expect(extractKeywords('Please find the payment_service timeout errors in the logs')).toEqual(['payment_service', 'timeout', 'errors', 'logs']);
    expect(compactToolArgs({ pattern: 'foo', path: '/x', nested: { a: 1 }, n: 3 })).toBe('pattern=foo path=/x n=3');
    expect(compactToolArgs('x'.repeat(400)).length).toBe(300);
  });
});

describe('otsu / segment / plan', () => {
  it('finds the natural break', () => {
    expect(otsuThreshold([0.1, 0.1, 0.9, 0.9])).toBe(0.5);
    expect(adaptiveThreshold([0.2, 0.2, 0.2], 0.25)).toBe(0.25);
    expect(adaptiveThreshold([0.1, 0.9], 0.25)).toBe(0.5);
  });
  it('segments losslessly and windows dense blocks', () => {
    const dense = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('');
    const segs = segment(dense);
    expect(segs.join('')).toBe(dense);
    expect(segs.length).toBe(4);
    const withIndent = 'a\n  b\n  c\nd\n'.repeat(4);
    expect(segment(withIndent, { window: 2 }).join('')).toBe(withIndent);
    expect(segment('single')).toEqual(['single']);
    expect(segment('')).toEqual([]);
  });
  it('plans keep/drop runs by relevance', () => {
    const content = `alpha payment failed\n\nbeta ok\n\ngamma ok\n\ndelta payment retry\n`;
    const runs = planRelevanceSplit(content, 'payment', { threshold: 0.25 });
    expect(runs.map((r) => r.keep)).toEqual([true, false, true]);
    expect(runs.map((r) => r.text).join('')).toBe(content);
    expect(planRelevanceSplit(content, '')).toEqual([{ keep: true, text: content }]);
    expect(planRelevanceSplit(content, 'x', { maxRecords: 2 })).toEqual([{ keep: true, text: content }]);
  });
});
