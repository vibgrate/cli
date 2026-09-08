/**
 * Lexical relevance: BM25 (single-doc neutral idf, batch real idf), the
 * hybrid-style sparse floors (any match ≥ 0.3, ≥2 matched terms +0.2), query
 * anchor extraction (UUIDs, numeric ids, hostnames, quoted strings, emails),
 * keyword extraction from a user ask + tool args, and the Otsu split used to
 * turn a score distribution into a KEEP/DROP plan. All deterministic; ties
 * break by first occurrence.
 */

export interface RelevanceScore {
  score: number;
  matched: string[];
}

const TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b\d{4,}\b|[a-z0-9_]+/g;

/** Lowercase tokens: UUIDs whole, 4+ digit ids whole, then `[a-z0-9_]+` runs. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const out: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(lower)) !== null) out.push(m[0]);
  return out;
}

export interface Bm25Options {
  k1?: number;
  b?: number;
  maxScore?: number;
  normalize?: boolean;
}

export class BM25Scorer {
  readonly k1: number;
  readonly b: number;
  readonly maxScore: number;
  readonly normalize: boolean;

  constructor(opts: Bm25Options = {}) {
    this.k1 = opts.k1 ?? 1.5;
    this.b = opts.b ?? 0.75;
    this.maxScore = opts.maxScore ?? 10;
    this.normalize = opts.normalize ?? true;
  }

  private termScore(f: number, docLen: number, avgdl: number, idf: number): number {
    const num = f * (this.k1 + 1);
    const den = f + this.k1 * (1 - this.b + (this.b * docLen) / avgdl);
    return (idf * num) / den;
  }

  private finalize(raw: number, matched: string[]): number {
    let s = this.normalize ? Math.min(1, raw / this.maxScore) : raw;
    if (matched.some((t) => t.length >= 8)) s = Math.min(1, s + 0.3);
    return s;
  }

  private queryFreq(query: string): Map<string, number> {
    const qf = new Map<string, number>();
    for (const t of tokenize(query)) qf.set(t, (qf.get(t) ?? 0) + 1);
    return qf;
  }

  /** Single document vs query; neutral idf ln(2). */
  score(item: string, query: string): RelevanceScore {
    const docTokens = tokenize(item);
    const qf = this.queryFreq(query);
    const { raw, matched } = this.bm25(docTokens, qf, 0, () => Math.LN2);
    return { score: this.finalize(raw, matched), matched: matched.slice(0, 10) };
  }

  /** Batch scoring with a real idf over the batch. */
  scoreBatch(items: readonly string[], query: string): RelevanceScore[] {
    const qf = this.queryFreq(query);
    if (qf.size === 0) return items.map(() => ({ score: 0, matched: [] }));
    const all = items.map((it) => tokenize(it));
    const total = all.reduce((a, t) => a + t.length, 0);
    const avg = total / Math.max(items.length, 1);
    const df = new Map<string, number>();
    for (const toks of all) {
      const uniq = new Set(toks);
      for (const t of uniq) if (qf.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = items.length;
    const idf = (term: string): number => {
      const d = df.get(term) ?? 0;
      return Math.log((n - d + 0.5) / (d + 0.5) + 1);
    };
    return all.map((toks) => {
      const { raw, matched } = this.bm25(toks, qf, avg, idf);
      return { score: this.finalize(raw, matched), matched: matched.slice(0, 5) };
    });
  }

  private bm25(docTokens: string[], qf: Map<string, number>, avgDocLen: number, idf: (t: string) => number): { raw: number; matched: string[] } {
    if (docTokens.length === 0 || qf.size === 0) return { raw: 0, matched: [] };
    const docLen = docTokens.length;
    const avgdl = avgDocLen > 0 ? avgDocLen : docLen > 0 ? docLen : 1;
    const freq = new Map<string, number>();
    for (const t of docTokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    const keys = [...qf.keys()].sort();
    let raw = 0;
    const matched: string[] = [];
    for (const term of keys) {
      const f = freq.get(term);
      if (f === undefined) continue;
      matched.push(term);
      raw += this.termScore(f, docLen, avgdl, idf(term)) * (qf.get(term) as number);
    }
    return { raw, matched };
  }
}

const DEFAULT_SCORER = new BM25Scorer();

/**
 * Hybrid-style lexical score: BM25 with the sparse floors the hybrid scorer
 * applies when embeddings are unavailable (any match ≥ 0.3; ≥2 matched terms
 * +0.2; cap 1). This is what the compressors use to pin query-relevant items.
 */
export function scoreRelevance(items: readonly string[], query: string, scorer: BM25Scorer = DEFAULT_SCORER): RelevanceScore[] {
  if (!query.trim() || items.length === 0) return items.map(() => ({ score: 0, matched: [] }));
  return scorer.scoreBatch(items, query).map((r) => {
    let s = r.score;
    if (r.matched.length > 0) s = Math.max(s, 0.3);
    if (r.matched.length >= 2) s = Math.min(1, s + 0.2);
    return { score: s, matched: r.matched };
  });
}

// ---------------------------------------------------------------------------
// Query anchors
// ---------------------------------------------------------------------------

const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const NUMERIC_ID_RE = /\b\d{4,}\b/g;
const HOSTNAME_RE = /\b[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z]{2,})?\b/g;
const QUOTED_RE = /['"]([^'"]{1,50})['"]/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const HOSTNAME_FALSE_POSITIVES = new Set(['e.g', 'i.e', 'etc.']);

function collect(re: RegExp, text: string, into: Set<string>, transform: (m: RegExpExecArray) => string | null): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = transform(m);
    if (v !== null) into.add(v);
    if (m[0].length === 0) re.lastIndex++;
  }
}

/** Exact-match anchors from a user ask (sorted for determinism). */
export function extractQueryAnchors(text: string): string[] {
  const out = new Set<string>();
  if (!text) return [];
  collect(UUID_RE, text, out, (m) => m[0].toLowerCase());
  collect(NUMERIC_ID_RE, text, out, (m) => m[0]);
  collect(HOSTNAME_RE, text, out, (m) => {
    const lc = m[0].toLowerCase();
    return HOSTNAME_FALSE_POSITIVES.has(lc) ? null : lc;
  });
  collect(QUOTED_RE, text, out, (m) => (m[1].trim().length >= 2 ? m[1].toLowerCase() : null));
  collect(EMAIL_RE, text, out, (m) => m[0].toLowerCase());
  return [...out].sort();
}

/** Python-`str()`-like rendering so anchors match `key: value` shapes as well as JSON. */
export function looseRepr(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `'${value}'`;
  if (Array.isArray(value)) return `[${value.map(looseRepr).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `'${k}': ${looseRepr(v)}`)
      .join(', ')}}`;
  }
  return String(value);
}

export function itemMatchesAnchors(item: unknown, anchors: readonly string[]): boolean {
  if (anchors.length === 0) return false;
  const s = looseRepr(item).toLowerCase();
  const j = JSON.stringify(item)?.toLowerCase() ?? '';
  return anchors.some((a) => s.includes(a) || j.includes(a));
}

// ---------------------------------------------------------------------------
// Query building / keywords
// ---------------------------------------------------------------------------

/** User prompt + triggering tool call (name + args) joined by `\n`. */
export function buildRelevanceQuery(userQuery: string, toolName = '', toolArgs = ''): string {
  const parts: string[] = [];
  const q = (userQuery ?? '').trim();
  if (q) parts.push(q);
  const call = [toolName.trim(), toolArgs.trim()].filter(Boolean).join(' ');
  if (call) parts.push(call);
  return parts.join('\n');
}

const STOP_WORDS = new Set(
  (
    'a an and are as at be but by can could did do does for from had has have he her his how i if in into is it its just let me my no not of on or our out she so than that the their them then there these they this those to too was we were what when where which who why will with would you your yours about above after again against all also am any because been before being below between both down during each few further here more most off once only other over own same should some such through under until up very ' +
    'please show find give get make tell look use want need like know think see try help run check list something anything'
  ).split(/\s+/),
);

const KEYWORD_RE = /\b[a-z][a-z0-9_.-]*[a-z0-9]\b|\b[a-z]{2,}\b/g;

/** Lowercased keywords (stop-word filtered, len ≥ 2), first-seen order. */
export function extractKeywords(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const lower = (text ?? '').toLowerCase();
  KEYWORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KEYWORD_RE.exec(lower)) !== null) {
    const w = m[0];
    if (w.length < 2 || STOP_WORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** Compact scalar args of a tool call (≤ `maxChars`), space-joined, for query building. */
export function compactToolArgs(args: unknown, maxChars = 300): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args.slice(0, maxChars);
  if (typeof args !== 'object') return String(args).slice(0, maxChars);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    parts.push(`${k}=${String(v)}`);
  }
  return parts.join(' ').slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Otsu split + segmentation + relevance plan
// ---------------------------------------------------------------------------

/** Otsu's threshold over the sorted values (midpoint of the winning adjacent pair). */
export function otsuThreshold(values: readonly number[]): number {
  const xs = [...values].sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return 0;
  const total = xs.reduce((a, b) => a + b, 0);
  let w0 = 0;
  let sum0 = 0;
  let bestT = xs[0];
  let bestVar = -1;
  for (let i = 0; i < n - 1; i++) {
    w0 += 1;
    sum0 += xs[i];
    const w1 = n - w0;
    const m0 = sum0 / w0;
    const m1 = (total - sum0) / w1;
    const between = w0 * w1 * (m0 - m1) * (m0 - m1);
    if (between > bestVar) {
      bestVar = between;
      bestT = (xs[i] + xs[i + 1]) / 2;
    }
  }
  return bestT;
}

/** `max(otsu, floor)`; fewer than 2 distinct values (9 dp) → the floor decides. */
export function adaptiveThreshold(values: readonly number[], floor: number): number {
  const distinct = new Set(values.map((v) => Math.round(v * 1e9) / 1e9));
  if (distinct.size < 2) return floor;
  return Math.max(otsuThreshold(values), floor);
}

/** Lossless partition: `segments.join('') === content`. Blank-line records, windowed dense blocks. */
export function segment(content: string, opts: { window?: number; maxChars?: number } = {}): string[] {
  const window = opts.window ?? 8;
  const maxChars = opts.maxChars ?? 1200;
  if (!content) return [];
  const lines: string[] = [];
  let start = 0;
  while (start < content.length) {
    const nl = content.indexOf('\n', start);
    if (nl < 0) {
      lines.push(content.slice(start));
      break;
    }
    lines.push(content.slice(start, nl + 1));
    start = nl + 1;
  }
  if (lines.length <= 1) return [content];
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const ln of lines) {
    cur.push(ln);
    if (ln.trim() === '') {
      blocks.push(cur);
      cur = [];
    }
  }
  if (cur.length) blocks.push(cur);
  const segments: string[] = [];
  for (const block of blocks) {
    const chars = block.reduce((a, x) => a + x.length, 0);
    if (block.length <= window && chars <= maxChars) {
      segments.push(block.join(''));
      continue;
    }
    let i = 0;
    while (i < block.length) {
      let j = Math.min(i + window, block.length);
      while (j < block.length && (block[j].startsWith(' ') || block[j].startsWith('\t'))) j++;
      segments.push(block.slice(i, j).join(''));
      i = j;
    }
  }
  return segments;
}

export interface RelevanceRun {
  keep: boolean;
  text: string;
}

/** Ordered KEEP/DROP runs; a single KEEP run when the query is empty, one record, or over `maxRecords`. */
export function planRelevanceSplit(
  content: string,
  query: string,
  opts: { threshold?: number; adaptive?: boolean; window?: number; maxChars?: number; maxRecords?: number; scorer?: BM25Scorer } = {},
): RelevanceRun[] {
  const threshold = opts.threshold ?? 0.25;
  if (!query.trim()) return [{ keep: true, text: content }];
  const segs = segment(content, { window: opts.window, maxChars: opts.maxChars });
  if (segs.length < 2 || (opts.maxRecords && segs.length > opts.maxRecords)) return [{ keep: true, text: content }];
  const scores = scoreRelevance(segs, query, opts.scorer).map((s) => s.score);
  const cut = opts.adaptive === false ? threshold : adaptiveThreshold(scores, threshold);
  const runs: RelevanceRun[] = [];
  segs.forEach((seg, i) => {
    const keep = scores[i] >= cut;
    const last = runs[runs.length - 1];
    if (last && last.keep === keep) last.text += seg;
    else runs.push({ keep, text: seg });
  });
  return runs;
}
