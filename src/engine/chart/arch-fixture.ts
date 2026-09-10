/** Deterministic two-package graph for architecture-map tests. Not shipped. */
import { SCHEMA_VERSION, type GraphEdge, type GraphNode, type VgGraph } from '../../schema.js';

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

export function monorepoGraph(): VgGraph {
  const nodes: GraphNode[] = [
    node({
      id: 'pkg-web',
      name: 'web',
      qualifiedName: '@acme/web',
      file: 'packages/web/package.json',
      kind: 'package',
    }),
    node({
      id: 'pkg-api',
      name: 'api',
      qualifiedName: '@acme/api',
      file: 'packages/api/package.json',
      kind: 'package',
    }),
    node({
      id: 'HomePage',
      name: 'HomePage',
      qualifiedName: 'HomePage',
      file: 'packages/web/src/HomePage.tsx',
      kind: 'component',
      importance: 0.7,
    }),
    node({
      id: 'CreateUser',
      name: 'CreateUser',
      qualifiedName: 'UsersController.CreateUser',
      file: 'packages/api/src/UsersController.ts',
      kind: 'method',
      importance: 0.9,
      isHub: true,
      span: { start: 12, end: 40 },
    }),
    node({
      id: 'UserService',
      name: 'Create',
      qualifiedName: 'UserService.Create',
      file: 'packages/api/src/UserService.ts',
      kind: 'method',
      importance: 0.8,
    }),
    node({
      id: 'SaveUser',
      name: 'Save',
      qualifiedName: 'UserRepo.Save',
      file: 'packages/api/src/UserRepo.ts',
      kind: 'method',
      importance: 0.6,
    }),
    node({
      id: 'UserDto',
      name: 'UserDto',
      qualifiedName: 'UserDto',
      file: 'packages/api/src/UserDto.ts',
      kind: 'class',
      importance: 0.2,
    }),
    node({
      id: 'helperTest',
      name: 'makeUser',
      qualifiedName: 'makeUser',
      file: 'packages/api/src/UserService.test.ts',
      kind: 'function',
      importance: 0.1,
    }),
    node({
      id: 'f1',
      name: 'UsersController.ts',
      qualifiedName: 'packages/api/src/UsersController.ts',
      file: 'packages/api/src/UsersController.ts',
      kind: 'file',
    }),
  ];
  const edges: GraphEdge[] = [
    { id: 'e-web-api', kind: 'import', src: 'pkg-web', dst: 'pkg-api', resolution: 'heuristic', confidence: 1 },
    { id: 'e-page', kind: 'call', src: 'HomePage', dst: 'CreateUser', resolution: 'tsc', confidence: 1 },
    { id: 'e-create', kind: 'call', src: 'CreateUser', dst: 'UserService', resolution: 'tsc', confidence: 1 },
    { id: 'e-save', kind: 'call', src: 'UserService', dst: 'SaveUser', resolution: 'tsc', confidence: 1 },
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
      corpusHash: 'arch-test',
    },
    meta: {
      root: '.',
      languages: ['ts'],
      counts: { nodes: nodes.length, edges: edges.length, areas: 2, tests: 1, untested: 4 },
      cluster: 'none',
      edgeKinds: ['call', 'import'],
    },
    nodes,
    edges,
    areas: [
      { id: 0, label: 'api', size: 6, members: ['CreateUser', 'UserService', 'SaveUser'], cohesion: 1, externalEdges: 1 },
      { id: 1, label: 'web', size: 1, members: ['HomePage'], cohesion: 1, externalEdges: 1 },
    ],
  };
}
