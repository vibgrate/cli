/**
 * Centralised rendering for local `vg serve` MCP tool results.
 *
 * Token economy (why this module exists): a tool result is not paid for once.
 * It is sent to the model when the tool returns, then re-sent inside the
 * conversation context on *every subsequent assistant turn* for the rest of the
 * session. So a few hundred wasted tokens in one response are paid dozens of
 * times over. Cheap, mostly-lossless levers live here:
 *
 *  1. **Compact serialisation** (`toolResult`). The text block has no
 *     pretty-print indentation — pure whitespace the model never reasons over.
 *     Byte-for-byte lossless; see `response.test.ts` for the measured reduction.
 *
 *  2. **Empty-field compaction** (`compactResult`). Drops `null`/empty fields the
 *     model can't use — the upload path's redundancy-stripping applied to MCP.
 *
 *  3. **Token ceiling** (`clampToBudget`). The offline counterpart of the hosted
 *     server's 25k-token budget, so no single result can flood the window.
 *
 *  4. **Honest list bounds** (`boundList`). Caps an array while always reporting
 *     the true total, so elision is visible and the model can ask for more.
 *
 * `renderToolResult` runs 1–3 together; tools opt into `boundList` where needed.
 *
 * Determinism: compact `JSON.stringify` preserves key insertion order; pruning
 * and trimming keep stable prefixes, so output stays stable for equal input.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { countTokens } from '../engine/tokens.js';

/**
 * Hard token ceiling for any single local tool result — the offline counterpart
 * of the hosted MCP's 25,000-token budget (GUARDRAILS §2.3). The local server
 * had no ceiling, so a hub `get_node` or a monorepo-wide `check_drift` could
 * return an unbounded payload. `clampToBudget` enforces this for every tool.
 */
export const MAX_RESULT_TOKENS = 25_000;

/**
 * Render a handler's return value into the MCP tool-result shape, applying the
 * full token-economy pipeline: drop empty/absent fields (`compactResult`),
 * enforce the token ceiling (`clampToBudget`), then serialise compactly. The
 * text block and `structuredContent` are the *same* shaped object, so a
 * structured-aware host and a text-only host see identical data.
 */
export function renderToolResult(result: unknown, maxTokens = MAX_RESULT_TOKENS): CallToolResult {
  return toolResult(clampToBudget(compactResult(result), maxTokens));
}

/**
 * Low-level renderer: compact JSON in the text block (token-lean);
 * `structuredContent` carries the same object for programmatic hosts. Prefer
 * `renderToolResult`, which also compacts and clamps.
 */
export function toolResult(result: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: asStructured(result),
  };
}

/**
 * Drop fields that carry no information for the model — `null`/`undefined`,
 * empty strings, empty arrays, and empty objects — recursively. This is the
 * upload path's "don't ship empties / cap redundancy" philosophy applied to
 * MCP responses (the upload's scan-artifact compactors target data the local
 * server never serves, so the *technique*, not that code, is what transfers).
 *
 * Lossless for an AI consumer: an absent field reads identically to an explicit
 * `null`/empty. Meaningful falsy values (`false`, `0`) are preserved.
 */
export function compactResult<T>(value: T): T {
  return prune(value) as T;
}

function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
      const pv = prune(raw);
      if (!isEmpty(pv)) out[k] = pv;
    }
    return out;
  }
  return v;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false; // false / 0 / non-empty values are meaningful
}

/**
 * Enforce a token ceiling on an object-shaped result by trimming its heaviest
 * array fields (halving the largest token contributor until under budget) and
 * recording what was elided under `_truncated`. Array-rooted results (the
 * `list_*` tools) are already bounded by their own `limit`, so they pass
 * through untouched. Deterministic: trimming keeps a stable prefix.
 */
export function clampToBudget<T>(value: T, maxTokens = MAX_RESULT_TOKENS): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (tokensOf(value) <= maxTokens) return value;

  const obj: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const truncated: Record<string, { shown: number; total: number }> = {};
  // Bounded loop: each pass halves one array, so it converges quickly.
  for (let guard = 0; guard < 64 && tokensOf(obj) > maxTokens; guard++) {
    const arrays = Object.entries(obj).filter(
      (e): e is [string, unknown[]] => Array.isArray(e[1]) && e[1].length > 0,
    );
    if (arrays.length === 0) break; // nothing left to trim
    arrays.sort((a, b) => tokensOf(b[1]) - tokensOf(a[1]));
    const [field, arr] = arrays[0];
    const total = truncated[field]?.total ?? arr.length;
    const shown = Math.max(1, Math.floor(arr.length / 2));
    obj[field] = arr.slice(0, shown);
    truncated[field] = { shown, total };
  }
  if (Object.keys(truncated).length) obj._truncated = truncated;
  return obj as T;
}

function tokensOf(v: unknown): number {
  return countTokens(JSON.stringify(v));
}

/** structuredContent must be an object; wrap arrays/primitives so it always is. */
export function asStructured(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { result };
}

export interface Bounded<T> {
  /** At most `max` items, in the input's (already deterministic) order. */
  items: T[];
  /** The true count before bounding — never silently dropped. */
  total: number;
}

/**
 * Cap a list to `max` items while reporting the real total. Callers surface
 * both `items` and `total` so truncation is always visible to the model.
 */
export function boundList<T>(items: T[], max: number): Bounded<T> {
  if (!Number.isFinite(max) || max < 0 || items.length <= max) {
    return { items, total: items.length };
  }
  return { items: items.slice(0, max), total: items.length };
}

/**
 * Default cap for a single node's relationship arrays (`calls`/`calledBy`). A
 * central hub can have hundreds of callers; the first N ranked entries answer
 * almost every question, and the total tells the model when to dig deeper
 * (e.g. via `impact_of`).
 */
export const NODE_EDGE_CAP = 50;
