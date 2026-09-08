/**
 * Memory ranking — offline, deterministic, no model required.
 *
 *   final = relevance × recency × evidenceBoost × scopeWeight
 *
 *  - relevance: BM25 over text + tags, normalised by the best score in the
 *    candidate set (0..1). When a query vector and memory vectors are
 *    supplied, relevance becomes 0.5·bm25 + 0.5·cosine (hybrid).
 *  - recency: exp(−ageDays / 30) on `updatedAt`; missing/negative age → 1.
 *  - evidenceBoost: min(1, 0.5 + 0.1·evidence) — a memory seen 5+ times is
 *    fully trusted, a single observation is discounted.
 *  - scopeWeight: project 1.0 · user 0.9 · global 0.8 so the most specific
 *    scope wins ties.
 *
 * Ties are broken by `updatedAt` desc, then `id` asc, so the same input
 * always yields the same order (prefix-cache stability across turns).
 */

import type { Memory, MemoryScope, SearchHit } from './types.js';

export const RECENCY_DECAY_DAYS = 30;
export const SCOPE_WEIGHTS: Readonly<Record<MemoryScope, number>> = { project: 1, user: 0.9, global: 0.8 };
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const DAY_MS = 86_400_000;

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'be', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from',
  'i', 'we', 'you', 'my', 'our', 'your', 'me', 'us', 'do', 'does', 'did', 'was', 'were', 'has', 'have', 'had', 'not', 'no', 'so', 'if',
  'about', 'what', 'which', 'how', 'when', 'where', 'who', 'any', 'all', 'can', 'should', 'would', 'will', 'use', 'using', 'used',
]);

/** Light plural stemming: `tests` → `test`, `queries` → `query`; never touches `ss`. */
export function stem(token: string): string {
  if (token.length >= 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length >= 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** Jaccard overlap of the token sets of two texts (0..1). */
export function jaccard(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Lower-case word tokens (letters, digits, `_`, `-`, `.`, `/`), stop words removed, plurals stemmed. Linear time. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  let cur = '';
  const flush = (): void => {
    if (cur.length > 1 && !STOP.has(cur)) out.push(/^[a-z]+$/.test(cur) ? stem(cur) : cur);
    cur = '';
  };
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    const code = lower.charCodeAt(i);
    const word = (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || ch === '_' || ch === '-' || ch === '.' || ch === '/' || code > 127;
    if (word) cur += ch;
    else flush();
  }
  flush();
  // Also emit path/dotted components so `src/auth` matches `auth`.
  const extra: string[] = [];
  for (const t of out) {
    if (t.includes('/') || t.includes('.') || t.includes('-')) {
      for (const part of t.split(/[/.\-]+/)) if (part.length > 1 && !STOP.has(part)) extra.push(stem(part));
    }
  }
  return out.concat(extra);
}

function termFreq(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Document text used for lexical matching: statement + tags. */
export function memoryDocument(m: Memory): string {
  return m.tags.length ? `${m.text} ${m.tags.join(' ')}` : m.text;
}

/** Raw BM25 scores for `query` against `docs` (same order as `docs`). */
export function bm25(query: string, docs: string[]): number[] {
  const q = [...new Set(tokenize(query))];
  const docTokens = docs.map(tokenize);
  const n = docs.length;
  if (n === 0 || q.length === 0) return docs.map(() => 0);
  const avgLen = docTokens.reduce((a, t) => a + t.length, 0) / n || 1;
  const df = new Map<string, number>();
  const tfs = docTokens.map(termFreq);
  for (const tf of tfs) for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  return tfs.map((tf, i) => {
    let score = 0;
    const len = docTokens[i].length;
    for (const term of q) {
      const f = tf.get(term);
      if (!f) continue;
      const d = df.get(term) ?? 0;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * len) / avgLen)));
    }
    return score;
  });
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** exp(−ageDays/decay); 1 for missing or future timestamps. */
export function recencyFactor(updatedAt: number | undefined, now: number, decayDays = RECENCY_DECAY_DAYS): number {
  if (updatedAt === undefined || !Number.isFinite(updatedAt)) return 1;
  const ageDays = (now - updatedAt) / DAY_MS;
  if (ageDays <= 0) return 1;
  return Math.exp(-ageDays / decayDays);
}

export function evidenceBoost(evidence: number): number {
  const e = Number.isFinite(evidence) && evidence > 0 ? evidence : 1;
  return Math.min(1, 0.5 + 0.1 * e);
}

export interface RankOptions {
  now: number;
  topK?: number;
  minScore?: number;
  queryVector?: number[];
  /** Memory id → vector (only used when `queryVector` is present). */
  vectors?: ReadonlyMap<string, number[]>;
  decayDays?: number;
}

/** Deterministic ordering: score desc, updatedAt desc, id asc. */
export function compareHits(a: SearchHit, b: SearchHit): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.memory.updatedAt !== a.memory.updatedAt) return b.memory.updatedAt - a.memory.updatedAt;
  return a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0;
}

/**
 * Rank `memories` for `query`. Pure: never mutates inputs. An empty query
 * ranks by recency × evidence × scope alone (a "what do you know" listing).
 */
export function rankMemories(memories: readonly Memory[], query: string, opts: RankOptions): SearchHit[] {
  if (memories.length === 0) return [];
  const docs = memories.map(memoryDocument);
  const hasQuery = tokenize(query).length > 0;
  const raw = hasQuery ? bm25(query, docs) : docs.map(() => 1);
  const max = Math.max(...raw);
  const lexical = raw.map((s) => (max > 0 ? s / max : 0));

  const useVectors = opts.queryVector !== undefined && opts.vectors !== undefined && opts.queryVector.length > 0;
  const hits: SearchHit[] = memories.map((m, i) => {
    let relevance = lexical[i];
    if (useVectors) {
      const v = opts.vectors?.get(m.id);
      const sim = v ? Math.max(0, cosine(opts.queryVector as number[], v)) : 0;
      relevance = 0.5 * lexical[i] + 0.5 * sim;
    }
    const score = relevance * recencyFactor(m.updatedAt, opts.now, opts.decayDays) * evidenceBoost(m.evidence) * (SCOPE_WEIGHTS[m.scope] ?? 0.8);
    return { memory: m, score: round6(score) };
  });

  const minScore = opts.minScore ?? 0;
  const filtered = hits.filter((h) => (hasQuery ? h.score > 0 : true) && h.score >= minScore);
  filtered.sort(compareHits);
  const k = opts.topK ?? filtered.length;
  return filtered.slice(0, Math.max(0, k));
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
