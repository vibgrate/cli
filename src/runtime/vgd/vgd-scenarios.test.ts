/**
 * End-to-end vgd scenarios the editor and `vg serve` depend on:
 * load a folder → query immediately; switch branch → query the new map;
 * several folders on different branches without leaking; memory stays bounded.
 *
 * Timing budgets are CI-generous (catch 10× regressions, not micro-jitter).
 * Scale numbers (small / medium) run in every `pnpm test`. A larger arm is
 * `pnpm bench:vgd` (`bench/vgd-runtime.bench.ts`).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { startVgdServer } from './server.js';
import { vgdRequest } from './client.js';
import { subscribeToSlots } from './slot-subscription.js';
import { serializeGraph } from '../../engine/serialize.js';
import { SCHEMA_VERSION, type GraphEdge, type GraphNode, type VgGraph } from '../../schema.js';
import { clearDetectGitRefCache } from '../git-ref.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  clearDetectGitRefCache();
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-vgd-scen-'));
  dirs.push(d);
  return d;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

function emptyCentrality() {
  return { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 };
}

/** A labelled map: unique hub symbol so cross-branch / cross-repo leaks are obvious. */
function labelledGraph(label: string, files = 4): VgGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const hub = label;
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
    const fnId = i === 0 ? hub : `${label}Helper${i}`;
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

function writeGraphFile(dir: string, graph: VgGraph): string {
  fs.mkdirSync(dir, { recursive: true });
  const graphPath = path.join(dir, 'graph.json');
  fs.writeFileSync(graphPath, serializeGraph(graph, { compact: true }));
  return graphPath;
}

function gitAvailable(): boolean {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

function git(root: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
}

describe('vgd scenarios — load, query, branch, multi-folder', () => {
  it('loads a folder then answers ask/search/impact immediately, within budget', async () => {
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const root = path.join(dir, 'app');
    fs.mkdirSync(root);
    const graph = labelledGraph('AuthService', 8);
    const graphPath = writeGraphFile(root, graph);
    // A source file so search_symbols has something to walk.
    fs.mkdirSync(path.join(root, 'src', 'AuthService'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'AuthService', 'm0.ts'), 'export function AuthService() {}\n');

    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
    try {
      const load = await timed(() =>
        vgdRequest({ op: 'ensure-graph', root, gitRef: 'main', graphPath }, { socketPath }),
      );
      expect(load.value.ok).toBe(true);
      if (!load.value.ok || !('stored' in load.value)) throw new Error('ensure-graph failed');
      expect(load.ms).toBeLessThan(2_000);
      const { repositoryId } = load.value;

      const ask = await timed(() =>
        vgdRequest(
          { op: 'graph-query', repositoryId, gitRef: 'main', mode: 'ask', question: 'AuthService', semantic: false },
          { socketPath },
        ),
      );
      expect(ask.value.ok).toBe(true);
      expect(ask.ms).toBeLessThan(500);
      if (ask.value.ok && 'result' in ask.value) {
        const result = ask.value.result as { ok?: boolean; data?: { matches?: Array<{ name: string }> } };
        expect(result.ok).toBe(true);
        expect(result.data?.matches?.some((m) => m.name.includes('AuthService'))).toBe(true);
      }

      const search = await timed(() =>
        vgdRequest({ op: 'query-graph', repositoryId, gitRef: 'main', query: 'AuthService', limit: 8 }, { socketPath }),
      );
      expect(search.value.ok).toBe(true);
      expect(search.ms).toBeLessThan(300);
      if (search.value.ok && 'matches' in search.value) {
        expect(search.value.matches.some((m) => m.qualifiedName === 'AuthService')).toBe(true);
      }

      const impact = await timed(() =>
        vgdRequest({ op: 'impact-of', repositoryId, gitRef: 'main', symbol: 'AuthService', depth: 3 }, { socketPath }),
      );
      expect(impact.value.ok).toBe(true);
      expect(impact.ms).toBeLessThan(300);

      const tool = await timed(() =>
        vgdRequest(
          { op: 'run-tool', repositoryId, gitRef: 'main', name: 'search_symbols', args: { query: 'AuthService', limit: 8 } },
          { socketPath },
        ),
      );
      expect(tool.value.ok).toBe(true);
      expect(tool.ms).toBeLessThan(1_000);

      const again = await timed(() =>
        vgdRequest({ op: 'ensure-graph', root, gitRef: 'main', graphPath }, { socketPath }),
      );
      expect(again.value.ok).toBe(true);
      if (again.value.ok && 'stored' in again.value) expect(again.value.alreadyHeld).toBe(true);
      expect(again.ms).toBeLessThan(200);
    } finally {
      await server.close();
    }
  });

  it('switch branch then query — never answers from the previous branch', async () => {
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
    try {
      const mainG = labelledGraph('OnMain', 3);
      const featG = labelledGraph('OnFeat', 3);
      await vgdRequest({ op: 'put-graph', repositoryId: 'repoA', gitRef: 'main', graph: mainG }, { socketPath });
      await vgdRequest({ op: 'put-graph', repositoryId: 'repoA', gitRef: 'feat', graph: featG }, { socketPath });

      const onMain = await vgdRequest(
        { op: 'query-graph', repositoryId: 'repoA', gitRef: 'main', query: 'OnMain' },
        { socketPath },
      );
      expect(onMain.ok && 'matches' in onMain && onMain.matches.some((m) => m.qualifiedName === 'OnMain')).toBe(true);

      const switched = await timed(() =>
        vgdRequest({ op: 'select-git-ref', repositoryId: 'repoA', gitRef: 'feat' }, { socketPath }),
      );
      expect(switched.value.ok).toBe(true);
      expect(switched.ms).toBeLessThan(200);

      const after = await timed(() =>
        vgdRequest({ op: 'query-graph', repositoryId: 'repoA', query: 'OnFeat' }, { socketPath }),
      );
      expect(after.value.ok).toBe(true);
      expect(after.ms).toBeLessThan(300);
      if (after.value.ok && 'matches' in after.value) {
        expect(after.value.matches.some((m) => m.qualifiedName === 'OnFeat')).toBe(true);
        expect(after.value.matches.some((m) => m.qualifiedName === 'OnMain')).toBe(false);
        expect(after.value.gitRef).toBe('feat');
      }

      // Explicit ref still reaches the other slot.
      const back = await vgdRequest(
        { op: 'query-graph', repositoryId: 'repoA', gitRef: 'main', query: 'OnMain' },
        { socketPath },
      );
      expect(back.ok && 'matches' in back && back.matches.some((m) => m.qualifiedName === 'OnMain')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('selecting a ref with no slot does not leak another branch\'s map', async () => {
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
    try {
      await vgdRequest(
        { op: 'put-graph', repositoryId: 'repoA', gitRef: 'main', graph: labelledGraph('OnlyMain', 2) },
        { socketPath },
      );
      await vgdRequest({ op: 'select-git-ref', repositoryId: 'repoA', gitRef: 'missing' }, { socketPath });
      const q = await vgdRequest({ op: 'query-graph', repositoryId: 'repoA', query: 'OnlyMain' }, { socketPath });
      expect(q.ok).toBe(false);
      if (!q.ok) expect(q.code).toBe('no_graph');
    } finally {
      await server.close();
    }
  });

  it('several folders on different branches do not leak symbols', async () => {
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
    try {
      const folders = [
        { id: 'pay', ref: 'main', symbol: 'ChargeCard' },
        { id: 'auth', ref: 'release', symbol: 'VerifyToken' },
        { id: 'edge', ref: 'feat/cache', symbol: 'PurgeCdn' },
      ];
      for (const f of folders) {
        await vgdRequest(
          { op: 'put-graph', repositoryId: f.id, gitRef: f.ref, graph: labelledGraph(f.symbol, 5) },
          { socketPath },
        );
      }

      const concurrent = await Promise.all(
        folders.map((f) =>
          timed(() =>
            vgdRequest({ op: 'query-graph', repositoryId: f.id, gitRef: f.ref, query: f.symbol, limit: 5 }, { socketPath }),
          ),
        ),
      );
      for (let i = 0; i < folders.length; i++) {
        const { ms, value } = concurrent[i]!;
        const f = folders[i]!;
        expect(value.ok, `${f.id}@${f.ref} query failed`).toBe(true);
        expect(ms).toBeLessThan(400);
        if (value.ok && 'matches' in value) {
          expect(value.matches.some((m) => m.qualifiedName === f.symbol)).toBe(true);
          for (const other of folders.filter((x) => x.id !== f.id)) {
            expect(value.matches.some((m) => m.qualifiedName === other.symbol)).toBe(false);
          }
        }
      }

      const slots = await vgdRequest({ op: 'list-graph-slots' }, { socketPath });
      expect(slots.ok && 'slots' in slots && slots.slots.length).toBe(3);
    } finally {
      await server.close();
    }
  });

  it('medium map (1k nodes) loads once and subsequent queries stay fast', async () => {
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const root = path.join(dir, 'xl');
    fs.mkdirSync(root);
    const graph = labelledGraph('MediumHub', 500); // 1000 nodes
    const graphPath = writeGraphFile(root, graph);
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
    try {
      const load = await timed(() =>
        vgdRequest({ op: 'load-graph', root, gitRef: 'main', graphPath }, { socketPath }),
      );
      expect(load.value.ok).toBe(true);
      expect(load.ms).toBeLessThan(5_000);
      if (!load.value.ok || !('stored' in load.value)) throw new Error('load-graph failed');
      expect(load.value.nodeCount).toBe(1000);
      const { repositoryId } = load.value;

      const first = await timed(() =>
        vgdRequest({ op: 'query-graph', repositoryId, query: 'MediumHub', limit: 5 }, { socketPath }),
      );
      const second = await timed(() =>
        vgdRequest({ op: 'query-graph', repositoryId, query: 'MediumHub', limit: 5 }, { socketPath }),
      );
      expect(first.value.ok && second.value.ok).toBe(true);
      expect(first.ms).toBeLessThan(800);
      expect(second.ms).toBeLessThan(400);
      // Warm query should not be slower than first by a large factor.
      expect(second.ms).toBeLessThan(first.ms * 3 + 50);

      const status = await vgdRequest({ op: 'status' }, { socketPath });
      expect(status.ok && 'memory' in status && status.memory).toBeTruthy();
      if (status.ok && 'memory' in status && status.memory) {
        expect(status.memory.graphSlots).toBe(1);
        // A 1k-node slot must not balloon into hundreds of MB of heap.
        expect(status.memory.heapUsed).toBeLessThan(400 * 1024 * 1024);
      }
    } finally {
      await server.close();
    }
  });

  it('repeated queries do not grow graph slot count (no leak)', async () => {
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
    try {
      await vgdRequest(
        { op: 'put-graph', repositoryId: 'r', gitRef: 'main', graph: labelledGraph('Stable', 6) },
        { socketPath },
      );
      const before = await vgdRequest({ op: 'status' }, { socketPath });
      const heapBefore = before.ok && 'memory' in before && before.memory ? before.memory.heapUsed : 0;
      for (let i = 0; i < 40; i++) {
        const q = await vgdRequest({ op: 'query-graph', repositoryId: 'r', query: 'Stable' }, { socketPath });
        expect(q.ok).toBe(true);
      }
      const after = await vgdRequest({ op: 'status' }, { socketPath });
      expect(after.ok && 'memory' in after && after.memory?.graphSlots).toBe(1);
      if (after.ok && 'memory' in after && after.memory && heapBefore) {
        // 40 queries must not leak tens of MB. Allow GC noise.
        expect(after.memory.heapUsed).toBeLessThan(heapBefore + 40 * 1024 * 1024);
      }
    } finally {
      await server.close();
    }
  });

  it('git checkout then ensure-graph serves the new ref (when git is available)', async function () {
    if (!gitAvailable()) return;
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const root = path.join(dir, 'repo');
    fs.mkdirSync(root);
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'vgd@test']);
    git(root, ['config', 'user.name', 'vgd']);
    fs.writeFileSync(path.join(root, 'README.md'), 'main\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'main']);
    git(root, ['checkout', '-b', 'feat']);
    fs.writeFileSync(path.join(root, 'README.md'), 'feat\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'feat']);
    git(root, ['checkout', 'main']);

    const mainPath = writeGraphFile(path.join(dir, 'main-g'), labelledGraph('GitMain', 2));
    const featPath = writeGraphFile(path.join(dir, 'feat-g'), labelledGraph('GitFeat', 2));

    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
    try {
      const mainLoad = await vgdRequest(
        { op: 'ensure-graph', root, gitRef: 'main', graphPath: mainPath },
        { socketPath },
      );
      expect(mainLoad.ok && 'stored' in mainLoad).toBe(true);
      if (!mainLoad.ok || !('stored' in mainLoad)) throw new Error('main ensure failed');
      const id = mainLoad.repositoryId;

      git(root, ['checkout', 'feat']);
      clearDetectGitRefCache(root);
      const featLoad = await timed(() =>
        vgdRequest({ op: 'ensure-graph', root, gitRef: 'feat', graphPath: featPath }, { socketPath }),
      );
      expect(featLoad.value.ok).toBe(true);
      expect(featLoad.ms).toBeLessThan(2_000);

      const q = await vgdRequest({ op: 'query-graph', repositoryId: id, gitRef: 'feat', query: 'GitFeat' }, { socketPath });
      expect(q.ok && 'matches' in q && q.matches.some((m) => m.qualifiedName === 'GitFeat')).toBe(true);
      const old = await vgdRequest(
        { op: 'query-graph', repositoryId: id, gitRef: 'main', query: 'GitMain' },
        { socketPath },
      );
      expect(old.ok && 'matches' in old && old.matches.some((m) => m.qualifiedName === 'GitMain')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('eight concurrent queries while a second repo loads stay correct', async () => {
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
    try {
      await vgdRequest(
        { op: 'put-graph', repositoryId: 'hot', gitRef: 'main', graph: labelledGraph('HotPath', 10) },
        { socketPath },
      );
      const root = path.join(dir, 'cold');
      fs.mkdirSync(root);
      const coldPath = writeGraphFile(root, labelledGraph('ColdPath', 80));

      const queries = Promise.all(
        Array.from({ length: 8 }, () =>
          vgdRequest({ op: 'query-graph', repositoryId: 'hot', query: 'HotPath', limit: 3 }, { socketPath }),
        ),
      );
      const load = vgdRequest({ op: 'load-graph', root, gitRef: 'main', graphPath: coldPath }, { socketPath });
      const [qs, loaded] = await Promise.all([queries, load]);
      expect(loaded.ok).toBe(true);
      for (const q of qs) {
        expect(q.ok).toBe(true);
        if (q.ok && 'matches' in q) {
          expect(q.matches.some((m) => m.qualifiedName === 'HotPath')).toBe(true);
          expect(q.matches.some((m) => m.qualifiedName === 'ColdPath')).toBe(false);
        }
      }
    } finally {
      await server.close();
    }
  });
});

describe('vgd surfaces — LSP, MCP, shared daemon, lifecycle', () => {
  async function boot() {
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
    const graph = labelledGraph('SurfaceHub', 4);
    const put = await vgdRequest(
      { op: 'put-graph', repositoryId: 'surf', gitRef: 'main', graph },
      { socketPath },
    );
    if (!put.ok || !('stored' in put)) throw new Error('put-graph failed');
    return { dir, socketPath, server, repositoryId: put.repositoryId, helper: 'SurfaceHubHelper1' };
  }

  it('every LSP graph-query mode answers without a local map copy', async () => {
    const { server, socketPath, repositoryId, helper } = await boot();
    try {
      const modes: Array<{ mode: string; extra?: Record<string, unknown> }> = [
        { mode: 'ask', extra: { question: 'SurfaceHub', semantic: false } },
        { mode: 'areas' },
        { mode: 'hubs' },
        { mode: 'impact', extra: { name: 'SurfaceHub' } },
        { mode: 'path', extra: { a: 'SurfaceHub', b: helper } },
        { mode: 'show', extra: { name: 'SurfaceHub' } },
        { mode: 'tree', extra: { name: 'SurfaceHub' } },
      ];
      for (const m of modes) {
        const res = await vgdRequest(
          { op: 'graph-query', repositoryId, gitRef: 'main', mode: m.mode, ...m.extra },
          { socketPath },
        );
        expect(res.ok, `graph-query ${m.mode} failed`).toBe(true);
        if (res.ok && 'result' in res) {
          const result = res.result as { ok?: boolean; mode?: string };
          expect(result.ok, `graph-query ${m.mode} result not ok`).toBe(true);
          expect(result.mode).toBe(m.mode);
        }
      }
    } finally {
      await server.close();
    }
  });

  it('MCP graph tools run inside vgd (run-tool) for the editor+Grok path', async () => {
    const { server, socketPath, repositoryId, helper, dir } = await boot();
    try {
      const root = path.join(dir, 'pkg');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'surf', version: '1.0.0' }));
      await vgdRequest({ op: 'register', root }, { socketPath });

      const tools: Array<{ name: string; args: Record<string, unknown> }> = [
        { name: 'orient', args: { question: 'SurfaceHub' } },
        { name: 'query_graph', args: { question: 'SurfaceHub', limit: 5 } },
        { name: 'get_node', args: { name: 'SurfaceHub' } },
        { name: 'find_path', args: { a: 'SurfaceHub', b: helper } },
        { name: 'impact_of', args: { name: 'SurfaceHub' } },
        { name: 'get_graph_summary', args: {} },
        { name: 'list_areas', args: { limit: 5 } },
        { name: 'list_hubs', args: { limit: 5 } },
        { name: 'tests_for', args: { name: 'SurfaceHub' } },
        { name: 'get_facts', args: { name: 'SurfaceHub' } },
        { name: 'list_models', args: {} },
      ];
      for (const t of tools) {
        const res = await vgdRequest(
          { op: 'run-tool', repositoryId, gitRef: 'main', name: t.name, args: t.args },
          { socketPath },
        );
        expect(res.ok, `run-tool ${t.name} failed: ${!res.ok ? res.error : ''}`).toBe(true);
        if (res.ok && 'result' in res) expect(res.result).toBeTruthy();
      }
    } finally {
      await server.close();
    }
  });

  it('VS Code query-graph and MCP run-tool share one daemon without mixing results', async () => {
    const { server, socketPath, repositoryId } = await boot();
    try {
      const [panel, mcp] = await Promise.all([
        vgdRequest(
          { op: 'query-graph', repositoryId, gitRef: 'main', query: 'SurfaceHub', semantic: true, limit: 5 },
          { socketPath },
        ),
        vgdRequest(
          { op: 'run-tool', repositoryId, gitRef: 'main', name: 'get_node', args: { name: 'SurfaceHub' } },
          { socketPath },
        ),
      ]);
      expect(panel.ok).toBe(true);
      expect(mcp.ok).toBe(true);
      if (panel.ok && 'mode' in panel) {
        // Index is cold — must still answer, lexically, not hang.
        expect(typeof panel.mode).toBe('string');
      }
      if (mcp.ok && 'result' in mcp) {
        const node = mcp.result as { name?: string };
        expect(node.name).toBe('SurfaceHub');
      }
    } finally {
      await server.close();
    }
  });

  it('watch-slots pushes after a republish so LSP/MCP can drop their local copy', async () => {
    const { server, socketPath, repositoryId } = await boot();
    const seen: string[] = [];
    const sub = await subscribeToSlots({
      socketPath,
      repositoryId,
      onChange: (c) => seen.push(`${c.gitRef}:${c.nodeCount}`),
    });
    try {
      expect(sub.active).toBe(true);
      await vgdRequest(
        { op: 'put-graph', repositoryId, gitRef: 'main', graph: labelledGraph('SurfaceHub', 8) },
        { socketPath },
      );
      const deadline = Date.now() + 1_000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((s) => s.startsWith('main:'))).toBe(true);
    } finally {
      sub.close();
      await server.close();
    }
  });

  it('unregister frees graph slots so a closed folder does not sit in memory', async () => {
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const root = path.join(dir, 'app');
    fs.mkdirSync(root);
    const graphPath = writeGraphFile(root, labelledGraph('LeaveMe', 3));
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
    try {
      const loaded = await vgdRequest({ op: 'load-graph', root, gitRef: 'main', graphPath }, { socketPath });
      expect(loaded.ok).toBe(true);
      const before = await vgdRequest({ op: 'list-graph-slots' }, { socketPath });
      expect(before.ok && 'slots' in before && before.slots.length).toBeGreaterThan(0);
      const gone = await vgdRequest({ op: 'unregister', root }, { socketPath });
      expect(gone.ok).toBe(true);
      const after = await vgdRequest({ op: 'list-graph-slots' }, { socketPath });
      expect(after.ok && 'slots' in after && after.slots.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('embed-index wait:false returns immediately; query-graph semantic stays lexical until ready', async () => {
    const { server, socketPath, repositoryId } = await boot();
    try {
      const kick = await timed(() =>
        vgdRequest({ op: 'embed-index', repositoryId, gitRef: 'main', wait: false }, { socketPath }),
      );
      expect(kick.value.ok).toBe(true);
      expect(kick.ms).toBeLessThan(500);
      const q = await vgdRequest(
        { op: 'query-graph', repositoryId, gitRef: 'main', query: 'SurfaceHub', semantic: true, limit: 5 },
        { socketPath },
      );
      expect(q.ok).toBe(true);
      if (q.ok && 'mode' in q) expect(q.mode).toMatch(/lexical|semantic/);
      if (q.ok && 'matches' in q) expect(q.matches.some((m) => m.qualifiedName === 'SurfaceHub')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('dep-context and federation register without requiring a local graph', async () => {
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const primary = path.join(dir, 'primary');
    const member = path.join(dir, 'member');
    fs.mkdirSync(primary);
    fs.mkdirSync(member);
    fs.writeFileSync(path.join(primary, 'package.json'), JSON.stringify({ name: 'primary', version: '1.0.0' }));
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
    try {
      const fed = await vgdRequest(
        {
          op: 'register-federation',
          primaryRoot: primary,
          members: [
            { root: primary, label: 'primary', role: 'primary' },
            { root: member, label: 'lib', role: 'member' },
          ],
        },
        { socketPath },
      );
      expect(fed.ok).toBe(true);
      if (fed.ok && 'workspaces' in fed && Array.isArray(fed.workspaces)) {
        expect(fed.workspaces.length).toBeGreaterThanOrEqual(2);
      }
      const list = await vgdRequest({ op: 'list' }, { socketPath });
      expect(list.ok && 'workspaces' in list && Array.isArray(list.workspaces) && list.workspaces.length).toBeGreaterThanOrEqual(2);
      const reg = await vgdRequest({ op: 'register', root: primary }, { socketPath });
      expect(reg.ok && 'workspace' in reg).toBe(true);
      if (reg.ok && 'workspace' in reg) {
        const deps = await vgdRequest({ op: 'dep-context', repositoryId: reg.workspace.id }, { socketPath });
        expect(deps.ok).toBe(true);
      }
    } finally {
      await server.close();
    }
  });

  it('a dead daemon fails queries instead of hanging the editor', async () => {
    const { server, socketPath, repositoryId } = await boot();
    await server.close();
    await expect(
      vgdRequest({ op: 'query-graph', repositoryId, query: 'SurfaceHub' }, { socketPath, timeoutMs: 1_000 }),
    ).rejects.toThrow();
  });
});

