import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanCandidates } from './literal-scan.js';
import { searchSymbols } from './search.js';
import type { GraphNode, VgGraph } from '../schema.js';
 
// @ts-ignore — plain-JS fixture helper shared with the benchmark
import { generateRepo, expectedCounts } from '../../bench/fixture.mjs';

/**
 * Correctness across literal *kinds*, over the same generated repo the benchmark
 * uses: UI copy, a log line, a config key (single token), a rare comment phrase,
 * and a guaranteed miss — plus a symbol lookup. Each kind must be found with the
 * exact count, the pure-JS fallback and ripgrep must agree, and matches inside
 * ignored dirs (node_modules/dist decoys) must never leak in.
 */

const N = 120;
let root: string;

const IGNORE = new Set(['.git', '.vibgrate', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__']);
function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || IGNORE.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs));
  }
  return out.sort();
}

beforeAll(() => {
  ({ root } = generateRepo(N));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const emptyGraph: VgGraph = {
  schemaVersion: 'vg-graph/1.0',
  generatedAt: 'x',
  provenance: { tool: 'vg', version: 'test', grammars: {}, resolver: ['heuristic'], deep: false, corpusHash: 'h' },
  meta: { root: '.', languages: [], counts: { nodes: 0, edges: 0, areas: 0, tests: 0, untested: 0 }, cluster: 'none', edgeKinds: [] },
  nodes: [],
  edges: [],
  areas: [],
};

describe('literal kinds — the engine finds each exactly', () => {
  it('counts every literal kind correctly and never leaks ignored dirs', async () => {
    const files = walk(root);
    for (const [needle, want] of Object.entries(expectedCounts(N) as Record<string, number>)) {
      const out = await scanCandidates(root, files, needle, { collectAll: true, budget: 10_000 });
      expect(out.total, `count for "${needle}"`).toBe(want);
      // The node_modules/dist decoys contain every marker — none may appear.
      expect(out.hits.every((h) => !h.file.includes('node_modules') && !h.file.includes('dist'))).toBe(true);
    }
  });
});

describe('literal kinds — ripgrep and the pure-JS fallback agree', () => {
  const sweep = (needle: string) => searchSymbols(emptyGraph, root, needle, 200);
  for (const needle of [
    'Save changes',
    'failed to connect to database',
    'you say the quiet part',
    '$9.99 (per item) [tax] a|b', // regex metacharacters: rg must be --fixed-strings
    'Café ☕ Ünïcödé déjà vu', // unicode / emoji / accents
  ]) {
    it(`"${needle}" — same count with rg and forced-fallback`, async () => {
      const want = (expectedCounts(N) as Record<string, number>)[needle];
      delete process.env.VG_DISABLE_RIPGREP;
      const withRg = await sweep(needle);
      process.env.VG_DISABLE_RIPGREP = '1';
      const noRg = await sweep(needle);
      delete process.env.VG_DISABLE_RIPGREP;
      expect(withRg.totalTextMatches).toBe(want);
      expect(noRg.totalTextMatches).toBe(want);
    });
  }
});

describe('symbols still resolve alongside literals', () => {
  it('a symbol name resolves symbol-first from the graph index', async () => {
    // A tiny graph with a symbol that also exists in the fixture as text.
    const node: GraphNode = {
      id: 'n1',
      kind: 'class',
      name: 'OrderService',
      qualifiedName: 'src/order.ts:OrderService',
      file: 'src/order.ts',
      span: { start: 1, end: 5 },
      lang: 'typescript',
      importance: 0.9,
      centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
      area: 0,
      isHub: true,
      tested: false,
    };
    const graph: VgGraph = { ...emptyGraph, nodes: [node] };
    const r = await searchSymbols(graph, root, 'OrderService', 8);
    expect(r.matches[0]).toMatchObject({ kind: 'class', name: 'src/order.ts:OrderService' });
  });
});
