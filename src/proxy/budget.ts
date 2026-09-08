/**
 * Budget enforcement on top of the cost tracker.
 *
 * `basis = billed` (default) counts only provider-measured spend against the
 * limit; `estimated` also counts locally estimated spend. A request that
 * would exceed the limit is refused with **402** and a typed body naming the
 * period, the limit, the spend so far and the estimated share.
 */

import type { CostTracker, BudgetPeriod } from './cost.js';

export interface BudgetVerdict {
  allowed: boolean;
  limitUsd: number;
  spentUsd: number;
  measuredUsd: number;
  estimatedUsd: number;
  remainingUsd: number;
  period: BudgetPeriod;
  basis: 'billed' | 'estimated';
}

export class BudgetGuard {
  constructor(private readonly tracker: CostTracker) {}

  check(limitUsd: number, period: BudgetPeriod, basis: 'billed' | 'estimated'): BudgetVerdict {
    const b = this.tracker.periodBreakdown(period);
    const spent = basis === 'estimated' ? b.totalUsd : b.measuredUsd;
    const remaining = Math.max(0, limitUsd - spent);
    return { allowed: limitUsd <= 0 || spent < limitUsd, limitUsd, spentUsd: spent, measuredUsd: b.measuredUsd, estimatedUsd: b.estimatedUsd, remainingUsd: remaining, period, basis };
  }
}

export function budgetDenialBody(v: BudgetVerdict, format: 'anthropic' | 'openai'): Record<string, unknown> {
  const message = `Budget exceeded: $${v.spentUsd.toFixed(4)} of $${v.limitUsd.toFixed(2)} per ${v.period} spent` + (v.estimatedUsd > 0 ? ` ($${v.estimatedUsd.toFixed(4)} estimated)` : '') + '. Raise VG_PROXY_BUDGET or wait for the period to roll over.';
  const detail = { period: v.period, limit_usd: v.limitUsd, spent_usd: v.spentUsd, measured_usd: v.measuredUsd, estimated_usd: v.estimatedUsd, basis: v.basis };
  if (format === 'anthropic') return { type: 'error', error: { type: 'budget_exceeded', message, ...detail } };
  return { error: { type: 'budget_exceeded', code: 'budget_exceeded', message, ...detail } };
}
