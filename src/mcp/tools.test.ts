import { describe, it, expect } from 'vitest';
import { TOOLS, type ToolContext } from './tools.js';
import type { GraphEdge, GraphNode, VgGraph } from '../schema.js';

/**
 * Tool-level behaviour for the token-reduction features: the `orient` one-shot,
 * `--dedup` collapse on repeat reads, and `impact_of` dropping its internal id.
 * Uses a tiny hand-built graph so the handlers run fully offline (lexical path).
 */

function node(id: string, name: string, file: string, opts: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: `${file}:${name}`,
    file,
    span: { start: 1, end: 10 },
    lang: 'typescript',
    importance: 0.5,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
    area: 0,
    isHub: false,
    tested: false,
    ...opts,
  };
}

function callEdge(src: string, dst: string): GraphEdge {
  return { id: `e_${src}_${dst}`, kind: 'call', src, dst, resolution: 'heuristic', confidence: 1 };
}

// foo is a hub called by both bar and baz.
function makeGraph(): VgGraph {
  const nodes = [
    node('n_foo', 'foo', 'src/a.ts', { importance: 0.9, isHub: true, signature: 'foo(): void' }),
    node('n_bar', 'bar', 'src/b.ts'),
    node('n_baz', 'baz', 'src/c.ts'),
  ];
  const edges = [callEdge('n_bar', 'n_foo'), callEdge('n_baz', 'n_foo')];
  return {
    schemaVersion: 'vg-graph/1.0',
    generatedAt: '2026-01-01T00:00:00Z',
    provenance: { tool: 'vg', version: 'test', grammars: {}, resolver: ['heuristic'], deep: false, corpusHash: 'h' },
    meta: {
      root: '.',
      languages: ['typescript'],
      counts: { nodes: 3, edges: 2, areas: 1, tests: 0, untested: 3 },
      cluster: 'louvain',
      edgeKinds: ['call'],
    },
    nodes,
    edges,
    areas: [{ id: 0, label: 'core', size: 3, members: ['n_bar', 'n_baz', 'n_foo'], cohesion: 0.8, externalEdges: 0 }],
  };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ root: '/tmp/vg-nonexistent', local: true, ...over });

describe('orient (one-shot orientation)', () => {
  it('bundles summary + matches + top blast radius in a single call', async () => {
    const g = makeGraph();
    const r = (await tool('orient').handler(g, { question: 'foo' }, ctx())) as Record<string, any>;
    expect(r.summary.counts.nodes).toBe(3);
    expect(r.mode).toBe('lexical'); // local:true → no embedder
    expect(typeof r.context).toBe('string');
    expect(r.matches.map((m: any) => m.name)).toContain('src/a.ts:foo');
    // foo is called by bar and baz → direct blast radius of 2.
    expect(r.topImpact.node).toBe('src/a.ts:foo');
    expect(r.topImpact.direct).toBe(2);
    // impact items carry no internal content-hash id.
    expect(r.topImpact.affected.every((a: any) => !('id' in a))).toBe(true);
  });
});

describe('get_node --dedup', () => {
  it('returns full relations first, then collapses on a repeat read', async () => {
    const g = makeGraph();
    const seen = new Set<string>();
    const c = ctx({ dedup: true, seen });

    const first = (await tool('get_node').handler(g, { name: 'foo' }, c)) as Record<string, any>;
    expect(first.calledBy).toEqual(['src/b.ts:bar', 'src/c.ts:baz']);
    expect(first.calledByTotal).toBe(2);
    expect(first.repeat).toBeUndefined();

    const second = (await tool('get_node').handler(g, { name: 'foo' }, c)) as Record<string, any>;
    expect(second.repeat).toBe(true);
    expect(second.calledByTotal).toBe(2); // totals still reported
    expect('calledBy' in second).toBe(false); // heavy array elided
    expect('calls' in second).toBe(false);
    // identity is always preserved so the model can still locate the node.
    expect(second.name).toBe('src/a.ts:foo');
    expect(second.signature).toBe('foo(): void');
  });

  it('does not collapse when --dedup is off', async () => {
    const g = makeGraph();
    const c = ctx({ dedup: false, seen: new Set<string>() });
    const first = (await tool('get_node').handler(g, { name: 'foo' }, c)) as Record<string, any>;
    const second = (await tool('get_node').handler(g, { name: 'foo' }, c)) as Record<string, any>;
    expect(second.repeat).toBeUndefined();
    expect(second.calledBy).toEqual(first.calledBy);
  });
});

describe('impact_of', () => {
  it('omits the internal content-hash id from affected items', async () => {
    const g = makeGraph();
    const r = (await tool('impact_of').handler(g, { name: 'foo' }, ctx())) as Record<string, any>;
    expect(r.direct).toBe(2);
    expect(r.affected.length).toBeGreaterThan(0);
    for (const item of r.affected) {
      expect('id' in item).toBe(false);
      expect(item.name).toBeTruthy();
      expect(item.file).toBeTruthy();
    }
  });
});
