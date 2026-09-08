/**
 * Prior-turn reasoning compaction.
 *
 * Models that re-bill prior-turn thinking as input make it worth shrinking;
 * editing a signed `thinking` block in place is futile (the provider pins the
 * original via the signature), so the block is converted to a plain `text`
 * block carrying the compacted text. Cache safety comes from determinism: the
 * same thinking always maps to the same bytes (memoised by content hash), so
 * the forwarded prefix stays stable turn over turn. The last `keepLast`
 * assistant turns keep their reasoning verbatim.
 *
 * Also handles OpenAI-chat shapes that resend reasoning as plain text
 * (`reasoning_content`, inline `<think>…</think>`).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Message } from './types.js';

export const THINKING_MARKER = '[prior reasoning, compressed]';
export const DEFAULT_THINKING_MIN_WORDS = 40;
const MEMO_CAP = 8192;

export interface ThinkingStats {
  turnsCompacted: number;
  blocks: number;
  wordsBefore: number;
  wordsAfter: number;
}

export type TextCompactor = (text: string) => string | null | undefined;

const encoder = new TextEncoder();
const memo = new Map<string, string>();

function memoKey(text: string): string {
  return bytesToHex(sha256(encoder.encode(text)));
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function memoCompact(text: string, compact: TextCompactor): string | null {
  const key = memoKey(text);
  const cached = memo.get(key);
  if (cached !== undefined) {
    memo.delete(key);
    memo.set(key, cached);
    return cached;
  }
  let out: string | null | undefined;
  try {
    out = compact(text);
  } catch {
    return null;
  }
  if (typeof out !== 'string' || !out) return null;
  memo.set(key, out);
  while (memo.size > MEMO_CAP) {
    const first = memo.keys().next().value;
    if (first === undefined) break;
    memo.delete(first);
  }
  return out;
}

/** Test hook. */
export function resetThinkingMemo(): void {
  memo.clear();
}

/**
 * Conservative heuristic gate used when the model registry is unavailable:
 * true for Claude 4.6+ and 5.x ids (they re-bill prior thinking), false otherwise.
 */
export function billsPriorThinkingHeuristic(model: string): boolean {
  const lower = model.toLowerCase();
  if (!lower.includes('claude')) return false;
  const nums: number[] = [];
  for (const part of lower.split('-')) {
    if (/^\d+$/.test(part)) nums.push(Number.parseInt(part, 10));
    else if (nums.length) break;
  }
  if (nums.length === 0) return false;
  const major = nums[0];
  const minor = nums[1] ?? 0;
  return major >= 5 || (major === 4 && minor >= 6);
}

function assistantIndices(messages: Message[]): number[] {
  const out: number[] = [];
  messages.forEach((m, i) => {
    if (m && typeof m === 'object' && (m as Record<string, unknown>).role === 'assistant') out.push(i);
  });
  return out;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Anthropic `thinking` blocks → compacted `text` blocks (mutates `messages` in place). */
export function compactThinkingBlocks(messages: Message[], opts: { compact: TextCompactor; keepLast?: number; minWords?: number }): ThinkingStats {
  const stats: ThinkingStats = { turnsCompacted: 0, blocks: 0, wordsBefore: 0, wordsAfter: 0 };
  const keepLast = Math.max(0, opts.keepLast ?? 1);
  const minWords = opts.minWords ?? DEFAULT_THINKING_MIN_WORDS;
  const asst = assistantIndices(messages);
  const keep = new Set(keepLast > 0 ? asst.slice(-keepLast) : []);
  for (const i of asst) {
    if (keep.has(i)) continue;
    const m = messages[i] as Record<string, unknown>;
    if (!Array.isArray(m.content)) continue;
    let changed = false;
    const next = m.content.map((b) => {
      if (!isObj(b) || b.type !== 'thinking' || typeof b.thinking !== 'string') return b;
      const text = b.thinking;
      const wb = words(text);
      if (wb < minWords) return b;
      const compacted = memoCompact(text, opts.compact);
      if (compacted === null || words(compacted) >= wb) return b;
      const block: Record<string, unknown> = { type: 'text', text: `${THINKING_MARKER} ${compacted}` };
      if ('cache_control' in b) block.cache_control = b.cache_control;
      changed = true;
      stats.blocks += 1;
      stats.wordsBefore += wb;
      stats.wordsAfter += words(compacted);
      return block;
    });
    if (changed) {
      m.content = next;
      stats.turnsCompacted += 1;
    }
  }
  return stats;
}

function compactThinkSpans(content: string, compact: TextCompactor, minWords: number): { text: string; blocks: number; wordsBefore: number; wordsAfter: number } {
  const open = '<think>';
  const close = '</think>';
  let blocks = 0;
  let wb = 0;
  let wa = 0;
  const parts: string[] = [];
  let pos = 0;
  for (;;) {
    const start = content.indexOf(open, pos);
    if (start === -1) {
      parts.push(content.slice(pos));
      break;
    }
    const end = content.indexOf(close, start + open.length);
    if (end === -1) {
      parts.push(content.slice(pos));
      break;
    }
    parts.push(content.slice(pos, start));
    const inner = content.slice(start + open.length, end);
    const w = words(inner);
    let next = inner;
    if (w >= minWords) {
      const c = memoCompact(inner, compact);
      if (c !== null && words(c) < w) {
        next = c;
        blocks += 1;
        wb += w;
        wa += words(c);
      }
    }
    parts.push(`${open}${next}${close}`);
    pos = end + close.length;
  }
  return { text: parts.join(''), blocks, wordsBefore: wb, wordsAfter: wa };
}

/** OpenAI-chat plain-text reasoning (`reasoning_content`, `<think>`) → compacted (mutates in place). */
export function compactReasoningText(messages: Message[], opts: { compact: TextCompactor; keepLast?: number; minWords?: number }): ThinkingStats {
  const stats: ThinkingStats = { turnsCompacted: 0, blocks: 0, wordsBefore: 0, wordsAfter: 0 };
  const keepLast = Math.max(0, opts.keepLast ?? 1);
  const minWords = opts.minWords ?? DEFAULT_THINKING_MIN_WORDS;
  const asst = assistantIndices(messages);
  const keep = new Set(keepLast > 0 ? asst.slice(-keepLast) : []);
  for (const i of asst) {
    if (keep.has(i)) continue;
    const m = messages[i] as Record<string, unknown>;
    let changed = false;
    const rc = m.reasoning_content;
    if (typeof rc === 'string' && words(rc) >= minWords) {
      const c = memoCompact(rc, opts.compact);
      if (c !== null && words(c) < words(rc)) {
        stats.blocks += 1;
        stats.wordsBefore += words(rc);
        stats.wordsAfter += words(c);
        m.reasoning_content = c;
        changed = true;
      }
    }
    if (typeof m.content === 'string' && m.content.includes('<think>')) {
      const r = compactThinkSpans(m.content, opts.compact, minWords);
      if (r.blocks) {
        m.content = r.text;
        stats.blocks += r.blocks;
        stats.wordsBefore += r.wordsBefore;
        stats.wordsAfter += r.wordsAfter;
        changed = true;
      }
    }
    if (changed) stats.turnsCompacted += 1;
  }
  return stats;
}

/** Run both shapes. */
export function compactThinking(messages: Message[], opts: { compact: TextCompactor; keepLast?: number; minWords?: number }): ThinkingStats {
  const a = compactThinkingBlocks(messages, opts);
  const b = compactReasoningText(messages, opts);
  return { turnsCompacted: a.turnsCompacted + b.turnsCompacted, blocks: a.blocks + b.blocks, wordsBefore: a.wordsBefore + b.wordsBefore, wordsAfter: a.wordsAfter + b.wordsAfter };
}
