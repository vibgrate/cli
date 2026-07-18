import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseGraph } from '../engine/serialize.js';
import { refreshIfStale } from '../engine/refresh.js';
import { TOOLS, warmEmbedderInBackground } from './tools.js';
import { renderToolResult } from './response.js';
import { recordSaving, sanitizeClient, PER_FILE_TOKENS, SAVINGS_TOOLS, type Outcome } from '../engine/savings.js';
import { countTokens } from '../engine/tokens.js';
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
  /**
   * Periodically upload the counts-only ledger to Vibgrate (opt-in; off by
   * default). Implies recording. The upload itself is driven by the serve
   * command (see commands/serve.ts + engine/stats-share.ts); here it just also
   * turns recording on so there's something to send.
   */
  shareStats?: boolean;
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
  const { savings = false, shareStats = false, local = false, dedup = false } = opts;
  // Recording feeds both the local `vg savings` report and the opt-in upload, so
  // enabling either turns it on. Absent both, `vg serve` records nothing.
  const record = savings || shareStats;
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
    {
      capabilities: { tools: {} },
      // Routing guidance once at the server level (hosts that surface
      // `instructions` get it at zero per-step schema cost): the flashlight
      // vs the map.
      instructions:
        'vg is a code map. Use search_symbols to find a known name or literal string fast — ' +
        'a multi-word/quoted phrase runs a complete literal sweep and reports totalTextMatches, ' +
        'so reach for it instead of grep even for plain-string "find every occurrence" lookups. ' +
        'Use orient/query_graph for meaning: symptoms, relationships, and what-breaks-if. ' +
        'Responses are concise by default; pass response_format:"detailed" only when a node proves load-bearing. ' +
        // Stop-discipline: the failure mode on a focused task is over-navigation
        // — one more query, one more get_node — which re-bills the whole context
        // every step. One good navigation call usually locates the code.
        'Navigate as little as possible: one good search/query usually locates the code. ' +
        'As soon as you have the file and line, read that file and make the edit — ' +
        'do not call further graph tools unless the edit fails or the match was wrong. ' +
        // Library docs: position against web search (version-correct beats
        // SEO results), and give a stopping rule so a thin doc doesn't turn
        // into an open-ended search loop.
        'For how-do-I-use-this-library questions call resolve_library once, then library_docs ' +
        'with the returned targetId and a focused query: the docs are official and matched to ' +
        'the version THIS project has installed (drift-annotated) — prefer them over web search ' +
        'or training-data recall when they conflict. Skip them for language built-ins or APIs ' +
        'already shown in context. If two library_docs calls have not surfaced the section you ' +
        'need, read the package source under node_modules instead of searching again.',
    },
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
      // Opt-in, counts-only usage ledger: one entry per navigation call, with its
      // outcome, the grep-baseline token counts, and — so `vg savings` can show
      // the command-vs-MCP split and which AI is calling — the source (`mcp`) and
      // the client detected from the initialize handshake.
      if (record) recordUsage(root, tool.name, result, detectClient(server));
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
  // Start the semantic-model warm-up as soon as the server boots, so the first
  // orient/query_graph doesn't pay a cold download. Non-blocking: navigation
  // answers lexically until the model is ready, then upgrades to semantic.
  warmEmbedderInBackground(opts.local);
  await server.connect(new StdioServerTransport());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.(); // never keep the server process alive just for the budget timer
  });
}

/**
 * Append a counts-only usage entry for a navigation call: which tool, how it
 * resolved (complete/partial/miss), and — for the grep-baseline tools — the
 * tokens vg spent vs the grep/read baseline it replaced.
 *
 * `vgTokens` is the size of the payload vg ACTUALLY returned — the rendered text
 * block the model receives and re-pays on every subsequent turn — measured with
 * the same token counter the budget uses. It is deliberately NOT read from a
 * `tokensEstimate` field: only query_graph's rarely-used *detailed* mode ever
 * set that (get_node never did), so the old code recorded nothing under normal
 * concise usage and `vg savings` always reported "recording is off".
 */
export function recordUsage(root: string, tool: string, result: unknown, client?: string): void {
  const outcome = classifyOutcome(result);
  let vgTokens = 0;
  let baselineTokens = 0;
  // Token savings are only meaningful for the tools with a grep/read baseline;
  // other tools still record their outcome for the per-command breakdown.
  if (SAVINGS_TOOLS.has(tool) && result && typeof result === 'object') {
    vgTokens = countTokens(renderedText(renderToolResult(result)));
    // Grep/read baseline: ~PER_FILE_TOKENS per distinct file the answer points
    // at — the files a grep/read agent would have had to open to learn the same
    // thing. query_graph surfaces them as `matches[].file`; get_node as its own
    // `file` plus the files of the callers/callees it returned in one call.
    baselineTokens = referencedFiles(result).size * PER_FILE_TOKENS;
  }
  recordSaving(
    root,
    { tool, outcome, vgTokens, baselineTokens, source: 'mcp', client: sanitizeClient(client) },
    Date.now(),
  );
}

/**
 * The coarse client label from the MCP `initialize` handshake, if the host sent
 * `clientInfo`. Read defensively — `getClientVersion()` exists on the SDK Server
 * once initialized, but we never want telemetry bookkeeping to throw. Returns
 * undefined when unknown (then sanitized to `'unknown'`).
 */
function detectClient(server: Server): string | undefined {
  try {
    const info = (server as { getClientVersion?: () => { name?: string } | undefined }).getClientVersion?.();
    return typeof info?.name === 'string' ? info.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bucket a tool result into complete / partial / miss. A `miss` is an answer
 * that found nothing (no match, not-found, not-connected, or an empty listing);
 * a `partial` found results but capped or paginated some of them; everything
 * else is `complete`. Note that a legitimately empty `affected`/`covers` (e.g.
 * "nothing depends on this") is a successful answer, not a miss — only the
 * primary discovery signals below mark a miss.
 */
function classifyOutcome(result: unknown): Outcome {
  if (Array.isArray(result)) return result.length === 0 ? 'miss' : 'complete';
  if (!result || typeof result !== 'object') return 'miss';
  const r = result as Record<string, unknown>;
  if (typeof r.error === 'string' && r.error) return 'miss'; // not_found / ambiguous / unresolved
  if (r.connected === false) return 'miss'; // find_path
  if (Array.isArray(r.matches) && r.matches.length === 0) return 'miss'; // query_graph / search_symbols
  return isPartial(r) ? 'partial' : 'complete';
}

/** True when a hit left results on the table: paginated, or a capped relation list. */
function isPartial(r: Record<string, unknown>): boolean {
  if (r.moreAvailable === true) return true;
  if (r._truncated && typeof r._truncated === 'object') return true;
  // A `<name>Total` greater than the length of its sibling `<name>` array means
  // the array was capped (e.g. get_node's callsTotal vs the shown calls).
  for (const [key, value] of Object.entries(r)) {
    if (typeof value !== 'number' || !key.endsWith('Total')) continue;
    const base = key.slice(0, -'Total'.length);
    const shown = Array.isArray(r[base]) ? (r[base] as unknown[]).length : 0;
    if (value > shown) return true;
  }
  return false;
}

/** The text block of a rendered tool result — what the model is billed for. */
function renderedText(rendered: CallToolResult): string {
  const block = rendered.content?.find((b) => b.type === 'text');
  return block && 'text' in block && typeof block.text === 'string' ? block.text : '';
}

/** Distinct files a navigation result points at (its grep/read baseline set). */
function referencedFiles(result: unknown): Set<string> {
  const r = result as { file?: unknown; matches?: unknown; calls?: unknown; calledBy?: unknown };
  const files = new Set<string>();
  if (typeof r.file === 'string' && r.file) files.add(r.file);
  for (const m of asArray(r.matches)) {
    const f = (m as { file?: unknown }).file;
    if (typeof f === 'string' && f) files.add(f);
  }
  // get_node's calls/calledBy are qualified names of the form `path:symbol`; the
  // path prefix is the file a grep/read agent would open to inspect that edge.
  for (const name of [...asArray(r.calls), ...asArray(r.calledBy)]) {
    if (typeof name !== 'string') continue;
    const i = name.indexOf(':');
    if (i > 0) files.add(name.slice(0, i));
  }
  return files;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function errorResult(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
