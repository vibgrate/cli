/**
 * A tiny, deterministic {@link VgGraph} used by the code-subsystem tests and the
 * benchmark's offline scenarios. Kept out of the `*.test.ts` glob so it can be
 * imported as a helper; it is not shipped (nothing in the entry graph imports
 * it). Represents a two-file fake repo with call edges and one declared fact, so
 * retrieval, impact, and fact-pinning all have something real to chew on.
 */

import { SCHEMA_VERSION, type Fact, type GraphEdge, type GraphNode, type VgGraph } from '../schema.js';

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

export function fixtureGraph(): VgGraph {
  const nodes: GraphNode[] = [
    node({ id: 'f1', name: 'scan.ts', qualifiedName: 'src/scan.ts', file: 'src/scan.ts', kind: 'file' }),
    node({
      id: 'scanDir',
      name: 'scanDir',
      qualifiedName: 'scanDir',
      file: 'src/scan.ts',
      kind: 'function',
      signature: 'function scanDir(dir: string): Report',
      span: { start: 5, end: 20 },
      importance: 0.8,
      isHub: true,
    }),
    node({
      id: 'readConfig',
      name: 'readConfig',
      qualifiedName: 'readConfig',
      file: 'src/scan.ts',
      kind: 'function',
      signature: 'function readConfig(): Config',
      span: { start: 22, end: 30 },
      importance: 0.4,
    }),
    node({ id: 'f2', name: 'report.ts', qualifiedName: 'src/report.ts', file: 'src/report.ts', kind: 'file' }),
    node({
      id: 'formatReport',
      name: 'formatReport',
      qualifiedName: 'formatReport',
      file: 'src/report.ts',
      kind: 'function',
      signature: 'function formatReport(r: Report): string',
      span: { start: 3, end: 12 },
      importance: 0.6,
    }),
  ];

  const edges: GraphEdge[] = [
    { id: 'e1', kind: 'call', src: 'scanDir', dst: 'readConfig', resolution: 'tsc', confidence: 1 },
    { id: 'e2', kind: 'call', src: 'formatReport', dst: 'scanDir', resolution: 'tsc', confidence: 1 },
  ];

  const facts: Fact[] = [
    {
      id: 'fact1',
      kind: 'invariant',
      subjectIds: ['scanDir'],
      predicate: { rule: 'scanDir must never follow symlinks out of the root' },
      derivedBy: 'declared',
      confidence: 'Observed',
      evidence: [{ file: 'src/scan.ts', span: { start: 5, end: 5 } }],
    },
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '1970-01-01T00:00:00.000Z',
    provenance: {
      tool: 'vg',
      version: '0.0.0-test',
      grammars: {},
      resolver: ['tsc'],
      deep: false,
      corpusHash: 'test',
    },
    meta: {
      root: '.',
      languages: ['ts'],
      counts: { nodes: nodes.length, edges: edges.length, areas: 1, tests: 0, untested: 3 },
      cluster: 'none',
      edgeKinds: ['call'],
    },
    nodes,
    edges,
    areas: [{ id: 0, label: 'scan', size: nodes.length, members: nodes.map((n) => n.id), cohesion: 1, externalEdges: 0 }],
    facts,
  };
}
