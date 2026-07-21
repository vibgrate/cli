import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
// @ts-ignore — plain-JS fixture helper, no types needed
import { generateXlRepo } from '../../bench/xl-fixture.mjs';
// @ts-ignore — plain-JS corpus helper, no types needed
import { buildCorpus, evaluateEntry, scoreByCategory } from './../../bench/locate-corpus.mjs';
import { buildGraph } from './build.js';
import { searchSymbols, clearListingCache } from './search.js';
import type { VgGraph } from '../schema.js';

/**
 * The locate quality gate: the FULL corpus (200+ categorized queries at this
 * scale) runs against a REAL graph built from the polyglot XL fixture, and
 * every category must resolve at 100% — exact symbols of every kind and
 * language, case variants, qualified names, file:line, globs, substrings,
 * reconstructed identifiers, token unions, routes, quoted literals, fluent
 * calls, config keys, shared phrases with exact totals, duplicates — and every
 * must-miss probe must return a clean no-match (no confident false positives).
 *
 * This is the enforcement half of the published `bench:locate` benchmark: the
 * bench reports the numbers per release; this gate stops a regression merging.
 * The goal it guards is explicit: an agent on this repo NEVER needs grep.
 */

interface CorpusEntry {
  q: string;
  category: string;
  k: number;
  expectFile?: string;
  expectFiles?: string[];
  expectLine?: number;
  expectTotal?: number;
  mustMiss?: boolean;
}
interface Outcome {
  entry: CorpusEntry;
  pass: boolean;
  reason?: string;
  ms: number;
}

const SCALE = 6;
const LIMIT = 15;

let root: string;
let graph: VgGraph;
let outcomes: Outcome[];

beforeAll(async () => {
  const fixture = generateXlRepo(SCALE) as { root: string; catalog: unknown };
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
  const corpus = buildCorpus(fixture.catalog) as CorpusEntry[];
  expect(corpus.length).toBeGreaterThanOrEqual(100); // the breadth contract
  clearListingCache();
  outcomes = [];
  for (const entry of corpus) {
    const s = process.hrtime.bigint();
    const result = await searchSymbols(graph, root, entry.q, LIMIT);
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    const { pass, reason } = evaluateEntry(entry, result) as { pass: boolean; reason?: string };
    outcomes.push({ entry, pass, reason, ms });
  }
}, 180_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('search_symbols locate quality gate (real graph over the XL fixture)', () => {
  it('every category resolves at 100% — failures listed with reasons', () => {
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

  it('must-miss probes never produce a confident false positive', () => {
    const misses = outcomes.filter((o) => o.entry.mustMiss);
    expect(misses.length).toBeGreaterThanOrEqual(5);
    for (const o of misses) expect(o.pass, `"${o.entry.q}": ${o.reason ?? ''}`).toBe(true);
  });

  it('stays fast: p95 per-query latency under 250ms at gate scale', () => {
    const sorted = outcomes.map((o) => o.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    expect(p95).toBeLessThan(250);
  });
});
