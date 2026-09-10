/**
 * vgd runtime bench — load, immediate query, branch switch, multi-folder, memory.
 *
 *   pnpm --filter @vibgrate/cli-public exec tsx bench/vgd-runtime.bench.ts
 *
 * Scales (files → ~2 nodes each):
 *   small  50 files    always
 *   medium 500 files   always
 *   large  2000 files  default; VG_VGD_SCALE=large (or a number of files)
 *
 * Does not download the embedding model. Semantic ranking is whatever the
 * daemon's worker can do from a cold start (usually lexical here).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startVgdServer } from '../src/runtime/vgd/server.js';
import { vgdRequest } from '../src/runtime/vgd/client.js';
import { serializeGraph } from '../src/engine/serialize.js';
import { SCHEMA_VERSION, type GraphEdge, type GraphNode, type VgGraph } from '../src/schema.js';

const SCALE: Record<string, number> = { small: 50, medium: 500, large: 2000 };
const requested = (process.env.VG_VGD_SCALE ?? 'small,medium,large').split(',').map((s) => s.trim());

function emptyCentrality() {
  return { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 };
}

function labelledGraph(label: string, files: number): VgGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < files; i++) {
    const file = `src/${label}/m${i}.ts`;
    nodes.push({
      id: `${label}-file-${i}`,
      name: `m${i}.ts`,
      qualifiedName: file,
      kind: 'file',
      file,
      span: { start: 1, end: 20 },
      lang: 'ts',
      importance: 0.1,
      centrality: emptyCentrality(),
      area: 0,
      isHub: false,
      tested: false,
    });
    const fnId = i === 0 ? label : `${label}H${i}`;
    nodes.push({
      id: `${label}-fn-${i}`,
      name: fnId,
      qualifiedName: fnId,
      kind: 'function',
      file,
      span: { start: 3, end: 12 },
      lang: 'ts',
      importance: i === 0 ? 0.9 : 0.2,
      centrality: emptyCentrality(),
      area: 0,
      isHub: i === 0,
      tested: false,
    });
    if (i > 0) {
      edges.push({
        id: `${label}-e${i}`,
        kind: 'call',
        src: `${label}-fn-0`,
        dst: `${label}-fn-${i}`,
        resolution: 'heuristic',
        confidence: 0.7,
      });
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '1970-01-01T00:00:00.000Z',
    provenance: {
      tool: 'vg',
      version: '0.0.0-bench',
      grammars: {},
      resolver: ['heuristic'],
      deep: false,
      corpusHash: `bench-${label}-${files}`,
    },
    meta: {
      root: '.',
      languages: ['ts'],
      counts: { nodes: nodes.length, edges: edges.length, areas: 1, tests: 0, untested: files },
      cluster: 'none',
      edgeKinds: ['call'],
    },
    nodes,
    edges,
    areas: [{ id: 0, label, size: nodes.length, members: [], cohesion: 1, externalEdges: 0 }],
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

function mb(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)}`;
}

function row(cols: Array<string | number>): string {
  return cols.map((c) => String(c).padStart(12)).join('  ');
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-vgd-bench-'));
  const socketPath = path.join(dir, 'vgd.sock');
  const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
  const lines: string[] = [];
  try {
    lines.push('# first scale includes daemon JIT; q2 is the warm query');
    lines.push(row(['scale', 'files', 'load_ms', 'q1_ms', 'q2_ms', 'switch_ms', 'heap_MB', 'rss_MB']));
    const scales = requested.map((name) => {
      if (name in SCALE) return { name, files: SCALE[name]! };
      const n = Number(name);
      return { name: `${n}f`, files: Number.isFinite(n) && n > 0 ? n : 50 };
    });

    for (const { name, files } of scales) {
      const root = path.join(dir, name);
      fs.mkdirSync(root, { recursive: true });
      const graph = labelledGraph(`Hub_${name}`, files);
      const graphPath = path.join(root, 'graph.json');
      fs.writeFileSync(graphPath, serializeGraph(graph, { compact: true }));

      const load = await timed(() =>
        vgdRequest({ op: 'load-graph', root, gitRef: 'main', graphPath }, { socketPath }),
      );
      if (!load.value.ok || !('stored' in load.value)) {
        throw new Error(`${name}: load-graph failed ${JSON.stringify(load.value)}`);
      }
      const { repositoryId } = load.value;

      const q1 = await timed(() =>
        vgdRequest({ op: 'query-graph', repositoryId, query: `Hub_${name}`, limit: 8 }, { socketPath }),
      );
      const q2 = await timed(() =>
        vgdRequest({ op: 'query-graph', repositoryId, query: `Hub_${name}`, limit: 8 }, { socketPath }),
      );

      const other = labelledGraph(`Alt_${name}`, Math.min(40, files));
      await vgdRequest({ op: 'put-graph', repositoryId, gitRef: 'feat', graph: other }, { socketPath });
      const sw = await timed(() =>
        vgdRequest({ op: 'select-git-ref', repositoryId, gitRef: 'feat' }, { socketPath }),
      );
      // Switch back so the next scale's current slot is not this one.
      await vgdRequest({ op: 'select-git-ref', repositoryId, gitRef: 'main' }, { socketPath });

      const status = await vgdRequest({ op: 'status' }, { socketPath });
      const mem = status.ok && 'memory' in status ? status.memory : undefined;
      lines.push(
        row([
          name,
          files,
          load.ms.toFixed(1),
          q1.ms.toFixed(1),
          q2.ms.toFixed(1),
          sw.ms.toFixed(1),
          mem ? mb(mem.heapUsed) : '?',
          mem ? mb(mem.rss) : '?',
        ]),
      );
      if (!q1.value.ok || !q2.value.ok) throw new Error(`${name}: query failed`);
    }

    // Multi-folder: three medium maps resident together.
    const multi = await timed(async () => {
      for (const id of ['a', 'b', 'c']) {
        const g = labelledGraph(`Multi${id}`, 120);
        await vgdRequest({ op: 'put-graph', repositoryId: `multi-${id}`, gitRef: 'main', graph: g }, { socketPath });
      }
      const qs = await Promise.all(
        ['a', 'b', 'c'].map((id) =>
          vgdRequest({ op: 'query-graph', repositoryId: `multi-${id}`, query: `Multi${id}`, limit: 3 }, { socketPath }),
        ),
      );
      if (qs.some((q) => !q.ok)) throw new Error('multi-folder query failed');
    });
    const end = await vgdRequest({ op: 'status' }, { socketPath });
    const mem = end.ok && 'memory' in end ? end.memory : undefined;
    lines.push('');
    lines.push(`multi-folder 3×120 files  ${multi.ms.toFixed(1)}ms`);
    if (mem) {
      lines.push(`final memory  heap ${mb(mem.heapUsed)}MB  rss ${mb(mem.rss)}MB  slots ${mem.graphSlots}`);
    }
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write(lines.join('\n') + '\n');
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
