/**
 * Counterfactual estimation of output-token savings.
 *
 * Three honest tiers: measured (A/B holdout) > estimated (synthetic control
 * from a learned baseline) > modelled (benchmark factors — ships empty). The
 * holdout arm is conversation-stable and derived from a content hash seeded
 * into vg's PRNG, so identical conversations always land in the same arm.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { mulberry32 } from '../engine/rng.js';
import { outputSavingsPath } from '../compress/paths.js';
import type { MessageFormat } from '../compress/types.js';
import { firstUserText } from './session.js';

// ---------------------------------------------------------------------------
// Stratification + holdout
// ---------------------------------------------------------------------------

const INPUT_BUCKETS = [2_000, 8_000, 32_000, 128_000];
const STRATUM_LABEL = 'output_shaper:stratum:';
const CONTROL_LABEL = 'output_shaper:control:';

export function inputBucket(tokens: number): string {
  if (tokens < INPUT_BUCKETS[0]) return 'xs';
  if (tokens < INPUT_BUCKETS[1]) return 's';
  if (tokens < INPUT_BUCKETS[2]) return 'm';
  if (tokens < INPUT_BUCKETS[3]) return 'l';
  return 'xl';
}

export function modelFamily(model: string): string {
  const m = model.toLowerCase();
  for (const fam of ['opus', 'sonnet', 'haiku', 'fable', 'mythos', 'gpt', 'gemini', 'grok', 'llama', 'deepseek', 'qwen', 'kimi', 'mistral', 'glm']) if (m.includes(fam)) return fam;
  if (/^o[1-9](?:-|$)/.test(m)) return 'gpt';
  return 'other';
}

export function stratumKey(opts: { turnKind: string; inputTokens: number; model: string; hasTools: boolean }): string {
  return [modelFamily(opts.model), opts.turnKind, inputBucket(opts.inputTokens), opts.hasTools ? 'tools' : 'notools'].join('|');
}

function stableResponsesIdentifier(body: Record<string, unknown>): string {
  const str = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      for (const k of ['id', 'conversation_id', 'session_id', 'thread_id']) {
        const n = (v as Record<string, unknown>)[k];
        if (typeof n === 'string' && n) return n;
      }
    }
    return '';
  };
  for (const k of ['conversation', 'conversation_id', 'session_id', 'thread_id']) {
    const v = str(body[k]);
    if (v && v.toLowerCase() !== 'auto') return `${k}:${v}`;
  }
  for (const ck of ['client_metadata', 'metadata']) {
    const c = body[ck];
    if (!c || typeof c !== 'object') continue;
    for (const k of ['conversation_id', 'conversation_key', 'session_id', 'thread_id', 'codex_session_id']) {
      const v = str((c as Record<string, unknown>)[k]);
      if (v && v.toLowerCase() !== 'auto') return `${ck}.${k}:${v}`;
    }
  }
  if (typeof body.instructions === 'string' && body.instructions) return `instructions:${body.instructions.slice(0, 512)}`;
  return '';
}

/** Conversation-stable key: model + first user text (512 chars) [+ Responses identifier]. */
export function conversationKey(body: Record<string, unknown>, format: MessageFormat): string {
  const model = String(body.model ?? '');
  let seed = model;
  const first = firstUserText(body, format);
  if (first) seed += `\0${first.slice(0, 512)}`;
  if (format === 'responses' || 'input' in body) {
    const id = stableResponsesIdentifier(body);
    if (id) seed += `\0${id}`;
    else if (!body.messages) seed += '\0responses';
  }
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}

/** Content-hash seeded arm assignment (deterministic per conversation). */
export function assignArm(key: string, holdoutFraction: number): 'treatment' | 'control' {
  if (!(holdoutFraction > 0)) return 'treatment';
  if (holdoutFraction >= 1) return 'control';
  const digest = createHash('sha256').update(`arm:${key}`).digest('hex');
  const seed = parseInt(digest.slice(0, 8), 16);
  const frac = mulberry32(seed)();
  return frac < holdoutFraction ? 'control' : 'treatment';
}

export function stratumLabel(arm: 'treatment' | 'control', key: string): string {
  return (arm === 'treatment' ? STRATUM_LABEL : CONTROL_LABEL) + key;
}

export function parseStratumLabel(label: string): { arm: 'treatment' | 'control'; key: string } | null {
  if (label.startsWith(STRATUM_LABEL)) return { arm: 'treatment', key: label.slice(STRATUM_LABEL.length) };
  if (label.startsWith(CONTROL_LABEL)) return { arm: 'control', key: label.slice(CONTROL_LABEL.length) };
  return null;
}

// ---------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------

export interface AccumJson {
  n: number;
  sum: number;
  sumsq: number;
}

export class Accum {
  n = 0;
  sum = 0;
  sumsq = 0;
  add(x: number): void {
    this.n++;
    this.sum += x;
    this.sumsq += x * x;
  }
  get mean(): number {
    return this.n ? this.sum / this.n : 0;
  }
  get var(): number {
    if (this.n < 2) return 0;
    return Math.max(0, (this.sumsq - (this.sum * this.sum) / this.n) / (this.n - 1));
  }
  merge(o: Accum): void {
    this.n += o.n;
    this.sum += o.sum;
    this.sumsq += o.sumsq;
  }
  toJSON(): AccumJson {
    return { n: this.n, sum: this.sum, sumsq: this.sumsq };
  }
  static from(d: Partial<AccumJson> | undefined): Accum {
    const a = new Accum();
    a.n = Math.max(0, Math.floor(Number(d?.n ?? 0)) || 0);
    a.sum = finite(d?.sum);
    a.sumsq = finite(d?.sumsq);
    return a;
  }
}

function finite(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export class BaselineModel {
  strata = new Map<string, Accum>();
  glob = new Accum();
  observe(key: string, outputTokens: number): void {
    let a = this.strata.get(key);
    if (!a) this.strata.set(key, (a = new Accum()));
    a.add(outputTokens);
    this.glob.add(outputTokens);
  }
  merge(other: BaselineModel): void {
    for (const [k, a] of other.strata) {
      let mine = this.strata.get(k);
      if (!mine) this.strata.set(k, (mine = new Accum()));
      mine.merge(a);
    }
    this.glob.merge(other.glob);
  }
  /** `(mean, var, n)` with hierarchical back-off: exact → trimmed prefixes → global. */
  lookup(key: string): { mean: number; variance: number; n: number } {
    const exact = this.strata.get(key);
    if (exact && exact.n > 0) return { mean: exact.mean, variance: exact.var, n: exact.n };
    let parts = key.split('|');
    while (parts.length > 1) {
      parts = parts.slice(0, -1);
      const prefix = `${parts.join('|')}|`;
      for (const k of [...this.strata.keys()].sort()) {
        const a = this.strata.get(k)!;
        if (k.startsWith(prefix) && a.n > 0) return { mean: a.mean, variance: a.var, n: a.n };
      }
    }
    return { mean: this.glob.mean, variance: this.glob.var, n: this.glob.n };
  }
  get totalSamples(): number {
    return this.glob.n;
  }
  toJSON(): { strata: Record<string, AccumJson>; glob: AccumJson } {
    const strata: Record<string, AccumJson> = {};
    for (const k of [...this.strata.keys()].sort()) strata[k] = this.strata.get(k)!.toJSON();
    return { strata, glob: this.glob.toJSON() };
  }
  static from(d: { strata?: Record<string, Partial<AccumJson>>; glob?: Partial<AccumJson> } | undefined): BaselineModel {
    const m = new BaselineModel();
    for (const [k, a] of Object.entries(d?.strata ?? {})) m.strata.set(k, Accum.from(a));
    m.glob = Accum.from(d?.glob);
    return m;
  }
}

export interface SavingsEstimate {
  tokensSaved: number;
  baselineTokens: number;
  pct: number;
  ciLowPct: number;
  ciHighPct: number;
  nRequests: number;
  kind: 'measured' | 'estimated' | 'modelled';
  /** False for the modelled tier: the band is a benchmark spread, not a CI. */
  bandIsCi: boolean;
}

/** Benchmark factors per level — ships empty by design; `registerModelledFactors` is the seam. */
export const MODELLED_REDUCTION = new Map<number, [number, number]>();

export function registerModelledFactors(level: number, conservative: number, optimistic: number): void {
  if (!(conservative > 0 && conservative < 1) || !(optimistic > 0 && optimistic < 1)) throw new Error(`reduction factors must lie in (0, 1); got (${conservative}, ${optimistic})`);
  if (conservative > optimistic) throw new Error(`conservative factor ${conservative} exceeds optimistic ${optimistic}`);
  MODELLED_REDUCTION.set(level, [conservative, optimistic]);
}

function finalize(saved: number, baseline: number, variance: number, n: number, kind: SavingsEstimate['kind']): SavingsEstimate {
  const pct = baseline > 0 ? (saved / baseline) * 100 : 0;
  const se = Math.sqrt(Math.max(0, variance));
  const lo = saved - 1.96 * se;
  const hi = saved + 1.96 * se;
  return { tokensSaved: saved, baselineTokens: baseline, pct, ciLowPct: baseline > 0 ? (lo / baseline) * 100 : 0, ciHighPct: baseline > 0 ? (hi / baseline) * 100 : 0, nRequests: n, kind, bandIsCi: true };
}

export class SavingsLedger {
  baseline = new BaselineModel();
  treatment = new Map<string, Accum>();
  control = new Map<string, Accum>();

  record(arm: 'treatment' | 'control', key: string, outputTokens: number): void {
    const target = arm === 'treatment' ? this.treatment : this.control;
    let a = target.get(key);
    if (!a) target.set(key, (a = new Accum()));
    a.add(outputTokens);
  }

  /** Tier 1: Σ n_s·(μ_s − ȳ_s) signed; Var = Σ[n·σ²_y + n²·σ²_μ/m]. */
  estimateFromBaseline(): SavingsEstimate {
    let saved = 0;
    let baseline = 0;
    let variance = 0;
    let n = 0;
    for (const key of [...this.treatment.keys()].sort()) {
      const acc = this.treatment.get(key)!;
      if (acc.n === 0) continue;
      const { mean, variance: muVar, n: m } = this.baseline.lookup(key);
      if (m === 0) continue;
      n += acc.n;
      saved += acc.n * (mean - acc.mean);
      baseline += acc.n * mean;
      variance += acc.n * acc.var + acc.n * acc.n * (muVar / m);
    }
    return finalize(saved, baseline, variance, n, 'estimated');
  }

  /** Tier 2: strata with both arms; Var = n²·(σ²_c/n_c + σ²_t/n_t). */
  estimateFromHoldout(): SavingsEstimate | null {
    let saved = 0;
    let baseline = 0;
    let variance = 0;
    let n = 0;
    let contributing = 0;
    for (const key of [...this.treatment.keys()].sort()) {
      const t = this.treatment.get(key)!;
      const c = this.control.get(key);
      if (!c || c.n === 0 || t.n === 0) continue;
      contributing++;
      n += t.n;
      const delta = c.mean - t.mean;
      saved += t.n * delta;
      baseline += t.n * c.mean;
      variance += t.n * t.n * (c.var / c.n + t.var / t.n);
    }
    if (!contributing) return null;
    return finalize(saved, baseline, variance, n, 'measured');
  }

  /** Tier 3: saved = O·r/(1−r); band = benchmark spread (not a CI). */
  estimateFromModel(level: number): SavingsEstimate | null {
    const factors = MODELLED_REDUCTION.get(level);
    if (!factors) return null;
    let observed = 0;
    let n = 0;
    for (const acc of this.treatment.values()) {
      if (acc.n === 0) continue;
      observed += acc.n * acc.mean;
      n += acc.n;
    }
    if (n === 0 || observed <= 0) return null;
    const [lo, hi] = factors;
    const saved = (observed * lo) / (1 - lo);
    return { tokensSaved: saved, baselineTokens: observed + saved, pct: lo * 100, ciLowPct: lo * 100, ciHighPct: hi * 100, nRequests: n, kind: 'modelled', bandIsCi: false };
  }

  bestEstimate(level?: number): SavingsEstimate {
    const measured = this.estimateFromHoldout();
    if (measured) return measured;
    const estimated = this.estimateFromBaseline();
    if (estimated.nRequests > 0) return estimated;
    if (level !== undefined) {
      const modelled = this.estimateFromModel(level);
      if (modelled) return modelled;
    }
    return estimated;
  }

  toJSON(): Record<string, unknown> {
    const dump = (m: Map<string, Accum>): Record<string, AccumJson> => {
      const out: Record<string, AccumJson> = {};
      for (const k of [...m.keys()].sort()) out[k] = m.get(k)!.toJSON();
      return out;
    };
    return { baseline: this.baseline.toJSON(), treatment: dump(this.treatment), control: dump(this.control) };
  }

  static from(d: Record<string, unknown> | null | undefined): SavingsLedger {
    const l = new SavingsLedger();
    if (!d || typeof d !== 'object') return l;
    l.baseline = BaselineModel.from(d.baseline as { strata?: Record<string, Partial<AccumJson>>; glob?: Partial<AccumJson> } | undefined);
    for (const [k, a] of Object.entries((d.treatment as Record<string, Partial<AccumJson>>) ?? {})) l.treatment.set(k, Accum.from(a));
    for (const [k, a] of Object.entries((d.control as Record<string, Partial<AccumJson>>) ?? {})) l.control.set(k, Accum.from(a));
    return l;
  }
}

/** Per-request clamped estimate (treatment only) for accumulate-only surfaces. */
export function estimateRequestSavings(ledger: SavingsLedger, labels: string[], outputTokens: number): number {
  for (const label of labels) {
    const parsed = parseStratumLabel(label);
    if (!parsed) continue;
    if (parsed.arm !== 'treatment') return 0;
    const { mean, n } = ledger.baseline.lookup(parsed.key);
    if (n === 0) return 0;
    return Math.max(0, Math.round(mean - outputTokens));
  }
  return 0;
}

/** Fraction of the response's word 8-grams already present in the context (direct waste signal). */
export function echoRatio(output: string, context: string, n = 8): number {
  const words = (s: string): string[] => s.toLowerCase().split(/\s+/).filter(Boolean);
  const out = words(output);
  const ctx = words(context);
  if (out.length < n || ctx.length < n) return 0;
  const grams = new Set<string>();
  for (let i = 0; i + n <= ctx.length; i++) grams.add(ctx.slice(i, i + n).join(' '));
  let hits = 0;
  let total = 0;
  for (let i = 0; i + n <= out.length; i++) {
    total++;
    if (grams.has(out.slice(i, i + n).join(' '))) hits++;
  }
  return total ? hits / total : 0;
}

// ---------------------------------------------------------------------------
// Recorder (durable output-savings.json)
// ---------------------------------------------------------------------------

export const OUTPUT_SAVINGS_FLUSH_EVERY = 25;

export class OutputSavingsRecorder {
  ledger: SavingsLedger;
  private pending = 0;
  private readonly file: string;
  private lastBaselineJson = '';

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly opts: { stateless?: boolean; flushEvery?: number } = {},
  ) {
    this.file = outputSavingsPath(env);
    this.ledger = this.load();
  }

  private load(): SavingsLedger {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const l = SavingsLedger.from(JSON.parse(raw) as Record<string, unknown>);
      this.lastBaselineJson = JSON.stringify(l.baseline.toJSON());
      return l;
    } catch {
      return new SavingsLedger();
    }
  }

  /** Adopt an on-disk baseline that changed (e.g. written by `vg install <agent> --learn --apply`). */
  reloadBaseline(): boolean {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      const fresh = BaselineModel.from(raw.baseline as { strata?: Record<string, Partial<AccumJson>>; glob?: Partial<AccumJson> } | undefined);
      const json = JSON.stringify(fresh.toJSON());
      if (json !== this.lastBaselineJson && fresh.totalSamples > 0) {
        this.ledger.baseline = fresh;
        this.lastBaselineJson = json;
        return true;
      }
    } catch {
      /* no file / corrupt → keep in-memory */
    }
    return false;
  }

  recordFromLabels(labels: string[], outputTokens: number): void {
    for (const label of labels) {
      const parsed = parseStratumLabel(label);
      if (!parsed) continue;
      this.ledger.record(parsed.arm, parsed.key, outputTokens);
      this.pending++;
      if (this.pending >= (this.opts.flushEvery ?? OUTPUT_SAVINGS_FLUSH_EVERY)) this.flush();
      return;
    }
  }

  estimateRequest(labels: string[], outputTokens: number): number {
    return estimateRequestSavings(this.ledger, labels, outputTokens);
  }

  flush(): void {
    this.pending = 0;
    if (this.opts.stateless) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.ledger.toJSON()), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        /* non-POSIX */
      }
    } catch {
      /* best effort */
    }
  }

  summary(level?: number): SavingsEstimate {
    return this.ledger.bestEstimate(level);
  }
}
