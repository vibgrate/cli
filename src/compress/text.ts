/**
 * Deterministic extractive text compressor. Splits prose into sentence
 * segments, scores each by position, BM25 relevance to the query, keyword
 * salience and must-keep tokens (hex, numbers, ALLCAPS, paths, flags,
 * CamelCase, directive words such as "not"/"must"/"never"), suppresses
 * near-duplicates with word shingles, and keeps the top segments — verbatim,
 * in original order — under a character budget. Segments carrying error
 * anchors are never dropped. With no `targetRatio` the budget is derived from
 * an Otsu split of the score distribution (clamped to 30..80%).
 */

import { isAnchorLine } from './anchors.js';
import { adaptiveThreshold, scoreRelevance } from './relevance.js';
import { clamp, type CompressRequest, type CompressResponse, type Compressor } from './types.js';

export interface TextCompressorConfig {
  targetRatio: number;
  wRecency: number;
  wRelevance: number;
  wSalience: number;
  wMustKeep: number;
  minSegmentChars: number;
  nearDupThreshold: number;
  minSegments: number;
  minWords: number;
}

export const DEFAULT_TEXT_CONFIG: Readonly<TextCompressorConfig> = {
  targetRatio: 0.5,
  wRecency: 1.0,
  wRelevance: 2.0,
  wSalience: 1.5,
  wMustKeep: 1.0,
  minSegmentChars: 12,
  nearDupThreshold: 0.85,
  minSegments: 6,
  minWords: 64,
};

export const SALIENT_KEYWORDS: readonly string[] = ['error', 'exception', 'failed', 'failure', 'fail', 'warning', 'traceback', 'assert', 'todo', 'fixme'];

const DIRECTIVES = "not|never|none|cannot|can't|don't|doesn't|didn't|won't|shouldn't|mustn't|isn't|aren't|avoid|refuse|prohibited|forbidden|disallow|unless|except|without|must|should|shall|required|always|only|mandatory";
const EXTENSIONS = 'ts|js|py|go|rs|java|json|yaml|yml|toml|md|txt|sh|cfg|ini|env';
const TRAILING_PUNCTUATION = '[.,;:!?]?$';

/**
 * Word shapes that must survive verbatim, and whose case carries the meaning:
 * hex, numbers, `ALL_CAPS` constants, dotted names, paths, `--flags` and
 * `camelCase` identifiers.
 *
 * Deliberately **not** case-insensitive. An `i` flag here would let
 * `[A-Z][A-Z0-9_]{1,}` match any two-letter word, so every word of ordinary
 * prose would count as must-keep and the signal would say nothing.
 */
export const MUST_KEEP_RE = new RegExp(
  `^(?:0x[0-9a-fA-F]+|\\d+(?:[.,]\\d+)*|[A-Z][A-Z0-9_]{1,}|[\\w-]+(?:\\.[\\w-]+){2,}|(?:\\.{0,2}/)?(?:[\\w.-]+/)+[\\w.-]*|--?[a-zA-Z][\\w-]*|[a-z]+(?:[A-Z][a-z0-9]+)+)${TRAILING_PUNCTUATION}`,
);

/** The shapes whose case genuinely does not matter: file names and the words that negate a sentence. */
export const MUST_KEEP_CASELESS_RE = new RegExp(`^(?:[\\w-]+\\.(?:${EXTENSIONS})|(?:${DIRECTIVES}))${TRAILING_PUNCTUATION}`, 'i');

function isCjk(cp: number): boolean {
  return (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x2fa1f);
}

function hasCjk(s: string): boolean {
  for (const ch of s) if (isCjk(ch.codePointAt(0) as number)) return true;
  return false;
}

/** Sentence-ish segments: per line, split after `.!?` + whitespace (ASCII) or after `。！？` with a length fallback (CJK). Trimmed, non-empty. */
export function splitSegments(text: string): string[] {
  const segs: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (hasCjk(t)) {
      let piece = '';
      for (const ch of t) {
        piece += ch;
        const n = [...piece].length;
        const term = ch === '。' || ch === '！' || ch === '？';
        const soft = /\s/.test(ch) || ch === '、' || ch === '，' || ch === '；' || ch === '：';
        if (term || (soft && n >= 20) || n >= 40) {
          const s = piece.trim();
          if (s) segs.push(s);
          piece = '';
        }
      }
      const s = piece.trim();
      if (s) segs.push(s);
      continue;
    }
    let cur = '';
    let prevTerm = false;
    for (const ch of t) {
      if (prevTerm && /\s/.test(ch)) {
        const s = cur.trim();
        if (s) segs.push(s);
        cur = '';
        prevTerm = false;
        continue;
      }
      cur += ch;
      prevTerm = ch === '.' || ch === '!' || ch === '?';
    }
    const s = cur.trim();
    if (s) segs.push(s);
  }
  return segs;
}

/** Lowercased alnum/underscore runs; CJK characters become single-character tokens. */
export function textTokens(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  const flush = (): void => {
    if (cur) {
      out.push(cur.toLowerCase());
      cur = '';
    }
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (isCjk(cp)) {
      flush();
      out.push(ch);
    } else if (/[\p{L}\p{N}_]/u.test(ch)) cur += ch;
    else flush();
  }
  flush();
  return out;
}

export function shingles(tokens: readonly string[], k = 3): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + k <= tokens.length; i++) out.add(tokens.slice(i, i + k).join(' '));
  return out;
}

function isSalient(word: string): boolean {
  const w = word.toLowerCase();
  return SALIENT_KEYWORDS.some((k) => w.includes(k));
}

export function mustKeepFraction(segment: string): number {
  const words = segment.split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let n = 0;
  for (const w of words) if (w.length > 1 && (MUST_KEEP_RE.test(w) || MUST_KEEP_CASELESS_RE.test(w))) n++;
  return n / words.length;
}

export interface TextCompression {
  text: string;
  keptSegments: number;
  totalSegments: number;
  ratio: number;
  pinned: number;
}

/**
 * Extractive selection. `targetRatio` undefined → adaptive budget from the
 * score distribution. Returns null when the input is too small to compress.
 */
export function compressText(content: string, query = '', targetRatio?: number, cfg: TextCompressorConfig = DEFAULT_TEXT_CONFIG): TextCompression | null {
  const segments = splitSegments(content);
  const n = segments.length;
  if (n < cfg.minSegments) return null;
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  if (wordCount < Math.max(10, cfg.minWords) && !hasCjk(content)) return null;
  const tokens = segments.map(textTokens);
  const relevance = query.trim() ? scoreRelevance(segments, query).map((r) => r.score) : segments.map(() => 0);
  const pinned = segments.map((s) => isAnchorLine(s));
  const scores = segments.map((seg, i) => {
    const recency = (i + 1) / n;
    const words = hasCjk(seg) ? tokens[i] : seg.split(/\s+/).filter(Boolean);
    const salient = words.filter(isSalient).length;
    const salience = salient / (words.length + 1);
    let score = cfg.wRecency * recency + cfg.wRelevance * relevance[i] + cfg.wSalience * salience + cfg.wMustKeep * mustKeepFraction(seg);
    if (seg.length < cfg.minSegmentChars) score *= 0.25;
    return score;
  });
  const totalChars = segments.reduce((a, s) => a + s.length, 0);
  let ratio: number;
  if (targetRatio !== undefined && Number.isFinite(targetRatio)) ratio = clamp(targetRatio, 0.05, 1);
  else {
    const cut = adaptiveThreshold(scores, 0);
    const keepFrac = scores.filter((s) => s >= cut).length / n;
    ratio = clamp(keepFrac, 0.3, 0.8);
  }
  const budget = Math.max(1, Math.trunc(totalChars * ratio));
  const order = segments.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
  const kept = new Array<boolean>(n).fill(false);
  const seen = new Set<string>();
  let keptChars = 0;
  let keptCount = 0;
  let pinnedCount = 0;
  // pinned segments first (never dropped), then greedy by score under budget
  for (let i = 0; i < n; i++) {
    if (!pinned[i]) continue;
    kept[i] = true;
    keptCount++;
    pinnedCount++;
    keptChars += segments[i].length;
    for (const s of shingles(tokens[i])) seen.add(s);
  }
  for (const i of order) {
    if (kept[i]) continue;
    if (keptChars >= budget) break;
    const sh = shingles(tokens[i]);
    if (sh.size) {
      let covered = 0;
      for (const s of sh) if (seen.has(s)) covered++;
      if (covered / sh.size >= cfg.nearDupThreshold) continue;
    }
    kept[i] = true;
    keptCount++;
    keptChars += segments[i].length;
    for (const s of sh) seen.add(s);
  }
  if (keptCount === 0 || keptCount === n) return null;
  const text = segments.filter((_, i) => kept[i]).join('\n');
  return { text, keptSegments: keptCount, totalSegments: n, ratio: text.length / Math.max(1, content.length), pinned: pinnedCount };
}

export class TextCompressor implements Compressor {
  readonly strategy = 'text' as const;
  readonly config: TextCompressorConfig;

  constructor(config: Partial<TextCompressorConfig> = {}) {
    this.config = { ...DEFAULT_TEXT_CONFIG, ...config };
  }

  compress(req: CompressRequest): CompressResponse {
    const content = req.content;
    const passthrough = (info: string): CompressResponse => ({ content, strategy: 'passthrough', chain: ['text', 'passthrough'], ccrHashes: [], info });
    try {
      const r = compressText(content, req.query ?? '', req.targetRatio, this.config);
      if (!r) return passthrough('too_small_or_nothing_kept');
      if (r.text.length >= content.length) return passthrough('no_savings');
      return { content: r.text, strategy: 'text', chain: ['text'], ccrHashes: [], info: `text(${r.totalSegments}->${r.keptSegments} segments${r.pinned ? `, ${r.pinned} pinned` : ''})`, itemCounts: { original: r.totalSegments, kept: r.keptSegments } };
    } catch {
      return passthrough('error');
    }
  }
}
