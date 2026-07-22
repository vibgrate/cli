/**
 * External MCP tools for the VG Code agent (VG-CLI-CODE §17).
 *
 * Like Claude Code, VG Code can use tools from external MCP servers you list in
 * `.vibgrate/code.json` (`mcpServers`). We connect to each server, list its
 * tools, expose them to the model namespaced as `mcp__<server>__<tool>`, and
 * route calls back. Read-only tools (per their `readOnlyHint`) run freely;
 * anything else goes through the same approval gate as a built-in mutating tool,
 * so an external server can't mutate or exfiltrate without consent.
 *
 * The transport is injectable, so namespacing, routing, the read-only/gated
 * split, and lifecycle are unit-tested with a fake client — no real server.
 */

import type { McpServerConfig } from './config.js';
import type { ToolResult } from './tools.js';
import type { MutatingAction } from './tools.js';
import type { ToolCall, ToolSpec } from './types.js';

/** The subset of an MCP client we use — satisfied by the real SDK client and by test fakes. */
export interface McpClientLike {
  listTools(): Promise<{ tools: McpToolDef[] }>;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<{ content?: { type: string; text?: string }[]; isError?: boolean }>;
  close(): Promise<void>;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** How to open a connection to a configured server (injectable; default uses the SDK). */
export type McpConnect = (name: string, config: McpServerConfig) => Promise<McpClientLike>;

const NS = 'mcp__';
const sep = '__';

interface OwnedTool {
  server: string;
  toolName: string;
  spec: ToolSpec;
  readOnly: boolean;
}

/** A live set of external MCP tools, keyed by their namespaced name. */
export class McpToolset {
  private constructor(
    private readonly clients: Map<string, McpClientLike>,
    private readonly tools: Map<string, OwnedTool>,
  ) {}

  /**
   * Connect to every configured server and enumerate its tools. A server that
   * fails to connect or list is skipped with a note in `warnings` — one broken
   * server never sinks the session.
   */
  static async connect(servers: Record<string, McpServerConfig>, connect: McpConnect): Promise<{ toolset: McpToolset; warnings: string[] }> {
    const clients = new Map<string, McpClientLike>();
    const tools = new Map<string, OwnedTool>();
    const warnings: string[] = [];
    for (const [server, config] of Object.entries(servers)) {
      try {
        const client = await connect(server, config);
        const listed = await client.listTools();
        clients.set(server, client);
        for (const t of listed.tools) {
          const name = `${NS}${server}${sep}${t.name}`;
          tools.set(name, {
            server,
            toolName: t.name,
            readOnly: t.annotations?.readOnlyHint === true,
            spec: {
              name,
              description: `[${server}] ${t.description ?? t.name}`,
              parameters: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
            },
          });
        }
      } catch (e) {
        warnings.push(`MCP server "${server}" unavailable: ${(e as Error).message}`);
      }
    }
    return { toolset: new McpToolset(clients, tools), warnings };
  }

  /** The tool specs to advertise to the model. */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Whether a tool call name belongs to this toolset. */
  owns(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Execute an external tool call. A non-read-only tool is gated through
   * `approve` first (default-deny if declined). Never throws — errors come back
   * as tool content for the model to read.
   */
  async execute(call: ToolCall, approve: (a: MutatingAction) => Promise<boolean>): Promise<ToolResult> {
    const owned = this.tools.get(call.name);
    if (!owned) return { content: `unknown MCP tool ${call.name}`, mutated: false };
    if (!owned.readOnly) {
      if (!(await approve({ kind: 'tool', name: call.name, args: call.arguments }))) {
        return { content: `calling ${call.name} was declined by the user`, mutated: false };
      }
    }
    const client = this.clients.get(owned.server);
    if (!client) return { content: `MCP server ${owned.server} is not connected`, mutated: false };
    try {
      const res = await client.callTool({ name: owned.toolName, arguments: call.arguments });
      const text = (res.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n') || '(no output)';
      return { content: text.slice(0, 12_000), mutated: !owned.readOnly && !res.isError };
    } catch (e) {
      return { content: `MCP tool ${call.name} failed: ${(e as Error).message}`, mutated: false };
    }
  }

  async dispose(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Default connect using the MCP SDK (loaded lazily). Handles both a local stdio
 * server (`command`) and a remote server (`url`, streamable-HTTP or SSE) — the
 * two shapes the standard config files use.
 */
export const defaultMcpConnect: McpConnect = async (name, config) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const client = new Client({ name: `vg-code:${name}`, version: '1.0.0' }, { capabilities: {} });
  if (config.url) {
    const url = new URL(config.url);
    const requestInit = config.headers ? { headers: config.headers } : undefined;
    if (config.type === 'sse') {
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      await client.connect(new SSEClientTransport(url, requestInit ? { requestInit } : undefined));
    } else {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      await client.connect(new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined));
    }
  } else if (config.command) {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    await client.connect(new StdioClientTransport({ command: config.command, args: config.args ?? [], env: config.env }));
  } else {
    throw new Error('server config has neither a command (stdio) nor a url (remote)');
  }
  return client as unknown as McpClientLike;
};
