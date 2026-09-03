import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, VgGraph } from '../../schema.js';
import { adaptGraph, isCallableKind } from './adapter.js';
import { classifyCallable } from './classify.js';
import { formatHaileLines } from './format.js';
import {
  emptySidecar,
  haileSidecarPathFor,
  readHaileSidecar,
  serializeSidecar,
  writeHaileSidecarFor,
  writeSidecarDocument,
} from './sidecar.js';
import type { HaileSymbol } from './types.js';
import { HAILE_ENGINE_VERSION, HAILE_MAGIC, HAILE_TAXONOMY } from './types.js';

function node(partial: Partial<GraphNode> & Pick<GraphNode, 'id' | 'kind' | 'name' | 'file'>): GraphNode {
  return {
    qualifiedName: partial.qualifiedName ?? partial.name,
    span: partial.span ?? { start: 1, end: 8 },
    lang: partial.lang ?? 'cs',
    importance: 0.1,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
    area: 0,
    isHub: false,
    tested: null,
    ...partial,
  };
}

function tinyGraph(nodes: GraphNode[], edges: GraphEdge[] = []): VgGraph {
  return {
    schemaVersion: 'vg-graph/1.1',
    generatedAt: '2020-01-01T00:00:00.000Z',
    provenance: {
      tool: 'vg',
      version: 'test',
      grammars: {},
      resolver: ['heuristic'],
      deep: false,
      corpusHash: 'abc123',
    },
    meta: {
      root: '.',
      languages: ['cs'],
      counts: { nodes: nodes.length, edges: edges.length, areas: 0, tests: 0, untested: 0 },
      cluster: 'none',
      edgeKinds: [],
    },
    nodes,
    edges,
    areas: [],
  };
}

function sampleSymbol(): HaileSymbol {
  return {
    node_id: 'n1',
    file_path: 'src/controllers/UsersController.cs',
    name: 'CreateUser',
    qualified_name: 'UsersController.CreateUser',
    symbol_kind: 'method',
    role: {
      primary: 'controller',
      alternatives: [{ role: 'application_service', confidence: 0.22 }],
      confidence: 0.81,
      band: 'high',
    },
    purposes: [
      { purpose: 'validate', confidence: 0.9 },
      { purpose: 'persist', confidence: 0.8 },
    ],
    intent: {
      text: 'validates CreateUserRequest and persists User',
      verbs: ['validate', 'persist'],
      objects: ['CreateUserRequest', 'User'],
    },
    evidence: [{ kind: 'lexical', signal: 'name looks like a handler', weight: 1 }],
  };
}

describe('H0 adapter', () => {
  it('keeps only callable node kinds and copies call edges as names', () => {
    const graph = tinyGraph(
      [
        node({ id: 'n1', kind: 'method', name: 'CreateUser', file: 'UsersController.cs', signature: 'CreateUser(req: CreateUserRequest): User' }),
        node({ id: 'n2', kind: 'method', name: 'Save', file: 'UserRepo.cs' }),
        node({ id: 'n3', kind: 'file', name: 'UsersController.cs', file: 'UsersController.cs' }),
      ],
      [{ id: 'e1', kind: 'call', src: 'n1', dst: 'n2', resolution: 'heuristic', confidence: 0.7 }],
    );
    const adapted = adaptGraph(graph);
    expect(adapted.map((c) => c.name)).toEqual(['CreateUser', 'Save']);
    expect(adapted[0]!.calls).toEqual(['Save']);
    expect(adapted[0]!.parameters[0]?.type_name).toBe('CreateUserRequest');
    expect(isCallableKind('file')).toBe(false);
  });

  it('carries file-layer and ast-role annotations without recomputing them', () => {
    const graph = tinyGraph([
      node({ id: 'n1', kind: 'method', name: 'CreateUser', file: 'src/controllers/UsersController.cs' }),
    ]);
    const adapted = adaptGraph(graph, {
      fileLayerByPath: new Map([['src/controllers/UsersController.cs', 'routing']]),
      astRoleByPath: new Map([['src/controllers/UsersController.cs', 'controller']]),
    });
    expect(adapted[0]!.file_layer).toBe('routing');
    expect(adapted[0]!.ast_role).toBe('controller');
  });
});

describe('H1 classify boundary', () => {
  it('refuses rather than guessing when the kernel is not shipped', () => {
    expect(() => classifyCallable()).toThrow(/Architecture classify is not shipped/);
  });
});

describe('H1 classify file', () => {
  it('is snake_case, corpus-hash bound, and byte-stable', () => {
    const doc = emptySidecar('abc123');
    doc.symbols = [sampleSymbol()];
    const a = serializeSidecar(doc);
    const b = serializeSidecar(doc);
    expect(a).toBe(b);
    const parsed = JSON.parse(a);
    expect(parsed.magic).toBe(HAILE_MAGIC);
    expect(parsed.taxonomy).toBe(HAILE_TAXONOMY);
    expect(parsed.engine_version).toBe(HAILE_ENGINE_VERSION);
    expect(parsed.corpus_hash).toBe('abc123');
    expect(parsed.symbols[0].node_id).toBe('n1');
    expect(Object.keys(parsed.symbols[0])).toEqual(
      expect.arrayContaining(['node_id', 'file_path', 'qualified_name', 'symbol_kind', 'role', 'purposes', 'intent', 'evidence']),
    );
  });

  it('returns null on stale corpus_hash and never throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haile-'));
    const graphPath = path.join(dir, 'graph.json');
    fs.writeFileSync(graphPath, '{}');
    const doc = emptySidecar('abc123');
    doc.symbols = [sampleSymbol()];
    expect(writeSidecarDocument(doc, graphPath)).toBe(haileSidecarPathFor(graphPath));
    expect(readHaileSidecar(graphPath, { corpusHash: 'abc123' })?.symbols).toHaveLength(1);
    expect(readHaileSidecar(graphPath, { corpusHash: 'other' })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writeHaileSidecarFor refuses when the architecture module is not installed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haile-'));
    const graphPath = path.join(dir, 'graph.json');
    fs.writeFileSync(graphPath, '{}');
    const prevPath = process.env.VIBGRATE_HAILE_PATH;
    const prevNo = process.env.VIBGRATE_NO_KERNEL;
    delete process.env.VIBGRATE_HAILE_PATH;
    process.env.VIBGRATE_NO_KERNEL = '1';
    try {
      const graph = tinyGraph([node({ id: 'n1', kind: 'function', name: 'main', file: 'main.rs' })]);
      expect(writeHaileSidecarFor(graph, graphPath)).toBeNull();
    } finally {
      if (prevPath === undefined) delete process.env.VIBGRATE_HAILE_PATH;
      else process.env.VIBGRATE_HAILE_PATH = prevPath;
      if (prevNo === undefined) delete process.env.VIBGRATE_NO_KERNEL;
      else process.env.VIBGRATE_NO_KERNEL = prevNo;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('H2 vg show formatter', () => {
  it('prints role distribution, purposes, intent, and band', () => {
    const text = formatHaileLines(sampleSymbol()).join('\n');
    expect(text).toMatch(/role controller/);
    expect(text).toMatch(/purposes /);
    expect(text).toMatch(/intent /);
    expect(text).toMatch(/high|medium|low|abstain/);
  });
});
