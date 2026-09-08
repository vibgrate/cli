import { describe, expect, it } from 'vitest';
import { bm25, evidenceBoost, jaccard, rankMemories, recencyFactor, tokenize, RECENCY_DECAY_DAYS } from './rank.js';
import type { Memory } from './types.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function mem(id: string, text: string, extra: Partial<Memory> = {}): Memory {
  return { id, scope: 'user', kind: 'fact', text, tags: [], source: 'user', createdAt: NOW, updatedAt: NOW, evidence: 1, hash: id.padEnd(64, '0'), ...extra };
}

describe('tokenize / bm25', () => {
  it('lower-cases, drops stop words, stems plurals and splits path components', () => {
    expect(tokenize('The Auth module IS in src/auth/login.ts')).toEqual(['auth', 'module', 'src/auth/login.ts', 'src', 'auth', 'login', 'ts']);
    expect(tokenize('run the tests and queries')).toEqual(['run', 'test', 'query']);
    expect(tokenize('')).toEqual([]);
    expect(jaccard('deploys run from main', 'deploys run from main please')).toBeCloseTo(0.75, 5); // "from" is a stop word
    expect(jaccard('', '')).toBe(1);
  });

  it('scores documents containing the query terms higher', () => {
    const scores = bm25('pnpm test', ['run pnpm test to verify', 'the cat sat', 'pnpm install first']);
    expect(scores[0]).toBeGreaterThan(scores[2]);
    expect(scores[2]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBe(0);
    expect(bm25('', ['a'])).toEqual([0]);
  });
});

describe('recency / evidence', () => {
  it('decays with age and clamps missing or future timestamps to 1', () => {
    expect(recencyFactor(NOW, NOW)).toBe(1);
    expect(recencyFactor(NOW + DAY, NOW)).toBe(1);
    expect(recencyFactor(undefined, NOW)).toBe(1);
    expect(recencyFactor(NOW - RECENCY_DECAY_DAYS * DAY, NOW)).toBeCloseTo(Math.exp(-1), 6);
    expect(recencyFactor(NOW - 15 * DAY, NOW)).toBeCloseTo(0.607, 3);
  });

  it('evidence boost saturates at 1 after five observations', () => {
    expect(evidenceBoost(1)).toBeCloseTo(0.6);
    expect(evidenceBoost(5)).toBe(1);
    expect(evidenceBoost(50)).toBe(1);
    expect(evidenceBoost(0)).toBeCloseTo(0.6);
  });
});

describe('rankMemories', () => {
  it('combines relevance, recency, evidence and scope; ties break by updatedAt then id', () => {
    const fresh = mem('b', 'use pnpm test');
    const stale = mem('a', 'use pnpm test', { updatedAt: NOW - 60 * DAY });
    const strong = mem('c', 'use pnpm test', { evidence: 5, updatedAt: NOW - 60 * DAY });
    const project = mem('d', 'use pnpm test', { scope: 'project' });
    const globalScope = mem('e', 'use pnpm test', { scope: 'global' });
    const ranked = rankMemories([stale, fresh, strong, globalScope, project], 'pnpm test', { now: NOW });
    expect(ranked.map((h) => h.memory.id)).toEqual(['d', 'b', 'e', 'c', 'a']);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    // Same score → updatedAt desc → id asc
    const tie = rankMemories([mem('z', 'same'), mem('y', 'same')], 'same', { now: NOW });
    expect(tie.map((h) => h.memory.id)).toEqual(['y', 'z']);
  });

  it('drops non-matching memories, honours topK and minScore, and is pure', () => {
    const input = [mem('1', 'alpha'), mem('2', 'beta'), mem('3', 'alpha beta')];
    const snapshot = JSON.stringify(input);
    const r = rankMemories(input, 'alpha', { now: NOW, topK: 1 });
    expect(r).toHaveLength(1);
    expect(['1', '3']).toContain(r[0].memory.id);
    expect(rankMemories(input, 'alpha', { now: NOW, minScore: 0.99 })).toEqual([]);
    expect(rankMemories(input, '', { now: NOW })).toHaveLength(3); // empty query = listing
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(rankMemories([], 'x', { now: NOW })).toEqual([]);
  });

  it('blends cosine similarity when vectors are supplied', () => {
    const a = mem('a', 'unrelated words here');
    const b = mem('b', 'other unrelated text');
    const vectors = new Map([
      ['a', [1, 0]],
      ['b', [0, 1]],
    ]);
    const r = rankMemories([a, b], 'query', { now: NOW, queryVector: [0, 1], vectors });
    expect(r.map((h) => h.memory.id)).toEqual(['b']);
  });
});
