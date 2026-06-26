import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parseGraph } from '../engine/serialize.js';
import { TOOLS } from './tools.js';
import { recordSaving, PER_FILE_TOKENS } from '../engine/savings.js';
import { VERSION } from '../version.js';
import type { VgGraph } from '../schema.js';

/**
 * The local `vg serve` MCP server. Self-contained and offline: it reads the
 * committed `graph.json` from disk and re-reads it only when the file's mtime
 * changes (cheap hot-reload tuned for local dev — no watcher dependency, no
 * network, fast startup). Every tool is read-only and auto-approvable.
 */

class GraphSource {
  private cachedMtimeMs = -1;
  private cached: VgGraph | null = null;

  constructor(private readonly graphPath: string) {}

  /** Current graph, reloaded if the file changed since last read. */
  get(): VgGraph {
    const stat = fs.statSync(this.graphPath); // throws if missing → surfaced as tool error
    if (stat.mtimeMs !== this.cachedMtimeMs || !this.cached) {
      this.cached = parseGraph(fs.readFileSync(this.graphPath, 'utf8'));
      this.cachedMtimeMs = stat.mtimeMs;
    }
    return this.cached;
  }
}

export function createServer(graphPath: string, savings = false, local = false): Server {
  const source = new GraphSource(graphPath);
  // root = the directory containing .vibgrate/ (graphPath = root/.vibgrate/graph.json)
  const root = path.dirname(path.dirname(graphPath));
  const server = new Server(
    { name: 'vg', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      return errorResult(`unknown tool "${request.params.name}"`);
    }
    let graph: VgGraph;
    try {
      graph = source.get();
    } catch {
      return errorResult(
        'no code map found. Run `vg` in the project to build .vibgrate/graph.json, then retry.',
      );
    }
    try {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const result = await tool.handler(graph, args, { root, local });
      // Opt-in, counts-only savings ledger (no telemetry by default).
      if (savings && (tool.name === 'query_graph' || tool.name === 'get_node')) {
        maybeRecordSaving(root, tool.name, result);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: asStructured(result),
      };
    } catch (err) {
      return errorResult(`tool "${tool.name}" failed: ${(err as Error).message}`);
    }
  });

  return server;
}

export async function serveStdio(graphPath: string, savings = false, local = false): Promise<void> {
  const server = createServer(graphPath, savings, local);
  await server.connect(new StdioServerTransport());
}

function maybeRecordSaving(root: string, tool: string, result: unknown): void {
  if (!result || typeof result !== 'object') return;
  const r = result as { tokensEstimate?: number; matches?: { file?: string }[] };
  const vgTokens = typeof r.tokensEstimate === 'number' ? r.tokensEstimate : 0;
  if (vgTokens <= 0) return;
  const files = new Set((r.matches ?? []).map((m) => m.file).filter(Boolean));
  const baselineTokens = files.size * PER_FILE_TOKENS;
  recordSaving(root, { tool, vgTokens, baselineTokens }, Date.now());
}

function errorResult(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asStructured(result: unknown): Record<string, unknown> {
  // structuredContent must be an object; wrap arrays/primitives.
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { result };
}
