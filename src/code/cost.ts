/**
 * Live cost / token metering for VG Code (VG-CLI-CODE §15).
 *
 * A session meter accumulates the prompt/completion tokens providers report and
 * turns them into a running dollar estimate from the model's published price
 * (per-million, from the catalog). Local models are free, so cost is 0 and only
 * tokens are shown. Pure and unit-tested; the estimate is labelled as such.
 */

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
}

/** USD per 1M tokens for the active model (from the catalog); absent for local/free. */
export interface ModelPricing {
  promptPerM?: number;
  completionPerM?: number;
}

/** Dollar cost of one usage sample under a pricing table (0 when unpriced/free). */
export function costOf(usage: TokenUsage, pricing: ModelPricing): number {
  const inCost = ((usage.promptTokens ?? 0) / 1e6) * (pricing.promptPerM ?? 0);
  const outCost = ((usage.completionTokens ?? 0) / 1e6) * (pricing.completionPerM ?? 0);
  return round4(inCost + outCost);
}

/** Accumulates usage + cost across a coding session. */
export class SessionMeter {
  private prompt = 0;
  private completion = 0;
  private cost = 0;
  private turns = 0;

  constructor(private pricing: ModelPricing = {}) {}

  /** Update the pricing (e.g. after `/model` switches model mid-session). */
  setPricing(pricing: ModelPricing): void {
    this.pricing = pricing;
  }

  /** Record one model turn; returns the incremental cost of just this turn. */
  add(usage: TokenUsage): number {
    this.prompt += usage.promptTokens ?? 0;
    this.completion += usage.completionTokens ?? 0;
    this.turns += 1;
    const delta = costOf(usage, this.pricing);
    this.cost = round4(this.cost + delta);
    return delta;
  }

  get totals(): { promptTokens: number; completionTokens: number; totalTokens: number; cost: number; turns: number } {
    return { promptTokens: this.prompt, completionTokens: this.completion, totalTokens: this.prompt + this.completion, cost: this.cost, turns: this.turns };
  }

  /** A compact one-line summary, e.g. `3.1k tok · ~$0.0042` (cost only when priced). */
  summary(): string {
    const t = this.totals;
    const tok = `${fmtTokens(t.totalTokens)} tok`;
    const priced = this.pricing.promptPerM || this.pricing.completionPerM;
    return priced ? `${tok} · ~$${t.cost.toFixed(4)}` : tok;
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
