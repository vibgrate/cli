import { encode, decode } from 'gpt-tokenizer/encoding/cl100k_base';

/**
 * Deterministic, offline, no-key token accounting (VG-LIB-SUPERSET-PLAN D5).
 *
 * Uses the `cl100k_base` BPE (gpt-tokenizer, MIT, zero-dep). This is a *budgeting
 * proxy* — not the target model's exact tokenizer (Claude's isn't public) — which
 * is fine because budgets are enforced against this same counter, deterministically.
 */

/** Exact token count under cl100k_base. */
export function countTokens(text: string): number {
  return encode(text).length;
}

export interface Truncation {
  text: string;
  truncated: boolean;
  /** Token count of the returned `text` (always ≤ budget when truncated). */
  tokens: number;
}

/**
 * Truncate `text` to at most `budget` tokens — token-accurate, replacing the old
 * `slice(0, budget * 4)` byte heuristic that under-counted tokens and cut entities
 * mid-line. We decode the kept token prefix, then snap back to the last newline so a
 * code block / entity is never left half-emitted, and append `marker` within budget.
 */
export function truncateToTokens(text: string, budget: number, marker = '\n…(truncated)'): Truncation {
  if (!Number.isFinite(budget) || budget <= 0) return { text, truncated: false, tokens: countTokens(text) };
  const tokens = encode(text);
  if (tokens.length <= budget) return { text, truncated: false, tokens: tokens.length };

  const markerTokens = encode(marker).length;
  const keep = Math.max(0, budget - markerTokens);
  let slice = decode(tokens.slice(0, keep));
  // Snap to the last line boundary so we never cut an entity mid-line.
  const lastNl = slice.lastIndexOf('\n');
  if (lastNl > 0) slice = slice.slice(0, lastNl);

  const out = slice + marker;
  return { text: out, truncated: true, tokens: countTokens(out) };
}
