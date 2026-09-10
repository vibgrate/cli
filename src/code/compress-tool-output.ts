import { env as knobEnv } from '../compress/config.js';
import { RETRIEVE_TOOL_NAME, retrieveToolOpenAI } from '../compress/ccr/tool.js';
import type { ToolSpec } from './types.js';

/**
 * In-loop compression for `vg code`.
 *
 * The agent's own tool results are the bulkiest thing in its context: a
 * `run_command` that prints a full test log, a `web_fetch` of a documentation
 * page, a `search_code` sweep over a large repo. Every one of those is re-billed
 * on every subsequent step, so compressing them once — on the way back from the
 * tool, before the result becomes part of the transcript — is worth more than
 * anything done later.
 *
 * This is deliberately not the proxy: `vg code` talks to the model itself, so
 * there is no wire to sit on. It is the same compression engine, called at the
 * one seam where a tool result enters the conversation.
 *
 * Two rules keep it safe:
 *
 *  1. **Reads stay byte-exact.** `read_file`, `read_notebook` and the file
 *     inspection tools feed edits; an edit computed against a summarised file
 *     corrupts the file. They are never compressed, whatever their size.
 *  2. **Failures stay whole.** A failed tool result is what the model needs in
 *     full to recover, and it is usually short anyway.
 *
 * Everything else is compressed only once it is genuinely large, and the
 * original stays in the local retrievable store. The model gets the same
 * `vg_retrieve` tool the listener injects on the wire, executed in-process,
 * so a marker in the transcript is a pointer it can follow — not dead weight.
 * What the loop saved is written to the compression ledger `vg savings` reads,
 * under the client `vg-code`, so a session here counts like one through the
 * listener.
 */

/** Tool results that an edit may be computed from — never summarised. */
const BYTE_EXACT_TOOLS = new Set([
  'read_file',
  'read_notebook',
  'inspect_change',
  'edit_file',
  'create_file',
  'apply_patch',
  'edit_notebook_cell',
]);

/** Which content router hint fits each tool's output shape. */
const ROUTER_HINT: Readonly<Record<string, string>> = {
  run_command: 'Bash',
  search_code: 'Grep',
  list_files: 'Glob',
  graph_impact: 'Grep',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  library_docs: 'WebFetch',
  browser_snapshot: 'WebFetch',
  inspect_task: 'Bash',
  spawn_subagent: 'Bash',
  verify_change: 'Bash',
};

/** What the loop compressed, for the run summary and the ledger. */
export interface CompressionStats {
  /** Tool results that were actually shrunk. */
  results: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  /** `vg_retrieve` calls the model made (found or not). */
  retrievals: number;
}

export interface ToolOutputCompressor {
  /** False when compression is off or the engine failed to load. */
  readonly enabled: boolean;
  /**
   * Compress one tool result. Returns the original string unchanged whenever
   * compression is off, the tool is byte-exact, the result is small, the result
   * failed, or anything at all goes wrong — this must never be the reason a
   * coding session breaks.
   */
  compress(toolName: string, content: string, opts: { failed?: boolean; query?: string }): string;
  /** Tokens saved so far this session, for `/cost` and the run summary. */
  readonly saved: number;
  /** Running totals behind `saved`. */
  readonly stats: CompressionStats;
  /**
   * The `vg_retrieve` tool to advertise to the model, present only when the
   * retrievable store is bound (otherwise a marker could never be followed).
   */
  readonly toolSpec: ToolSpec | null;
  /** Answer a `vg_retrieve` call from the store. `null` when there is no store. */
  retrieve(args: Record<string, unknown>): { content: string; found: boolean } | null;
  /**
   * Write this session's savings to the compression ledger (the one `vg
   * savings` / `vg show savings` read). No-op when nothing was saved. Returns
   * true when an event was written.
   */
  record(attribution: { model: string; client?: string; project?: string }): boolean;
}

const EMPTY_STATS: CompressionStats = { results: 0, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0, retrievals: 0 };

const OFF: ToolOutputCompressor = { enabled: false, compress: (_n, content) => content, saved: 0, stats: EMPTY_STATS, toolSpec: null, retrieve: () => null, record: () => false };

/** `vg_retrieve` in the agent loop's own tool-spec shape (OpenAI function parameters). */
export function retrieveToolSpec(): ToolSpec {
  const fn = (retrieveToolOpenAI() as { function: { name: string; description: string; parameters: Record<string, unknown> } }).function;
  return { name: fn.name, description: fn.description, parameters: fn.parameters };
}

export { RETRIEVE_TOOL_NAME };

/**
 * Build the in-loop compressor, or the identity when compression is disabled.
 *
 * On by default: an agent loop is exactly the case the layer exists for. Set
 * `VG_CODE_COMPRESS=0` to turn it off, or raise `VG_CODE_COMPRESS_MIN_CHARS` to
 * only touch very large results.
 */
export function createToolOutputCompressor(deps: {
  /** The router call — injected so tests need no module graph. */
  compress: (input: { content: string; toolName?: string; query?: string }) => { content: string; tokensSaved: number; tokensBefore?: number; tokensAfter?: number };
  /** Retrieval from the store behind the markers; absent → no `vg_retrieve` tool is advertised. */
  retrieve?: (args: Record<string, unknown>) => { content: string; found: boolean };
  /** Ledger sink and pricing, injected so tests write nowhere. */
  ledger?: { append: (ev: LedgerEvent) => boolean; usdSaved: (model: string, tokens: number) => number };
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): ToolOutputCompressor {
  const env = deps.env ?? process.env;
  if (!knobEnv.bool('VG_CODE_COMPRESS', env)) return OFF;
  const minChars = knobEnv.int('VG_CODE_COMPRESS_MIN_CHARS', env, { min: 0 });
  const stats: CompressionStats = { ...EMPTY_STATS };
  const toolSpec = deps.retrieve ? retrieveToolSpec() : null;
  return {
    enabled: true,
    get saved() {
      return stats.tokensSaved;
    },
    stats,
    toolSpec,
    compress(toolName, content, opts) {
      if (!shouldCompress(toolName, content, opts, minChars)) return content;
      try {
        const res = deps.compress({ content, toolName: ROUTER_HINT[toolName] ?? toolName, query: opts.query });
        // A compressor that grew the content, or produced nothing, is a no-op.
        if (!res.content || res.content.length >= content.length) return content;
        const tokensSaved = Math.max(0, res.tokensSaved);
        stats.results++;
        stats.tokensSaved += tokensSaved;
        stats.tokensBefore += res.tokensBefore ?? tokensSaved;
        stats.tokensAfter += res.tokensAfter ?? 0;
        return res.content;
      } catch {
        return content;
      }
    },
    retrieve(args) {
      if (!deps.retrieve) return null;
      stats.retrievals++;
      try {
        return deps.retrieve(args);
      } catch (err) {
        return { content: JSON.stringify({ error: `Retrieval failed: ${(err as Error).message}` }), found: false };
      }
    },
    record(attribution) {
      if (!deps.ledger || stats.tokensSaved <= 0) return false;
      try {
        return deps.ledger.append({
          ts: (deps.now ?? Date.now)(),
          source: 'cli',
          model: attribution.model || 'unknown',
          client: attribution.client ?? 'vg-code',
          project: attribution.project,
          tokensBefore: stats.tokensBefore,
          tokensAfter: stats.tokensAfter,
          tokensSaved: stats.tokensSaved,
          usdSaved: deps.ledger.usdSaved(attribution.model || 'unknown', stats.tokensSaved),
          transforms: ['code:tool_output'],
          ccrHashes: stats.results,
        });
      } catch {
        return false;
      }
    },
  };
}

/** The ledger row shape (`src/compress/ledger.ts` `SavingsEvent`), restated so this module stays lazily bound to the engine. */
export interface LedgerEvent {
  ts: number;
  source: 'proxy' | 'mcp' | 'sdk' | 'cli';
  model: string;
  client: string;
  project?: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  usdSaved: number;
  transforms: string[];
  ccrHashes: number;
}

/** The decision, split out so it can be asserted directly. */
export function shouldCompress(
  toolName: string,
  content: string,
  opts: { failed?: boolean },
  minChars: number,
): boolean {
  if (opts.failed) return false;
  if (BYTE_EXACT_TOOLS.has(toolName)) return false;
  return content.length >= minChars;
}

export { BYTE_EXACT_TOOLS, ROUTER_HINT };
