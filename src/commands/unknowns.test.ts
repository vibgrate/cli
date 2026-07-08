import { describe, it, expect } from 'vitest';
import { rankSites } from './unknowns.js';
import type { GraphEdge, GraphNode, Unknown, VgGraph } from '../schema.js';

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: 'function',
    name: id,
    qualifiedName: `src/x.ts:${id}`,
    file: 'src/x.ts',
    span: { start: 1, end: 5 },
    lang: 'typescript',
    importance: 0.1,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
    area: 0,
    isHub: false,
    tested: false,
    ...over,
  };
}

function callEdge(src: string, dst: string): GraphEdge {
  return { id: `e_${src}_${dst}`, kind: 'call', src, dst, resolution: 'heuristic', confidence: 1 };
}

// hub is depended on by many; leaf by none. Both have one unknown reference.
function makeGraph(unknowns: Unknown[]): VgGraph {
  const nodes = [
    node('hub', { importance: 0.9 }),
    node('leaf', { importance: 0.05 }),
    node('d1'),
    node('d2'),
    node('d3'),
  ];
  const edges = [callEdge('d1', 'hub'), callEdge('d2', 'hub'), callEdge('d3', 'd1')];
  return {
    schemaVersion: 'vg-graph/1.0',
    generatedAt: '2026-01-01T00:00:00Z',
    provenance: { tool: 'vg', version: 't', grammars: {}, resolver: ['heuristic'], deep: false, corpusHash: 'h' },
    meta: {
      root: '.',
      languages: ['typescript'],
      counts: { nodes: 5, edges: edges.length, areas: 1, tests: 0, untested: 5 },
      cluster: 'louvain',
      edgeKinds: ['call'],
    },
    nodes,
    edges,
    areas: [],
    unknowns,
  };
}

describe('rankSites', () => {
  it('ranks an unknown inside a hub above an equally-frequent unknown in a leaf', () => {
    const g = makeGraph([
      { from: 'hub', name: 'mystery', kind: 'call', count: 1 },
      { from: 'leaf', name: 'mystery', kind: 'call', count: 1 },
    ]);
    const sites = rankSites(g, 10);
    expect(sites.map((s) => s.node.id)).toEqual(['hub', 'leaf']);
    // hub has transitive dependents (d1, d2, d3); leaf has none.
    expect(sites[0].blastRadius).toBeGreaterThan(sites[1].blastRadius);
    expect(sites[1].blastRadius).toBe(0);
  });

  it('aggregates multiple unknown references at one site', () => {
    const g = makeGraph([
      { from: 'hub', name: 'a', kind: 'call', count: 2 },
      { from: 'hub', name: 'Base', kind: 'extends', count: 1 },
    ]);
    const sites = rankSites(g, 10);
    expect(sites).toHaveLength(1);
    expect(sites[0].refs).toHaveLength(2);
    expect(sites[0].total).toBe(3);
  });

  it('drops unknowns whose originating node is no longer in the graph', () => {
    const g = makeGraph([{ from: 'ghost', name: 'x', kind: 'call', count: 1 }]);
    expect(rankSites(g, 10)).toHaveLength(0);
  });

  it('returns nothing when there are no unknowns', () => {
    const g = makeGraph([]);
    g.unknowns = undefined;
    expect(rankSites(g, 10)).toEqual([]);
  });

  it('honors the limit', () => {
    const g = makeGraph([
      { from: 'hub', name: 'a', kind: 'call', count: 1 },
      { from: 'leaf', name: 'b', kind: 'call', count: 1 },
    ]);
    expect(rankSites(g, 1)).toHaveLength(1);
  });
});
