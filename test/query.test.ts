import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { queryGraph } from '../src/engine/query.js';
import { sanitizeRank, type RankResult } from '../src/engine/relevance-provider.js';
import { findNodes, resolveOne } from '../src/engine/lookup.js';
import { impactOf } from '../src/engine/impact.js';
import { shortestPath } from '../src/engine/paths.js';
import { makeProject, cleanup, SAMPLE_FILES } from './helpers.js';
import type { VgGraph } from '../src/schema.js';

let graph: VgGraph;
let dir: string;
beforeAll(async () => {
  dir = makeProject(SAMPLE_FILES);
  graph = (await buildGraph({ root: dir, generatedAt: '2020-01-01T00:00:00.000Z', inline: true })).graph;
});
afterAll(() => cleanup(dir));

describe('queryGraph (ask)', () => {
  it('returns ranked matches for a term', () => {
    const r = queryGraph(graph, 'order service');
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches[0].node.qualifiedName.toLowerCase()).toContain('order');
    expect(r.context).toContain('# Context for: order service');
  });

  it('respects the token budget', () => {
    const small = queryGraph(graph, 'order', { budget: 30 });
    expect(small.tokensEstimate).toBeLessThanOrEqual(60); // bounded near budget
  });

  it('is deterministic', () => {
    expect(queryGraph(graph, 'double').context).toBe(queryGraph(graph, 'double').context);
  });

  it('handles no-match gracefully', () => {
    const r = queryGraph(graph, 'zzzznotathing');
    expect(r.matches.length).toBe(0);
    expect(r.context).toContain('No matching symbols');
  });
});

describe('queryGraph with a module ranking (provider seam)', () => {
  const rankedOf = (raw: RankResult) =>
    sanitizeRank(raw, new Set(graph.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'external').map((n) => n.id)));

  it('consumes the module ordering verbatim, capped at the limit', () => {
    const picks = graph.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'external').slice(0, 4);
    const ranked = rankedOf({
      version: 'stub-ranker@1',
      hasContent: true,
      seeds: picks.map((n, i) => ({ id: n.id, score: 40 - i, why: `pick ${i}` })),
      conceptMap: [],
    });
    const r = queryGraph(graph, 'anything', { ranked, limit: 3 });
    expect(r.matches.map((m) => m.node.id)).toEqual(picks.slice(0, 3).map((n) => n.id));
  });

  it('an honest module miss yields no seeds even when tokens would match mechanically', () => {
    const ranked = rankedOf({ version: 'stub-ranker@1', hasContent: false, seeds: [], conceptMap: [] });
    const r = queryGraph(graph, 'order service', { ranked });
    expect(r.matches).toEqual([]);
  });

  it('is deterministic with a module ranking', () => {
    const picks = graph.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'external').slice(0, 2);
    const raw: RankResult = {
      version: 'stub-ranker@1',
      hasContent: true,
      seeds: picks.map((n, i) => ({ id: n.id, score: 10 - i, why: `pick ${i}` })),
      conceptMap: [],
    };
    expect(queryGraph(graph, 'order', { ranked: rankedOf(raw) }).context).toBe(
      queryGraph(graph, 'order', { ranked: rankedOf(raw) }).context,
    );
  });
});

describe('mechanical fallback boundaries (relevance behaviours live in the module)', () => {
  // IDF weighting, scaffolding stopwords, lexicon expansion, typo repair and
  // morphology are gated in @vibgrate/relevance now. Mechanically, matching
  // is exact-name / part / qualified-name only — these hold the boundary.
  let g: VgGraph;
  let d: string;
  beforeAll(async () => {
    d = makeProject({
      'src/repo.ts': [
        'export class AccessPolicyRepository {',
        '  findByIdAsync(id: string): void {}',
        '}',
        'export function toComparable(x: number): number { return x; }',
      ].join('\n'),
    });
    g = (await buildGraph({ root: d, generatedAt: '2020-01-01T00:00:00.000Z', inline: true })).graph;
  });
  afterAll(() => cleanup(d));

  it('part matching pins a named symbol without any language model', () => {
    const r = queryGraph(g, 'write tests for toComparable');
    expect(r.matches[0].node.name).toBe('toComparable');
  });

  it('never fuzzy-matches: a word-form variant is an honest miss', () => {
    // "comparables" ≠ part "comparable"; morphology is the module's job.
    const r = queryGraph(g, 'comparables');
    expect(r.matches).toEqual([]);
  });
});

describe('queryGraph tokenization edge cases', () => {
  // Adversarial-fixture-shaped names (single-letter, non-Latin identifiers)
  // used to tokenize to zero terms and return an empty result unconditionally
  // (VG-LOCATE-FAILURE-ANALYSIS.md).
  let g: VgGraph;
  let d: string;
  beforeAll(async () => {
    d = makeProject({
      'src/short.ts': [
        'export function h(): void {}',
        'export function 名前(): void {}',
      ].join('\n'),
    });
    g = (await buildGraph({ root: d, generatedAt: '2020-01-01T00:00:00.000Z', inline: true })).graph;
  });
  afterAll(() => cleanup(d));

  it('locates a single-character symbol name', () => {
    const r = queryGraph(g, 'what does h do?');
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches[0].node.name).toBe('h');
  });

  it('locates a non-Latin (Unicode) symbol name', () => {
    const r = queryGraph(g, 'where is 名前 defined?');
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches[0].node.name).toBe('名前');
  });
});

describe('lookup', () => {
  it('resolves by qualified name', () => {
    expect(findNodes(graph, 'OrderService.addItem')[0]?.name).toBe('addItem');
  });
  it('resolves by short name', () => {
    expect(findNodes(graph, 'double').length).toBeGreaterThan(0);
  });
  it('resolves by glob', () => {
    expect(findNodes(graph, 'Order*').length).toBeGreaterThan(0);
  });
  it('resolveOne returns candidates on ambiguity', () => {
    const r = resolveOne(graph, '*'); // matches many
    expect(r.node).toBeUndefined();
    expect(r.candidates.length).toBeGreaterThan(1);
  });
});

describe('impactOf', () => {
  it('finds reverse-reachable dependents with decaying confidence', () => {
    const node = findNodes(graph, 'double')[0];
    const r = impactOf(graph, node.id, { depth: 4 });
    const names = r.affected.map((a) => a.name);
    expect(names).toContain('OrderService.addItem');
    expect(r.direct).toBeGreaterThanOrEqual(1);
    const direct = r.affected.find((a) => a.name === 'OrderService.addItem')!;
    const transitive = r.affected.find((a) => a.depth > 1);
    if (transitive) expect(transitive.confidence).toBeLessThan(direct.confidence);
  });
});

describe('shortestPath', () => {
  it('finds the call path A → B', () => {
    const a = findNodes(graph, 'OrderService.deleteAsync')[0];
    const b = findNodes(graph, 'double')[0];
    const p = shortestPath(graph, a.id, b.id)!;
    expect(p).not.toBeNull();
    const byId = new Map(graph.nodes.map((n) => [n.id, n.qualifiedName]));
    expect(p.ids.map((id) => byId.get(id))).toEqual([
      'OrderService.deleteAsync',
      'OrderService.addItem',
      'double',
    ]);
  });

  it('pathDisconnect reports neighbors when unconnected', async () => {
    const { pathDisconnect } = await import('../src/engine/paths.js');
    // double and OrderService are connected via calls; pick a file node vs a far leaf if needed.
    // Use two distinct endpoints that may still be linked — assert shape on a self-path miss:
    // shortestPath to self is a zero-hop path, so invent a synthetic check via any node.
    const a = findNodes(graph, 'OrderService.deleteAsync')[0];
    const disc = pathDisconnect(graph, a.id, a.id);
    expect(disc.connected).toBe(false);
    expect(disc.from.name).toBeTruthy();
    expect(disc.to.name).toBe(disc.from.name);
    expect(typeof disc.hint).toBe('string');
    // deleteAsync should have callees in this fixture.
    expect(disc.from.calls.length + disc.from.calledBy.length).toBeGreaterThan(0);
  });
});
