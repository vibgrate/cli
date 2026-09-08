/**
 * Anchors — the things a lossy pass must never lose.
 *
 * Two flavours:
 *  1. Array anchors (SmartCrusher): position-based slots allocated by data
 *     pattern (search results are front-heavy, logs back-heavy, time series
 *     balanced), shifted by recency/historical words in the query, with the
 *     middle region filled by information density.
 *  2. Line anchors (every compressor): error evidence, identifiers (UUIDs,
 *     hashes, URLs, numbers with units, test names). `accuracyGuard` checks
 *     that a rewrite kept them (or that they are recoverable behind a marker).
 */

import { canonicalize, shortId } from '../engine/hash.js';

// ---------------------------------------------------------------------------
// Array anchors
// ---------------------------------------------------------------------------

export type DataPattern = 'search_results' | 'logs' | 'time_series' | 'generic';
export type AnchorStrategy = 'front_heavy' | 'back_heavy' | 'balanced' | 'distributed';

export interface AnchorConfig {
  anchorBudgetPct: number;
  minAnchorSlots: number;
  maxAnchorSlots: number;
  useInformationDensity: boolean;
  candidateMultiplier: number;
  dedupIdenticalItems: boolean;
}

export const DEFAULT_ANCHOR_CONFIG: Readonly<AnchorConfig> = {
  anchorBudgetPct: 0.25,
  minAnchorSlots: 3,
  maxAnchorSlots: 12,
  useInformationDensity: true,
  candidateMultiplier: 3,
  dedupIdenticalItems: true,
};

export interface AnchorWeights {
  front: number;
  middle: number;
  back: number;
}

export const RECENCY_KEYWORDS: readonly string[] = ['latest', 'recent', 'last', 'newest', 'current', 'now'];
export const HISTORICAL_KEYWORDS: readonly string[] = ['first', 'oldest', 'earliest', 'original', 'initial', 'beginning'];

export function strategyForPattern(pattern: DataPattern): AnchorStrategy {
  switch (pattern) {
    case 'search_results':
      return 'front_heavy';
    case 'logs':
      return 'back_heavy';
    case 'time_series':
      return 'balanced';
    default:
      return 'distributed';
  }
}

export function baseWeights(strategy: AnchorStrategy): AnchorWeights {
  switch (strategy) {
    case 'front_heavy':
      return { front: 0.75, middle: 0.1, back: 0.15 };
    case 'back_heavy':
      return { front: 0.15, middle: 0.1, back: 0.75 };
    case 'balanced':
      return { front: 0.45, middle: 0.1, back: 0.45 };
    default:
      return { front: 0.5, middle: 0.1, back: 0.4 };
  }
}

export function normalizeWeights(w: AnchorWeights): AnchorWeights {
  const sum = w.front + w.middle + w.back;
  if (sum <= 0) return { front: 0.5, middle: 0.1, back: 0.4 };
  return { front: w.front / sum, middle: w.middle / sum, back: w.back / sum };
}

/** Recency-only query → shift 0.15 front→back; historical-only → the mirror; both/neither → unchanged. */
export function adjustWeightsForQuery(w: AnchorWeights, query?: string): AnchorWeights {
  if (!query) return w;
  const q = query.toLowerCase();
  const wordIn = (words: readonly string[]): boolean => words.some((k) => new RegExp(`\\b${k}\\b`).test(q));
  const recency = wordIn(RECENCY_KEYWORDS);
  const historical = wordIn(HISTORICAL_KEYWORDS);
  if (recency && !historical) return normalizeWeights({ front: Math.max(0.1, w.front - 0.15), middle: w.middle, back: Math.min(0.8, w.back + 0.15) });
  if (historical && !recency) return normalizeWeights({ front: Math.min(0.8, w.front + 0.15), middle: w.middle, back: Math.max(0.1, w.back - 0.15) });
  return w;
}

export function anchorBudget(arraySize: number, maxItems: number, cfg: AnchorConfig = DEFAULT_ANCHOR_CONFIG): number {
  if (arraySize <= maxItems) return 0;
  let budget = Math.trunc(maxItems * cfg.anchorBudgetPct);
  budget = Math.max(cfg.minAnchorSlots, budget);
  budget = Math.min(cfg.maxAnchorSlots, budget);
  return Math.min(budget, arraySize);
}

/** blake3 short id of the canonical JSON — content identity for dedup. */
export function itemHash(item: unknown): string {
  return shortId(canonicalize(item));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Weighted mean (0.4 value uniqueness + 0.3 length + 0.3 structural
 * uniqueness) in [0,1]. Non-objects and empty corpora → 0.
 */
export function informationScore(item: unknown, all: readonly unknown[]): number {
  if (!item || all.length === 0 || !isRecord(item)) return 0;
  const n = all.length;
  const objs = all.filter(isRecord);
  // value uniqueness
  let valueScore = 0.5;
  if (n >= 2) {
    const freq = new Map<string, Map<string, number>>();
    for (const o of objs) {
      for (const [k, v] of Object.entries(o)) {
        let m = freq.get(k);
        if (!m) {
          m = new Map();
          freq.set(k, m);
        }
        const key = typeof v === 'string' ? v : canonicalize(v);
        m.set(key, (m.get(key) ?? 0) + 1);
      }
    }
    const scores: number[] = [];
    for (const [k, v] of Object.entries(item)) {
      const m = freq.get(k);
      if (!m) continue;
      const key = typeof v === 'string' ? v : canonicalize(v);
      scores.push(1 - (m.get(key) ?? 0) / n);
    }
    if (scores.length) valueScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  }
  // length score
  let lengthScore = 0.5;
  if (n >= 2) {
    const lens = all.map((x) => JSON.stringify(x)?.length ?? 0);
    const mn = Math.min(...lens);
    const mx = Math.max(...lens);
    if (mx > mn) lengthScore = ((JSON.stringify(item)?.length ?? 0) - mn) / (mx - mn);
  }
  // structural uniqueness
  let structural = 0;
  {
    const counts = new Map<string, number>();
    for (const o of objs) for (const k of Object.keys(o)) counts.set(k, (counts.get(k) ?? 0) + 1);
    const common = new Set<string>();
    const rare = new Set<string>();
    for (const [k, c] of counts) {
      if (c >= n * 0.8) common.add(k);
      if (c < n * 0.2) rare.add(k);
    }
    const keys = new Set(Object.keys(item));
    if (rare.size) structural += 0.5 * ([...keys].filter((k) => rare.has(k)).length / Math.max(rare.size, 1));
    if (common.size) structural += 0.5 * ([...common].filter((k) => !keys.has(k)).length / Math.max(common.size, 1));
    structural = Math.min(1, structural);
  }
  const score = (0.4 * valueScore + 0.3 * lengthScore + 0.3 * structural) / 1.0;
  return Math.max(0, Math.min(1, score));
}

class Dedup {
  private readonly seen = new Set<string>();
  constructor(
    private readonly items: readonly unknown[],
    private readonly enabled: boolean,
  ) {}
  /** True if `idx` may be included; records the hash unless `checkOnly`. */
  allow(idx: number, checkOnly = false): boolean {
    if (!this.enabled) return true;
    if (idx < 0 || idx >= this.items.length) return false;
    const it = this.items[idx];
    if (!isRecord(it)) return true;
    const h = itemHash(it);
    if (this.seen.has(h)) return false;
    if (!checkOnly) this.seen.add(h);
    return true;
  }
}

function selectRegion(items: readonly unknown[], start: number, end: number, slots: number, dedup: Dedup, useDensity: boolean, cfg: AnchorConfig): number[] {
  const size = end - start;
  const out: number[] = [];
  if (size <= 0 || slots <= 0) return out;
  if (slots >= size) {
    for (let i = start; i < end; i++) if (dedup.allow(i)) out.push(i);
    return out;
  }
  if (useDensity) {
    const numCandidates = Math.min(slots * cfg.candidateMultiplier, size);
    const step = size / (numCandidates + 1);
    const candidates: number[] = [];
    for (let i = 0; i < numCandidates; i++) {
      const idx = Math.min(end - 1, start + Math.trunc((i + 1) * step));
      if (!candidates.includes(idx) && dedup.allow(idx, true)) candidates.push(idx);
    }
    const region = items.slice(start, end);
    const scored = candidates.map((idx) => ({ idx, score: isRecord(items[idx]) ? informationScore(items[idx], region) : 0.5 }));
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
    for (const { idx } of scored) {
      if (out.length >= slots) break;
      if (dedup.allow(idx)) out.push(idx);
    }
    return out.sort((a, b) => a - b);
  }
  const step = size / (slots + 1);
  for (let i = 0; i < slots; i++) {
    let idx = Math.min(end - 1, start + Math.trunc((i + 1) * step));
    if (out.includes(idx) || !dedup.allow(idx)) {
      let placed = false;
      for (const off of [1, -1, 2, -2]) {
        const alt = idx + off;
        if (alt >= start && alt < end && !out.includes(alt) && dedup.allow(alt)) {
          idx = alt;
          placed = true;
          break;
        }
      }
      if (!placed) continue;
    }
    out.push(idx);
  }
  return out;
}

/**
 * Position-based anchor indices for an array of `n` items that must shrink
 * to `maxItems`. `n ≤ maxItems` → every index. Front/back are always
 * position-based; the middle uses information density when enabled.
 */
export function selectAnchors(items: readonly unknown[], maxItems: number, pattern: DataPattern = 'generic', query?: string, cfg: AnchorConfig = DEFAULT_ANCHOR_CONFIG): Set<number> {
  const n = items.length;
  if (n === 0) return new Set();
  if (n <= maxItems) return new Set(Array.from({ length: n }, (_, i) => i));
  const budget = anchorBudget(n, maxItems, cfg);
  if (budget === 0) return new Set();
  const w = normalizeWeights(adjustWeightsForQuery(baseWeights(strategyForPattern(pattern)), query));
  let front = Math.max(1, Math.trunc(budget * w.front));
  let back = Math.max(1, Math.trunc(budget * w.back));
  let middle = Math.max(0, budget - front - back);
  while (front + back + middle > budget) {
    if (middle > 0) middle--;
    else if (back > 1) back--;
    else if (front > 1) front--;
    else break;
  }
  const dedup = new Dedup(items, cfg.dedupIdenticalItems);
  const frontEnd = Math.min(front * 2, Math.trunc(n / 3));
  const backStart = Math.max(n - back * 2, Math.trunc((2 * n) / 3));
  const out = new Set<number>();
  const frontIdx = selectRegion(items, 0, Math.max(frontEnd, Math.min(n, front)), front, dedup, false, cfg);
  for (const i of frontIdx) out.add(i);
  const backIdx = selectRegion(items, Math.min(backStart, Math.max(0, n - back)), n, back, dedup, false, cfg);
  for (const i of backIdx) out.add(i);
  if (middle > 0) {
    const ms = frontIdx.length ? Math.max(...frontIdx) + 1 : 0;
    const me = backIdx.length ? Math.min(...backIdx) : n;
    if (me > ms) for (const i of selectRegion(items, ms, me, middle, dedup, cfg.useInformationDensity, cfg)) out.add(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line anchors + accuracy guard
// ---------------------------------------------------------------------------

export interface LineAnchors {
  /** Error evidence: exception class names, error-line key tokens, failing test names. */
  errors: string[];
  /** Identifiers: UUIDs, hashes, URLs, numbers with units, path:line refs. */
  ids: string[];
}

const ERROR_LINE_RE = /\b(?:error|exception|traceback|fatal|panic|critical|failed|failure|denied|timeout)\b/i;
const EXCEPTION_CLASS_RE = /\b[A-Z][A-Za-z0-9]*(?:Error|Exception|Panic|Fault)\b/g;
const TEST_NAME_RE = /\b(?:test_[a-z0-9_]+|it\((?:'|")[^'"]{3,80}(?:'|")|(?:FAIL|FAILED|ERROR)\s+[^\s:]+::[^\s]+)/g;
const UUID_ANCHOR_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const HASH_ANCHOR_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{12,64}\b/g;
const URL_ANCHOR_RE = /https?:\/\/[^\s<>"')\]]+/g;
const UNIT_NUMBER_RE = /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|m|min|h|hrs|KB|MB|GB|TB|kb|mb|gb|%|px|req\/s|rps)\b/g;
const PATH_LINE_RE = /\b[\w./-]+\.[a-z]{1,6}:\d+\b/g;
const ERROR_TOKEN_RE = /[A-Za-z_][A-Za-z0-9_.:/-]{4,}/g;

export const MAX_ERROR_ANCHORS = 128;
export const MAX_ID_ANCHORS = 256;

function collectAll(re: RegExp, text: string, into: Set<string>, cap: number, positions?: Map<string, number>): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (into.size < cap && (m = re.exec(text)) !== null) {
    if (!into.has(m[0])) {
      into.add(m[0]);
      positions?.set(m[0], m.index);
    }
    if (m[0].length === 0) re.lastIndex++;
  }
}

/** The key token of an error line: the longest identifier-ish token that is not the keyword itself. */
function errorLineToken(line: string): string | null {
  ERROR_TOKEN_RE.lastIndex = 0;
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = ERROR_TOKEN_RE.exec(line)) !== null) {
    const tok = m[0];
    if (/^(error|exception|traceback|fatal|panic|critical|failed|failure|denied|timeout|warning)$/i.test(tok)) continue;
    if (!best || tok.length > best.length) best = tok;
  }
  return best;
}

/** Deterministic anchor extraction: errors in order of first appearance (so first/last are textual), ids first-seen per kind. Capped. */
export function extractAnchors(text: string): LineAnchors {
  const errors = new Set<string>();
  const positions = new Map<string, number>();
  const ids = new Set<string>();
  if (!text) return { errors: [], ids: [] };
  collectAll(EXCEPTION_CLASS_RE, text, errors, MAX_ERROR_ANCHORS, positions);
  collectAll(TEST_NAME_RE, text, errors, MAX_ERROR_ANCHORS, positions);
  if (errors.size < MAX_ERROR_ANCHORS) {
    let start = 0;
    while (start < text.length && errors.size < MAX_ERROR_ANCHORS) {
      let nl = text.indexOf('\n', start);
      if (nl < 0) nl = text.length;
      const line = text.slice(start, nl);
      const lineStart = start;
      start = nl + 1;
      if (line.length > 2000 || !ERROR_LINE_RE.test(line)) continue;
      const tok = errorLineToken(line);
      if (tok && !errors.has(tok)) {
        errors.add(tok);
        positions.set(tok, lineStart + line.indexOf(tok));
      }
    }
  }
  collectAll(UUID_ANCHOR_RE, text, ids, MAX_ID_ANCHORS);
  collectAll(HASH_ANCHOR_RE, text, ids, MAX_ID_ANCHORS);
  collectAll(URL_ANCHOR_RE, text, ids, MAX_ID_ANCHORS);
  collectAll(UNIT_NUMBER_RE, text, ids, MAX_ID_ANCHORS);
  collectAll(PATH_LINE_RE, text, ids, MAX_ID_ANCHORS);
  const ordered = [...errors].sort((a, b) => (positions.get(a) ?? 0) - (positions.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  return { errors: ordered, ids: [...ids] };
}

export interface GuardResult {
  ok: boolean;
  missingErrors: string[];
  missingIds: string[];
}

/**
 * Did `compressed` keep the anchors of `original`?
 *  - recoverable (marker present): the first and last error anchors must survive;
 *  - not recoverable: every error anchor and every id anchor must survive.
 * Matching is case-insensitive substring so re-rendered (CSV, JSON) forms count.
 */
export function accuracyGuard(original: string, compressed: string, opts: { recoverable: boolean }): GuardResult {
  const a = extractAnchors(original);
  const hay = compressed.toLowerCase();
  const has = (s: string): boolean => hay.includes(s.toLowerCase());
  const missingErrors: string[] = [];
  const missingIds: string[] = [];
  if (opts.recoverable) {
    if (a.errors.length) {
      const first = a.errors[0];
      const last = a.errors[a.errors.length - 1];
      if (!has(first)) missingErrors.push(first);
      if (last !== first && !has(last)) missingErrors.push(last);
    }
  } else {
    for (const e of a.errors) if (!has(e)) missingErrors.push(e);
    for (const id of a.ids) if (!has(id)) missingIds.push(id);
  }
  return { ok: missingErrors.length === 0 && missingIds.length === 0, missingErrors, missingIds };
}

/** Whether a line carries an error anchor (used by compressors to pin lines/segments). */
export function isAnchorLine(line: string): boolean {
  if (line.length > 4000) return false;
  EXCEPTION_CLASS_RE.lastIndex = 0;
  if (EXCEPTION_CLASS_RE.test(line)) return true;
  return ERROR_LINE_RE.test(line);
}
