import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseGraph } from '../engine/serialize.js';
import { mapFileStat } from '../engine/snapshot.js';
import { loadGraphPreferIndex } from '../engine/index-db.js';
import type { RefreshOutcome, refreshIfStale } from '../engine/refresh.js';
import { RefreshScheduler, REFRESH_BUDGET_MS as SCHEDULER_BUDGET_MS } from '../engine/refresh-scheduler.js';
import { TOOLS, budgetSuffix, listedToolNames, warmEmbedderInBackground, type ToolSurface } from './tools.js';
import { isRelevantChange } from '../engine/watch-filter.js';
import { renderToolResult } from './response.js';
import { recordSaving, sanitizeClient, PER_FILE_TOKENS, SAVINGS_TOOLS, type Outcome } from '../engine/savings.js';
import type { SessionStats } from './serve-stats.js';
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
 *    single-flight). The call waits only a **micro-budget** so a warm probe can
 *    land without stalling MCP tools — otherwise it answers from the current
 *    map while the rebuild finishes for a later call (hot-reload picks it up).
 *
 * Every tool remains read-only and auto-approvable; the refresh only rewrites
 * vg's own artifacts under `.vibgrate/`, never user code.
 */

/**
 * How long a tool call waits for an in-flight refresh before answering from
 * the current map. Kept deliberately small: MCP tool latency is sub-10ms on
 * warm maps, and a multi-second budget (the previous 5s ceiling matched
 * `git rev-parse`'s spawn timeout) turned every sequential tool call during a
 * large-repo rebuild into a multi-second stall — measured as TypeScript p50
 * ~5.2s on the release benchmark for the `vg-cli-public` corpus entry.
 * Warm probes still finish inside this window; heavy rebuilds never should.
 *
 * Re-exported from the shared scheduler, which owns this and the probe-interval
 * tuning for every surface (`vg serve` and `vg lsp` alike).
 */
export const REFRESH_BUDGET_MS = SCHEDULER_BUDGET_MS;
/** Settle time between a watcher event and the background refresh it triggers. */
const WATCH_DEBOUNCE_MS = 400;

export type RefreshImpl = typeof refreshIfStale;

export interface GraphSourceTuning {
  probeIntervalMs?: number;
  refreshBudgetMs?: number;
  /**
   * Workspace root for freshness probes. Prefer passing this explicitly —
   * deriving it from `graphPath` via `dirname` twice only works for the legacy
   * `root/.vibgrate/graph.json` layout, not the global branch-keyed store.
   */
  root?: string;
  /** Tests only: inject a slow/fake refresh to assert the micro-budget. */
  refreshImpl?: RefreshImpl;
}

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
  /**
   * Event-driven refresh: recursive fs.watch on the workspace so a save
   * rebuilds in ~400 ms instead of waiting out the freshness poll (default
   * true when refresh is on; `--no-watch` opts out). Where recursive watch is
   * unavailable the poll silently remains the only mechanism.
   */
  watch?: boolean;
  /**
   * Workspace root (project directory). When set, freshness probes and tools
   * use this instead of inferring root from the graph path.
   */
  root?: string;
  /**
   * In-memory session stats behind the live `vg serve` status display. Always
   * safe to pass: nothing recorded here is persisted or uploaded — it dies with
   * the process (the opt-in ledger above is a separate concern).
   */
  stats?: SessionStats;
  /**
   * Listing surface (`--surface hot` / `--tools a,b`). Filters ONLY what
   * `tools/list` advertises; every tool stays callable so behaviour is
   * byte-identical across surfaces. See `listedToolNames` in ./tools.ts.
   */
  toolSurface?: ToolSurface;
}

export class GraphSource {
  private cachedMtimeMs = -1;
  private cached: VgGraph | null = null;
  /** Project root used for freshness probes and rebuilds. */
  readonly root: string;
  /** Debounce, single-flight, self-tuning and budget cap — shared with `vg lsp`. */
  private readonly refresher: RefreshScheduler;
  /**
   * Files seen changing since the last COMMITTED refresh (watcher events,
   * filename → last-seen ms). Entries are cleared only after a refresh that
   * started at-or-after their last event completes with 'fresh'/'refreshed' —
   * a change landing mid-refresh stays pending, so the staleness signal can
   * be a false positive but never a false negative.
   */
  private readonly pendingChanges = new Map<string, number>();
  private watcher: fs.FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly graphPath: string,
    private readonly refresh = false,
    /** Timing / root overrides (production passes `root`; tests may pass more). */
    private readonly tuning: GraphSourceTuning = {},
  ) {
    // Prefer an explicit root. Fallback assumes legacy `root/.vibgrate/graph.json`
    // (dirname twice); wrong for the global store — callers should pass `root`.
    this.root = tuning.root ?? path.dirname(path.dirname(graphPath));
    this.refresher = new RefreshScheduler({
      root: this.root,
      graphPath,
      probeIntervalMs: tuning.probeIntervalMs,
      refreshBudgetMs: tuning.refreshBudgetMs,
      refreshImpl: tuning.refreshImpl,
      onSettled: (outcome, startedAt) => this.onRefreshSettled(outcome, startedAt),
    });
  }

  /** Current graph: auto-refreshed if the tree drifted, reloaded if the file changed. */
  async get(): Promise<VgGraph> {
    if (this.refresh) await this.maybeRefresh();
    // JSON when present, else the standalone snapshot (global-store mode);
    // throws if neither exists → surfaced as tool error.
    const stat = mapFileStat(this.graphPath);
    if (stat.mtimeMs !== this.cachedMtimeMs || !this.cached) {
      // Prefer SQLite reconstruct when corpusHash matches (scale past JSON parse).
      const preferred = loadGraphPreferIndex(this.root, this.graphPath);
      this.cached = preferred
        ? preferred.graph
        : parseGraph(fs.readFileSync(this.graphPath, 'utf8'));
      this.cachedMtimeMs = stat.mtimeMs;
    }
    return this.cached;
  }

  /**
   * Debounced, single-flight refresh — the shared scheduler does the work (see
   * engine/refresh-scheduler.ts). Never throws: a refresh problem must degrade
   * to "answer from the current map", not break the tool call.
   */
  private maybeRefresh(): Promise<void> {
    return this.refresher.maybeRefresh();
  }

  /**
   * A COMMITTED outcome (map verified fresh, or rebuilt) clears the pending
   * set — but only entries whose last event predates the refresh start.
   * 'locked'/'error'/'no-snapshot' clear nothing: the map may still be behind
   * those changes.
   */
  private onRefreshSettled(outcome: RefreshOutcome | null, startedAt: number): void {
    if (outcome?.status !== 'fresh' && outcome?.status !== 'refreshed') return;
    for (const [file, seenAt] of this.pendingChanges) {
      if (seenAt <= startedAt) this.pendingChanges.delete(file);
    }
  }

  /**
   * Record a source change (watcher event, or a test). Arms the next probe to
   * run immediately (bypassing the self-tuned interval — a real event is not a
   * poll) and schedules a debounced background refresh so the rebuild happens
   * BETWEEN tool calls instead of on the next call's 100 ms budget.
   */
  notePendingChange(filename: string): void {
    this.pendingChanges.set(filename, Date.now());
    this.refresher.arm();
    if (!this.refresh) return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.maybeRefresh();
    }, WATCH_DEBOUNCE_MS);
    this.watchTimer.unref?.();
  }

  /**
   * Event-driven freshness (the serve-loop watcher): a recursive `fs.watch`
   * on the workspace feeds `notePendingChange`, so a save triggers a rebuild
   * in ~WATCH_DEBOUNCE_MS instead of waiting out the 2–30 s poll. The poll
   * stays armed as the fallback — on filesystems where recursive watch fails
   * (some containers/NFS) this returns false and behaviour is unchanged.
   */
  startWatching(): boolean {
    if (this.watcher) return true;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (!isRelevantChange(filename)) return;
        this.notePendingChange(filename);
      });
      this.watcher.unref?.();
      return true;
    } catch {
      this.watcher = null;
      return false;
    }
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
  }

  /**
   * In-band staleness signal for tool responses: what has changed since the
   * last committed refresh. Null when the map is current (the common case —
   * responses carry zero overhead then).
   */
  stalenessNote(): string | null {
    const n = this.pendingChanges.size;
    if (n === 0) return null;
    const names = [...this.pendingChanges.keys()].sort().slice(0, 3);
    const more = n > names.length ? `, +${n - names.length} more` : '';
    return `map freshness: ${n} file(s) changed since the last rebuild (${names.join(', ')}${more}) — auto-refresh pending; symbol locations may have shifted`;
  }
}

export function createServer(source: GraphSource, opts: ServeOptions = {}): Server {
  const { savings = false, shareStats = false, local = false, dedup = false, stats } = opts;
  // Recording feeds both the local `vg savings` report and the opt-in upload, so
  // enabling either turns it on. Absent both, `vg serve` records nothing.
  const record = savings || shareStats;
  // Prefer GraphSource's explicit root (set by serve from the project cwd).
  const root = opts.root ?? source.root;
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = new Set(listedToolNames(opts.toolSurface));
    // Repo-size call budget on orient's listed description: the stop-discipline
    // where the model decides, priced once per list, not per step. Best-effort —
    // when no map is loadable yet the description ships without the line.
    let budget = '';
    try {
      const graph = await source.get();
      budget = budgetSuffix(new Set(graph.nodes.map((n) => n.file)).size);
    } catch {
      /* no map yet — plain description */
    }
    return {
      tools: TOOLS.filter((t) => listed.has(t.name)).map((t) => ({
        name: t.name,
        description: t.name === 'orient' && budget ? `${t.description}${budget}` : t.description,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      })),
    };
  });

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
    const startedAt = Date.now();
    try {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const result = await tool.handler(graph, args, { root, local, dedup, seen, graphPath: source.graphPath });
      const ms = Date.now() - startedAt;
      // Live, in-memory session stats for the serve status display — always on
      // when a serve process passed them (nothing leaves the process).
      stats?.record({ ...measureCall(tool.name, result), client: sanitizeClient(detectClient(server)), ms });
      // Opt-in, counts-only usage ledger: one entry per navigation call, with its
      // outcome, the grep-baseline token counts, and — so `vg savings` can show
      // the command-vs-MCP split and which AI is calling — the source (`mcp`) and
      // the client detected from the initialize handshake.
      if (record) recordUsage(root, tool.name, result, detectClient(server), ms);
      // Compact → clamp to the token ceiling → compact-serialise. See ./response.ts.
      const rendered = renderToolResult(result);
      // In-band staleness (serve-loop watcher): when the working tree has
      // drifted past the served map, say so ON the response — the agent is the
      // one acting on possibly-moved symbols, and stderr never reaches it.
      // Zero overhead when the map is current (the overwhelmingly common case).
      const staleness = source.stalenessNote();
      if (staleness) rendered.content = [...(rendered.content ?? []), { type: 'text', text: `[${staleness}]` }];
      return rendered;
    } catch (err) {
      // A failed call still counts in the live display — as a miss, so the
      // operator sees trouble instead of a silently frozen dashboard.
      stats?.record({
        tool: tool.name,
        client: sanitizeClient(detectClient(server)),
        outcome: 'miss',
        ms: Date.now() - startedAt,
        vgTokens: 0,
        baselineTokens: 0,
      });
      return errorResult(`tool "${tool.name}" failed: ${(err as Error).message}`);
    }
  });

  return server;
}

export async function serveStdio(graphPath: string, opts: ServeOptions = {}): Promise<void> {
  const source = new GraphSource(graphPath, opts.refresh !== false, { root: opts.root });
  if (opts.refresh !== false && opts.watch !== false) source.startWatching();
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
export function recordUsage(root: string, tool: string, result: unknown, client?: string, ms?: number): void {
  recordSaving(
    root,
    { ...measureCall(tool, result), source: 'mcp', client: sanitizeClient(client), ...(ms !== undefined ? { ms } : {}) },
    Date.now(),
  );
}

/**
 * Measure one tool call for the ledger and the live session stats: its outcome
 * plus — for the grep-baseline tools only — the context tokens vg returned and
 * the baseline they replaced (other tools report zeros, meaning "no baseline").
 */
function measureCall(tool: string, result: unknown): { tool: string; outcome: Outcome; vgTokens: number; baselineTokens: number } {
  const outcome = classifyOutcome(result);
  let vgTokens = 0;
  let baselineTokens = 0;
  if (SAVINGS_TOOLS.has(tool) && result && typeof result === 'object') {
    vgTokens = countTokens(renderedText(renderToolResult(result)));
    // Grep/read baseline: ~PER_FILE_TOKENS per distinct file the answer points
    // at — the files a grep/read agent would have had to open to learn the same
    // thing. query_graph surfaces them as `matches[].file`; get_node as its own
    // `file` plus the files of the callers/callees it returned in one call.
    baselineTokens = referencedFiles(result).size * PER_FILE_TOKENS;
  }
  return { tool, outcome, vgTokens, baselineTokens };
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
