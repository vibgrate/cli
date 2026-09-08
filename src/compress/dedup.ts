/**
 * Cross-turn dedup of repeated tool output.
 *
 * Coding agents re-display the same bytes many times (`cat foo`, then
 * `sed -n 75,100p foo`, then `cat foo` again). Per-block compressors are blind
 * to that; this pass replaces a later repeat with a pointer to the earlier,
 * still-in-context copy.
 *
 * Invariants:
 *  - prefix-monotonic (cache-safe): blocks are matched only against strictly
 *    earlier blocks, references are absolute message indices, and the first
 *    occurrence is never rewritten — appending a turn never changes an earlier
 *    turn's bytes;
 *  - information-preserving: a whole-block verbatim repeat is always
 *    recoverable in context; near-verbatim repeats (same lines modulo a
 *    uniform line-number shift or ≤ 5 % differing lines) are folded only when
 *    `recoverable` is set and a retrieval hint can name the original.
 */

import { RETRIEVE_ORIGINAL_PREFIX } from './ccr/markers.js';

export interface DedupBlock {
  /** Text of the tool result. */
  text: string;
  /** Absolute message index (stable across turns). */
  messageIndex: number;
  /** Never rewritten (frozen prefix, cache_control, excluded) — still a reference target. */
  protected: boolean;
  /** Tokens of `text` (for the pointer's "N tokens omitted"). */
  tokens: number;
  /** Hash a retrieval hint can name when a near-verbatim fold needs one. */
  hash?: string;
}

export interface DedupFold {
  index: number;
  refMessageIndex: number;
  kind: 'verbatim' | 'near_verbatim';
  pointer: string;
  tokensOmitted: number;
}

export interface DedupOptions {
  minLines?: number;
  minChars?: number;
  /** Allow near-verbatim folds (needs `hash` on the block to be recoverable). */
  recoverable?: boolean;
  /** Fraction of lines that may differ for a near-verbatim match. */
  nearThreshold?: number;
}

export const DEFAULT_MIN_LINES = 3;
export const DEFAULT_MIN_CHARS = 40;
export const DEFAULT_NEAR_THRESHOLD = 0.05;

const LINENO_RE = /^([1-9]\d*)(:|\t)(.*)$/s;

function stripLineNo(line: string): { num: number | null; key: string } {
  const m = LINENO_RE.exec(line);
  if (!m) return { num: null, key: line };
  return { num: Number.parseInt(m[1], 10), key: m[2] + m[3] };
}

/** Lines normalised for matching: trailing whitespace trimmed, line numbers stripped. */
export function normalizedLines(text: string): Array<{ num: number | null; key: string }> {
  return text.split('\n').map((l) => stripLineNo(l.replace(/[ \t\r]+$/, '')));
}

/** Pointer text for a whole-block duplicate (see design §3.4). */
export function dedupPointer(refMessageIndex: number, tokensOmitted: number, opts: { hash?: string; originalTokens?: number } = {}): string {
  let s = `[duplicate of tool result #${refMessageIndex} — ${tokensOmitted} tokens omitted]`;
  if (opts.hash) s += `\n${RETRIEVE_ORIGINAL_PREFIX}${opts.hash} (${opts.originalTokens ?? tokensOmitted} → 0 tokens)`;
  return s;
}

/** True when `a` equals `b` modulo trailing whitespace and a uniform line-number shift. */
function sameModuloShift(a: Array<{ num: number | null; key: string }>, b: Array<{ num: number | null; key: string }>): boolean {
  if (a.length !== b.length) return false;
  let delta: number | null = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key) return false;
    if (a[i].num !== null && b[i].num !== null) {
      const d = (a[i].num as number) - (b[i].num as number);
      if (delta === null) delta = d;
      else if (delta !== d) return false;
    } else if ((a[i].num === null) !== (b[i].num === null)) return false;
  }
  return true;
}

function differingFraction(a: Array<{ key: string }>, b: Array<{ key: string }>): number {
  if (a.length === 0 || b.length === 0) return 1;
  if (Math.abs(a.length - b.length) / Math.max(a.length, b.length) > 0.1) return 1;
  const counts = new Map<string, number>();
  for (const l of b) counts.set(l.key, (counts.get(l.key) ?? 0) + 1);
  let missing = 0;
  for (const l of a) {
    const c = counts.get(l.key) ?? 0;
    if (c > 0) counts.set(l.key, c - 1);
    else missing += 1;
  }
  return (missing + Math.abs(a.length - b.length)) / Math.max(a.length, b.length);
}

/**
 * Fold repeated blocks. Returns the rewritten texts (same length as input,
 * unchanged entries for non-folded blocks) and the folds applied.
 */
export function dedupBlocks(blocks: DedupBlock[], opts: DedupOptions = {}): { texts: string[]; folds: DedupFold[] } {
  const minLines = opts.minLines ?? DEFAULT_MIN_LINES;
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;
  const near = opts.nearThreshold ?? DEFAULT_NEAR_THRESHOLD;
  const texts = blocks.map((b) => b.text);
  const folds: DedupFold[] = [];
  try {
    // Verbatim index over normalised text of blocks that survived un-folded (keep-earliest).
    const exact = new Map<string, number>();
    const corpus: Array<{ pos: number; lines: Array<{ num: number | null; key: string }> }> = [];
    for (let i = 0; i < blocks.length; i++) {
      const blk = blocks[i];
      const lines = normalizedLines(blk.text);
      const normKey = lines.map((l) => l.key).join('\n');
      const eligible = !blk.protected && lines.length >= minLines && blk.text.length >= minChars;
      if (eligible) {
        const ref = exact.get(normKey);
        if (ref !== undefined) {
          const pointer = dedupPointer(blocks[ref].messageIndex, blk.tokens);
          texts[i] = pointer;
          folds.push({ index: i, refMessageIndex: blocks[ref].messageIndex, kind: 'verbatim', pointer, tokensOmitted: blk.tokens });
          continue;
        }
        if (opts.recoverable && blk.hash) {
          let hit: number | undefined;
          for (const c of corpus) {
            if (sameModuloShift(lines, c.lines) || differingFraction(lines, c.lines) <= near) {
              hit = c.pos;
              break;
            }
          }
          if (hit !== undefined) {
            const pointer = dedupPointer(blocks[hit].messageIndex, blk.tokens, { hash: blk.hash, originalTokens: blk.tokens });
            texts[i] = pointer;
            folds.push({ index: i, refMessageIndex: blocks[hit].messageIndex, kind: 'near_verbatim', pointer, tokensOmitted: blk.tokens });
            continue;
          }
        }
      }
      if (lines.length >= minLines && blk.text.length >= minChars) {
        if (!exact.has(normKey)) exact.set(normKey, i);
        corpus.push({ pos: i, lines });
      }
    }
    return { texts, folds };
  } catch {
    return { texts: blocks.map((b) => b.text), folds: [] };
  }
}

/** Cache-safety check used by tests: dedup(prefix) equals the prefix of dedup(all). */
export function isPrefixMonotonic(blocks: DedupBlock[], opts: DedupOptions = {}): boolean {
  const full = dedupBlocks(blocks, opts).texts;
  for (let k = 1; k <= blocks.length; k++) {
    const partial = dedupBlocks(blocks.slice(0, k), opts).texts;
    for (let i = 0; i < k; i++) if (partial[i] !== full[i]) return false;
  }
  return true;
}
