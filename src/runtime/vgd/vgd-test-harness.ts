/**
 * Shared fixtures for live-vgd surface tests. Not a `*.test.ts` — vitest
 * must not run this file on its own.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { serializeGraph } from '../../engine/serialize.js';
import { SCHEMA_VERSION, type GraphEdge, type GraphNode, type VgGraph } from '../../schema.js';
import { startVgdServer, type VgdServer, type VgdServerOptions } from './server.js';
import { vgdRequest } from './client.js';
import { envForNamedVgdSocket } from './attach.js';

export function makeTmpTracker(): { tmp(): string; cleanup(): void } {
  const dirs: string[] = [];
  return {
    tmp() {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-vgd-surf-'));
      dirs.push(d);
      return d;
    },
    cleanup() {
      while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    },
  };
}

function emptyCentrality() {
  return { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 };
}

/** Unique hub name so cross-branch / cross-repo leaks are obvious. */
export function labelledGraph(label: string, files = 4): VgGraph {
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
    const fnId = i === 0 ? label : `${label}Helper${i}`;
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
      signature: `function ${fnId}(): void`,
    });
    if (i > 0) {
      edges.push({
        id: `${label}-e${i}`,
        kind: 'call',
        src: `${label}-fn-0`,
        dst: `${label}-fn-${i}`,
        resolution: 'heuristic',
        confidence: 0.8,
      });
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '1970-01-01T00:00:00.000Z',
    provenance: {
      tool: 'vg',
      version: '0.0.0-test',
      grammars: {},
      resolver: ['heuristic'],
      deep: false,
      corpusHash: `hash-${label}-${files}`,
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
    areas: [
      {
        id: 0,
        label,
        size: nodes.length,
        members: nodes.map((n) => n.id),
        cohesion: 1,
        externalEdges: 0,
      },
    ],
  };
}

export function writeGraphFile(dir: string, graph: VgGraph): string {
  fs.mkdirSync(dir, { recursive: true });
  const graphPath = path.join(dir, 'graph.json');
  fs.writeFileSync(graphPath, serializeGraph(graph, { compact: true }));
  return graphPath;
}

export function writeInRepoGraph(root: string, graph: VgGraph): string {
  return writeGraphFile(path.join(root, '.vibgrate'), graph);
}

export function writeMiniProject(root: string, label: string, files = 4): { graphPath: string; helper: string } {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: label.toLowerCase(), version: '1.0.0' }));
  const src = path.join(root, 'src', label);
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'm0.ts'), `export function ${label}() {}\n`);
  const graph = labelledGraph(label, files);
  return { graphPath: writeInRepoGraph(root, graph), helper: `${label}Helper1` };
}

export async function startTestVgd(
  dir: string,
  extra: VgdServerOptions = {},
): Promise<{ server: VgdServer; socketPath: string }> {
  const socketPath = extra.socketPath ?? path.join(dir, 'vgd.sock');
  const { pidPath, watch, rebuild, ...rest } = extra;
  const server = await startVgdServer({
    ...rest,
    socketPath,
    pidPath: pidPath ?? path.join(dir, 'vgd.pid'),
    watch: watch ?? false,
    // Vitest's argv[1] is the worker, not `vg` — a real spawnRebuild would
    // hang the suite. Tests that want a rebuild inject one.
    rebuild: rebuild ?? (async () => ({ ok: false, error: 'rebuild not expected in tests' })),
  });
  return { server, socketPath };
}

export const namedVgdEnv = envForNamedVgdSocket;

export async function putLabelled(
  socketPath: string,
  repositoryId: string,
  gitRef: string,
  label: string,
  files = 4,
): Promise<{ repositoryId: string; gitRef: string; helper: string }> {
  const graph = labelledGraph(label, files);
  const put = await vgdRequest({ op: 'put-graph', repositoryId, gitRef, graph }, { socketPath });
  if (!put.ok || !('stored' in put)) throw new Error(`put-graph ${label} failed`);
  return { repositoryId: put.repositoryId, gitRef: put.gitRef, helper: `${label}Helper1` };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function until(pred: () => boolean | Promise<boolean>, timeoutMs = 2_000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}
