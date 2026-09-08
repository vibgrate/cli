/**
 * Token accounting for the context-compression layer.
 *
 * Two paths:
 *  - `tokenizerFor(model)` — the canonical budget counter. Exact `cl100k_base`
 *    counts (shared with the rest of vg via `src/engine/tokens.ts`) scaled by a
 *    per-family factor so a Claude/Gemini/Llama request is not systematically
 *    under-counted. Deterministic and offline.
 *  - `estimateTokens(text, model)` — the fast pre-gate. Character heuristics
 *    calibrated per content type (prose 4.0 chars/token, code 3.5, JSON 3.2,
 *    dense CJK scripts 1.5) plus URL/UUID overhead. Never used for anything
 *    that reaches the wire; only for "is this block big enough to bother".
 */

import { countTokens } from '../engine/tokens.js';
import { isDenseScript, type Tokenizer } from './types.js';

export type TokenizerFamily = 'openai' | 'anthropic' | 'gemini' | 'llama' | 'unknown';

/** Multiplier applied to a cl100k count to approximate the family's tokenizer. */
export const FAMILY_FACTORS: Readonly<Record<TokenizerFamily, number>> = {
  openai: 1,
  anthropic: 1.15,
  gemini: 1,
  llama: 1.1,
  unknown: 1,
};

/** Fixed chars-per-token used by `estimateTokens` for families without a cl100k-like BPE. */
const FAMILY_CHARS_PER_TOKEN: Readonly<Partial<Record<TokenizerFamily, number>>> = {
  anthropic: 3.5,
  gemini: 4.0,
  llama: 3.8,
};

export const CHARS_PER_TOKEN = 4.0;
export const CHARS_PER_TOKEN_CODE = 3.5;
export const CHARS_PER_TOKEN_JSON = 3.2;
export const CHARS_PER_TOKEN_CJK = 1.5;

/**
 * Progressive unwrapping of gateway-prefixed model ids, most specific first:
 *   `openrouter/anthropic/claude-x` → `anthropic/claude-x` → `claude-x`
 *   `us.anthropic.claude-…-v1:0`    → `anthropic.claude-…-v1:0` → `claude-…-v1:0` → `claude-…`
 * Dated suffixes (`-20250929`, `@20251101`) and Bedrock version tails (`-v1:0`)
 * are stripped as extra candidates so a pinned snapshot resolves to its family.
 */
export function modelIdCandidates(model: string): string[] {
  const out: string[] = [];
  const push = (s: string): void => {
    const t = s.trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  };
  const base = model.trim().toLowerCase();
  push(base);
  // slash-separated gateway prefixes
  const slash = base.split('/');
  for (let i = 1; i < slash.length; i++) push(slash.slice(i).join('/'));
  // dotted bedrock prefixes on every slash candidate
  const snapshot = [...out];
  for (const c of snapshot) {
    const dots = c.split('.');
    // only treat as a prefix chain when the segment before the dot has no digits
    // (so `gpt-4.1` / `claude-3.5` style ids are never split)
    for (let i = 1; i < dots.length; i++) {
      const head = dots.slice(0, i).join('.');
      if (/\d/.test(head)) break;
      push(dots.slice(i).join('.'));
    }
  }
  // strip version / date tails
  const snapshot2 = [...out];
  for (const c of snapshot2) {
    let s = c;
    s = s.replace(/-v\d+:\d+$/, '');
    s = s.replace(/:\d+$/, '');
    push(s);
    const undated = s.replace(/[-@]\d{8}$/, '');
    push(undated);
    push(undated.replace(/-latest$/, ''));
  }
  return out;
}

const OPENAI_RE = /^(gpt-|o[1-9](?:-|$)|text-embedding|text-davinci|code-|davinci|curie|babbage|ada|chatgpt)/;
const ANTHROPIC_RE = /^(claude|anthropic\.)/;
const GEMINI_RE = /^(gemini|palm|gemma)/;
const LLAMA_RE = /^(llama|meta-llama|codellama|mistral|mixtral|codestral|ministral|pixtral|qwen|qwq|deepseek|phi-?\d|yi-|falcon|mpt-|starcoder|codegen|grok|kimi|moonshot)/;

export function tokenizerFamily(model?: string): TokenizerFamily {
  if (!model) return 'unknown';
  for (const c of modelIdCandidates(model)) {
    if (OPENAI_RE.test(c)) return 'openai';
    if (ANTHROPIC_RE.test(c)) return 'anthropic';
    if (GEMINI_RE.test(c)) return 'gemini';
    if (LLAMA_RE.test(c)) return 'llama';
  }
  return 'unknown';
}

const tokenizerCache = new Map<string, Tokenizer>();

/** Exact cl100k counter (family factor 1). */
export const CL100K: Tokenizer = { id: 'cl100k', count: (text: string): number => (text ? countTokens(text) : 0) };

/**
 * cl100k exact count scaled by the family factor. The `id` names the family
 * for labels, e.g. `cl100k`, `anthropic~cl100k*1.15`, `gemini~cl100k`.
 */
export function tokenizerFor(model?: string): Tokenizer {
  const family = tokenizerFamily(model);
  const factor = FAMILY_FACTORS[family];
  if (family === 'openai' || factor === 1) {
    if (family === 'openai' || family === 'unknown') return CL100K;
  }
  const id = factor === 1 ? `${family}~cl100k` : `${family}~cl100k*${factor.toFixed(2)}`;
  const cached = tokenizerCache.get(id);
  if (cached) return cached;
  const tok: Tokenizer = {
    id,
    count: (text: string): number => {
      if (!text) return 0;
      const n = countTokens(text);
      return Math.max(1, Math.round(n * factor));
    },
  };
  tokenizerCache.set(id, tok);
  return tok;
}

const CODE_PATTERN = /(?:def |class |function |const |let |var |import |from |if \(|for \(|while \(|switch \(|try \{|catch \(|=>|->|\{\{|\}\}|;$)/gm;
const URL_PATTERN = /https?:\/\/\S+/g;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const JSON_PARSE_CAP = 1_000_000;

/** Count dense-script (CJK / Kana / Hangul / full-width) code points. */
export function countDenseChars(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i) as number;
    if (cp > 0xffff) i++;
    if (isDenseScript(cp)) n++;
  }
  return n;
}

function countMatches(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) {
    n++;
    if (re.lastIndex === 0) break;
  }
  return n;
}

/** Pick the chars-per-token ratio from the content shape (JSON < code < prose). */
export function detectCharsPerToken(text: string): number {
  const head = text.trimStart();
  if (head.startsWith('[') || head.startsWith('{')) {
    if (text.length > JSON_PARSE_CAP) return CHARS_PER_TOKEN_JSON;
    try {
      JSON.parse(text);
      return CHARS_PER_TOKEN_JSON;
    } catch {
      /* not JSON */
    }
  }
  const codeMatches = countMatches(CODE_PATTERN, text);
  if (codeMatches > text.length / 500) return CHARS_PER_TOKEN_CODE;
  return CHARS_PER_TOKEN;
}

/** URLs tokenize per path segment; UUIDs cost ~2 extra tokens each. */
export function specialOverhead(text: string): number {
  let overhead = 0;
  URL_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_PATTERN.exec(text)) !== null) {
    const url = m[0];
    for (let i = 0; i < url.length; i++) {
      const ch = url.charCodeAt(i);
      if (ch === 47 || ch === 63 || ch === 38) overhead++;
    }
  }
  overhead += countMatches(UUID_PATTERN, text) * 2;
  return overhead;
}

/**
 * Fast token estimate (pre-gates only). Fixed-ratio families price dense
 * scripts separately; the auto path detects JSON/code/prose and adds
 * URL/UUID overhead. Empty → 0, otherwise ≥ 1.
 */
export function estimateTokens(text: string, model?: string): number {
  if (!text) return 0;
  const family = tokenizerFamily(model);
  const fixed = FAMILY_CHARS_PER_TOKEN[family];
  const dense = countDenseChars(text);
  const other = text.length - dense;
  if (fixed !== undefined) {
    return Math.max(1, Math.trunc(other / fixed + dense / CHARS_PER_TOKEN_CJK + 0.5));
  }
  const ratio = detectCharsPerToken(text);
  const base = Math.trunc(other / ratio + dense / CHARS_PER_TOKEN_CJK + 0.5);
  return Math.max(1, base + specialOverhead(text));
}
