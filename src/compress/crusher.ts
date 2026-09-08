/**
 * SmartCrusher — the JSON array compressor.
 *
 * Statistical, schema-preserving compression of tool output arrays:
 *   analyze fields → decide whether crushing is SAFE (crushability tree) →
 *   pick a strategy (time_series | cluster | top_n | smart_sample) → plan the
 *   keep set (position anchors, structural outliers, Pareto-rare statuses,
 *   error keywords, numeric anomalies, change points, query anchors, BM25
 *   relevance, preserve keywords) → prioritise under the adaptive budget.
 *
 * Lossless-first: a cleanly tabular array is re-encoded as a csv-schema block
 * (`[N]{col:type?,…}` + CSV rows) and shipped without dropping anything when
 * that saves ≥ 15% of bytes. Otherwise the lossy keep/drop path emits the
 * kept items plus a `{"_vg_dropped": N, "hash": "HASH"}` sentinel and a
 * `<<vg-ccr:HASH N_rows_offloaded>>` marker whose original lives in the CCR
 * store. Output contains only items from the input — never generated text.
 */

import { canonicalize } from '../engine/hash.js';
import { computeOptimalK } from './adaptive.js';
import { itemHash, selectAnchors, type DataPattern } from './anchors.js';
import { normalizeConcatenatedJson, parseJsonLoose } from './detect.js';
import { extractQueryAnchors, itemMatchesAnchors, scoreRelevance } from './relevance.js';
import { roundTiesEven, type CcrSink, type CompressRequest, type CompressResponse, type Compressor } from './types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const ERROR_KEYWORDS: readonly string[] = ['error', 'exception', 'failed', 'failure', 'critical', 'fatal', 'crash', 'panic', 'abort', 'timeout', 'denied', 'rejected'];

export interface CrusherConfig {
  minItemsToAnalyze: number;
  minTokensToCrush: number;
  varianceThreshold: number;
  uniquenessThreshold: number;
  similarityThreshold: number;
  maxItemsAfterCrush: number;
  preserveChangePoints: boolean;
  factorOutConstants: boolean;
  dedupIdenticalItems: boolean;
  firstFraction: number;
  lastFraction: number;
  relevanceThreshold: number;
  losslessMinSavingsRatio: number;
  withCompaction: boolean;
  compactionFormat: 'csv-schema' | 'json';
  /** No drops, no markers (data-lossless compaction only). */
  losslessOnly: boolean;
  coreFieldFraction: number;
  heterogeneousCoreRatio: number;
  maxFlattenInnerKeys: number;
  minBuckets: number;
  maxBuckets: number;
  opaqueMinBytes: number;
}

export const DEFAULT_CRUSHER_CONFIG: Readonly<CrusherConfig> = {
  minItemsToAnalyze: 5,
  minTokensToCrush: 200,
  varianceThreshold: 2.0,
  uniquenessThreshold: 0.1,
  similarityThreshold: 0.8,
  maxItemsAfterCrush: 15,
  preserveChangePoints: true,
  factorOutConstants: false,
  dedupIdenticalItems: true,
  firstFraction: 0.3,
  lastFraction: 0.15,
  relevanceThreshold: 0.3,
  losslessMinSavingsRatio: 0.15,
  withCompaction: true,
  compactionFormat: 'csv-schema',
  losslessOnly: false,
  coreFieldFraction: 0.8,
  heterogeneousCoreRatio: 0.6,
  maxFlattenInnerKeys: 6,
  minBuckets: 2,
  maxBuckets: 8,
  opaqueMinBytes: 256,
};

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

export function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function sampleVariance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1);
}

export function sampleStdev(xs: readonly number[]): number {
  return Math.sqrt(sampleVariance(xs));
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** numpy "linear" percentile. */
export function percentileLinear(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = lo + 1 < n ? lo + 1 : lo;
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

export function isUuidFormat(s: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
}

/** Shannon entropy normalised by log2(min(distinct, length)); 0 for < 2 code points. */
export function stringEntropy(s: string): number {
  const chars = [...s];
  const n = chars.length;
  if (n < 2) return 0;
  const freq = new Map<string, number>();
  for (const c of chars) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / n;
    if (p > 0) h -= p * Math.log2(p);
  }
  const max = Math.log2(Math.min(freq.size, n));
  return max > 0 ? h / max : 0;
}

function parseIntLike(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  let cleaned = t;
  if (t.includes('_')) {
    if (t.startsWith('_') || t.endsWith('_') || t.includes('__')) return null;
    cleaned = t.replace(/_/g, '');
  }
  if (!/^[+-]?\d+$/.test(cleaned)) return null;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

/** IDs are 1,2,3…: unit steps; numeric-typed values must exist (all-string numerics never count). */
export function detectSequentialPattern(values: readonly unknown[], checkOrder = true): boolean {
  if (values.length < 5) return false;
  const nums: number[] = [];
  let hadNumeric = false;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      nums.push(v);
      hadNumeric = true;
    } else if (typeof v === 'string') {
      const p = parseIntLike(v);
      if (p !== null) nums.push(p);
    }
  }
  if (nums.length < 5 || !hadNumeric) return false;
  const sorted = [...nums].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) if (Math.abs(sorted[i] - sorted[i - 1] - 1) > 1e-9) return false;
  if (checkOrder) for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i - 1]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Field statistics
// ---------------------------------------------------------------------------

export type FieldType = 'numeric' | 'string' | 'boolean' | 'object' | 'array' | 'null' | 'unknown';

export interface FieldStats {
  name: string;
  fieldType: FieldType;
  count: number;
  uniqueCount: number;
  uniqueRatio: number;
  isConstant: boolean;
  constantValue?: unknown;
  min?: number;
  max?: number;
  mean?: number;
  variance?: number;
  changePoints: number[];
  avgLength?: number;
  topValues: Array<[string, number]>;
}

function reprValue(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  return JSON.stringify(v) ?? '';
}

export function detectChangePoints(values: readonly number[], window = 5, threshold = 2.0): number[] {
  if (values.length < window * 2) return [];
  const std = sampleStdev(values);
  if (!(std > 0)) return [];
  const limit = threshold * std;
  const cps: number[] = [];
  for (let i = window; i < values.length - window; i++) {
    const before = mean(values.slice(i - window, i));
    const after = mean(values.slice(i, i + window));
    if (Math.abs(after - before) > limit) cps.push(i);
  }
  const out: number[] = [];
  for (const cp of cps) if (!out.length || cp - out[out.length - 1] > window) out.push(cp);
  return out;
}

export function analyzeField(name: string, items: readonly Rec[], cfg: CrusherConfig = DEFAULT_CRUSHER_CONFIG): FieldStats {
  const values = items.map((it) => (Object.prototype.hasOwnProperty.call(it, name) ? it[name] : null));
  const nonNull = values.filter((v) => v !== null && v !== undefined);
  const stats: FieldStats = { name, fieldType: 'null', count: values.length, uniqueCount: 0, uniqueRatio: 0, isConstant: true, changePoints: [], topValues: [] };
  if (nonNull.length === 0) return stats;
  const first = nonNull[0];
  stats.fieldType = typeof first === 'boolean' ? 'boolean' : typeof first === 'number' ? 'numeric' : typeof first === 'string' ? 'string' : Array.isArray(first) ? 'array' : isRecord(first) ? 'object' : 'unknown';
  const distinct = new Set(values.map(reprValue));
  stats.uniqueCount = distinct.size;
  stats.uniqueRatio = distinct.size / values.length;
  stats.isConstant = distinct.size === 1;
  stats.constantValue = first;
  if (stats.fieldType === 'numeric') {
    const nums = nonNull.filter(isFiniteNumber);
    if (nums.length) {
      stats.min = Math.min(...nums);
      stats.max = Math.max(...nums);
      stats.mean = mean(nums);
      stats.variance = nums.length > 1 ? sampleVariance(nums) : 0;
      if (![stats.min, stats.max, stats.mean, stats.variance].every(Number.isFinite)) {
        delete stats.min;
        delete stats.max;
        delete stats.mean;
        stats.variance = 0;
      } else {
        stats.changePoints = detectChangePoints(nums, 5, cfg.varianceThreshold);
      }
    } else {
      stats.variance = 0;
    }
  } else if (stats.fieldType === 'string') {
    const strs = nonNull.filter((v): v is string => typeof v === 'string');
    stats.avgLength = strs.length ? strs.reduce((a, s) => a + [...s].length, 0) / strs.length : 0;
    const counts = new Map<string, number>();
    for (const s of strs) counts.set(s, (counts.get(s) ?? 0) + 1);
    stats.topValues = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Field detectors
// ---------------------------------------------------------------------------

export function detectIdField(stats: FieldStats, values: readonly unknown[]): [boolean, number] {
  if (stats.uniqueRatio < 0.9) return [false, 0];
  if (stats.fieldType === 'string') {
    const sample = values.slice(0, 20).filter((v): v is string => typeof v === 'string');
    if (sample.length) {
      const uuid = sample.filter(isUuidFormat).length;
      if (uuid / sample.length > 0.8) return [true, 0.95];
      const avgEntropy = sample.reduce((a, s) => a + stringEntropy(s), 0) / sample.length;
      if (avgEntropy > 0.7 && stats.uniqueRatio > 0.95) return [true, 0.8];
    }
  }
  if (stats.fieldType === 'numeric') {
    if (detectSequentialPattern(values, true) && stats.uniqueRatio > 0.95) return [true, 0.9];
    if (stats.min !== undefined && stats.max !== undefined && stats.max - stats.min > 0 && stats.uniqueRatio > 0.95) return [true, 0.85];
  }
  if (stats.uniqueRatio > 0.98) return [true, 0.7];
  return [false, 0];
}

export function detectScoreField(stats: FieldStats, items: readonly Rec[]): [boolean, number] {
  if (stats.fieldType !== 'numeric' || stats.min === undefined || stats.max === undefined) return [false, 0];
  const mn = stats.min;
  const mx = stats.max;
  let conf = 0;
  if (mn >= 0 && mn <= 1 && mx >= 0 && mx <= 1) conf += 0.4;
  else if (mn >= 0 && mn <= 10 && mx >= 0 && mx <= 10) conf += 0.3;
  else if (mn >= 0 && mn <= 100 && mx >= 0 && mx <= 100) conf += 0.25;
  else if (mn >= -1 && mx <= 1) conf += 0.35;
  else return [false, 0];
  const sample = items
    .slice(0, 50)
    .filter((it) => Object.prototype.hasOwnProperty.call(it, stats.name))
    .map((it) => it[stats.name]);
  if (detectSequentialPattern(sample, true)) return [false, 0];
  const ordered = items.map((it) => it[stats.name]).filter(isFiniteNumber);
  if (ordered.length >= 5) {
    let desc = 0;
    for (let i = 1; i < ordered.length; i++) if (ordered[i - 1] >= ordered[i]) desc++;
    if (desc / (ordered.length - 1) > 0.7) conf += 0.3;
  }
  const first20 = ordered.slice(0, 20);
  const floats = first20.filter((v) => v !== Math.trunc(v)).length;
  if (first20.length && floats > first20.length * 0.3) conf += 0.1;
  return [conf >= 0.4, Math.min(conf, 0.95)];
}

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function detectTemporalField(fieldStats: ReadonlyMap<string, FieldStats>, items: readonly Rec[]): string | null {
  for (const [name, st] of fieldStats) {
    if (st.fieldType === 'string') {
      const sample = items
        .slice(0, 10)
        .map((it) => it[name])
        .filter((v): v is string => typeof v === 'string');
      if (sample.length && sample.filter((s) => ISO_DATETIME_RE.test(s) || ISO_DATE_RE.test(s)).length / sample.length > 0.5) return name;
    } else if (st.fieldType === 'numeric' && st.min !== undefined) {
      if ((st.min >= 1e9 && st.min <= 2e9) || (st.min >= 1e12 && st.min <= 2e12)) return name;
    }
  }
  return null;
}

export function detectPattern(fieldStats: ReadonlyMap<string, FieldStats>, items: readonly Rec[]): DataPattern {
  const temporal = detectTemporalField(fieldStats, items) !== null;
  let numericWithVariance = false;
  let messageLike = false;
  let levelLike = false;
  for (const st of fieldStats.values()) {
    if (st.fieldType === 'numeric' && (st.variance ?? 0) > 0) numericWithVariance = true;
    if (st.fieldType === 'string') {
      if (st.uniqueRatio > 0.5 && (st.avgLength ?? 0) > 20) messageLike = true;
      if (st.uniqueRatio < 0.1 && st.uniqueCount >= 2 && st.uniqueCount <= 10) levelLike = true;
    }
  }
  if (temporal && numericWithVariance) return 'time_series';
  if (messageLike && levelLike) return 'logs';
  for (const st of fieldStats.values()) {
    const [ok, conf] = detectScoreField(st, items);
    if (ok && conf >= 0.5) return 'search_results';
  }
  return 'generic';
}

// ---------------------------------------------------------------------------
// Outliers / error items
// ---------------------------------------------------------------------------

/** Per common field with 2..50 distinct values: the smallest K whose top-K covers ≥80%; if K ≤ 5, the rest are rare. */
export function detectRareStatusValues(items: readonly unknown[], commonFields: readonly string[]): number[] {
  const out = new Set<number>();
  for (const field of [...commonFields].sort()) {
    const values: Array<[number, string]> = [];
    items.forEach((it, i) => {
      if (isRecord(it) && Object.prototype.hasOwnProperty.call(it, field)) {
        const v = it[field];
        values.push([i, v === null ? '__none__' : typeof v === 'string' ? v : reprValue(v)]);
      }
    });
    const counts = new Map<string, number>();
    for (const [, v] of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    if (counts.size < 2 || counts.size > 50) continue;
    const total = values.length;
    const threshold = Math.ceil(0.8 * total);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const topK = new Set<string>();
    let acc = 0;
    for (const [v, c] of sorted) {
      topK.add(v);
      acc += c;
      if (acc >= threshold) break;
    }
    if (topK.size > 5) continue;
    for (const [i, v] of values) if (!topK.has(v)) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/** Items carrying a rare field (<20% of items) ∪ rare-status values. Needs ≥5 items. */
export function detectStructuralOutliers(items: readonly unknown[]): number[] {
  const n = items.length;
  if (n < 5) return [];
  const counts = new Map<string, number>();
  for (const it of items) if (isRecord(it)) for (const k of Object.keys(it)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const common: string[] = [];
  const rare = new Set<string>();
  for (const [k, c] of counts) {
    if (c >= n * 0.8) common.push(k);
    if (c < n * 0.2) rare.add(k);
  }
  const out = new Set<number>();
  items.forEach((it, i) => {
    if (isRecord(it) && Object.keys(it).some((k) => rare.has(k))) out.add(i);
  });
  for (const i of detectRareStatusValues(items, common)) out.add(i);
  return [...out].sort((a, b) => a - b);
}

/** Items whose serialized form contains an error keyword (lowercased substring). Objects only. */
export function detectErrorItems(items: readonly unknown[], itemStrings?: readonly string[], keywords: readonly string[] = ERROR_KEYWORDS): number[] {
  const out: number[] = [];
  items.forEach((it, i) => {
    if (!isRecord(it)) return;
    const s = (itemStrings && i < itemStrings.length ? itemStrings[i] : (JSON.stringify(it) ?? '')).toLowerCase();
    if (keywords.some((k) => s.includes(k))) out.push(i);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Crushability + strategy
// ---------------------------------------------------------------------------

export interface Crushability {
  crushable: boolean;
  confidence: number;
  reason: string;
  signalsPresent: string[];
  signalsAbsent: string[];
  hasIdField: boolean;
  idField?: string;
  idUniqueness: number;
  avgStringUniqueness: number;
  hasScoreField: boolean;
  scoreField?: string;
  errorItemCount: number;
  anomalyCount: number;
}

export function analyzeCrushability(items: readonly Rec[], fieldStats: ReadonlyMap<string, FieldStats>, cfg: CrusherConfig = DEFAULT_CRUSHER_CONFIG): Crushability {
  const present: string[] = [];
  const absent: string[] = [];
  let idField: string | undefined;
  let idConf = 0;
  let idUniqueness = 0;
  for (const [name, st] of fieldStats) {
    const [isId, conf] = detectIdField(
      st,
      items.map((it) => it[name]),
    );
    if (isId && conf > idConf) {
      idConf = conf;
      idField = name;
      idUniqueness = st.uniqueRatio;
    }
  }
  const hasIdField = idField !== undefined && idConf >= 0.7;
  if (hasIdField) present.push(`id_field:${idField}(conf=${idConf.toFixed(2)})`);
  let scoreField: string | undefined;
  for (const [name, st] of fieldStats) {
    const [ok, conf] = detectScoreField(st, items);
    if (ok) {
      scoreField = name;
      present.push(`score_field:${name}(conf=${conf.toFixed(2)})`);
      break;
    }
  }
  if (!scoreField) absent.push('score_field');
  const structural = detectStructuralOutliers(items);
  if (structural.length) present.push(`structural_outliers:${structural.length}`);
  else absent.push('structural_outliers');
  const keywordErrors = detectErrorItems(items);
  if (structural.length === 0) {
    if (keywordErrors.length) present.push(`error_keywords:${keywordErrors.length}`);
    else absent.push('error_keywords');
  }
  const errorCount = Math.max(structural.length, keywordErrors.length);
  const anomalies = new Set<number>();
  for (const [name, st] of fieldStats) {
    if (st.fieldType !== 'numeric' || st.mean === undefined || !(st.variance && st.variance > 0)) continue;
    const std = Math.sqrt(st.variance);
    if (!(std > 0)) continue;
    const limit = cfg.varianceThreshold * std;
    items.forEach((it, i) => {
      const v = it[name];
      if (isFiniteNumber(v) && Math.abs(v - (st.mean as number)) > limit) anomalies.add(i);
    });
  }
  if (anomalies.size) present.push(`anomalies:${anomalies.size}`);
  else absent.push('anomalies');
  const strU: number[] = [];
  const numU: number[] = [];
  for (const [name, st] of fieldStats) {
    if (name === idField) continue;
    if (st.fieldType === 'string') strU.push(st.uniqueRatio);
    if (st.fieldType === 'numeric') numU.push(st.uniqueRatio);
  }
  const avgString = strU.length ? mean(strU) : 0;
  const avgNumeric = numU.length ? mean(numU) : 0;
  const maxUniqueness = Math.max(avgString, hasIdField ? idUniqueness : 0, 0);
  const nonIdContent = Math.max(avgString, avgNumeric);
  let hasChangePoints = false;
  for (const st of fieldStats.values()) if (st.fieldType === 'numeric' && st.changePoints.length) hasChangePoints = true;
  if (hasChangePoints) present.push('change_points');
  else absent.push('change_points');
  const hasSignal = present.length > 0;

  const base = { signalsPresent: present, signalsAbsent: absent, hasIdField, idField, idUniqueness, avgStringUniqueness: avgString, hasScoreField: scoreField !== undefined, scoreField, errorItemCount: errorCount, anomalyCount: anomalies.size };
  if (nonIdContent < 0.1 && hasIdField) {
    present.push('repetitive_content');
    return { ...base, crushable: true, confidence: 0.85, reason: 'repetitive_content_with_ids' };
  }
  if (maxUniqueness < 0.3) return { ...base, crushable: true, confidence: 0.9, reason: 'low_uniqueness_safe_to_sample' };
  if (hasIdField && maxUniqueness > 0.8 && !hasSignal) return { ...base, crushable: false, confidence: 0.85, reason: 'unique_entities_no_signal' };
  if (maxUniqueness > 0.8 && hasSignal) return { ...base, crushable: true, confidence: 0.7, reason: 'unique_entities_with_signal' };
  if (!hasSignal) return { ...base, crushable: false, confidence: 0.6, reason: 'medium_uniqueness_no_signal' };
  return { ...base, crushable: true, confidence: 0.5, reason: 'medium_uniqueness_with_signal' };
}

export type CrushStrategy = 'none' | 'skip' | 'time_series' | 'cluster' | 'top_n' | 'smart_sample';

export interface ArrayAnalysis {
  itemCount: number;
  fieldStats: Map<string, FieldStats>;
  pattern: DataPattern;
  constantFields: string[];
  crushability?: Crushability;
  strategy: CrushStrategy;
  estimatedReduction: number;
}

export function selectStrategy(fieldStats: ReadonlyMap<string, FieldStats>, pattern: DataPattern, itemCount: number, crushability: Crushability | undefined, cfg: CrusherConfig): CrushStrategy {
  if (itemCount < cfg.minItemsToAnalyze) return 'none';
  if (crushability && !crushability.crushable) return 'skip';
  if (pattern === 'time_series') for (const st of fieldStats.values()) if (st.fieldType === 'numeric' && st.changePoints.length) return 'time_series';
  if (pattern === 'logs') {
    for (const name of [...fieldStats.keys()].sort()) {
      if (name.toLowerCase().includes('message')) {
        if ((fieldStats.get(name) as FieldStats).uniqueRatio < 0.5) return 'cluster';
        break;
      }
    }
  }
  if (pattern === 'search_results') return 'top_n';
  return 'smart_sample';
}

export function estimateReduction(fieldStats: ReadonlyMap<string, FieldStats>, strategy: CrushStrategy): number {
  if (strategy === 'none' || fieldStats.size === 0) return 0;
  let constants = 0;
  for (const st of fieldStats.values()) if (st.isConstant) constants++;
  const constantRatio = constants / fieldStats.size;
  const base = strategy === 'time_series' ? 0.7 : strategy === 'cluster' ? 0.8 : strategy === 'top_n' ? 0.6 : strategy === 'smart_sample' ? 0.5 : 0.3;
  return Math.min(base + constantRatio * 0.2, 0.95);
}

export function analyzeArray(items: readonly unknown[], cfg: CrusherConfig = DEFAULT_CRUSHER_CONFIG): ArrayAnalysis {
  const fieldStats = new Map<string, FieldStats>();
  if (!items.length || !isRecord(items[0])) return { itemCount: items.length, fieldStats, pattern: 'generic', constantFields: [], strategy: 'none', estimatedReduction: 0 };
  const recs = items.filter(isRecord);
  const keys = new Set<string>();
  for (const it of recs) for (const k of Object.keys(it)) keys.add(k);
  for (const k of [...keys].sort()) fieldStats.set(k, analyzeField(k, recs, cfg));
  const pattern = detectPattern(fieldStats, recs);
  const constantFields = [...fieldStats.values()].filter((s) => s.isConstant).map((s) => s.name);
  const crushability = analyzeCrushability(recs, fieldStats, cfg);
  const strategy = selectStrategy(fieldStats, pattern, items.length, crushability, cfg);
  return { itemCount: items.length, fieldStats, pattern, constantFields, crushability, strategy, estimatedReduction: estimateReduction(fieldStats, strategy) };
}

// ---------------------------------------------------------------------------
// K split + primitive crushers
// ---------------------------------------------------------------------------

export function computeKSplit(itemStrings: readonly string[], cfg: CrusherConfig, bias: number, maxItems?: number): { total: number; first: number; last: number; importance: number } {
  const maxK = maxItems !== undefined && maxItems > 0 ? maxItems : cfg.maxItemsAfterCrush > 0 ? cfg.maxItemsAfterCrush : undefined;
  const total = computeOptimalK(itemStrings, bias, 3, maxK);
  let first = Math.max(1, roundTiesEven(total * cfg.firstFraction));
  let last = Math.max(1, roundTiesEven(total * cfg.lastFraction));
  first = Math.min(first, total);
  last = Math.min(last, Math.max(0, total - first));
  return { total, first, last, importance: Math.max(0, total - first - last) };
}

function hasErrorKeyword(s: string): boolean {
  const lower = s.toLowerCase();
  return ERROR_KEYWORDS.some((k) => lower.includes(k));
}

export function crushStringArray(items: readonly string[], cfg: CrusherConfig = DEFAULT_CRUSHER_CONFIG, bias = 1, maxItems?: number): { items: string[]; info: string } {
  const n = items.length;
  if (n <= 8) return { items: [...items], info: 'string:passthrough' };
  const { total, first, last } = computeKSplit(items, cfg, bias, maxItems);
  const errorIdx = new Set<number>();
  items.forEach((s, i) => {
    if (hasErrorKeyword(s)) errorIdx.add(i);
  });
  const lengths = items.map((s) => [...s].length);
  const anomalyIdx = new Set<number>();
  if (lengths.length > 1) {
    const m = mean(lengths);
    const sd = sampleStdev(lengths);
    if (sd > 0) lengths.forEach((l, i) => Math.abs(l - m) > cfg.varianceThreshold * sd && anomalyIdx.add(i));
  }
  const keep = new Set<number>([...errorIdx, ...anomalyIdx]);
  for (let i = 0; i < Math.min(first, n); i++) keep.add(i);
  for (let i = Math.max(0, n - last); i < n; i++) keep.add(i);
  const seen = new Set<string>();
  for (const i of keep) seen.add(items[i]);
  let dedup = 0;
  const remaining = total - keep.size;
  if (remaining > 0) {
    const stride = Math.max(1, Math.trunc((n - 1) / (remaining + 1)));
    const cap = total + errorIdx.size + anomalyIdx.size;
    for (let i = 0; i < n; i += stride) {
      if (keep.size >= cap) break;
      if (keep.has(i)) continue;
      if (!seen.has(items[i])) {
        keep.add(i);
        seen.add(items[i]);
      } else dedup++;
    }
  }
  const idx = [...keep].sort((a, b) => a - b);
  let info = `string:adaptive(${n}->${idx.length}`;
  if (dedup) info += `,dedup=${dedup}`;
  if (errorIdx.size) info += `,errors=${errorIdx.size}`;
  return { items: idx.map((i) => items[i]), info: `${info})` };
}

function formatG(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return String(x);
  return Number(x.toPrecision(6)).toString();
}

export function crushNumberArray(items: readonly unknown[], cfg: CrusherConfig = DEFAULT_CRUSHER_CONFIG, bias = 1, maxItems?: number): { items: unknown[]; info: string } {
  const n = items.length;
  if (n <= 8) return { items: [...items], info: 'number:passthrough' };
  const finite = items.filter(isFiniteNumber);
  if (!finite.length) return { items: [...items], info: 'number:no_finite' };
  const strings = items.map((v) => JSON.stringify(v) ?? 'null');
  const { total, first, last } = computeKSplit(strings, cfg, bias, maxItems);
  const m = mean(finite);
  const med = median(finite);
  const sd = finite.length > 1 ? sampleStdev(finite) : 0;
  const sorted = [...finite].sort((a, b) => a - b);
  const p25 = percentileLinear(sorted, 0.25);
  const p75 = percentileLinear(sorted, 0.75);
  const outliers = new Set<number>();
  if (sd > 0) items.forEach((v, i) => isFiniteNumber(v) && Math.abs(v - m) > cfg.varianceThreshold * sd && outliers.add(i));
  const changes = new Set<number>();
  if (cfg.preserveChangePoints && n > 10 && sd > 0) {
    const w = 5;
    for (let i = w; i < n - w; i++) {
      const left = items.slice(i - w, i).filter(isFiniteNumber);
      const right = items.slice(i, i + w).filter(isFiniteNumber);
      if (left.length && right.length && Math.abs(mean(right) - mean(left)) > cfg.varianceThreshold * sd) changes.add(i);
    }
  }
  const keep = new Set<number>([...outliers, ...changes]);
  for (let i = 0; i < Math.min(first, n); i++) keep.add(i);
  for (let i = Math.max(0, n - last); i < n; i++) keep.add(i);
  const remaining = total - keep.size;
  if (remaining > 0) {
    const stride = Math.max(1, Math.trunc((n - 1) / (remaining + 1)));
    const cap = total + outliers.size;
    for (let i = 0; i < n; i += stride) {
      if (keep.size >= cap) break;
      keep.add(i);
    }
  }
  const idx = [...keep].sort((a, b) => a - b);
  let info = `number:adaptive(${n}->${idx.length},min=${formatG(sorted[0])},max=${formatG(sorted[sorted.length - 1])},mean=${formatG(m)},median=${formatG(med)},stddev=${formatG(sd)},p25=${formatG(p25)},p75=${formatG(p75)}`;
  if (outliers.size) info += `,outliers=${outliers.size}`;
  if (changes.size) info += `,change_points=${changes.size}`;
  return { items: idx.map((i) => items[i]), info: `${info})` };
}

export function crushObject(obj: Rec, cfg: CrusherConfig = DEFAULT_CRUSHER_CONFIG, bias = 1, maxItems?: number): { value: Rec; info: string } {
  const keys = Object.keys(obj);
  const n = keys.length;
  if (n <= 8) return { value: { ...obj }, info: 'object:passthrough' };
  const kvTokens = keys.map((k) => Math.trunc((JSON.stringify(obj[k]) ?? 'null').length / 4) + Math.trunc(k.length / 4) + 2);
  const totalTokens = kvTokens.reduce((a, b) => a + b, 0);
  if (totalTokens < cfg.minTokensToCrush) return { value: { ...obj }, info: 'object:passthrough' };
  const kvStrings = keys.map((k) => `${k}: ${JSON.stringify(obj[k]) ?? 'null'}`);
  const maxK = maxItems !== undefined && maxItems > 0 ? maxItems : cfg.maxItemsAfterCrush > 0 ? cfg.maxItemsAfterCrush : undefined;
  const total = computeOptimalK(kvStrings, bias, 3, maxK);
  if (total >= n) return { value: { ...obj }, info: 'object:passthrough' };
  const keep = new Set<string>();
  const isError = (k: string): boolean => hasErrorKeyword(JSON.stringify(obj[k]) ?? '');
  for (const k of keys) if (isError(k)) keep.add(k);
  keys.forEach((k, i) => kvTokens[i] <= 12 && keep.add(k));
  const first = Math.max(1, roundTiesEven(total * cfg.firstFraction));
  const last = Math.max(1, roundTiesEven(total * cfg.lastFraction));
  for (const k of keys.slice(0, first)) keep.add(k);
  for (const k of keys.slice(Math.max(0, n - last))) keep.add(k);
  const remaining = total - keep.size;
  if (remaining > 0) {
    const stride = Math.max(1, Math.trunc((n - 1) / (remaining + 1)));
    for (let i = 0; i < n; i += stride) {
      const errorsKept = [...keep].filter(isError).length;
      if (keep.size >= total + errorsKept) break;
      keep.add(keys[i]);
    }
  }
  const value: Rec = {};
  for (const k of keys) if (keep.has(k)) value[k] = obj[k];
  return { value, info: `object:adaptive(${n}->${Object.keys(value).length} keys)` };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PlanOptions {
  query?: string;
  maxItems: number;
  preserveKeywords?: readonly string[];
  itemStrings?: readonly string[];
}

function numericAnomalyIndices(items: readonly Rec[], analysis: ArrayAnalysis, cfg: CrusherConfig): Set<number> {
  const out = new Set<number>();
  for (const [name, st] of analysis.fieldStats) {
    if (st.fieldType !== 'numeric' || st.mean === undefined || !(st.variance && st.variance > 0)) continue;
    const limit = cfg.varianceThreshold * Math.sqrt(st.variance);
    items.forEach((it, i) => {
      const v = it[name];
      if (isFiniteNumber(v) && Math.abs(v - (st.mean as number)) > limit) out.add(i);
    });
  }
  return out;
}

function fillRemainingSlots(keep: Set<number>, items: readonly unknown[], n: number, effectiveMax: number): Set<number> {
  const remaining = effectiveMax - keep.size;
  if (remaining <= 0) return new Set(keep);
  const seen = new Set<string>();
  for (const i of keep) if (i < n) seen.add(itemHash(items[i]));
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) if (!keep.has(i)) candidates.push(i);
  if (!candidates.length) return new Set(keep);
  const result = new Set(keep);
  const step = Math.max(1, Math.trunc(candidates.length / (remaining + 1)));
  let added = 0;
  outer: for (let off = 0; off < step; off++) {
    if (added >= remaining) break;
    for (let i = off; i < candidates.length; i += step) {
      if (added >= remaining) break outer;
      const idx = candidates[i];
      const h = itemHash(items[idx]);
      if (!seen.has(h)) {
        result.add(idx);
        seen.add(h);
        added++;
      }
    }
  }
  return result;
}

/** Dedup by content → fill to budget → if over budget keep all critical + first-3/last-2 + ascending rest. May exceed the budget when critical items alone do. */
export function prioritizeIndices(keep: ReadonlySet<number>, items: readonly unknown[], effectiveMax: number, cfg: CrusherConfig, analysis?: ArrayAnalysis): number[] {
  const n = items.length;
  let current = new Set<number>();
  if (cfg.dedupIdenticalItems) {
    const seen = new Map<string, number>();
    for (const i of [...keep].sort((a, b) => a - b)) {
      if (i >= n) continue;
      const h = itemHash(items[i]);
      if (!seen.has(h)) seen.set(h, i);
    }
    current = new Set(seen.values());
  } else current = new Set([...keep].filter((i) => i < n));
  if (current.size < effectiveMax && current.size < n) current = fillRemainingSlots(current, items, n, effectiveMax);
  if (current.size <= effectiveMax) return [...current].sort((a, b) => a - b);

  const recs = items.filter(isRecord);
  const critical = new Set<number>([...detectErrorItems(items), ...detectStructuralOutliers(items)]);
  if (analysis && recs.length === items.length) for (const i of numericAnomalyIndices(recs, analysis, cfg)) critical.add(i);
  const prioritized = new Set<number>([...critical].filter((i) => current.has(i) || i < n));
  let remaining = effectiveMax - prioritized.size;
  if (remaining > 0) {
    for (let i = 0; i < Math.min(3, n) && remaining > 0; i++) {
      if (!prioritized.has(i)) {
        prioritized.add(i);
        remaining--;
      }
    }
    for (let i = Math.max(0, n - 2); i < n && remaining > 0; i++) {
      if (!prioritized.has(i)) {
        prioritized.add(i);
        remaining--;
      }
    }
  }
  if (remaining > 0) {
    for (const i of [...current].filter((x) => !prioritized.has(x)).sort((a, b) => a - b)) {
      if (remaining <= 0) break;
      prioritized.add(i);
      remaining--;
    }
  }
  return [...prioritized].sort((a, b) => a - b);
}

function normalizeMessage(s: string): string {
  return s
    .replace(/0x[0-9a-fA-F]+/g, 'ADDR')
    .replace(/\d+/g, 'N')
    .replace(/\/[\w/]+\//g, '/PATH/');
}

/** Keep-set planner for object arrays. Returns sorted indices. */
export function planKeepIndices(analysis: ArrayAnalysis, items: readonly Rec[], opts: PlanOptions, cfg: CrusherConfig = DEFAULT_CRUSHER_CONFIG): number[] {
  const n = items.length;
  const maxItems = opts.maxItems;
  const strings = opts.itemStrings ?? items.map((it) => JSON.stringify(it) ?? '');
  const query = (opts.query ?? '').trim();
  const strategy = analysis.strategy;
  if (strategy === 'skip' || strategy === 'none') return items.map((_, i) => i);

  const keep = new Set<number>();
  const addConstraints = (): void => {
    for (const i of detectStructuralOutliers(items)) keep.add(i);
    for (const i of detectErrorItems(items, strings)) keep.add(i);
  };
  const addQuerySignals = (limitRelevance?: { threshold: number; maxAdds: number }): void => {
    if (!query) return;
    const anchors = extractQueryAnchors(query);
    if (anchors.length) items.forEach((it, i) => itemMatchesAnchors(it, anchors) && keep.add(i));
    const scores = scoreRelevance(strings, query);
    if (limitRelevance) {
      let adds = 0;
      scores.forEach((s, i) => {
        if (adds < limitRelevance.maxAdds && s.score >= limitRelevance.threshold && !keep.has(i)) {
          keep.add(i);
          adds++;
        }
      });
    } else scores.forEach((s, i) => s.score >= cfg.relevanceThreshold && keep.add(i));
  };
  const addPreserve = (): void => {
    const kws = (opts.preserveKeywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
    if (!kws.length) return;
    strings.forEach((s, i) => {
      const lower = s.toLowerCase();
      if (kws.some((k) => lower.includes(k))) keep.add(i);
    });
  };

  if (strategy === 'top_n') {
    let best: { name: string; conf: number } | undefined;
    for (const st of analysis.fieldStats.values()) {
      const [ok, conf] = detectScoreField(st, items);
      if (ok && (!best || conf > best.conf)) best = { name: st.name, conf };
    }
    if (best) {
      const name = best.name;
      const order = items.map((it, i) => ({ i, s: isFiniteNumber(it[name]) ? (it[name] as number) : 0 })).sort((a, b) => b.s - a.s || a.i - b.i);
      for (const { i } of order.slice(0, Math.max(0, maxItems - 3))) keep.add(i);
      addConstraints();
      addQuerySignals({ threshold: Math.max(2 * cfg.relevanceThreshold, 0.5), maxAdds: 3 });
      addPreserve();
      return [...keep].sort((a, b) => a - b);
    }
  }

  for (const i of selectAnchors(items, maxItems, analysis.pattern, query || undefined)) keep.add(i);
  addConstraints();
  for (const i of numericAnomalyIndices(items, analysis, cfg)) keep.add(i);
  const window = strategy === 'time_series' ? 2 : 1;
  if (strategy === 'time_series' || cfg.preserveChangePoints) {
    for (const st of analysis.fieldStats.values()) {
      for (const cp of st.changePoints) for (let i = Math.max(0, cp - window); i <= Math.min(n - 1, cp + window); i++) keep.add(i);
    }
  }
  if (strategy === 'cluster') {
    let messageField: string | undefined;
    for (const name of [...analysis.fieldStats.keys()].sort()) {
      if (name.toLowerCase().includes('message')) {
        messageField = name;
        break;
      }
    }
    if (messageField) {
      const seen = new Set<string>();
      items.forEach((it, i) => {
        const v = it[messageField as string];
        const key = normalizeMessage(typeof v === 'string' ? v : reprValue(v));
        if (!seen.has(key)) {
          seen.add(key);
          keep.add(i);
        }
      });
    }
  }
  addQuerySignals();
  addPreserve();
  return prioritizeIndices(keep, items, maxItems, cfg, analysis);
}

// ---------------------------------------------------------------------------
// Compaction (csv-schema)
// ---------------------------------------------------------------------------

export interface FieldSpec {
  name: string;
  typeTag: string;
  nullable: boolean;
}

export type CellValue = { kind: 'missing' } | { kind: 'scalar'; value: unknown } | { kind: 'nested'; value: unknown[] } | { kind: 'opaque'; marker: string };

export type Compaction =
  | { kind: 'table'; schema: FieldSpec[]; rows: CellValue[][]; originalCount: number }
  | { kind: 'buckets'; discriminator: string; buckets: Array<{ key: string; schema: FieldSpec[]; rows: CellValue[][] }>; originalCount: number }
  | { kind: 'untouched'; items: unknown[] };

export type OpaqueHandler = (value: string, kind: 'base64' | 'html' | 'string') => string | null;

export interface CompactOptions {
  opaque?: OpaqueHandler;
}

function typeTagFor(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'string';
  return 'json';
}

function inferTypeTag(items: readonly Rec[], key: string): string {
  let tag: string | undefined;
  for (const it of items) {
    const v = it[key];
    if (v === null || v === undefined) continue;
    const t = typeTagFor(v);
    if (tag === undefined) tag = t;
    else if (tag !== t) return 'json';
  }
  return tag ?? 'string';
}

function looksLikeBase64(s: string): boolean {
  if (s.length < 64 || s.includes('<') || s.includes('>') || /\s/.test(s)) return false;
  let alphabet = 0;
  const uniq = new Set<string>();
  for (const c of s) {
    if (/[A-Za-z0-9+/=_-]/.test(c)) alphabet++;
    uniq.add(c);
  }
  return alphabet / s.length >= 0.95 && uniq.size >= 16;
}

function looksLikeHtml(s: string): boolean {
  let tags = 0;
  for (let i = 0; i + 1 < s.length; i++) if (s[i] === '<' && /[A-Za-z/!]/.test(s[i + 1])) tags++;
  return tags >= 3;
}

function cellFromValue(v: unknown, cfg: CrusherConfig, opts: CompactOptions): CellValue {
  if (Array.isArray(v)) {
    if (v.length >= 2 && v.every(isRecord)) return { kind: 'nested', value: v };
    return { kind: 'scalar', value: v };
  }
  if (typeof v === 'string') {
    if (v.includes('<<vg-ccr:')) return { kind: 'scalar', value: v };
    const t = v.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const parsed = JSON.parse(v) as unknown;
        if (parsed !== null && typeof parsed === 'object') {
          if (Array.isArray(parsed) && parsed.length >= 2 && parsed.every(isRecord)) return { kind: 'nested', value: parsed };
          return { kind: 'scalar', value: parsed };
        }
      } catch {
        /* not JSON */
      }
    }
    if (opts.opaque && Buffer.byteLength(v, 'utf8') > cfg.opaqueMinBytes) {
      const kind = looksLikeBase64(v) ? 'base64' : looksLikeHtml(v) ? 'html' : 'string';
      const marker = opts.opaque(v, kind);
      if (marker) return { kind: 'opaque', marker };
    }
  }
  return { kind: 'scalar', value: v };
}

function keyFreqs(items: readonly Rec[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) for (const k of Object.keys(it)) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

function buildTable(items: readonly Rec[], freqs: Map<string, number>, cfg: CrusherConfig, opts: CompactOptions): Compaction {
  const ordered = [...freqs.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k]) => k);
  const total = items.length;
  const schema: FieldSpec[] = ordered.map((k) => ({
    name: k,
    typeTag: inferTypeTag(items, k),
    nullable: (freqs.get(k) ?? 0) < total || items.some((it) => Object.prototype.hasOwnProperty.call(it, k) && (it[k] === null || it[k] === undefined)),
  }));
  const rows: CellValue[][] = items.map((it) => ordered.map((k) => (Object.prototype.hasOwnProperty.call(it, k) ? cellFromValue(it[k], cfg, opts) : { kind: 'missing' as const })));
  flattenUniformNested(schema, rows, cfg);
  return { kind: 'table', schema, rows, originalCount: total };
}

function flattenUniformNested(schema: FieldSpec[], rows: CellValue[][], cfg: CrusherConfig): void {
  let i = 0;
  while (i < schema.length) {
    if (schema[i].name.includes('.')) {
      i++;
      continue;
    }
    let canonical: string[] | undefined;
    let sawObject = false;
    let ok = true;
    for (const row of rows) {
      const cell = row[i];
      if (cell.kind === 'missing') continue;
      if (cell.kind === 'scalar' && isRecord(cell.value)) {
        const keys = Object.keys(cell.value);
        sawObject = true;
        if (!canonical) canonical = keys;
        else if (canonical.length !== keys.length || canonical.some((k, j) => k !== keys[j])) {
          ok = false;
          break;
        }
      } else {
        ok = false;
        break;
      }
    }
    if (!ok || !sawObject || !canonical || canonical.length === 0 || canonical.length > cfg.maxFlattenInnerKeys) {
      i++;
      continue;
    }
    const parent = schema[i].name;
    const inner = canonical;
    const specs: FieldSpec[] = inner.map((k) => ({ name: `${parent}.${k}`, typeTag: 'string', nullable: false }));
    schema.splice(i, 1, ...specs);
    for (const row of rows) {
      const cell = row[i];
      const obj = cell.kind === 'scalar' && isRecord(cell.value) ? cell.value : null;
      const expanded: CellValue[] = inner.map((k) => (obj && Object.prototype.hasOwnProperty.call(obj, k) ? { kind: 'scalar', value: obj[k] } : { kind: 'missing' }));
      row.splice(i, 1, ...expanded);
    }
    for (let off = 0; off < inner.length; off++) {
      const col = i + off;
      let tag: string | undefined;
      let nullable = false;
      for (const row of rows) {
        const cell = row[col];
        if (cell.kind === 'missing') nullable = true;
        else if (cell.kind === 'scalar') {
          if (cell.value === null || cell.value === undefined) nullable = true;
          else {
            const t = typeTagFor(cell.value);
            if (tag === undefined) tag = t;
            else if (tag !== t) tag = 'json';
          }
        } else tag = 'json';
      }
      schema[col].typeTag = tag ?? 'string';
      schema[col].nullable = nullable;
    }
    i += inner.length;
  }
}

function detectDiscriminator(items: readonly Rec[], freqs: Map<string, number>, cfg: CrusherConfig): string | null {
  const total = items.length;
  let best: { key: string; n: number } | null = null;
  for (const [k, f] of [...freqs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (f < total) continue;
    const distinct = new Set<string>();
    let allStrings = true;
    for (const it of items) {
      const v = it[k];
      if (typeof v !== 'string') {
        allStrings = false;
        break;
      }
      distinct.add(v);
    }
    if (!allStrings) continue;
    const n = distinct.size;
    if (n < cfg.minBuckets || n > cfg.maxBuckets) continue;
    if (n / total > 0.7) continue;
    if (!best || n > best.n) best = { key: k, n };
  }
  return best?.key ?? null;
}

/** Array of objects → table / buckets / untouched. */
export function compactArray(items: readonly unknown[], cfg: CrusherConfig = DEFAULT_CRUSHER_CONFIG, opts: CompactOptions = {}): Compaction {
  if (items.length < 2 || !items.every(isRecord)) return { kind: 'untouched', items: [...items] };
  const recs = items as Rec[];
  const freqs = keyFreqs(recs);
  const total = recs.length;
  const coreThreshold = Math.ceil(total * cfg.coreFieldFraction);
  let coreCount = 0;
  for (const f of freqs.values()) if (f >= coreThreshold) coreCount++;
  const coreRatio = freqs.size === 0 ? 1 : coreCount / freqs.size;
  if (coreRatio < cfg.heterogeneousCoreRatio) {
    const disc = detectDiscriminator(recs, freqs, cfg);
    if (disc) {
      const groups = new Map<string, Rec[]>();
      for (const it of recs) {
        const key = typeof it[disc] === 'string' ? (it[disc] as string) : '__missing__';
        let g = groups.get(key);
        if (!g) {
          g = [];
          groups.set(key, g);
        }
        g.push(it);
      }
      const buckets = [...groups.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([key, group]) => {
          const inner = compactArray(group, cfg, opts);
          if (inner.kind === 'table') return { key, schema: inner.schema, rows: inner.rows };
          return { key, schema: [{ name: 'value', typeTag: 'json', nullable: false }], rows: group.map((v) => [{ kind: 'scalar' as const, value: v }]) };
        });
      return { kind: 'buckets', discriminator: disc, buckets, originalCount: total };
    }
  }
  return buildTable(recs, freqs, cfg, opts);
}

function csvQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function needsCsvQuote(s: string): boolean {
  return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r');
}

function scalarToCsv(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return needsCsvQuote(v) ? csvQuote(v) : v;
  return csvQuote(JSON.stringify(v) ?? '');
}

function formatCell(c: CellValue): string {
  switch (c.kind) {
    case 'missing':
      return '';
    case 'scalar':
      return scalarToCsv(c.value);
    case 'nested':
      return csvQuote(JSON.stringify(c.value) ?? '');
    case 'opaque':
      return c.marker;
  }
}

function writeTable(out: string[], schema: FieldSpec[], rows: CellValue[][], originalCount: number, includeDrop: boolean): void {
  const decl = schema.map((f) => `${f.name}:${f.typeTag}${f.nullable ? '?' : ''}`).join(',');
  let head = `[${rows.length}]{${decl}}`;
  if (includeDrop && rows.length < originalCount) head += ` __dropped:${originalCount - rows.length}`;
  out.push(head);
  for (const row of rows) out.push(row.map(formatCell).join(','));
}

/** `[N]{col:type?,…}[ __dropped:D]` + CSV rows; buckets as `__buckets:disc` / `__key:` sections. Newline-terminated rows. */
export function renderCsvSchema(c: Compaction, opts: { dropped?: number } = {}): string {
  const out: string[] = [];
  const includeDrop = opts.dropped !== undefined && opts.dropped > 0;
  if (c.kind === 'table') {
    writeTable(out, c.schema, c.rows, includeDrop ? c.rows.length + (opts.dropped as number) : c.originalCount, includeDrop);
  } else if (c.kind === 'buckets') {
    let head = `__buckets:${c.discriminator}`;
    if (includeDrop) head += ` __dropped:${opts.dropped}`;
    out.push(head);
    for (const b of c.buckets) {
      out.push(`__key:${scalarToCsv(b.key)}`);
      writeTable(out, b.schema, b.rows, b.rows.length, false);
    }
  } else {
    return JSON.stringify(c.items);
  }
  return `${out.join('\n')}\n`;
}

/** Compact JSON rendering of a compaction (`{"_compaction":"table",…}`). */
export function renderCompactionJson(c: Compaction): string {
  const cell = (v: CellValue): unknown => (v.kind === 'missing' ? null : v.kind === 'scalar' ? v.value : v.kind === 'nested' ? v.value : v.marker);
  const schema = (s: FieldSpec[]): unknown[] => s.map((f) => (f.nullable ? { name: f.name, type: f.typeTag, nullable: true } : { name: f.name, type: f.typeTag }));
  if (c.kind === 'table') return JSON.stringify({ _compaction: 'table', _schema: schema(c.schema), _kept: c.rows.length, _total: c.originalCount, _rows: c.rows.map((r) => r.map(cell)) });
  if (c.kind === 'buckets') return JSON.stringify({ _compaction: 'buckets', _discriminator: c.discriminator, _total: c.originalCount, _buckets: c.buckets.map((b) => ({ _key: b.key, _schema: schema(b.schema), _rows: b.rows.map((r) => r.map(cell)) })) });
  return JSON.stringify(c.items);
}

export function isCompacted(c: Compaction): boolean {
  return c.kind !== 'untouched';
}

// ---------------------------------------------------------------------------
// crushArray
// ---------------------------------------------------------------------------

export interface CrushArrayOptions {
  query?: string;
  bias?: number;
  /** Effective item cap (profile / env); falls back to `cfg.maxItemsAfterCrush`. */
  maxItems?: number;
  ccr?: CcrSink | null;
  /** Emit markers + store originals. False = marker-free lossy. */
  injectMarker?: boolean;
  preserveKeywords?: readonly string[];
  toolName?: string;
  /** The text stored as the recoverable original (defaults to the canonical array JSON). */
  originalText?: string;
  originalTokens?: number;
}

export interface CrushArrayResult {
  items: unknown[];
  strategyInfo: string;
  /** 24-char store hash when rows were offloaded and stored. */
  ccrHash?: string;
  /** `<<vg-ccr:HASH N_rows_offloaded>>` when rows were dropped and stored. */
  droppedSummary: string;
  compacted?: string;
  compactionKind?: string;
  dropped: number;
  lossless: boolean;
}

export const ROW_MARKER_RE = /<<vg-ccr:([0-9a-f]{12,24}) (\d+)_rows_offloaded>>/g;

export function rowMarker(hash: string, dropped: number): string {
  return `<<vg-ccr:${hash.slice(0, 12)} ${dropped}_rows_offloaded>>`;
}

export function droppedSentinel(dropped: number, hash?: string): Rec {
  return hash ? { _vg_dropped: dropped, hash: hash.slice(0, 12) } : { _vg_dropped: dropped };
}

export function isDroppedSentinel(item: unknown): boolean {
  return isRecord(item) && typeof item._vg_dropped === 'number';
}

export function stripSentinels(items: unknown[]): unknown[] {
  return items.filter((it) => !isDroppedSentinel(it));
}

function humanCount(n: number): string {
  return String(n);
}

function makeOpaqueHandler(opts: CrushArrayOptions, cfg: CrusherConfig): OpaqueHandler | undefined {
  if (!opts.injectMarker || !opts.ccr || cfg.losslessOnly) return undefined;
  const sink = opts.ccr;
  return (value: string): string | null => {
    try {
      const hash = sink.store(value, { compressed: '', strategy: 'smart_crusher', toolName: opts.toolName, originalItemCount: 1, compressedItemCount: 0 });
      return `<<vg-ccr:${hash.slice(0, 12)},chars,${humanCount([...value].length)}>>`;
    } catch {
      return null;
    }
  };
}

export function canonicalArrayJson(items: readonly unknown[]): string {
  return canonicalize(items);
}

/** The full SmartCrusher pipeline over an already-parsed array. */
export function crushArray(items: readonly unknown[], opts: CrushArrayOptions = {}, cfg: CrusherConfig = DEFAULT_CRUSHER_CONFIG): CrushArrayResult {
  const bias = Number.isFinite(opts.bias) && (opts.bias as number) > 0 ? (opts.bias as number) : 1;
  const strings = items.map((it) => JSON.stringify(it) ?? 'null');
  const maxK = opts.maxItems !== undefined && opts.maxItems > 0 ? opts.maxItems : cfg.maxItemsAfterCrush > 0 ? cfg.maxItemsAfterCrush : undefined;
  const adaptiveK = computeOptimalK(strings, bias, 3, maxK);
  const untouched = (info: string): CrushArrayResult => ({ items: [...items], strategyInfo: info, droppedSummary: '', dropped: 0, lossless: true });
  if (items.length <= adaptiveK) return untouched('none:adaptive_at_limit');

  if (cfg.withCompaction && items.every(isRecord)) {
    const c = compactArray(items, cfg, { opaque: makeOpaqueHandler(opts, cfg) });
    if (isCompacted(c)) {
      const rendered = cfg.compactionFormat === 'json' ? renderCompactionJson(c) : renderCsvSchema(c);
      const inputBytes = strings.reduce((a, s) => a + s.length + 1, 0) + 1;
      const savings = inputBytes > 0 ? 1 - rendered.length / inputBytes : 0;
      if (savings >= cfg.losslessMinSavingsRatio) {
        return { items: [...items], strategyInfo: `lossless:${c.kind}(${items.length} rows)`, droppedSummary: '', compacted: rendered, compactionKind: c.kind, dropped: 0, lossless: true };
      }
    }
  }
  if (cfg.losslessOnly) return untouched('lossless_only:uncompacted');
  // markers requested but nowhere to store the original → row drops would be unrecoverable
  if (opts.injectMarker && !opts.ccr) return untouched('skip:no_store');

  if (!items.every(isRecord)) return untouched('skip:not_objects');
  const recs = items as Rec[];
  const analysis = analyzeArray(recs, cfg);
  if (analysis.strategy === 'skip' || analysis.strategy === 'none') return untouched(analysis.strategy === 'skip' ? `skip:${analysis.crushability?.reason ?? ''}` : 'none:too_few');
  const keep = planKeepIndices(analysis, recs, { query: opts.query, maxItems: adaptiveK, preserveKeywords: opts.preserveKeywords, itemStrings: strings }, cfg);
  const kept = keep.map((i) => items[i]);
  const dropped = items.length - kept.length;
  if (dropped <= 0) return untouched('none:nothing_dropped');
  let ccrHash: string | undefined;
  let droppedSummary = '';
  if (opts.injectMarker && opts.ccr) {
    const original = opts.originalText ?? canonicalArrayJson(items);
    try {
      ccrHash = opts.ccr.store(original, {
        compressed: JSON.stringify(kept),
        strategy: 'smart_crusher',
        originalItemCount: items.length,
        compressedItemCount: kept.length,
        toolName: opts.toolName,
        queryContext: opts.query,
        originalTokens: opts.originalTokens,
      });
      droppedSummary = rowMarker(ccrHash, dropped);
    } catch {
      return untouched('skip:store_failed');
    }
  }
  return { items: kept, strategyInfo: `${analysis.strategy}(${items.length}->${kept.length})`, ccrHash, droppedSummary, dropped, lossless: false };
}

/** Group a mixed-type array by type, crush each group ≥ minItems, reassemble in original order. */
export function crushMixedArray(items: readonly unknown[], opts: CrushArrayOptions = {}, cfg: CrusherConfig = DEFAULT_CRUSHER_CONFIG): { items: unknown[]; info: string; dropped: number } {
  const groups = new Map<string, number[]>();
  const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v === 'object' ? 'dict' : typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? 'number' : typeof v === 'string' ? 'str' : 'other');
  items.forEach((it, i) => {
    const t = typeOf(it);
    let g = groups.get(t);
    if (!g) {
      g = [];
      groups.set(t, g);
    }
    g.push(i);
  });
  const keep = new Set<number>();
  const infos: string[] = [];
  for (const [t, idx] of groups) {
    if (idx.length < cfg.minItemsToAnalyze) {
      for (const i of idx) keep.add(i);
      continue;
    }
    const group = idx.map((i) => items[i]);
    if (t === 'dict') {
      const r = crushArray(group, { ...opts, injectMarker: false }, { ...cfg, withCompaction: false });
      const keptSet = new Set(r.items.map((v) => JSON.stringify(v)));
      let taken = 0;
      for (const i of idx) {
        const s = JSON.stringify(items[i]);
        if (keptSet.has(s) && taken < r.items.length) {
          keep.add(i);
          taken++;
        }
      }
      infos.push(`dict:${r.strategyInfo}`);
    } else if (t === 'str') {
      const r = crushStringArray(group as string[], cfg, opts.bias ?? 1, opts.maxItems);
      const counts = new Map<string, number>();
      for (const s of r.items) counts.set(s, (counts.get(s) ?? 0) + 1);
      for (const i of idx) {
        const s = items[i] as string;
        const c = counts.get(s) ?? 0;
        if (c > 0) {
          keep.add(i);
          counts.set(s, c - 1);
        }
      }
      infos.push(r.info);
    } else if (t === 'number') {
      const r = crushNumberArray(group, cfg, opts.bias ?? 1, opts.maxItems);
      const counts = new Map<string, number>();
      for (const v of r.items) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      for (const i of idx) {
        const s = String(items[i]);
        const c = counts.get(s) ?? 0;
        if (c > 0) {
          keep.add(i);
          counts.set(s, c - 1);
        }
      }
      infos.push(r.info);
    } else for (const i of idx) keep.add(i);
  }
  const ordered = [...keep].sort((a, b) => a - b);
  return { items: ordered.map((i) => items[i]), info: `mixed(${items.length}->${ordered.length}:${infos.join(';')})`, dropped: items.length - ordered.length };
}

// ---------------------------------------------------------------------------
// Compressor
// ---------------------------------------------------------------------------

const WRAPPER_KEYS = ['items', 'results', 'data', 'records', 'rows', 'entries', 'hits', 'matches', 'messages', 'files'];

export class SmartCrusher implements Compressor {
  readonly strategy = 'smart_crusher' as const;
  readonly config: CrusherConfig;

  constructor(config: Partial<CrusherConfig> = {}) {
    this.config = { ...DEFAULT_CRUSHER_CONFIG, ...config };
  }

  compress(req: CompressRequest): CompressResponse {
    const content = req.content;
    const passthrough = (info: string): CompressResponse => ({ content, strategy: 'passthrough', chain: ['smart_crusher', 'passthrough'], ccrHashes: [], info });
    try {
      if (!content.trim()) return passthrough('empty');
      if (content.length / 3.2 < this.config.minTokensToCrush && req.tokenizer.count(content) < this.config.minTokensToCrush) return passthrough('below_min_tokens');
      const cfg: CrusherConfig = { ...this.config, losslessOnly: this.config.losslessOnly || req.losslessOnly };
      const normalized = normalizeConcatenatedJson(content);
      const parsed = parseJsonLoose(normalized ?? content);
      if (!parsed) return passthrough('not_json');
      const stripped = (normalized ?? content).trim();
      const prefix = normalized ? '' : stripped.slice(0, parsed.span[0]);
      const suffix = normalized ? '' : stripped.slice(parsed.span[1]);
      const maxItems = req.profile?.maxItemsAfterCrush;
      const base: CrushArrayOptions = {
        query: req.query,
        bias: req.bias ?? req.profile?.bias,
        maxItems,
        ccr: req.ccr ?? null,
        injectMarker: req.injectMarker && !cfg.losslessOnly,
        preserveKeywords: req.profile?.preserveKeywords,
        toolName: req.toolName,
        originalText: content,
        originalTokens: req.tokenizer.count(content),
      };
      const value = parsed.value;
      let out: string;
      let info: string;
      let ccrHashes: string[] = [];
      let itemCounts: { original: number; kept: number } | undefined;
      let lossless = true;
      if (Array.isArray(value)) {
        const r = this.crushAny(value, base, cfg);
        out = r.text;
        info = r.info;
        ccrHashes = r.ccrHash ? [r.ccrHash] : [];
        itemCounts = { original: value.length, kept: value.length - r.dropped };
        lossless = r.lossless;
      } else if (isRecord(value)) {
        const key = WRAPPER_KEYS.find((k) => Array.isArray(value[k]) && (value[k] as unknown[]).length >= cfg.minItemsToAnalyze);
        if (key) {
          const inner = value[key] as unknown[];
          const r = this.crushAny(inner, base, cfg);
          if (r.dropped === 0 && !r.compacted) return passthrough(r.info);
          const rest: Rec = { ...value };
          rest[key] = r.compacted !== undefined ? r.compacted : r.items;
          out = JSON.stringify(rest) + (r.marker ? `\n${r.marker}` : '');
          info = `${key}:${r.info}`;
          ccrHashes = r.ccrHash ? [r.ccrHash] : [];
          itemCounts = { original: inner.length, kept: inner.length - r.dropped };
          lossless = r.lossless;
        } else {
          if (cfg.losslessOnly) {
            out = JSON.stringify(value);
            info = 'object:minify';
          } else {
            const r = crushObject(value, cfg, base.bias ?? 1, maxItems);
            if (r.info === 'object:passthrough') {
              out = JSON.stringify(value);
              info = 'object:minify';
            } else {
              // dropped keys are unrecoverable without a marker: only allowed marker-free or with a store
              if (base.injectMarker && !base.ccr) return passthrough('skip:no_store');
              let hash: string | undefined;
              if (base.injectMarker && base.ccr) {
                hash = base.ccr.store(content, { compressed: JSON.stringify(r.value), strategy: 'smart_crusher', originalItemCount: Object.keys(value).length, compressedItemCount: Object.keys(r.value).length, toolName: req.toolName, queryContext: req.query, originalTokens: base.originalTokens });
                ccrHashes = [hash];
              }
              const dropped = Object.keys(value).length - Object.keys(r.value).length;
              out = JSON.stringify({ ...r.value, ...droppedSentinel(dropped, hash) });
              info = r.info;
              itemCounts = { original: Object.keys(value).length, kept: Object.keys(r.value).length };
              lossless = false;
            }
          }
        }
      } else return passthrough('not_container');
      const full = prefix + out + suffix;
      if (full.length >= content.length) return passthrough(`${info}:not_smaller`);
      return { content: full, strategy: 'smart_crusher', chain: lossless ? ['lossless_json', 'smart_crusher'] : ['smart_crusher'], ccrHashes, info: lossless && !info.startsWith('lossless:') ? `lossless:${info}` : info, itemCounts };
    } catch {
      return passthrough('error');
    }
  }

  private crushAny(value: unknown[], base: CrushArrayOptions, cfg: CrusherConfig): { text: string; info: string; ccrHash?: string; dropped: number; items: unknown[]; compacted?: string; marker?: string; lossless: boolean } {
    if (value.every(isRecord)) {
      const r = crushArray(value, base, cfg);
      if (r.compacted !== undefined) return { text: r.compacted, info: r.strategyInfo, dropped: 0, items: r.items, compacted: r.compacted, lossless: true };
      if (r.dropped === 0) return { text: JSON.stringify(value), info: `${r.strategyInfo}:minify`, dropped: 0, items: r.items, lossless: true };
      const withSentinel = [...r.items, droppedSentinel(r.dropped, r.ccrHash)];
      let text = JSON.stringify(withSentinel);
      if (cfg.withCompaction && cfg.compactionFormat === 'csv-schema' && r.items.every(isRecord)) {
        const c = compactArray(r.items, cfg, {});
        if (isCompacted(c)) {
          const csv = renderCsvSchema(c, { dropped: r.dropped });
          if (csv.length <= text.length * (1 - cfg.losslessMinSavingsRatio)) text = csv.replace(/\n$/, '');
        }
      }
      if (r.droppedSummary) text += `\n${r.droppedSummary}`;
      return { text, info: r.strategyInfo, ccrHash: r.ccrHash, dropped: r.dropped, items: r.items, marker: r.droppedSummary || undefined, lossless: false };
    }
    if (cfg.losslessOnly) return { text: JSON.stringify(value), info: 'array:minify', dropped: 0, items: value, lossless: true };
    if (base.injectMarker && !base.ccr) return { text: JSON.stringify(value), info: 'skip:no_store', dropped: 0, items: value, lossless: true };
    let items: unknown[];
    let info: string;
    if (value.every((v) => typeof v === 'string')) {
      const r = crushStringArray(value as string[], cfg, base.bias ?? 1, base.maxItems);
      items = r.items;
      info = r.info;
    } else if (value.every((v) => typeof v === 'number')) {
      const r = crushNumberArray(value, cfg, base.bias ?? 1, base.maxItems);
      items = r.items;
      info = r.info;
    } else {
      const r = crushMixedArray(value, base, cfg);
      items = r.items;
      info = r.info;
    }
    const dropped = value.length - items.length;
    if (dropped === 0) return { text: JSON.stringify(value), info: `${info}:minify`, dropped: 0, items, lossless: true };
    let ccrHash: string | undefined;
    let marker: string | undefined;
    if (base.injectMarker && base.ccr) {
      ccrHash = base.ccr.store(base.originalText ?? JSON.stringify(value), { compressed: JSON.stringify(items), strategy: 'smart_crusher', originalItemCount: value.length, compressedItemCount: items.length, toolName: base.toolName, queryContext: base.query, originalTokens: base.originalTokens });
      marker = rowMarker(ccrHash, dropped);
    }
    let text = JSON.stringify([...items, droppedSentinel(dropped, ccrHash)]);
    if (marker) text += `\n${marker}`;
    return { text, info, ccrHash, dropped, items, marker, lossless: false };
  }
}
