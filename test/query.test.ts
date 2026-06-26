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
});
