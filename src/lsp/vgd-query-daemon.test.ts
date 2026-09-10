/**
 * Drive `VibgrateLanguageServer` over PassThrough streams against a live vgd.
 * The editor path is initialize → initialized → vibgrate/graph/query; while
 * attached, every mode is answered inside the daemon, not from a local copy.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VibgrateLanguageServer } from './server.js';
import { MessageReader, type RpcMessage } from './protocol.js';
import { createServer, GraphSource } from '../mcp/server.js';
import { vgdRequest } from '../runtime/vgd/client.js';
import {
  makeTmpTracker,
  startTestVgd,
  until,
  writeMiniProject,
} from '../runtime/vgd/vgd-test-harness.js';

const t = makeTmpTracker();
afterEach(() => t.cleanup());

function frame(msg: object): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

class LspHarness {
  private nextId = 0;
  private readonly pending = new Map<number | string, (msg: RpcMessage) => void>();
  readonly notes: RpcMessage[] = [];
  readonly input = new PassThrough();
  readonly output = new PassThrough();

  constructor() {
    const reader = new MessageReader();
    this.output.on('data', (chunk: Buffer) => {
      for (const msg of reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        if (msg.id !== undefined && msg.id !== null) {
          this.pending.get(msg.id)?.(msg);
          this.pending.delete(msg.id);
        } else {
          this.notes.push(msg);
        }
      }
    });
  }

  request(method: string, params?: unknown, timeoutMs = 15_000): Promise<RpcMessage> {
    const id = ++this.nextId;
    this.input.write(frame({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`lsp ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.input.write(frame({ jsonrpc: '2.0', method, params }));
  }

  async shutdown(): Promise<void> {
    try {
      await this.request('shutdown', undefined, 5_000);
    } catch {
      /* server may already be idle */
    }
    this.input.end();
    this.output.end();
  }
}

function graphStatus(notes: RpcMessage[]): string | undefined {
  const last = [...notes].reverse().find((n) => n.method === 'vibgrate/graph/status');
  const params = last?.params as { state?: string } | undefined;
  return params?.state;
}

describe('vg lsp + vgd — PassThrough', () => {
  it('initialize then every graph-query mode answers via the daemon', async () => {
    const dir = t.tmp();
    const { server: vgd, socketPath } = await startTestVgd(dir);
    try {
      const root = path.join(dir, 'app');
      const { helper } = writeMiniProject(root, 'SurfaceHub', 4);
      await vgdRequest(
        { op: 'load-graph', root, gitRef: 'main', graphPath: path.join(root, '.vibgrate', 'graph.json') },
        { socketPath },
      );

      const lsp = new LspHarness();
      new VibgrateLanguageServer(
        {
          root,
          offline: true,
          diagnostics: false,
          graph: true,
          semantic: false,
          daemon: true,
          socketPath,
        },
        lsp.output,
        lsp.input,
      );

      const init = await lsp.request('initialize', {
        processId: null,
        rootUri: `file://${root}`,
        capabilities: {},
      });
      expect(init.error).toBeUndefined();
      expect(init.result).toMatchObject({ capabilities: expect.any(Object) });
      lsp.notify('initialized', {});

      const ready = await until(() => graphStatus(lsp.notes) === 'ready', 8_000);
      expect(ready, `graph status was ${graphStatus(lsp.notes)}`).toBe(true);

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
        const res = await lsp.request('vibgrate/graph/query', { mode: m.mode, ...m.extra });
        expect(res.error, `lsp ${m.mode}: ${res.error?.message}`).toBeUndefined();
        const result = res.result as { ok?: boolean; mode?: string };
        expect(result.ok, `lsp ${m.mode} not ok: ${JSON.stringify(res.result)}`).toBe(true);
        expect(result.mode).toBe(m.mode);
      }
      await lsp.shutdown();
    } finally {
      await vgd.close();
    }
  });

  it('--no-daemon LSP answers graph-query from the local map', async () => {
    const dir = t.tmp();
    const root = path.join(dir, 'app');
    writeMiniProject(root, 'LocalLsp', 3);
    const lsp = new LspHarness();
    new VibgrateLanguageServer(
      {
        root,
        offline: true,
        diagnostics: false,
        graph: true,
        semantic: false,
        daemon: false,
      },
      lsp.output,
      lsp.input,
    );
    await lsp.request('initialize', { processId: null, rootUri: `file://${root}`, capabilities: {} });
    lsp.notify('initialized', {});
    await until(() => graphStatus(lsp.notes) === 'ready' || graphStatus(lsp.notes) === 'error', 8_000);
    const ask = await lsp.request('vibgrate/graph/query', {
      mode: 'ask',
      question: 'LocalLsp',
      semantic: false,
    });
    expect(ask.error).toBeUndefined();
    const result = ask.result as { ok?: boolean; mode?: string; data?: { matches?: Array<{ name?: string }> } };
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('ask');
    expect(result.data?.matches?.some((m) => String(m.name).includes('LocalLsp'))).toBe(true);
    await lsp.shutdown();
  });

  it('LSP graph-query and MCP run-tool share one daemon without mixing results', async () => {
    const dir = t.tmp();
    const { server: vgd, socketPath } = await startTestVgd(dir);
    try {
      const root = path.join(dir, 'app');
      writeMiniProject(root, 'SharedHub', 4);
      const loaded = await vgdRequest(
        { op: 'load-graph', root, gitRef: 'main', graphPath: path.join(root, '.vibgrate', 'graph.json') },
        { socketPath },
      );
      if (!loaded.ok || !('stored' in loaded)) throw new Error('load-graph failed');

      const lsp = new LspHarness();
      new VibgrateLanguageServer(
        {
          root,
          offline: true,
          diagnostics: false,
          graph: true,
          semantic: false,
          daemon: true,
          socketPath,
        },
        lsp.output,
        lsp.input,
      );
      await lsp.request('initialize', { processId: null, rootUri: `file://${root}`, capabilities: {} });
      lsp.notify('initialized', {});
      await until(() => graphStatus(lsp.notes) === 'ready', 8_000);

      const source = new GraphSource(path.join(root, '.vibgrate', 'graph.json'), false, { root });
      source.deferFreshnessToDaemon({
        repositoryId: loaded.repositoryId,
        gitRef: loaded.gitRef,
        socketPath,
      });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const mcpServer = createServer(source, { root, socketPath, local: true });
      const mcpClient = new Client({ name: 'lsp-mcp-pair', version: '0.0.0' });
      await Promise.all([mcpServer.connect(serverT), mcpClient.connect(clientT)]);
      try {
        const [lspAsk, mcpNode] = await Promise.all([
          lsp.request('vibgrate/graph/query', { mode: 'show', name: 'SharedHub' }),
          mcpClient.callTool({ name: 'get_node', arguments: { name: 'SharedHub' } }),
        ]);
        expect(lspAsk.error).toBeUndefined();
        expect((lspAsk.result as { ok?: boolean }).ok).toBe(true);
        const mcpText = (mcpNode.content as Array<{ text?: string }>)?.[0]?.text ?? '';
        expect(mcpText).toContain('SharedHub');
      } finally {
        await mcpClient.close().catch(() => {});
        await mcpServer.close().catch(() => {});
        await lsp.shutdown();
      }
    } finally {
      await vgd.close();
    }
  });

  it('graph-query with the graph turned off is disabled, not a hang', async () => {
    const dir = t.tmp();
    const root = path.join(dir, 'app');
    fs.mkdirSync(root);
    const lsp = new LspHarness();
    new VibgrateLanguageServer(
      {
        root,
        offline: true,
        diagnostics: false,
        graph: false,
        semantic: false,
        daemon: false,
      },
      lsp.output,
      lsp.input,
    );
    await lsp.request('initialize', { processId: null, rootUri: `file://${root}`, capabilities: {} });
    const res = await lsp.request('vibgrate/graph/query', { mode: 'ask', question: 'anything' });
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ ok: false, error: 'disabled' });
    await lsp.shutdown();
  });
});
