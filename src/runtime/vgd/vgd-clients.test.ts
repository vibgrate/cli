/**
 * Live attach / vg code backend / host broker / freshness / pipe coverage
 * against a real vgd — the surfaces that are not MCP or LSP themselves.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attachVgd } from './attach.js';
import { vgdIsRunning, vgdRequest } from './client.js';
import { vgdSocketPath } from './paths.js';
import { FreshnessSupervisor } from './freshness.js';
import { VgdHostBroker } from './host-broker.js';
import { WorkspaceRegistry } from './registry.js';
import { loadGraph } from '../../engine/load.js';
import { vgdGraphBackend } from '../../code/graph-backend.js';
import {
  labelledGraph,
  makeTmpTracker,
  namedVgdEnv,
  startTestVgd,
  until,
  writeInRepoGraph,
  writeMiniProject,
} from './vgd-test-harness.js';

const t = makeTmpTracker();
afterEach(() => t.cleanup());

function fakeHostLib(reply = 'host-ok') {
  return {
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}) }),
      }),
    }),
    LlamaChatSession: class {
      async prompt() {
        return reply;
      }
    },
  };
}

describe('attachVgd + vgdGraphBackend against a live daemon', () => {
  it('attachVgd publishes the on-disk map and answers query-graph', async () => {
    const dir = t.tmp();
    const { server, socketPath } = await startTestVgd(dir);
    try {
      const root = path.join(dir, 'app');
      writeMiniProject(root, 'PublishMe', 3);
      const attached = await attachVgd(root, {
        socketPath,
        autoStart: false,
        publish: true,
        env: namedVgdEnv(),
        graphPath: path.join(root, '.vibgrate', 'graph.json'),
      });
      expect(attached.status).toBe('attached');
      expect(attached.socketPath).toBe(socketPath);
      expect(attached.repositoryId).toBeTruthy();
      expect(attached.published?.status).toMatch(/published|current/);

      const running = await vgdIsRunning({ socketPath });
      expect(running).toBe(true);

      const q = await vgdRequest(
        {
          op: 'query-graph',
          repositoryId: attached.repositoryId!,
          gitRef: attached.gitRef,
          query: 'PublishMe',
        },
        { socketPath },
      );
      expect(q.ok && 'matches' in q && q.matches.some((m) => m.qualifiedName === 'PublishMe')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('vgdGraphBackend search and impact report source vgd, not a local copy', async () => {
    const dir = t.tmp();
    const { server, socketPath } = await startTestVgd(dir);
    try {
      const root = path.join(dir, 'app');
      writeMiniProject(root, 'BackendHub', 4);
      const loaded = await vgdRequest(
        { op: 'load-graph', root, gitRef: 'main', graphPath: path.join(root, '.vibgrate', 'graph.json') },
        { socketPath },
      );
      if (!loaded.ok || !('stored' in loaded)) throw new Error('load-graph failed');
      const backend = vgdGraphBackend({
        repositoryId: loaded.repositoryId,
        gitRef: loaded.gitRef,
        socketPath,
      });
      expect(backend.source).toBe('vgd');
      const search = await backend.search('BackendHub', { limit: 5 });
      expect(search.source).toBe('vgd');
      expect(search.matches.some((m) => m.qualifiedName === 'BackendHub')).toBe(true);

      // Incoming dependents: the hub calls the helper, so changing the helper
      // is what has blast radius. An empty "nothing depends on the hub" is
      // honest, not a miss.
      const hubImpact = await backend.impact('BackendHub', { depth: 3 });
      expect(hubImpact).not.toBeNull();
      expect(hubImpact!.source).toBe('vgd');
      expect(hubImpact!.root.name).toBe('BackendHub');

      const helperImpact = await backend.impact('BackendHubHelper1', { depth: 3 });
      expect(helperImpact).not.toBeNull();
      expect(helperImpact!.source).toBe('vgd');
      expect(helperImpact!.affected.some((a) => a.name === 'BackendHub' || a.id.includes('BackendHub'))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('vgdGraphBackend with no local fallback returns empty when the daemon is dead, and does not hang', async () => {
    const dir = t.tmp();
    const { server, socketPath } = await startTestVgd(dir);
    const root = path.join(dir, 'app');
    writeMiniProject(root, 'DeadBackend', 2);
    const loaded = await vgdRequest(
      { op: 'load-graph', root, gitRef: 'main', graphPath: path.join(root, '.vibgrate', 'graph.json') },
      { socketPath },
    );
    if (!loaded.ok || !('stored' in loaded)) throw new Error('load-graph failed');
    const backend = vgdGraphBackend({
      repositoryId: loaded.repositoryId,
      gitRef: loaded.gitRef,
      socketPath,
    });
    await server.close();
    const search = await backend.search('DeadBackend');
    expect(search.source).toBe('vgd');
    expect(search.matches).toEqual([]);
    const impact = await backend.impact('DeadBackend');
    expect(impact).toBeNull();
  });
});

describe('host broker over the vgd protocol', () => {
  it('host-load / host-status / host-generate / host-unload round-trip', async () => {
    const dir = t.tmp();
    const hostBroker = new VgdHostBroker();
    hostBroker.setBinding(fakeHostLib('generated-from-vgd'));
    const { server, socketPath } = await startTestVgd(dir, { hostBroker });
    try {
      const status0 = await vgdRequest({ op: 'host-status' }, { socketPath });
      expect(status0.ok && 'host' in status0 && status0.host.bindingReady).toBe(true);

      const loaded = await vgdRequest({ op: 'host-load', modelPath: '/models/test.gguf' }, { socketPath });
      expect(loaded.ok).toBe(true);
      if (loaded.ok && 'hostLoaded' in loaded) {
        expect(loaded.hostLoaded).toBe(true);
        expect(loaded.modelPath).toBe('/models/test.gguf');
      }

      const gen = await vgdRequest(
        {
          op: 'host-generate',
          modelPath: '/models/test.gguf',
          messages: [{ role: 'user', content: 'hi' }],
        },
        { socketPath },
      );
      expect(gen.ok).toBe(true);
      if (gen.ok && 'text' in gen) expect(gen.text).toBe('generated-from-vgd');

      const unloaded = await vgdRequest({ op: 'host-unload', modelPath: '/models/test.gguf' }, { socketPath });
      expect(unloaded.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('host-load without a binding is an actionable host_error', async () => {
    const dir = t.tmp();
    const { server, socketPath } = await startTestVgd(dir, { hostBroker: new VgdHostBroker() });
    try {
      const loaded = await vgdRequest({ op: 'host-load', modelPath: '/models/missing.gguf' }, { socketPath });
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.code).toBe('host_error');
        expect(loaded.error).toMatch(/binding/i);
      }
    } finally {
      await server.close();
    }
  });
});

describe('freshness: disk change then query', () => {
  it('load-graph reloads when the on-disk map is newer than the slot', async () => {
    const dir = t.tmp();
    const { server, socketPath } = await startTestVgd(dir);
    try {
      const root = path.join(dir, 'app');
      writeMiniProject(root, 'BeforeBump', 2);
      const graphPath = path.join(root, '.vibgrate', 'graph.json');
      const first = await vgdRequest({ op: 'load-graph', root, gitRef: 'main', graphPath }, { socketPath });
      expect(first.ok && 'stored' in first && first.alreadyHeld !== true).toBe(true);
      if (!first.ok || !('stored' in first)) throw new Error('first load failed');

      const before = await vgdRequest(
        { op: 'query-graph', repositoryId: first.repositoryId, gitRef: 'main', query: 'BeforeBump' },
        { socketPath },
      );
      expect(before.ok && 'matches' in before && before.matches.some((m) => m.qualifiedName === 'BeforeBump')).toBe(true);

      writeInRepoGraph(root, labelledGraph('AfterBump', 2));
      const future = new Date(Date.now() + 2_000);
      fs.utimesSync(graphPath, future, future);

      const second = await vgdRequest({ op: 'load-graph', root, gitRef: 'main', graphPath }, { socketPath });
      expect(second.ok).toBe(true);
      if (second.ok && 'alreadyHeld' in second) expect(second.alreadyHeld).not.toBe(true);

      const after = await vgdRequest(
        { op: 'query-graph', repositoryId: first.repositoryId, gitRef: 'main', query: 'AfterBump' },
        { socketPath },
      );
      expect(after.ok && 'matches' in after && after.matches.some((m) => m.qualifiedName === 'AfterBump')).toBe(true);
      const stale = await vgdRequest(
        { op: 'query-graph', repositoryId: first.repositoryId, gitRef: 'main', query: 'BeforeBump' },
        { socketPath },
      );
      expect(stale.ok && 'matches' in stale && stale.matches.some((m) => m.qualifiedName === 'BeforeBump')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('ensure-graph with no map rebuilds in a child then answers', async () => {
    const dir = t.tmp();
    const root = path.join(dir, 'app');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'rebuilt', version: '1.0.0' }));
    const { server, socketPath } = await startTestVgd(dir, {
      rebuild: async (rebuildRoot) => {
        writeInRepoGraph(rebuildRoot, labelledGraph('RebuiltHub', 3));
        return { ok: true };
      },
    });
    try {
      const ensured = await vgdRequest({ op: 'ensure-graph', root, gitRef: 'main' }, { socketPath });
      expect(ensured.ok).toBe(true);
      if (!ensured.ok || !('stored' in ensured)) throw new Error('ensure-graph failed');
      expect(ensured.rebuilt).toBe(true);
      const q = await vgdRequest(
        { op: 'query-graph', repositoryId: ensured.repositoryId, gitRef: 'main', query: 'RebuiltHub' },
        { socketPath },
      );
      expect(q.ok && 'matches' in q && q.matches.some((m) => m.qualifiedName === 'RebuiltHub')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('a source edit triggers rebuild+reload; the next query sees the new map', async () => {
    const dir = t.tmp();
    const root = path.join(dir, 'app');
    writeMiniProject(root, 'FreshBefore', 2);
    const registry = new WorkspaceRegistry();
    let fire: (filename: string) => void = () => {};
    const freshness = new FreshnessSupervisor({
      settleMs: 15,
      minRebuildGapMs: 0,
      reload: async (repositoryId, reloadRoot, gitRef) => {
        const graph = loadGraph(reloadRoot);
        if (!graph) return null;
        registry.putGraph(repositoryId, gitRef, graph);
        return graph.nodes?.length ?? 0;
      },
      select: (repositoryId, gitRef) => registry.selectGitRef(repositoryId, gitRef),
      watch: (_d, onChange) => {
        fire = onChange;
        return { close() {} };
      },
      rebuild: async (rebuildRoot) => {
        writeInRepoGraph(rebuildRoot, labelledGraph('FreshAfter', 3));
        return { ok: true };
      },
    });
    const { server, socketPath } = await startTestVgd(dir, { registry, freshness, watch: true });
    try {
      const loaded = await vgdRequest(
        { op: 'load-graph', root, gitRef: 'main', graphPath: path.join(root, '.vibgrate', 'graph.json') },
        { socketPath },
      );
      if (!loaded.ok || !('stored' in loaded)) throw new Error('load-graph failed');
      fire('src/FreshBefore/m0.ts');
      const swapped = await until(async () => {
        const q = await vgdRequest(
          { op: 'query-graph', repositoryId: loaded.repositoryId, gitRef: 'main', query: 'FreshAfter' },
          { socketPath },
        );
        return q.ok && 'matches' in q && q.matches.some((m) => m.qualifiedName === 'FreshAfter');
      }, 4_000);
      expect(swapped).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe('protocol edges', () => {
  it('unknown run-tool name is unknown_tool, not a hang', async () => {
    const dir = t.tmp();
    const { server, socketPath } = await startTestVgd(dir);
    try {
      const put = await vgdRequest(
        { op: 'put-graph', repositoryId: 'r', gitRef: 'main', graph: labelledGraph('X', 1) },
        { socketPath },
      );
      expect(put.ok).toBe(true);
      const res = await vgdRequest(
        { op: 'run-tool', repositoryId: 'r', gitRef: 'main', name: 'not_a_tool', args: {} },
        { socketPath },
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('unknown_tool');
        expect(res.error).toMatch(/not_a_tool/);
      }
    } finally {
      await server.close();
    }
  });

  it('status.memory tracks slots across two concurrent clients', async () => {
    const dir = t.tmp();
    const { server, socketPath } = await startTestVgd(dir);
    try {
      await Promise.all([
        vgdRequest({ op: 'put-graph', repositoryId: 'a', gitRef: 'main', graph: labelledGraph('Aaa', 2) }, { socketPath }),
        vgdRequest({ op: 'put-graph', repositoryId: 'b', gitRef: 'feat', graph: labelledGraph('Bbb', 2) }, { socketPath }),
      ]);
      const [qa, qb] = await Promise.all([
        vgdRequest({ op: 'query-graph', repositoryId: 'a', gitRef: 'main', query: 'Aaa' }, { socketPath }),
        vgdRequest({ op: 'run-tool', repositoryId: 'b', gitRef: 'feat', name: 'get_node', args: { name: 'Bbb' } }, { socketPath }),
      ]);
      expect(qa.ok).toBe(true);
      expect(qb.ok).toBe(true);
      if (qa.ok && 'matches' in qa) expect(qa.matches.some((m) => m.qualifiedName === 'Aaa')).toBe(true);
      if (qb.ok && 'result' in qb) expect((qb.result as { name?: string }).name).toBe('Bbb');
      const status = await vgdRequest({ op: 'status' }, { socketPath });
      expect(status.ok && 'memory' in status && status.memory?.graphSlots).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('vgdSocketPath on Windows is a named pipe; live pipe round-trip runs on win32', async () => {
    expect(vgdSocketPath({}, 'win32')).toMatch(/pipe/i);
    if (process.platform !== 'win32') return;
    const pipe = `\\\\.\\pipe\\vibgrate-vgd-test-${process.pid}`;
    const dir = t.tmp();
    const { server } = await startTestVgd(dir, { socketPath: pipe });
    try {
      const ping = await vgdRequest({ op: 'ping' }, { socketPath: pipe });
      expect(ping.ok).toBe(true);
    } finally {
      await server.close();
    }
  });
});
