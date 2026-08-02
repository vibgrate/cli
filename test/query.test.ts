import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { queryGraph } from '../src/engine/query.js';
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

describe('queryGraph with a relevance analysis (provider seam)', () => {
  const relevance = (expansions: Array<{ term: string; from: string; weight: number }>) => ({
    version: 'stub-relevance@1',
    topics: [],
    expansions,
  });

  it('provider expansions surface conceptually-related symbols the ask never names', () => {
    // "purchase flow" shares no token with OrderService; the expansion
    // purchase→order bridges it, with provenance in the why string.
    const without = queryGraph(graph, 'purchase flow');
    const withRel = queryGraph(graph, 'purchase flow', {
      relevance: relevance([{ term: 'order', from: 'purchase', weight: 0.6 }]),
    });
    expect(without.matches.some((m) => m.node.qualifiedName.includes('OrderService'))).toBe(false);
    const hit = withRel.matches.find((m) => m.node.qualifiedName.includes('OrderService'));
    expect(hit).toBeTruthy();
    expect(hit!.why).toContain('purchase→order');
  });

  it('junk expansions cannot make a weak-only ask seed (grab-bag guard holds)', () => {
    const r = queryGraph(graph, 'add a new feature', {
      relevance: relevance([{ term: 'zzznotathing', from: 'sometopic', weight: 0.9 }]),
    });
    expect(r.matches.length).toBe(0);
  });

  it('a provider term the lexicon already produced is not double-counted', () => {
    // Both the analysis and the ask name "order": scores must equal the
    // no-provider run because base tokens win over provider duplicates.
    const a = queryGraph(graph, 'order service');
    const b = queryGraph(graph, 'order service', {
      relevance: relevance([{ term: 'order', from: 'purchase', weight: 0.9 }]),
    });
    expect(b.matches.map((m) => [m.node.id, m.score])).toEqual(a.matches.map((m) => [m.node.id, m.score]));
  });

  it('is deterministic with a relevance analysis', () => {
    const opts = { relevance: relevance([{ term: 'order', from: 'purchase', weight: 0.6 }]) };
    expect(queryGraph(graph, 'purchase flow', opts).context).toBe(queryGraph(graph, 'purchase flow', opts).context);
  });

  it('topic-affinity: enrichment tags lift in-topic nodes and annotate why, but never seed alone', () => {
    // Tag every OrderService-family node with a topic the question is about.
    const tagged = new Map<string, readonly string[]>();
    for (const n of graph.nodes) if (n.qualifiedName.includes('OrderService')) tagged.set(n.id, ['commerce']);
    const withAffinity = {
      relevance: { version: 'stub-relevance@1', topics: [{ id: 'commerce', score: 1 }], expansions: [] },
      topicTags: tagged,
    };
    const plain = queryGraph(graph, 'order');
    const boosted = queryGraph(graph, 'order', withAffinity);
    const score = (r: typeof plain, name: string) => r.matches.find((m) => m.node.qualifiedName.includes(name))?.score ?? 0;
    expect(score(boosted, 'OrderService')).toBeGreaterThan(score(plain, 'OrderService'));
    const hit = boosted.matches.find((m) => m.node.qualifiedName.includes('OrderService'))!;
    expect(hit.why).toContain('topic:commerce');
    // A tagged node with zero textual evidence still never seeds.
    const noText = queryGraph(graph, 'zzzznotathing', withAffinity);
    expect(noText.matches.length).toBe(0);
  });
});

describe('queryGraph term specificity (IDF)', () => {
  // A distinctive term must outweigh a common-word exact-name hit: the pathology
  // where "run"/"copy"/"code" in a natural-language question hijacked the ranking.
  let g: VgGraph;
  let d: string;
  beforeAll(async () => {
    d = makeProject({
      'src/runners.ts': [
        'export function run() {}',
        'export function runScan() {}',
        'export function runBuild() {}',
        'export function runDeploy() {}',
        'export function runTest() {}',
      ].join('\n'),
      'src/util.ts': ['export function toComparable(x: number): number {', '  return x;', '}'].join('\n'),
    });
    g = (await buildGraph({ root: d, generatedAt: '2020-01-01T00:00:00.000Z', inline: true })).graph;
  });
  afterAll(() => cleanup(d));

  it('ranks the rare-term match above a common-word exact-name match', () => {
    // "run" is common (5 symbols); "comparable" is rare (1). The question is
    // *about* comparable — run is incidental. toComparable must win.
    const r = queryGraph(g, 'run the comparable value');
    expect(r.matches[0].node.name).toBe('toComparable');
  });
});

describe('queryGraph question-scaffolding stopwords', () => {
  // "find the code responsible for X" / "explain how X works" are template
  // FRAMING, not identifier terms. Left unfiltered, "find" alone dragged in
  // every Find*/FindBy* method ahead of the actual (differently-named) target
  // — the dominant "locate" failure mode on real CRUD-heavy repos
  // (VG-LOCATE-FAILURE-ANALYSIS.md).
  let g: VgGraph;
  let d: string;
  beforeAll(async () => {
    d = makeProject({
      'src/repo.ts': [
        'export class AccessPolicyRepository {',
        '  findByIdAsync(id: string): void {}',
        '  findAllAsync(): void {}',
        '}',
        'export class OrderService {',
        '  deleteAsync(id: string): void {}',
        '}',
      ].join('\n'),
    });
    g = (await buildGraph({ root: d, generatedAt: '2020-01-01T00:00:00.000Z', inline: true })).graph;
  });
  afterAll(() => cleanup(d));

  it('does not let template scaffolding ("find", "code", "responsible") outrank the real target', () => {
    const r = queryGraph(g, 'find the code responsible for delete async');
    expect(r.matches[0].node.name).toBe('deleteAsync');
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
