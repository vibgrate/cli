import type { VgTool } from './tools.js';
import { createRouter, type ContentRouter } from '../compress/router.js';
import { tokenizerFor } from '../compress/tokenizers.js';
import { defaultStore } from '../compress/ccr/store.js';
import { appendSavingsEvent, readSavingsEvents, rollupSavings } from '../compress/ledger.js';
import { readSessionStats, recordSessionStat } from '../compress/session-stats.js';
import { costUsd } from '../compress/pricing.js';
import { activeProfile } from '../compress/config.js';
import {
  MemoryStore,
  mcpMemorySearch,
  mcpMemorySave,
  MCP_MEMORY_SEARCH_DESCRIPTION,
  MCP_MEMORY_SAVE_DESCRIPTION,
  MCP_MEMORY_SEARCH_SCHEMA,
  MCP_MEMORY_SAVE_SCHEMA,
} from '../memory/index.js';

/**
 * Context-compression tools for `vg serve` (Vibgrate AI Context). They answer
 * from the compression layer alone, so the server dispatches them without
 * consulting the code map (`vg serve` still builds one at startup for the
 * graph tools, as it always has).
 *
 *   • `compress_content`   — shrink a tool output before it enters the context
 *     (JSON arrays, logs, grep output, diffs, code, prose). Originals stay
 *     retrievable through the local store, so nothing is lost.
 *   • `retrieve_original`  — expand a marker back to the original, or a slice
 *     of it (`grep` / `lines` / `head` / `tail` / `json_path`).
 *   • `compression_stats`  — what the layer saved: today / 7 days / 30 days.
 *   • `memory_search` / `memory_save` — cross-agent project memory.
 *
 * `compress_content` and `memory_save` write to local, user-owned state only
 * (a short-TTL store, an append-only ledger, the memory file); they are
 * idempotent for identical input and never destructive, so they are advertised
 * with `readOnlyHint: false, destructiveHint: false, idempotentHint: true`.
 */

const obj = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties: props,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

let router: ContentRouter | null = null;
function sharedRouter(): ContentRouter {
  if (!router) router = createRouter({ profile: activeProfile().name });
  return router;
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x.length ? x : undefined;
}
function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

export const COMPRESS_TOOLS: VgTool[] = [
  {
    name: 'compress_content',
    description:
      'Shrink a large tool output (JSON, logs, grep/test output, diffs, code, prose) before it enters your context. Keeps errors, ids and the parts relevant to `query`; the full original stays retrievable via `retrieve_original` using the hash in the returned marker.',
    inputSchema: obj(
      {
        content: { type: 'string', description: 'the raw tool output to compress' },
        tool_name: { type: 'string', description: 'which tool produced it (Bash, Grep, Read, WebFetch, …) — improves routing' },
        query: { type: 'string', description: 'what you are looking for — matching lines are kept', maxLength: 500 },
        lossless: { type: 'boolean', description: 'only byte-reversible folds; never drops anything (default false)' },
        model: { type: 'string', description: 'model id for token accounting (default: the active profile’s tokenizer)' },
        target_ratio: { type: 'number', description: 'keep ratio for prose, 0.1..1 (default adaptive)' },
      },
      ['content'],
    ),
    graphless: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (_graph, args, ctx) => {
      const content = String(args.content ?? '');
      if (!content) return { error: 'bad_request', message: 'content is required' };
      const model = str(args.model) ?? 'claude-sonnet-4-5';
      const tokenizer = tokenizerFor(model);
      const store = defaultStore();
      const res = sharedRouter().compress({
        content,
        query: str(args.query),
        toolName: str(args.tool_name),
        tokenizer,
        ccr: store,
        injectMarker: true,
        losslessOnly: args.lossless === true,
        targetRatio: num(args.target_ratio),
      });
      const before = tokenizer.count(content);
      const after = tokenizer.count(res.content);
      const saved = Math.max(0, before - after);
      const now = Date.now();
      if (saved > 0) {
        try {
          appendSavingsEvent({
            ts: now,
            source: 'mcp',
            model,
            client: 'mcp',
            project: ctx.root ? ctx.root.split(/[\\/]/).filter(Boolean).pop() : undefined,
            tokensBefore: before,
            tokensAfter: after,
            tokensSaved: saved,
            usdSaved: costUsd(model, { input: saved }),
            transforms: res.chain.length ? res.chain : [res.strategy],
            ccrHashes: res.ccrHashes.length,
          });
          recordSessionStat({ ts: now, pid: process.pid, tokensSaved: saved, requests: 1 });
        } catch {
          /* ledger is best-effort; the compressed content is the answer */
        }
      }
      return {
        content: res.content,
        strategy: res.strategy,
        chain: res.chain,
        tokensBefore: before,
        tokensAfter: after,
        tokensSaved: saved,
        ...(res.itemCounts ? { items: res.itemCounts } : {}),
        ...(res.ccrHashes.length ? { retrievable: res.ccrHashes } : {}),
      };
    },
  },
  {
    name: 'retrieve_original',
    description:
      'Expand a compression marker (`<<vg-ccr:HASH …>>` or `Retrieve original: hash=…`) back to the stored original — or just the slice you need with grep / lines / head / tail / json_path, which is much cheaper than the whole thing.',
    inputSchema: obj(
      {
        hash: { type: 'string', description: '12- or 24-character hash from the marker' },
        grep: { type: 'string', description: 'only lines containing this text (or a /regex/)' },
        lines: { type: 'string', description: '1-based line range, e.g. "120-180"' },
        head: { type: 'number', description: 'first N lines' },
        tail: { type: 'number', description: 'last N lines' },
        json_path: { type: 'string', description: 'for JSON originals: dotted path or [index]' },
        max_tokens: { type: 'number', description: 'cap the returned slice (default 4000)' },
      },
      ['hash'],
    ),
    graphless: true,
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (_graph, args) => {
      const raw = String(args.hash ?? '');
      const m = raw.match(/([0-9a-f]{24}|[0-9a-f]{12})/i);
      if (!m) return { error: 'bad_request', message: 'hash must be the 12- or 24-character hash from a marker' };
      let lines: [number, number] | undefined;
      const range = str(args.lines);
      if (range) {
        const r = range.match(/^(\d+)\s*[-:]\s*(\d+)$/);
        if (!r) return { error: 'bad_request', message: 'lines must look like "120-180"' };
        lines = [Number(r[1]), Number(r[2])];
      }
      const result = defaultStore().retrieve(m[1].toLowerCase(), {
        grep: str(args.grep),
        lines,
        head: num(args.head),
        tail: num(args.tail),
        jsonPath: str(args.json_path),
        maxTokens: num(args.max_tokens) ?? 4000,
      });
      if (!result.found) {
        return {
          error: 'not_found',
          message: `nothing retrievable for ${m[1]} — entries expire after their TTL (default 30 minutes); the compressed view you already have is all that remains`,
        };
      }
      return result;
    },
  },
  {
    name: 'compression_stats',
    description: 'What context compression saved on this machine: requests, tokens and estimated dollars for today / 7 days / 30 days, by model and client, plus the retrievable store size.',
    inputSchema: obj({
      window: { type: 'string', enum: ['today', '7d', '30d', 'all'], description: 'which rollup to return (default all four)' },
    }),
    graphless: true,
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (_graph, args) => {
      const now = Date.now();
      const events = readSavingsEvents(undefined, { now });
      const rollups = rollupSavings(events, now);
      const window = str(args.window) as keyof typeof rollups | undefined;
      const store = defaultStore().stats();
      const session = readSessionStats(now);
      return {
        ...(window && rollups[window] ? { [window]: rollups[window] } : rollups),
        store,
        session,
      };
    },
  },
];

/** Memory tools are only listed when memory is enabled (`VG_MEMORY=1` or `vg serve --memory`). */
export function memoryVgTools(root: string): VgTool[] {
  let store: MemoryStore | null = null;
  const getStore = (): MemoryStore => (store ??= new MemoryStore({ projectRoot: root }));
  return [
    {
      name: 'memory_search',
      description: MCP_MEMORY_SEARCH_DESCRIPTION,
      inputSchema: MCP_MEMORY_SEARCH_SCHEMA,
      graphless: true,
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: (_graph, args) => ({ result: mcpMemorySearch(getStore(), args) }),
    },
    {
      name: 'memory_save',
      description: MCP_MEMORY_SAVE_DESCRIPTION,
      inputSchema: MCP_MEMORY_SAVE_SCHEMA,
      graphless: true,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: (_graph, args) => ({ result: mcpMemorySave(getStore(), args) }),
    },
  ];
}
