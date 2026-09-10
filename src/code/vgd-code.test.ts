/**
 * VG Code against a live vgd: ensureCodeMap, search_code, graph_impact,
 * inspect_change, list_files, and a branch switch. The agent tools must
 * report `via vgd` for search/impact when the daemon holds the slot — not a
 * second in-process map.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeTool, type ToolContext } from './tools.js';
import { ensureCodeMap } from './ensure-map.js';
import { vgdGraphBackend } from './graph-backend.js';
import { inspectChange } from './inspect-change.js';
import type { CodeFs } from './session.js';
import type { ToolCall } from './types.js';
import type { VgGraph } from '../schema.js';
import { SCHEMA_VERSION } from '../schema.js';
import { vgdRequest } from '../runtime/vgd/client.js';
import {
  labelledGraph,
  makeTmpTracker,
  startTestVgd,
  writeMiniProject,
} from '../runtime/vgd/vgd-test-harness.js';

const t = makeTmpTracker();
afterEach(() => t.cleanup());

const EMPTY_GRAPH: VgGraph = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: '1970-01-01T00:00:00.000Z',
  provenance: { tool: 'vg', version: '0.0.0-test', grammars: {}, resolver: [], deep: false, corpusHash: 'empty' },
  meta: { root: '.', languages: ['ts'], counts: { nodes: 0, edges: 0, areas: 0, tests: 0, untested: 0 }, cluster: 'none', edgeKinds: [] },
  nodes: [],
  edges: [],
  areas: [],
};

function memFs(): CodeFs {
  return {
    read: () => null,
    write: () => {},
    remove: () => {},
    appendAudit: () => {},
  };
}

function ctx(over: Partial<ToolContext>): ToolContext {
  return {
    root: '/repo',
    graph: EMPTY_GRAPH,
    fsImpl: memFs(),
    spans: new Map(),
    run: () => ({ stdout: '', exitCode: 0 }),
    approve: async () => true,
    ...over,
  };
}

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: 'c1', name, arguments: args });

describe('VG Code + live vgd', () => {
  it('ensureCodeMap asks the daemon to build — never runBuild in-process', async () => {
    const dir = t.tmp();
    const root = path.join(dir, 'app');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
    const { server, socketPath } = await startTestVgd(dir, {
      rebuild: async (rebuildRoot) => {
        writeMiniProject(rebuildRoot, 'EnsureHub', 3);
        return { ok: true };
      },
    });
    try {
      const phases: string[] = [];
      const status = await ensureCodeMap(root, { daemon: true }, {
        socketPath,
        onProgress: (p) => phases.push(p.phase),
      });
      expect(status).toBe('built');
      expect(phases).toEqual(['start', 'done']);
      const q = await vgdRequest({ op: 'query-graph', repositoryId: 'x', query: 'EnsureHub' }, { socketPath }).catch(() => null);
      // Slot is keyed by repository id from the root — query via list.
      const slots = await vgdRequest({ op: 'list-graph-slots' }, { socketPath });
      expect(slots.ok && 'slots' in slots && slots.slots.length).toBeGreaterThan(0);
      void q;
    } finally {
      await server.close();
    }
  });

  it('graph_impact and search_code answer via vgd, not an empty local copy', async () => {
    const dir = t.tmp();
    const { server, socketPath } = await startTestVgd(dir);
    try {
      const emptyRoot = path.join(dir, 'empty');
      fs.mkdirSync(emptyRoot);
      await vgdRequest(
        { op: 'put-graph', repositoryId: 'code', gitRef: 'main', graph: labelledGraph('CodeHub', 4) },
        { socketPath },
      );
      const backend = vgdGraphBackend({
        repositoryId: 'code',
        gitRef: 'main',
        socketPath,
      });
      const toolCtx = ctx({ root: emptyRoot, graphBackend: backend, graph: EMPTY_GRAPH });

      const impact = await executeTool(call('graph_impact', { symbol: 'CodeHubHelper1' }), toolCtx);
      expect(impact.content).toMatch(/via vgd/);
      expect(impact.content).toMatch(/CodeHub/);

      const aliased = await executeTool(call('impact_of', { name: 'CodeHubHelper1' }), toolCtx);
      expect(aliased.content).toMatch(/via vgd/);

      const search = await executeTool(call('search_code', { query: 'CodeHub' }), toolCtx);
      expect(search.content).toMatch(/CodeHub/);
      expect(search.content).toMatch(/via vgd/);
    } finally {
      await server.close();
    }
  });

  it('list_files and inspect_change still work for the coding session overlay', async () => {
    const dir = t.tmp();
    const graph = labelledGraph('OverlayHub', 3);
    const listed = await executeTool(call('list_files', {}), ctx({ graph }));
    expect(listed.content).toMatch(/OverlayHub/);

    const inspected = inspectChange(graph, { symbols: ['OverlayHubHelper1'] });
    expect(inspected.roots.length).toBeGreaterThan(0);
    expect(inspected.affected.some((a) => a.name === 'OverlayHub' || a.id.includes('OverlayHub'))).toBe(true);
  });

  it('after select-git-ref, graph_impact uses the new branch and not the old hub', async () => {
    const dir = t.tmp();
    const { server, socketPath } = await startTestVgd(dir);
    try {
      await vgdRequest(
        { op: 'put-graph', repositoryId: 'code', gitRef: 'main', graph: labelledGraph('OnMain', 3) },
        { socketPath },
      );
      await vgdRequest(
        { op: 'put-graph', repositoryId: 'code', gitRef: 'feat', graph: labelledGraph('OnFeat', 3) },
        { socketPath },
      );
      await vgdRequest({ op: 'select-git-ref', repositoryId: 'code', gitRef: 'feat' }, { socketPath });

      const backend = vgdGraphBackend({ repositoryId: 'code', gitRef: 'feat', socketPath });
      const toolCtx = ctx({ graphBackend: backend });
      const feat = await executeTool(call('graph_impact', { symbol: 'OnFeatHelper1' }), toolCtx);
      expect(feat.content).toMatch(/via vgd/);
      expect(feat.content).toMatch(/OnFeat/);
      expect(feat.content).not.toMatch(/OnMain/);

      const mainBackend = vgdGraphBackend({ repositoryId: 'code', gitRef: 'main', socketPath });
      const mainHit = await executeTool(
        call('graph_impact', { symbol: 'OnMainHelper1' }),
        ctx({ graphBackend: mainBackend }),
      );
      expect(mainHit.content).toMatch(/OnMain/);
      expect(mainHit.content).not.toMatch(/OnFeat/);
    } finally {
      await server.close();
    }
  });
});

