/**
 * Live `vg serve` over InMemoryTransport against a real vgd.
 *
 * Graph tools must run inside the daemon (`run-tool`) — GraphSource.get() is
 * never used while attached. Graph-less tools (compress / memory) stay local.
 * `--no-daemon` still loads a local copy. A dead daemon resumes local freshness.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { attachGraphSource, createServer, GraphSource, type ServeOptions } from './server.js';
import { TOOLS } from './tools.js';
import { serializeGraph } from '../engine/serialize.js';
import { repositoryIdFromRoot } from '../runtime/paths.js';
import { attachVgd } from '../runtime/vgd/attach.js';
import { vgdRequest } from '../runtime/vgd/client.js';
import { subscribeToSlots } from '../runtime/vgd/slot-subscription.js';
import {
  labelledGraph,
  makeTmpTracker,
  namedVgdEnv,
  startTestVgd,
  until,
  writeMiniProject,
} from '../runtime/vgd/vgd-test-harness.js';

const t = makeTmpTracker();
afterEach(() => t.cleanup());

function payloadOf(result: unknown): { isError: boolean; data: unknown; text: string } {
  const r = (result ?? {}) as {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
  let data: unknown = r.structuredContent ?? text;
  if (typeof text === 'string' && text.startsWith('{')) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { isError: r.isError === true, data, text };
}

async function connectMcp(source: GraphSource, opts: ServeOptions = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(source, opts);
  const client = new Client({ name: 'vgd-serve-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    async close() {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

const GRAPH_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  orient: { question: 'AuthService' },
  search_symbols: { query: 'AuthService', limit: 8 },
  query_graph: { question: 'AuthService', limit: 5 },
  get_node: { name: 'AuthService' },
  find_path: { a: 'AuthService', b: 'AuthServiceHelper1' },
  impact_of: { name: 'AuthService' },
  cross_impact_of: { name: 'AuthService' },
  tests_for: { name: 'AuthService' },
  get_graph_summary: {},
  list_areas: { limit: 5 },
  list_hubs: { limit: 5 },
  get_facts: { name: 'AuthService' },
  guide_node: { name: 'AuthService' },
  check_drift: {},
  vuln_attribution: {},
  list_vulnerabilities: {},
  upgrade_impact: { package: 'left-pad' },
  list_models: {},
  resolve_library: { query: 'typescript' },
  library_docs: { targetId: 'typescript', query: 'compiler options' },
  assess_change: { file: 'src/AuthService/m0.ts', content: 'export function AuthService() { return 1; }\n' },
};

describe('vg serve + vgd — InMemoryTransport', () => {
  it('every listed graph tool has a live call in this suite', () => {
    const missing = TOOLS.map((tool) => tool.name).filter((name) => !GRAPH_TOOL_ARGS[name]);
    expect(missing, `add GRAPH_TOOL_ARGS for: ${missing.join(', ')}`).toEqual([]);
  });

  it('graph tools answer through vgd; GraphSource.get is never used while attached', async () => {
    const dir = t.tmp();
    const { server: vgd, socketPath } = await startTestVgd(dir);
    try {
      const root = path.join(dir, 'app');
      writeMiniProject(root, 'AuthService', 4);
      const graphPath = path.join(root, '.vibgrate', 'graph.json');
      const loaded = await vgdRequest(
        { op: 'load-graph', root, gitRef: 'main', graphPath },
        { socketPath },
      );
      expect(loaded.ok && 'stored' in loaded).toBe(true);
      if (!loaded.ok || !('stored' in loaded)) throw new Error('load-graph failed');

      const source = new GraphSource(graphPath, false, { root });
      const get = vi.spyOn(source, 'get');
      source.deferFreshnessToDaemon({
        repositoryId: loaded.repositoryId,
        gitRef: loaded.gitRef,
        socketPath,
      });

      const mcp = await connectMcp(source, { root, socketPath, local: true, daemon: true });
      try {
        const listed = await mcp.client.listTools();
        const listedNames = new Set(listed.tools.map((tool) => tool.name));
        for (const name of Object.keys(GRAPH_TOOL_ARGS)) {
          expect(listedNames.has(name), `tools/list omitted ${name}`).toBe(true);
        }

        const failures: string[] = [];
        for (const [name, args] of Object.entries(GRAPH_TOOL_ARGS)) {
          const raw = await mcp.client.callTool({ name, arguments: args });
          const { isError, data, text } = payloadOf(raw);
          if (isError) failures.push(`${name}: ${text}`);
          expect(data, `${name} returned nothing`).toBeTruthy();
        }
        expect(failures, failures.join('\n')).toEqual([]);
        expect(get).not.toHaveBeenCalled();
        await expect(source.get()).rejects.toThrow(/vgd owns this map/);
      } finally {
        await mcp.close();
      }
    } finally {
      await vgd.close();
    }
  });

  it('compress and memory tools stay local while the daemon owns the map', async () => {
    const dir = t.tmp();
    const { server: vgd, socketPath } = await startTestVgd(dir);
    try {
      const root = path.join(dir, 'app');
      writeMiniProject(root, 'LocalOnly', 2);
      const graphPath = path.join(root, '.vibgrate', 'graph.json');
      const loaded = await vgdRequest(
        { op: 'load-graph', root, gitRef: 'main', graphPath },
        { socketPath },
      );
      if (!loaded.ok || !('stored' in loaded)) throw new Error('load-graph failed');

      const source = new GraphSource(graphPath, false, { root });
      const get = vi.spyOn(source, 'get');
      source.deferFreshnessToDaemon({
        repositoryId: loaded.repositoryId,
        gitRef: loaded.gitRef,
        socketPath,
      });

      const mcp = await connectMcp(source, {
        root,
        socketPath,
        local: true,
        compressTools: true,
        memory: true,
      });
      try {
        const compress = payloadOf(
          await mcp.client.callTool({
            name: 'compress_content',
            arguments: { content: 'error: AuthService exploded\n'.repeat(40), query: 'AuthService' },
          }),
        );
        expect(compress.isError).toBe(false);
        expect(compress.text.length).toBeGreaterThan(0);

        const stats = payloadOf(await mcp.client.callTool({ name: 'compression_stats', arguments: {} }));
        expect(stats.isError).toBe(false);

        const saved = payloadOf(
          await mcp.client.callTool({
            name: 'memory_save',
            arguments: { facts: ['AuthService is the hub in this fixture'] },
          }),
        );
        expect(saved.isError).toBe(false);

        const found = payloadOf(
          await mcp.client.callTool({ name: 'memory_search', arguments: { query: 'AuthService' } }),
        );
        expect(found.isError).toBe(false);

        // Daemon only knows TOOLS — compress/memory are not run-tool names.
        const viaDaemon = await vgdRequest(
          { op: 'run-tool', repositoryId: loaded.repositoryId, name: 'compress_content', args: { content: 'x' } },
          { socketPath },
        );
        expect(viaDaemon.ok).toBe(false);
        if (!viaDaemon.ok) expect(viaDaemon.code).toBe('unknown_tool');

        expect(get).not.toHaveBeenCalled();
      } finally {
        await mcp.close();
      }
    } finally {
      await vgd.close();
    }
  });

  it('--no-daemon GraphSource still loads a local copy and answers tools', async () => {
    const dir = t.tmp();
    const root = path.join(dir, 'app');
    writeMiniProject(root, 'SoloMap', 3);
    const graphPath = path.join(root, '.vibgrate', 'graph.json');
    const source = new GraphSource(graphPath, false, { root });
    await attachGraphSource(source, { daemon: false, root, refresh: false, watch: false });
    expect(source.attachedDaemon).toBeNull();
    const graph = await source.get();
    expect(graph.nodes.some((n) => n.name === 'SoloMap')).toBe(true);

    const mcp = await connectMcp(source, { root, daemon: false, local: true });
    try {
      const node = payloadOf(await mcp.client.callTool({ name: 'get_node', arguments: { name: 'SoloMap' } }));
      expect(node.isError).toBe(false);
      expect(JSON.stringify(node.data)).toContain('SoloMap');
    } finally {
      await mcp.close();
    }
  });

  it('attachGraphSource against a live daemon drops the local copy', async () => {
    const dir = t.tmp();
    const { server: vgd, socketPath } = await startTestVgd(dir);
    try {
      const root = path.join(dir, 'app');
      writeMiniProject(root, 'Attached', 3);
      const graphPath = path.join(root, '.vibgrate', 'graph.json');
      const loaded = await vgdRequest(
        { op: 'load-graph', root, gitRef: 'main', graphPath },
        { socketPath },
      );
      expect(loaded.ok).toBe(true);
      const source = new GraphSource(graphPath, false, { root });

      const attached = await attachVgd(root, {
        socketPath,
        autoStart: false,
        publish: false,
        env: namedVgdEnv(),
      });
      expect(attached.status, JSON.stringify(attached)).toBe('attached');
      const ensured = await vgdRequest(
        { op: 'ensure-graph', root, graphPath, gitRef: 'main' },
        { socketPath, timeoutMs: 5_000 },
      );
      expect(ensured.ok && 'stored' in ensured, JSON.stringify(ensured)).toBe(true);
      if (!ensured.ok || !('stored' in ensured)) throw new Error('ensure-graph failed');
      const sub = await subscribeToSlots({
        socketPath,
        repositoryId: ensured.repositoryId,
        onChange: (change) => source.onDaemonSlotChanged(change),
        onDetach: () => source.resumeLocalFreshness(),
        readyMs: 3_000,
      });
      expect(sub.active).toBe(true);
      source.deferFreshnessToDaemon({
        repositoryId: ensured.repositoryId,
        gitRef: ensured.gitRef,
        socketPath,
      });

      expect(source.attachedDaemon).toBeTruthy();
      expect(source.attachedDaemon?.socketPath).toBe(socketPath);
      await expect(source.get()).rejects.toThrow(/vgd owns this map/);

      const mcp = await connectMcp(source, { root, socketPath, local: true });
      try {
        const summary = payloadOf(await mcp.client.callTool({ name: 'get_graph_summary', arguments: {} }));
        expect(summary.isError).toBe(false);
        expect(JSON.stringify(summary.data)).toMatch(/Attached|nodes|counts/i);
      } finally {
        sub.close();
        await mcp.close();
      }
    } finally {
      await vgd.close();
    }
  });

  it('a dead daemon resumes local freshness so GraphSource.get works again', async () => {
    const dir = t.tmp();
    const { server: vgd, socketPath } = await startTestVgd(dir);
    const root = path.join(dir, 'app');
    writeMiniProject(root, 'ResumeMe', 2);
    const graphPath = path.join(root, '.vibgrate', 'graph.json');
    const loaded = await vgdRequest({ op: 'load-graph', root, gitRef: 'main', graphPath }, { socketPath });
    if (!loaded.ok || !('stored' in loaded)) throw new Error('load-graph failed');
    const source = new GraphSource(graphPath, false, { root });
    const sub = await subscribeToSlots({
      socketPath,
      repositoryId: loaded.repositoryId,
      onChange: (change) => source.onDaemonSlotChanged(change),
      onDetach: () => source.resumeLocalFreshness(),
      readyMs: 3_000,
    });
    expect(sub.active).toBe(true);
    source.deferFreshnessToDaemon({
      repositoryId: loaded.repositoryId,
      gitRef: loaded.gitRef,
      socketPath,
    });
    expect(source.attachedDaemon).toBeTruthy();
    await vgd.close();
    const resumed = await until(() => source.attachedDaemon === null, 3_000);
    expect(resumed).toBe(true);
    const graph = await source.get();
    expect(graph.nodes.some((n) => n.name === 'ResumeMe')).toBe(true);
  });

  it('attachGraphSource production wrapper defers the map to a live daemon', async () => {
    const dir = t.tmp();
    const { server: vgd, socketPath } = await startTestVgd(dir);
    try {
      const root = path.join(dir, 'app');
      writeMiniProject(root, 'WrapperHub', 2);
      const graphPath = path.join(root, '.vibgrate', 'graph.json');
      await vgdRequest({ op: 'load-graph', root, gitRef: 'main', graphPath }, { socketPath });
      const source = new GraphSource(graphPath, false, { root });
      await attachGraphSource(source, {
        root,
        socketPath,
        daemon: true,
        refresh: false,
        watch: false,
      });
      expect(source.attachedDaemon).toBeTruthy();
      await expect(source.get()).rejects.toThrow(/vgd owns this map/);
    } finally {
      await vgd.close();
    }
  });

  it('two MCP clients on two folders do not mix symbols', async () => {
    const dir = t.tmp();
    const { server: vgd, socketPath } = await startTestVgd(dir);
    try {
      const pay = path.join(dir, 'pay');
      const auth = path.join(dir, 'auth');
      writeMiniProject(pay, 'ChargeCard', 3);
      writeMiniProject(auth, 'VerifyToken', 3);
      const payLoad = await vgdRequest(
        { op: 'load-graph', root: pay, gitRef: 'main', graphPath: path.join(pay, '.vibgrate', 'graph.json') },
        { socketPath },
      );
      const authLoad = await vgdRequest(
        { op: 'load-graph', root: auth, gitRef: 'main', graphPath: path.join(auth, '.vibgrate', 'graph.json') },
        { socketPath },
      );
      if (!payLoad.ok || !('stored' in payLoad) || !authLoad.ok || !('stored' in authLoad)) {
        throw new Error('load-graph failed');
      }

      const paySource = new GraphSource(path.join(pay, '.vibgrate', 'graph.json'), false, { root: pay });
      const authSource = new GraphSource(path.join(auth, '.vibgrate', 'graph.json'), false, { root: auth });
      paySource.deferFreshnessToDaemon({
        repositoryId: payLoad.repositoryId,
        gitRef: 'main',
        socketPath,
      });
      authSource.deferFreshnessToDaemon({
        repositoryId: authLoad.repositoryId,
        gitRef: 'main',
        socketPath,
      });

      const payMcp = await connectMcp(paySource, { root: pay, socketPath, local: true });
      const authMcp = await connectMcp(authSource, { root: auth, socketPath, local: true });
      try {
        const [payHit, authHit] = await Promise.all([
          payMcp.client.callTool({ name: 'get_node', arguments: { name: 'ChargeCard' } }),
          authMcp.client.callTool({ name: 'get_node', arguments: { name: 'VerifyToken' } }),
        ]);
        const payData = JSON.stringify(payloadOf(payHit).data);
        const authData = JSON.stringify(payloadOf(authHit).data);
        expect(payData).toContain('ChargeCard');
        expect(payData).not.toContain('VerifyToken');
        expect(authData).toContain('VerifyToken');
        expect(authData).not.toContain('ChargeCard');
      } finally {
        await payMcp.close();
        await authMcp.close();
      }
    } finally {
      await vgd.close();
    }
  });

  it('cross_impact_of and assess_change run via the MCP client against federated maps in vgd', async () => {
    const dir = t.tmp();
    const { server: vgd, socketPath } = await startTestVgd(dir);
    try {
      const home = path.join(dir, 'home');
      const member = path.join(dir, 'member');
      writeMiniProject(home, 'CollectMandate', 3);
      fs.mkdirSync(path.join(member, '.vibgrate'), { recursive: true });
      const memberGraph = labelledGraph('CollectMandate', 2);
      // Member uses the same symbol name so the cross-repo hop is visible.
      memberGraph.nodes = memberGraph.nodes.map((n) =>
        n.name === 'CollectMandate' ? { ...n, file: 'src/billing/wrapper.ts', qualifiedName: 'src/billing/wrapper.ts:CollectMandate' } : n,
      );
      fs.writeFileSync(path.join(member, '.vibgrate', 'graph.json'), serializeGraph(memberGraph));
      fs.writeFileSync(path.join(member, 'package.json'), JSON.stringify({ name: 'member-b', version: '1.0.0' }));

      const homeId = repositoryIdFromRoot(home);
      const memberId = repositoryIdFromRoot(member);
      fs.writeFileSync(
        path.join(home, '.vibgrate', 'federation.json'),
        JSON.stringify({
          schemaVersion: 'federation/0',
          members: [
            { root: '.', role: 'primary' },
            { root: '../member', label: 'member-b' },
          ],
          bridges: [
            {
              schemaVersion: 'bridge-edge/0',
              fromRepositoryId: memberId,
              toRepositoryId: homeId,
              fromRoot: member,
              toRoot: home,
              kind: 'package-dependency',
              confidence: 0.9,
              evidence: 'member-b depends on home@workspace:*',
              packageName: 'home',
            },
          ],
        }),
      );

      await vgdRequest(
        {
          op: 'register-federation',
          primaryRoot: home,
          members: [
            { root: home, label: 'home', role: 'primary' },
            { root: member, label: 'member-b', role: 'member' },
          ],
        },
        { socketPath },
      );
      const homeLoad = await vgdRequest(
        { op: 'load-graph', root: home, gitRef: 'main', graphPath: path.join(home, '.vibgrate', 'graph.json') },
        { socketPath },
      );
      const memberLoad = await vgdRequest(
        { op: 'load-graph', root: member, gitRef: 'main', graphPath: path.join(member, '.vibgrate', 'graph.json') },
        { socketPath },
      );
      expect(homeLoad.ok && memberLoad.ok).toBe(true);
      if (!homeLoad.ok || !('stored' in homeLoad)) throw new Error('home load failed');

      const source = new GraphSource(path.join(home, '.vibgrate', 'graph.json'), false, { root: home });
      source.deferFreshnessToDaemon({
        repositoryId: homeLoad.repositoryId,
        gitRef: homeLoad.gitRef,
        socketPath,
      });
      const mcp = await connectMcp(source, { root: home, socketPath, local: true });
      try {
        const cross = payloadOf(
          await mcp.client.callTool({ name: 'cross_impact_of', arguments: { name: 'CollectMandate' } }),
        );
        expect(cross.isError).toBe(false);
        const crossObj = cross.data as {
          federation?: { consumingMembers?: number };
          crossRepo?: Array<{ member?: string; matches?: unknown[] }>;
        };
        expect(crossObj.federation?.consumingMembers).toBe(1);
        expect(crossObj.crossRepo?.[0]?.member).toBe('member-b');
        expect((crossObj.crossRepo?.[0]?.matches ?? []).length).toBeGreaterThan(0);

        const assess = payloadOf(
          await mcp.client.callTool({
            name: 'assess_change',
            arguments: {
              file: 'src/CollectMandate/m0.ts',
              content: 'export function CollectMandate() { return "ok"; }\n',
            },
          }),
        );
        expect(assess.isError).toBe(false);
        expect(assess.data).toMatchObject({ status: expect.stringMatching(/ok|partial|no_baseline/) });
      } finally {
        await mcp.close();
      }
    } finally {
      await vgd.close();
    }
  });

  it('unknown MCP tool is an actionable error, not a hang', async () => {
    const dir = t.tmp();
    const root = path.join(dir, 'app');
    writeMiniProject(root, 'Nope', 1);
    const source = new GraphSource(path.join(root, '.vibgrate', 'graph.json'), false, { root });
    await attachGraphSource(source, { daemon: false, root, refresh: false, watch: false });
    const mcp = await connectMcp(source, { root, daemon: false, local: true });
    try {
      const raw = await mcp.client.callTool({ name: 'definitely_not_a_tool', arguments: {} });
      const { isError, text } = payloadOf(raw);
      expect(isError).toBe(true);
      expect(text).toMatch(/unknown tool/i);
    } finally {
      await mcp.close();
    }
  });
});
