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
  it('bundles summary + matches + top blast radius under detailed', async () => {
    const g = makeGraph();
    const r = (await tool('orient').handler(g, { question: 'foo', response_format: 'detailed' }, ctx())) as Record<string, any>;
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

  it('concise returns the location only — no blast radius (find→edit path)', async () => {
    const g = makeGraph();
    // Default (concise): the caller needs where the code is, not what a change
    // there would touch. Surfacing blast radius invited impact-exploration the
    // task didn't need, so topImpact is a detailed-only concern now.
    const r = (await tool('orient').handler(g, { question: 'foo' }, ctx())) as Record<string, any>;
    expect(r.matches.map((m: any) => m.name)).toContain('src/a.ts:foo');
    expect('topImpact' in r).toBe(false);
    expect('context' in r).toBe(false);
  });

  it('treats scope "." / "./" as the whole repo, not a literal path filter', async () => {
    const g = makeGraph();
    // Files are repo-relative ("src/a.ts"); a literal startsWith(".") matched
    // nothing and silently zeroed orient. An agent passing "." for "here" must
    // still get results (trace: this wasted the first step and forced a grep
    // fallback on the C wander task).
    for (const scope of ['.', './']) {
      const r = (await tool('orient').handler(g, { question: 'foo', scope }, ctx())) as Record<string, any>;
      expect(r.matches.map((m: any) => m.name)).toContain('src/a.ts:foo');
    }
    // A real subdir prefix still filters (and tolerates a leading "./").
    const scoped = (await tool('orient').handler(g, { question: 'foo', scope: './src/b.ts' }, ctx())) as Record<string, any>;
    expect(scoped.matches.every((m: any) => m.file.startsWith('src/b.ts'))).toBe(true);
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
    const r = (await tool('impact_of').handler(g, { name: 'foo', response_format: 'detailed' }, ctx())) as Record<string, any>;
    expect(r.directCallers).toBe(2);
    expect(r.affected.length).toBeGreaterThan(0);
    for (const item of r.affected) {
      expect('id' in item).toBe(false);
      expect(item.name).toBeTruthy();
      expect(item.file).toBeTruthy();
    }
  });
});

describe('ambiguity payloads carry discriminating info', () => {
  it('get_node ambiguous candidates include kind/file/line and a pick index', async () => {
    const g = makeGraph();
    // Two same-named nodes in different files → ambiguous by short name.
    g.nodes.push(node('n_foo2', 'foo', 'src/z.ts', { importance: 0.4 }));
    const r = (await tool('get_node').handler(g, { name: 'foo' }, ctx())) as {
      error: string;
      candidates: { pick: number; name: string; kind: string; file: string; line: number }[];
      hint: string;
    };
    expect(r.error).toBe('ambiguous');
    expect(r.candidates[0]).toMatchObject({ pick: 1, kind: 'function', file: 'src/a.ts', line: 1 });
    expect(r.candidates[1].file).toBe('src/z.ts');
    expect(r.hint).toContain('pick');
  });

  it('get_node honours pick to break the tie', async () => {
    const g = makeGraph();
    g.nodes.push(node('n_foo2', 'foo', 'src/z.ts', { importance: 0.4 }));
    const r = (await tool('get_node').handler(g, { name: 'foo', pick: 2 }, ctx())) as { file: string };
    expect(r.file).toBe('src/z.ts');
  });

  it('find_path reports which endpoint failed, with candidates', async () => {
    const g = makeGraph();
    g.nodes.push(node('n_foo2', 'foo', 'src/z.ts', { importance: 0.4 }));
    const r = (await tool('find_path').handler(g, { a: 'foo', b: 'bar' }, ctx())) as {
      endpoint: string;
      error: string;
      candidates: unknown[];
    };
    expect(r.endpoint).toBe('a');
    expect(r.error).toBe('ambiguous');
    expect(r.candidates.length).toBe(2);
  });

  it('impact_of distinguishes ambiguous from not_found', async () => {
    const g = makeGraph();
    g.nodes.push(node('n_foo2', 'foo', 'src/z.ts', { importance: 0.4 }));
    const amb = (await tool('impact_of').handler(g, { name: 'foo' }, ctx())) as { error: string };
    expect(amb.error).toBe('ambiguous');
    const nf = (await tool('impact_of').handler(g, { name: 'nope_zzz' }, ctx())) as { error: string };
    expect(nf.error).toBe('not_found');
  });
});

describe('list_areas token economy', () => {
  it('strips raw member id arrays from the response', async () => {
    const r = (await tool('list_areas').handler(makeGraph(), {}, ctx())) as Record<string, unknown>[];
    expect(r[0]).toMatchObject({ id: 0, label: 'core', size: 3 });
    expect(r[0].members).toBeUndefined();
  });
});
