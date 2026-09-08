/**
 * Cost model: prices a request from provider usage, values savings at list
 * price, and keeps a bounded, time-windowed ledger the budget guard reads.
 *
 *  - `savingsUsd` is list-priced (`saved · input_price`), monotonic — what
 *    budget enforcement and the headline use;
 *  - `cacheAwareSavingsUsd` values live-zone savings by the request's cache
 *    mix (message compression touches only the live zone: never cache-read);
 *  - an inferred cache write (OpenAI reports no write counter) is the same
 *    tokens as the uncached slice and is never double-counted.
 */

import type { ProxyDeps, UsageLike } from './deps.js';

export type BudgetPeriod = 'hour' | 'day' | 'week' | 'month';
export type CostBasis = 'measured' | 'estimated';

export interface CostEntry {
  ts: number;
  usd: number;
  basis: CostBasis;
}

export const MAX_COST_ENTRIES = 100_000;
export const COST_RETENTION_HOURS = 744;
const PRUNE_INTERVAL_MS = 300_000;
export const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000;

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** True when the write counter is inferred (no provider counter). */
  cacheInferred?: boolean;
}

/** Period cutoff: hour → now−1h; day → local midnight; week → Monday midnight; month → day 1. */
export function periodStart(period: BudgetPeriod, now: number): number {
  if (period === 'hour') return now - 3_600_000;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === 'day') return d.getTime();
  if (period === 'week') {
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dow);
    return d.getTime();
  }
  d.setDate(1);
  return d.getTime();
}

export class CostTracker {
  private entries: CostEntry[] = [];
  private lastPrune = 0;
  private readonly byModel = new Map<string, { requests: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; usd: number; tokensSaved: number; savingsUsd: number }>();
  totalUsd = 0;
  totalSavingsUsd = 0;
  totalCacheAwareSavingsUsd = 0;

  constructor(
    private readonly deps: Pick<ProxyDeps, 'priceFor' | 'costUsd'>,
    private readonly env: NodeJS.ProcessEnv,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Price a request; `measured` when provider usage is present, else estimated from local counts. */
  record(model: string, usage: ProviderUsage, localInputTokens: number, tokensSaved: number): { usd: number; basis: CostBasis; savingsUsd: number; cacheAwareSavingsUsd: number } {
    const hasUsage = usage.inputTokens !== undefined || usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined;
    const read = Math.max(0, usage.cacheReadTokens ?? 0);
    const write = usage.cacheInferred ? 0 : Math.max(0, usage.cacheWriteTokens ?? 0);
    const uncached = hasUsage ? Math.max(0, (usage.inputTokens ?? 0) - (usage.cacheInferred ? 0 : 0)) : localInputTokens;
    const usageLike: UsageLike = { input: uncached, output: Math.max(0, usage.outputTokens ?? 0), cacheRead: read, cacheWrite: write };
    let usd = 0;
    try {
      usd = this.deps.costUsd(model, usageLike, this.env);
    } catch {
      usd = 0;
    }
    if (!Number.isFinite(usd) || usd < 0) usd = 0;
    const basis: CostBasis = hasUsage ? 'measured' : 'estimated';
    const saved = Math.max(0, tokensSaved);
    let price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    try {
      const p = this.deps.priceFor(model, this.env);
      price = { input: p.input, output: p.output, cacheRead: p.cacheRead ?? p.input * 0.1, cacheWrite: p.cacheWrite ?? p.input * 1.25 };
    } catch {
      /* blended */
    }
    const savingsUsd = (saved * price.input) / 1e6;
    // Live-zone mix: write + uncached only.
    const live = write + uncached;
    const cacheAware = live > 0 ? (saved * ((write / live) * price.cacheWrite + (uncached / live) * price.input)) / 1e6 : savingsUsd;
    this.push({ ts: this.now(), usd, basis });
    this.totalUsd += usd;
    this.totalSavingsUsd += savingsUsd;
    this.totalCacheAwareSavingsUsd += cacheAware;
    const row = this.byModel.get(model) ?? { requests: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, usd: 0, tokensSaved: 0, savingsUsd: 0 };
    row.requests++;
    row.inputTokens += uncached + read + write;
    row.outputTokens += usageLike.output ?? 0;
    row.cacheRead += read;
    row.cacheWrite += write;
    row.usd += usd;
    row.tokensSaved += saved;
    row.savingsUsd += savingsUsd;
    this.byModel.set(model, row);
    return { usd, basis, savingsUsd, cacheAwareSavingsUsd: cacheAware };
  }

  private push(e: CostEntry): void {
    this.entries.push(e);
    if (this.entries.length > MAX_COST_ENTRIES) this.entries.splice(0, this.entries.length - MAX_COST_ENTRIES);
    if (e.ts - this.lastPrune > PRUNE_INTERVAL_MS) {
      const cutoff = e.ts - COST_RETENTION_HOURS * 3_600_000;
      this.entries = this.entries.filter((x) => x.ts >= cutoff);
      this.lastPrune = e.ts;
    }
  }

  /** Spend inside the current period, split by basis. */
  periodBreakdown(period: BudgetPeriod): { period: BudgetPeriod; totalUsd: number; measuredUsd: number; estimatedUsd: number; records: number; estimatedRecords: number } {
    const start = periodStart(period, this.now());
    let measured = 0;
    let estimated = 0;
    let records = 0;
    let estimatedRecords = 0;
    for (const e of this.entries) {
      if (e.ts < start) continue;
      records++;
      if (e.basis === 'measured') measured += e.usd;
      else {
        estimated += e.usd;
        estimatedRecords++;
      }
    }
    return { period, totalUsd: measured + estimated, measuredUsd: measured, estimatedUsd: estimated, records, estimatedRecords };
  }

  perModel(): Record<string, { requests: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; usd: number; tokensSaved: number; savingsUsd: number }> {
    const out: Record<string, { requests: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; usd: number; tokensSaved: number; savingsUsd: number }> = {};
    for (const k of [...this.byModel.keys()].sort()) out[k] = { ...this.byModel.get(k)! };
    return out;
  }

  reset(): void {
    this.entries = [];
    this.byModel.clear();
    this.totalUsd = 0;
    this.totalSavingsUsd = 0;
    this.totalCacheAwareSavingsUsd = 0;
  }
}
