import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parseGraph } from '../engine/serialize.js';
import { refreshIfStale } from '../engine/refresh.js';
import { TOOLS } from './tools.js';
import { renderToolResult } from './response.js';
import { recordSaving, PER_FILE_TOKENS } from '../engine/savings.js';
import { VERSION } from '../version.js';
import type { VgGraph } from '../schema.js';

/**
 * The local `vg serve` MCP server. Self-contained and offline. Freshness is
 * two-layered, with no filesystem watcher (freshness only matters at the
 * moment of a query, so we check on read instead of watching):
 *
 * 1. **Hot reload** — `graph.json` is re-read whenever its mtime changes, so a
 *    rebuild from ANY source (a foreground `vg`, another serve process, CI)
 *    is picked up on the next tool call.
 * 2. **Auto-refresh** (default on) — each tool call runs a debounced, stat-only
 *    freshness probe against the last build's snapshot; if the working tree
 *    drifted, an incremental rebuild runs in-process (cross-process locked,
 *    single-flight). The call waits for it up to a small budget — warm
 *    incremental rebuilds land well inside it — and otherwise answers from
 *    the current map while the rebuild finishes for the next call.
 *
 * Every tool remains read-only and auto-approvable; the refresh only rewrites
 * vg's own artifacts under `.vibgrate/`, never user code.
 */

/** Min gap between freshness probes — bounds stat-walk cost under bursty tool calls. */
const PROBE_INTERVAL_MS = 2000;
/** Ceiling for the self-tuned probe interval on very large repos. */
const MAX_PROBE_INTERVAL_MS = 30_000;
/** Probe may consume at most ~1/PROBE_DUTY_FACTOR of serve wall-time (20 → ≤5%). */
const PROBE_DUTY_FACTOR = 20;
/** How long a tool call waits for an in-flight refresh before answering from the current map. */
const REFRESH_BUDGET_MS = 5_000;
/** After a refresh failure (e.g. read-only checkout), don't retry for this long. */
const FAILURE_COOLDOWN_MS = 60_000;

export interface ServeOptions {
  /** Record local, counts-only usage savings (opt-in). */
  savings?: boolean;
  /** Air-gapped mode (no model downloads). */
  local?: boolean;
  /** Collapse repeat heavy relation lists within a session (opt-in). */
  dedup?: boolean;
  /** Auto-refresh the map when the working tree drifts (default true). */
  refresh?: boolean;
}

export class GraphSource {
  private cachedMtimeMs = -1;
  private cached: VgGraph | null = null;
  private readonly root: string;
  private lastProbeAt = 0;
  private failedUntil = 0;
  private inflight: Promise<void> | null = null;
  /** Self-tuned: grows with measured probe cost so huge repos aren't penalized. */
  private probeIntervalMs = PROBE_INTERVAL_MS;

  constructor(
    readonly graphPath: string,
    private readonly refresh = false,
    /** Timing overrides (tests only). */
    private readonly tuning: { probeIntervalMs?: number; refreshBudgetMs?: number } = {},
  ) {
    // root = the directory containing .vibgrate/ (graphPath = root/.vibgrate/graph.json)
    this.root = path.dirname(path.dirname(graphPath));
  }

  /** Current graph: auto-refreshed if the tree drifted, reloaded if the file changed. */
  async get(): Promise<VgGraph> {
    if (this.refresh) await this.maybeRefresh();
    const stat = fs.statSync(this.graphPath); // throws if missing → surfaced as tool error
    if (stat.mtimeMs !== this.cachedMtimeMs || !this.cached) {
      this.cached = parseGraph(fs.readFileSync(this.graphPath, 'utf8'));
      this.cachedMtimeMs = stat.mtimeMs;
    }
    return this.cached;
  }

  /**
   * Debounced, single-flight refresh. Never throws — a refresh problem must
   * degrade to "answer from the current map", not break the tool call.
   */
  private async maybeRefresh(): Promise<void> {
    const now = Date.now();
    if (!this.inflight) {
      const interval = this.tuning.probeIntervalMs ?? this.probeIntervalMs;
      if (now < this.failedUntil || now - this.lastProbeAt < interval) return;
      this.lastProbeAt = now;
      this.inflight = refreshIfStale(this.root)
        .then((r) => {
          if (r.status === 'error') this.failedUntil = Date.now() + FAILURE_COOLDOWN_MS;
          // Self-tune the probe cadence to the repo's actual size: when the
          // outcome was probe-only (no rebuild), its duration ≈ the stat-walk
          // cost, and the next probe is spaced so probing can never take more
          // than ~1/PROBE_DUTY_FACTOR of serve wall-time. Small repos stay at
          // the 2s floor; a 100k-file tree self-paces toward the 30s ceiling.
          if (r.status === 'fresh' || r.status === 'no-snapshot' || r.status === 'locked') {
            const cost = Date.now() - now;
            this.probeIntervalMs = Math.min(
              MAX_PROBE_INTERVAL_MS,
              Math.max(PROBE_INTERVAL_MS, cost * PROBE_DUTY_FACTOR),
            );
          }
        })
        .catch(() => {
          this.failedUntil = Date.now() + FAILURE_COOLDOWN_MS;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    await Promise.race([this.inflight, sleep(this.tuning.refreshBudgetMs ?? REFRESH_BUDGET_MS)]);
  }
}

export function createServer(source: GraphSource, opts: ServeOptions = {}): Server {
  const { savings = false, local = false, dedup = false } = opts;
  // root = the directory containing .vibgrate/ (graphPath = root/.vibgrate/graph.json)
  const root = path.dirname(path.dirname(source.graphPath));
  // Per-session memory of node ids whose full detail was already returned — the
  // basis for opt-in cross-call dedup (`--dedup`). Scoped to this server
  // instance so it never leaks across sessions. Node ids are content-addressed
  // (blake3 of content), so an edited node gets a new id and is never falsely
  // treated as already-seen — dedup is stale-safe by construction.
  const seen = new Set<string>();
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
      graph = await source.get();
    } catch {
      return errorResult(
        'no code map found. Run `vg` in the project to build .vibgrate/graph.json, then retry.',
      );
    }
    try {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const result = await tool.handler(graph, args, { root, local, dedup, seen });
      // Opt-in, counts-only savings ledger (no telemetry by default).
      if (savings && (tool.name === 'query_graph' || tool.name === 'get_node')) {
        maybeRecordSaving(root, tool.name, result);
      }
      // Compact → clamp to the token ceiling → compact-serialise. See ./response.ts.
      return renderToolResult(result);
    } catch (err) {
      return errorResult(`tool "${tool.name}" failed: ${(err as Error).message}`);
    }
  });

  return server;
}

export async function serveStdio(graphPath: string, opts: ServeOptions = {}): Promise<void> {
  const source = new GraphSource(graphPath, opts.refresh !== false);
  const server = createServer(source, opts);
  await server.connect(new StdioServerTransport());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.(); // never keep the server process alive just for the budget timer
  });
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
