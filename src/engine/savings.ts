import * as fs from 'node:fs';
import * as path from 'node:path';
import { cacheDir } from './cache.js';

/**
 * Usage-savings tracking (VG-DEVELOPMENT-PLAN §5) — local, privacy-safe, and
 * **opt-in**. We record *counts only* — never code, never the question text —
 * comparing the context tokens vg returned against a grep/read baseline estimate.
 * `vg savings` reports it with the assumptions shown; figures are labelled
 * estimates, never a hero number.
 *
 * Each entry also carries which path served the call (`source`: an MCP tool call
 * vs a `vg <subcommand>` CLI invocation) and, when known, a coarse `client` label
 * (the AI on the other end). That powers the command-vs-MCP split and the
 * per-client breakdown in `vg savings`, and is the basis for the opt-in
 * `vg serve --share-stats` upload (see ./stats-share.ts). Nothing here leaves the
 * machine unless the operator explicitly enables sharing.
 */

const LEDGER = 'savings.jsonl';
// A conservative, documented estimate: tokens an agent reads per file it opens.
export const PER_FILE_TOKENS = 400;

/** The tools whose grep/read token baseline the savings summary is computed from.
 *  search_symbols belongs here: it is the direct grep replacement (the server
 *  instructions steer agents to it INSTEAD of grep), yet it used to contribute
 *  zero to the estimate — on search-heavy sessions most of the real saving went
 *  uncounted. Its baseline is the same measure as query_graph's: the distinct
 *  files its matches point at, at PER_FILE_TOKENS each. */
export const SAVINGS_TOOLS = new Set(['query_graph', 'get_node', 'search_symbols']);

/**
 * How a navigation call reached the map:
 *  - `mcp` — a tool call over the local `vg serve` MCP server;
 *  - `cli` — a `vg <subcommand>` invocation that identified itself with `--client`.
 * Both are recorded into one ledger under a shared tool vocabulary (CLI
 * subcommands are normalised to their MCP tool names via CLI_TOOL_ALIASES), so
 * `(tool, source)` is the command-vs-MCP split and the token math stays unified.
 * Absent on ledger lines written before sources existed → read as `mcp` (the
 * only path that recorded then).
 */
export type Source = 'mcp' | 'cli';

/**
 * Canonical tool name a CLI navigation subcommand maps to — the same vocabulary
 * the MCP tools use, so a `vg ask --client=claude` and an MCP `query_graph` call
 * land on one row distinguished only by `source`. A subcommand with no MCP twin
 * (e.g. `tree`) keeps its own name.
 */
export const CLI_TOOL_ALIASES: Readonly<Record<string, string>> = {
  ask: 'query_graph',
  show: 'get_node',
  impact: 'impact_of',
  path: 'find_path',
  hubs: 'list_hubs',
  areas: 'list_areas',
  tree: 'tree',
};

/**
 * Normalise a free-form client name (from `--client` or the MCP `initialize`
 * handshake) to a short, bounded, non-PII token: lowercase, `[a-z0-9._-]` only,
 * ≤ 40 chars. Never carries arbitrary user input into the ledger or an upload —
 * it is a coarse client label (e.g. `claude`, `cursor`, `cline`), not identity.
 * Returns `'unknown'` when nothing usable is provided.
 */
export function sanitizeClient(name: string | undefined | null): string {
  if (typeof name !== 'string') return 'unknown';
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'unknown';
}

/**
 * Outcome of a recorded navigation call:
 *  - `complete` — returned results, with nothing capped or paginated;
 *  - `partial`  — returned results, but more were available/truncated;
 *  - `miss`     — returned no result (no match, not-found, not-connected).
 */
export type Outcome = 'complete' | 'partial' | 'miss';

export interface SavingEntry {
  ts: number; // epoch ms (runtime ledger state, not part of any artifact)
  tool: string;
  // Optional for back-compat with ledger lines written before outcomes existed;
  // an absent value is read as `complete` (those lines only recorded hits).
  outcome?: Outcome;
  vgTokens: number;
  baselineTokens: number;
  // Optional for back-compat: absent `source` reads as `mcp`. `client` is a
  // sanitized coarse label (see sanitizeClient) or absent when unidentified.
  source?: Source;
  client?: string;
  // The model that made the call, for per-model savings auditing. `provider` is
  // a coarse provider label (e.g. `anthropic`, `ollama`), `model` the sanitized
  // model slug. VG Code sets both so `vg savings` can break usage down per model.
  // Absent on lines from callers that don't identify a model.
  provider?: string;
  model?: string;
  // Wall time of the call, ms. Optional: absent on lines written before timing
  // existed (and on CLI-sourced lines) — absent means "not measured", never 0.
  ms?: number;
}

/**
 * Normalise a model slug to a bounded, non-PII token — like {@link sanitizeClient}
 * but keeping the `/` and `:` that model ids use (`anthropic/claude-3.5-sonnet`,
 * `qwen2.5-coder:7b`). Returns undefined when nothing usable is given.
 */
export function sanitizeModelId(name: string | undefined | null): string | undefined {
  if (typeof name !== 'string') return undefined;
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || undefined;
}

/**
 * Record a CLI navigation call (`vg <subcommand> --client=<ai>`) into the same
 * local ledger the MCP path uses. Only ever called when the caller passed
 * `--client` — i.e. an AI host explicitly identified itself — so a human's bare
 * `vg ask` still records nothing. Counts only; never the question or code.
 */
export function recordCliCall(
  root: string,
  entry: { tool: string; client?: string; provider?: string; model?: string; outcome: Outcome; vgTokens?: number; baselineFiles?: number },
  now: number,
): void {
  recordSaving(
    root,
    {
      tool: entry.tool,
      source: 'cli',
      client: sanitizeClient(entry.client),
      provider: entry.provider ? sanitizeClient(entry.provider) : undefined,
      model: sanitizeModelId(entry.model),
      outcome: entry.outcome,
      vgTokens: entry.vgTokens ?? 0,
      baselineTokens: (entry.baselineFiles ?? 0) * PER_FILE_TOKENS,
    },
    now,
  );
}

/**
 * Absolute path of the local usage ledger for this repo. Exported so the serve
 * status display can tail it live (mcp/ledger-tail.ts) — the file itself stays
 * local-only (GUARDRAILS §3.4; upload is the separate opt-in stats-share path).
 */
export function savingsLedgerPath(root: string): string {
  return path.join(cacheDir(root), LEDGER);
}

function ledgerPath(root: string): string {
  return savingsLedgerPath(root);
}

/** Whether a savings ledger exists for this repo (i.e. `vg serve --savings` has recorded). */
export function savingsRecorded(root: string): boolean {
  return fs.existsSync(ledgerPath(root));
}

/**
 * Delete the recorded usage data for this repo: the ledger itself plus the
 * stats-share state that indexes into it (a byte offset into the ledger and the
 * random per-install id) — a stale offset against a fresh ledger would silently
 * skip new entries, and clearing "my data" should also reset the id. Everything
 * removed lives under `.vibgrate/cache/`; nothing else is touched. Returns
 * whether a ledger existed.
 */
export function clearSavings(root: string): boolean {
  const file = ledgerPath(root);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  fs.rmSync(path.join(cacheDir(root), 'stats-share.json'), { force: true });
  return existed;
}

export function recordSaving(root: string, entry: Omit<SavingEntry, 'ts'>, now: number): void {
  try {
    fs.mkdirSync(cacheDir(root), { recursive: true });
    const line = JSON.stringify({ ts: now, ...entry });
    fs.appendFileSync(ledgerPath(root), line + '\n');
  } catch {
    /* never let telemetry break a tool call */
  }
}

export interface SavingsReport {
  enabled: boolean;
  days: number;
  queries: number;
  vgTokens: number;
  baselineTokens: number;
  ratio: number;
  estCostVg: number;
  estCostBaseline: number;
  saved: number;
  rateLabel: string;
}

// Published-style input rate ($/1M tokens), shipped with the CLI. Labelled
// estimate; the user can pass their own model rate.
const DEFAULT_RATE_PER_M = 3.0; // e.g. a mid-tier model input rate
const DEFAULT_RATE_LABEL = 'input @ $3/1M';

export function readSavings(root: string, days: number, now: number, ratePerM = DEFAULT_RATE_PER_M): SavingsReport {
  const file = ledgerPath(root);
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let queries = 0;
  let vgTokens = 0;
  let baselineTokens = 0;
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as SavingEntry;
        if (e.ts < cutoff) continue;
        // The token-savings figures compare only the tools with a meaningful
        // grep/read baseline; the full per-command breakdown lives in readUsage.
        if (!SAVINGS_TOOLS.has(e.tool)) continue;
        queries++;
        vgTokens += e.vgTokens;
        baselineTokens += e.baselineTokens;
      } catch {
        /* skip corrupt line */
      }
    }
  }
  const estCostVg = (vgTokens / 1e6) * ratePerM;
  const estCostBaseline = (baselineTokens / 1e6) * ratePerM;
  return {
    enabled: savingsRecorded(root),
    days,
    queries,
    vgTokens,
    baselineTokens,
    ratio: vgTokens > 0 ? Math.round((baselineTokens / vgTokens) * 100) / 100 : 0,
    estCostVg: round2(estCostVg),
    estCostBaseline: round2(estCostBaseline),
    saved: round2(estCostBaseline - estCostVg),
    rateLabel: DEFAULT_RATE_LABEL,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Token + cost savings attributed to one model (VG Code per-model auditing). */
export interface ModelSaving {
  /** `provider/model`, the ledger's per-model key. */
  key: string;
  provider: string;
  model: string;
  queries: number;
  vgTokens: number;
  baselineTokens: number;
  saved: number;
}

/**
 * Per-model breakdown of the token-savings figures — the basis of "full savings
 * auditing per model". Only entries that carry a `model` and are savings-baseline
 * tools contribute, so it lines up with the headline `readSavings` totals.
 * Sorted by dollars saved (desc), then key.
 */
export function readModelSavings(root: string, days: number, now: number, ratePerM = DEFAULT_RATE_PER_M): ModelSaving[] {
  const file = ledgerPath(root);
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const byModel = new Map<string, { provider: string; model: string; queries: number; vg: number; base: number }>();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as SavingEntry;
        if (e.ts < cutoff || !e.model || !SAVINGS_TOOLS.has(e.tool)) continue;
        const provider = e.provider ?? 'unknown';
        const key = `${provider}/${e.model}`;
        const row = byModel.get(key) ?? { provider, model: e.model, queries: 0, vg: 0, base: 0 };
        row.queries++;
        row.vg += e.vgTokens;
        row.base += e.baselineTokens;
        byModel.set(key, row);
      } catch {
        /* skip corrupt line */
      }
    }
  }
  return [...byModel.entries()]
    .map(([key, r]) => ({
      key,
      provider: r.provider,
      model: r.model,
      queries: r.queries,
      vgTokens: r.vg,
      baselineTokens: r.base,
      saved: round2(((r.base - r.vg) / 1e6) * ratePerM),
    }))
    .sort((a, b) => b.saved - a.saved || a.key.localeCompare(b.key));
}

/** Per-command usage stats over the ledger window (all recorded tools). */
export interface CommandStat {
  tool: string;
  calls: number;
  complete: number;
  partial: number;
  miss: number;
  /** (complete + partial) / calls, as a whole-number percentage. */
  successPct: number;
  /** Mean wall time over the calls that recorded one; null when none did. */
  avgMs: number | null;
}

/** Calls attributed to one dimension value (a source, or a client). */
export interface DimensionStat {
  key: string;
  calls: number;
  complete: number;
  partial: number;
  miss: number;
  successPct: number;
}

export interface UsageReport {
  enabled: boolean;
  days: number;
  /** One row per tool used, ordered by call count (desc), then name. */
  commands: CommandStat[];
  /** The command-vs-MCP split: calls grouped by `source` (`cli` / `mcp`). */
  sources: DimensionStat[];
  /** Which AI is calling: calls grouped by coarse `client` label. */
  clients: DimensionStat[];
  /** Column sums across all commands. */
  totals: { calls: number; complete: number; partial: number; miss: number };
  /** The mean of the per-command success percentages (each command weighted equally). */
  avgSuccessPct: number;
}

interface OutcomeCounts {
  complete: number;
  partial: number;
  miss: number;
}

/** Turn a name→outcome-count map into sorted DimensionStat rows. */
function toDimensionStats(byKey: Map<string, OutcomeCounts>): DimensionStat[] {
  return [...byKey.entries()]
    .map(([key, r]) => {
      const calls = r.complete + r.partial + r.miss;
      return {
        key,
        calls,
        complete: r.complete,
        partial: r.partial,
        miss: r.miss,
        successPct: calls ? Math.round(((r.complete + r.partial) / calls) * 100) : 0,
      };
    })
    .sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
}

/**
 * Per-command breakdown of recorded navigation calls: how often each tool was
 * used and how those calls resolved (complete / partial / miss), plus column
 * totals and the average success rate. Complements the token-savings summary —
 * this counts *every* recorded tool, not just the grep-baseline ones.
 */
export function readUsage(root: string, days: number, now: number): UsageReport {
  const file = ledgerPath(root);
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const byTool = new Map<string, OutcomeCounts>();
  const bySource = new Map<string, OutcomeCounts>();
  const byClient = new Map<string, OutcomeCounts>();
  // Per-tool timing over the entries that recorded a duration (older ledger
  // lines and CLI-sourced calls carry none — "not measured", never zero).
  const msByTool = new Map<string, { sum: number; n: number }>();
  const bump = (m: Map<string, OutcomeCounts>, key: string, outcome: Outcome): void => {
    const row = m.get(key) ?? { complete: 0, partial: 0, miss: 0 };
    row[outcome]++;
    m.set(key, row);
  };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as SavingEntry;
        if (e.ts < cutoff) continue;
        const outcome: Outcome = e.outcome ?? 'complete';
        // Back-compat: lines written before these dims existed are MCP calls
        // from an unidentified client.
        bump(byTool, e.tool, outcome);
        bump(bySource, e.source ?? 'mcp', outcome);
        bump(byClient, e.client ?? 'unknown', outcome);
        if (typeof e.ms === 'number' && e.ms >= 0) {
          const timing = msByTool.get(e.tool) ?? { sum: 0, n: 0 };
          timing.sum += e.ms;
          timing.n++;
          msByTool.set(e.tool, timing);
        }
      } catch {
        /* skip corrupt line */
      }
    }
  }
  const commands: CommandStat[] = toDimensionStats(byTool).map((d) => {
    const timing = msByTool.get(d.key);
    return {
      tool: d.key,
      calls: d.calls,
      complete: d.complete,
      partial: d.partial,
      miss: d.miss,
      successPct: d.successPct,
      avgMs: timing && timing.n > 0 ? Math.round(timing.sum / timing.n) : null,
    };
  });
  const totals = commands.reduce(
    (t, c) => ({
      calls: t.calls + c.calls,
      complete: t.complete + c.complete,
      partial: t.partial + c.partial,
      miss: t.miss + c.miss,
    }),
    { calls: 0, complete: 0, partial: 0, miss: 0 },
  );
  const avgSuccessPct = commands.length
    ? Math.round(commands.reduce((s, c) => s + c.successPct, 0) / commands.length)
    : 0;
  return {
    enabled: savingsRecorded(root),
    days,
    commands,
    sources: toDimensionStats(bySource),
    clients: toDimensionStats(byClient),
    totals,
    avgSuccessPct,
  };
}
