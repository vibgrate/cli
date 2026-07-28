import { describe, it, expect } from 'vitest';
import { extractLiteralNeedles, queryGraph, stripLiteralNeedles } from './query.js';
import { SCHEMA_VERSION, type GraphNode, type VgGraph } from '../schema.js';

function node(partial: Partial<GraphNode> & Pick<GraphNode, 'id' | 'name' | 'qualifiedName' | 'file' | 'kind'>): GraphNode {
  return {
    span: { start: 1, end: 10 },
    lang: 'ts',
    importance: 0.5,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
    area: 0,
    isHub: false,
    tested: false,
    ...partial,
  } as GraphNode;
}

/** Graph shaped like the field-report false-positive set (DoesNot / NonExisting / dash). */
function poisonGraph(): VgGraph {
  const nodes: GraphNode[] = [
    node({
      id: 'doesNot',
      name: 'FieldDeclared_DoesNotEmit_NavigationProperties',
      qualifiedName: 'EfCoreModelExtractorTests.FieldDeclared_DoesNotEmit_NavigationProperties',
      file: 'packages/vibgrate-hcs/tests/EfCore.cs',
      kind: 'method',
      importance: 0.9,
    }),
    node({
      id: 'nonExisting',
      name: 'GetById_WithNonExistingId_ReturnsNotFound',
      qualifiedName: 'ProductsControllerTests.GetById_WithNonExistingId_ReturnsNotFound',
      file: 'tests/ProductsControllerTests.cs',
      kind: 'method',
      importance: 0.85,
    }),
    node({
      id: 'commandExists',
      name: 'commandExists',
      qualifiedName: 'commandExists',
      file: 'packages/vibgrate-contextbench-node/src/util/process.mjs',
      kind: 'function',
      importance: 0.7,
    }),
    node({
      id: 'risksDash',
      name: 'RisksComplianceDashboardPage',
      qualifiedName: 'RisksComplianceDashboardPage',
      file: 'packages/vibgrate-dash/src/pages/RisksComplianceDashboard.tsx',
      kind: 'function',
      importance: 0.95,
      isHub: true,
    }),
    node({
      id: 'scanDir',
      name: 'scanDir',
      qualifiedName: 'scanDir',
      file: 'src/scan.ts',
      kind: 'function',
      importance: 0.8,
    }),
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '1970-01-01T00:00:00.000Z',
    provenance: {
      tool: 'vg',
      version: '0.0.0-test',
      grammars: {},
      resolver: [],
      deep: false,
      corpusHash: 'test',
    },
    meta: {
      root: '.',
      languages: ['ts'],
      counts: { nodes: nodes.length, edges: 0, areas: 0, tests: 0, untested: 0 },
      cluster: 'none',
      edgeKinds: [],
    },
    nodes,
    edges: [],
    areas: [],
    facts: [],
    unknowns: [],
  };
}

describe('extractLiteralNeedles', () => {
  it('pulls URLs out of a free-text locate ask', () => {
    const q = 'https://dash.vibgrate.com/signup does not exist find occurrences';
    expect(extractLiteralNeedles(q)).toEqual(['https://dash.vibgrate.com/signup']);
  });

  it('strips a trailing English ? from "where is <url>?" without breaking query strings', () => {
    expect(extractLiteralNeedles('where is https://dash.vibgrate.com/signup?')).toEqual([
      'https://dash.vibgrate.com/signup',
    ]);
    expect(extractLiteralNeedles('open https://example.com/search?q=signup')).toEqual([
      'https://example.com/search?q=signup',
    ]);
  });

  it('pulls quoted phrases', () => {
    expect(extractLiteralNeedles('find every "you say" in brand copy')).toEqual(['you say']);
  });

  it('strips needles so residual framing remains', () => {
    const q = 'https://dash.vibgrate.com/signup does not exist find occurrences';
    expect(stripLiteralNeedles(q)).toMatch(/does not exist find occurrences/i);
    expect(stripLiteralNeedles(q)).not.toContain('https://');
  });
});

describe('queryGraph — URL / occurrence locate (field report)', () => {
  it('does not seed DoesNot*/NonExisting*/Dashboard from a missing-URL locate ask', () => {
    const q = 'https://dash.vibgrate.com/signup does not exist find occurrences';
    const r = queryGraph(poisonGraph(), q, { limit: 8 });
    expect(r.matches.map((m) => m.node.name)).toEqual([]);
    expect(r.context).toContain('https://dash.vibgrate.com/signup');
    expect(r.context).toMatch(/literal/i);
  });

  it('still resolves a real symbol when the residual ask names one', () => {
    const q = 'https://example.com/x update scanDir timeout';
    const r = queryGraph(poisonGraph(), q, { limit: 8 });
    expect(r.matches.some((m) => m.node.qualifiedName === 'scanDir')).toBe(true);
    expect(r.matches.some((m) => m.node.name.includes('DoesNot'))).toBe(false);
  });

  it('keeps normal identifier asks working', () => {
    const r = queryGraph(poisonGraph(), 'add a timeout to scanDir', { limit: 8 });
    expect(r.matches[0]?.node.qualifiedName).toBe('scanDir');
  });
});
