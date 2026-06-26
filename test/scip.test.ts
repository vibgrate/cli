import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeScipIndex, scipEdges, type ScipIndex } from '../src/engine/scip.js';
import { buildGraph } from '../src/engine/build.js';
import { makeProject, cleanup } from './helpers.js';
import type { GraphNode } from '../src/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'scip');

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('SCIP decoder (against a real scip-typescript index)', () => {
  it('decodes the tool, documents, and occurrences', () => {
    const buf = fs.readFileSync(path.join(FIXTURE, 'index.scip'));
    const index = decodeScipIndex(new Uint8Array(buf));
    expect(index.toolName).toBe('scip-typescript');
    expect(index.documents.length).toBe(1);
    const doc = index.documents[0];
    expect(doc.relativePath).toBe('src/math.ts');
    expect(doc.occurrences.length).toBeGreaterThan(0);
    // Definition occurrences carry the Definition role bit.
    expect(doc.occurrences.some((o) => (o.roles & 1) === 1 && o.symbol.includes('add().'))).toBe(true);
    // Reference occurrences (role 0) exist too (the call to add inside double).
    expect(doc.occurrences.some((o) => (o.roles & 1) === 0)).toBe(true);
  });
});

describe('SCIP edge mapping (unit, no protobuf)', () => {
  it('maps a reference occurrence to a precise call edge', () => {
    const nodes: GraphNode[] = [
      mkNode('n-add', 'add', 'function', 'src/m.ts', 1, 1),
      mkNode('n-dbl', 'double', 'function', 'src/m.ts', 2, 2),
    ];
    const index: ScipIndex = {
      documents: [
        {
          relativePath: 'src/m.ts',
          occurrences: [
            { range: [0, 16, 19], symbol: 'pkg add().', roles: 1 }, // def of add (line 1)
            { range: [1, 40, 43], symbol: 'pkg add().', roles: 0 }, // ref to add inside double (line 2)
          ],
        },
      ],
    };
    const res = scipEdges(index, nodes, (p) => p);
    expect(res.edges).toHaveLength(1);
    const e = res.edges[0];
    expect(e).toMatchObject({ kind: 'call', src: 'n-dbl', dst: 'n-add', resolution: 'scip', confidence: 1 });
  });
});

describe('SCIP end-to-end build', () => {
  it('auto-detects index.scip and resolves edges precisely', async () => {
    const root = makeProject({
      'src/math.ts': fs.readFileSync(path.join(FIXTURE, 'src', 'math.ts'), 'utf8'),
    });
    dirs.push(root);
    fs.copyFileSync(path.join(FIXTURE, 'index.scip'), path.join(root, 'index.scip'));

    const { graph } = await buildGraph({ root, generatedAt: '2020-01-01T00:00:00.000Z', inline: true });
    expect(graph.provenance.resolver).toContain('scip');
    const byId = new Map(graph.nodes.map((n) => [n.id, n.qualifiedName]));
    const edge = graph.edges.find((e) => e.kind === 'call' && byId.get(e.src) === 'double' && byId.get(e.dst) === 'add');
    expect(edge?.resolution).toBe('scip');
    expect(edge?.confidence).toBe(1);
  });

  it('--no-scip ignores the index (heuristic only)', async () => {
    const root = makeProject({
      'src/math.ts': fs.readFileSync(path.join(FIXTURE, 'src', 'math.ts'), 'utf8'),
    });
    dirs.push(root);
    fs.copyFileSync(path.join(FIXTURE, 'index.scip'), path.join(root, 'index.scip'));

    const { graph } = await buildGraph({ root, generatedAt: '2020-01-01T00:00:00.000Z', inline: true, noScip: true });
    expect(graph.provenance.resolver).not.toContain('scip');
  });
});

function mkNode(id: string, name: string, kind: GraphNode['kind'], file: string, start: number, end: number): GraphNode {
  return {
    id,
    kind,
    name,
    qualifiedName: name,
    file,
    span: { start, end },
    lang: 'ts',
    importance: 0,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
    area: -1,
    isHub: false,
    tested: null,
  };
}
