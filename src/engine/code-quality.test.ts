import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
// @ts-ignore — plain-JS fixture helper, no types needed
import { generateIntentRepo } from '../../bench/intent-fixture.mjs';
// @ts-ignore — plain-JS corpus helper, no types needed
import { buildCodeCorpus, evaluateCodeEntry } from '../../bench/code-corpus.mjs';
// @ts-ignore — shared evaluation contract with the ask corpus
import { evaluateAskEntry } from '../../bench/ask-corpus.mjs';
// @ts-ignore — plain-JS scoreboard helper shared with the locate/ask gates
import { scoreByCategory } from '../../bench/locate-corpus.mjs';
import { buildGraph } from './build.js';
import { queryGraph } from './query.js';
import type { VgGraph } from '../schema.js';

/**
 * The `vg code` MECHANICAL prompt gate (post relevance-relocation, 2026-08).
 *
 * The full 800+-prompt coding corpus gates the relevance module in that
 * package's suite. This public gate holds the module-less fallback to the
 * subset a mechanical matcher must still win: prompts that NAME a real
 * symbol or paste a real path — test-writing, refactors, stack traces —
 * pin the named file, and content-free prompts return an honest empty.
 */

interface CodeEntry {
  q: string;
  category: string;
  k: number;
  mustMiss?: boolean;
}
interface Outcome {
  entry: CodeEntry;
  pass: boolean;
  reason?: string;
  ms: number;
}

/** Categories a mechanical name matcher is expected to win outright. */
const MECHANICAL_CATEGORIES = new Set(['code-test-writing', 'code-refactor-named', 'code-path-hint']);

const SCALE = 6;
const SEED_LIMIT = 16;

let root: string;
let graph: VgGraph;
let outcomes: Outcome[];

beforeAll(async () => {
  const fixture = generateIntentRepo(SCALE) as { root: string; catalog: unknown };
  root = fixture.root;
  const built = await buildGraph({
    root,
    inline: true,
    noGround: true,
    noTsc: true,
    noCoverage: true,
    noScip: true,
    generatedAt: '2026-01-01T00:00:00Z',
  });
  graph = built.graph;
  const corpus = (buildCodeCorpus(fixture.catalog) as CodeEntry[]).filter((e) => MECHANICAL_CATEGORIES.has(e.category));
  expect(corpus.length).toBeGreaterThanOrEqual(100);
  outcomes = [];
  for (const entry of corpus) {
    const s = process.hrtime.bigint();
    const result = queryGraph(graph, entry.q, { limit: SEED_LIMIT });
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    const seeds = result.matches.map((m) => ({ file: m.node.file }));
    const { pass, reason } = evaluateCodeEntry(entry, seeds, evaluateAskEntry) as { pass: boolean; reason?: string };
    outcomes.push({ entry, pass, reason, ms });
  }
}, 180_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('vg code mechanical prompt gate (module-less fallback)', () => {
  it('every name-bearing coding-prompt category resolves at 100%', () => {
    const scored = scoreByCategory(outcomes) as Array<{
      category: string;
      total: number;
      passed: number;
      rate: number;
      failures: Array<{ q: string; reason: string }>;
    }>;
    const failing = scored.filter((r) => r.rate < 1);
    const detail = failing
      .map((r) => `${r.category} ${r.passed}/${r.total}\n` + r.failures.map((f) => `    "${f.q}" — ${f.reason}`).join('\n'))
      .join('\n');
    expect(failing, `\nfailing categories:\n${detail}\n`).toEqual([]);
  });

  it('content-free coding prompts return an honest empty mechanically', () => {
    for (const q of ['fix the bug', 'make it faster please', 'the fft window function clips at the nyquist bin']) {
      const r = queryGraph(graph, q, { limit: SEED_LIMIT });
      expect(r.matches, q).toEqual([]);
    }
  });

  it('stays fast: p95 per-prompt latency under 250ms at gate scale', () => {
    const sorted = outcomes.map((o) => o.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    expect(p95).toBeLessThan(250);
  });
});
