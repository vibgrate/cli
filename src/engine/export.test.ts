import { describe, it, expect } from 'vitest';
import { exportGraph, formatForExt, type ExportContext } from './export.js';
import type { Fact, GraphEdge, GraphNode, VgGraph } from '../schema.js';

/**
 * Portable SQL fact-DB export (agent-consumption). Asserts the DDL shape, that
 * the `edges` insert carries an `epistemic` tier an agent can filter on, and
 * that an identical graph yields byte-identical .sql (determinism).
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

function edge(src: string, dst: string, opts: Partial<GraphEdge> = {}): GraphEdge {
  return { id: `e_${src}_${dst}`, kind: 'call', src, dst, resolution: 'heuristic', confidence: 1, epistemic: 'observed', ...opts };
}

function makeGraph(withFacts = false): VgGraph {
  const nodes = [
    node('n_foo', 'foo', 'src/a.ts', { importance: 0.9, isHub: true, signature: "foo(x): 'ok'" }),
    node('n_bar', 'bar', 'src/b.ts', { tested: null, coverage: 0.5 }),
  ];
  const edges = [
    edge('n_bar', 'n_foo', { epistemic: 'observed', confidence: 0.95, count: 2 }),
    edge('n_foo', 'n_bar', { epistemic: 'name-matched', confidence: 0.4, resolution: 'heuristic' }),
  ];
  const facts: Fact[] = [
    {
      id: 'f_1',
      kind: 'contract',
      subjectIds: ['n_foo', 'n_bar'],
      predicate: { requires: "x != 'y'" },
      derivedBy: 'static',
      confidence: 'Derived',
      evidence: [{ file: 'src/a.ts', span: { start: 1, end: 10 } }],
    },
  ];
  return {
    schemaVersion: 'vg-graph/1.0',
    generatedAt: '2026-01-01T00:00:00Z',
    provenance: { tool: 'vg', version: 'test', grammars: {}, resolver: ['heuristic'], deep: withFacts, corpusHash: 'h' },
    meta: {
      root: '.',
      languages: ['typescript'],
      counts: { nodes: 2, edges: 2, areas: 1, tests: 0, untested: 2 },
      cluster: 'louvain',
      edgeKinds: ['call'],
    },
    nodes,
    edges,
    areas: [{ id: 0, label: 'core', size: 2, members: ['n_bar', 'n_foo'], cohesion: 0.8, externalEdges: 0 }],
    ...(withFacts ? { facts } : {}),
  };
}

const ctx = (graph: VgGraph): ExportContext => ({ graph, generatedAt: graph.generatedAt });

describe('sql export', () => {
  it('maps the .sql extension to the sql format', () => {
    expect(formatForExt('.sql')).toBe('sql');
  });

  it('emits the expected CREATE TABLE statements wrapped in a transaction', () => {
    const out = exportGraph('sql', ctx(makeGraph(true)));
    expect(out.startsWith('BEGIN;')).toBe(true);
    expect(out.trimEnd().endsWith('COMMIT;')).toBe(true);
    for (const t of ['meta', 'nodes', 'edges', 'areas', 'area_members', 'facts', 'fact_subjects', 'fact_evidence']) {
      expect(out).toContain(`CREATE TABLE IF NOT EXISTS ${t} `);
    }
  });

  it('omits the facts tables when the graph has no facts (non --deep build)', () => {
    const out = exportGraph('sql', ctx(makeGraph(false)));
    expect(out).toContain('CREATE TABLE IF NOT EXISTS nodes ');
    expect(out).not.toContain('CREATE TABLE IF NOT EXISTS facts ');
  });

  it('carries an epistemic tier on the edges insert (agent can SELECT WHERE epistemic=...)', () => {
    const out = exportGraph('sql', ctx(makeGraph(true)));
    const edgeInserts = out.split('\n').filter((l) => l.startsWith('INSERT INTO edges VALUES'));
    expect(edgeInserts.length).toBe(2);
    expect(edgeInserts.some((l) => l.includes("'observed'"))).toBe(true);
    expect(edgeInserts.some((l) => l.includes("'name-matched'"))).toBe(true);
  });

  it('escapes single quotes by doubling and renders booleans/NULLs correctly', () => {
    const out = exportGraph('sql', ctx(makeGraph(true)));
    // signature "foo(x): 'ok'" → doubled quotes.
    expect(out).toContain("foo(x): ''ok''");
    // n_bar.tested is null → NULL, is_hub false → 0, coverage 0.5 kept.
    const barRow = out.split('\n').find((l) => l.startsWith('INSERT INTO nodes') && l.includes("'n_bar'"))!;
    expect(barRow).toContain('0.5');
    expect(barRow).toContain('NULL');
  });

  it('is deterministic: the same graph exports byte-identically', () => {
    const a = exportGraph('sql', ctx(makeGraph(true)));
    const b = exportGraph('sql', ctx(makeGraph(true)));
    expect(a).toBe(b);
  });
});
