/**
 * In-process metrics with a Prometheus text exposition (`vg_` prefix).
 *
 * Bounded cardinality: labelled series are capped and overflow lands in an
 * `other` bucket; label values are escaped and keys sorted so a scrape never
 * fails because of a client-controlled model id. Timings are milliseconds
 * (`_sum/_count/_min/_max`, no histogram buckets — `vg savings --benchmark` has real p95).
 */

export const MAX_DISTINCT_MODELS = 100;
export const MAX_DISTINCT_LABEL_VALUES = 64;

interface Timing {
  sum: number;
  count: number;
  min: number;
  max: number;
}

function timing(): Timing {
  return { sum: 0, count: 0, min: Number.POSITIVE_INFINITY, max: 0 };
}

function observe(t: Timing, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  t.sum += ms;
  t.count++;
  t.min = Math.min(t.min, ms);
  t.max = Math.max(t.max, ms);
}

export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"').replace(/[\uD800-\uDFFF]/g, '\uFFFD');
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  return `{${keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(',')}}`;
}

export interface RequestMetricInput {
  provider: string;
  model: string;
  client: string;
  status: number;
  inputTokens: number;
  outputTokens: number;
  tokensSaved: number;
  deferredTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  overheadMs: number;
  ttfbMs?: number;
  cached: boolean;
  transforms: string[];
  outputTokensSaved?: number;
  usd: number;
  usdSaved: number;
}

export class Metrics {
  readonly startedAt: number;
  requestsTotal = 0;
  requestsCached = 0;
  requestsRateLimited = 0;
  requestsBudgetDenied = 0;
  requestsFailed = 0;
  inboundTotal = 0;
  inboundActive = 0;
  tokensInput = 0;
  tokensOutput = 0;
  tokensSaved = 0;
  tokensDeferred = 0;
  outputTokensSaved = 0;
  cacheRead = 0;
  cacheWrite = 0;
  usdTotal = 0;
  usdSaved = 0;
  compressionFailed = new Map<string, number>();
  retrieveRounds = 0;
  upstreamErrors = new Map<string, number>();
  readonly latency = timing();
  readonly overhead = timing();
  readonly ttfb = timing();
  private readonly byProvider = new Map<string, number>();
  private readonly byModel = new Map<string, { requests: number; tokensSaved: number; inputTokens: number; outputTokens: number; usd: number; usdSaved: number }>();
  private readonly byClient = new Map<string, { requests: number; tokensSaved: number }>();
  private readonly byStatus = new Map<string, number>();
  private readonly transforms = new Map<string, number>();
  private readonly strategyTokens = new Map<string, number>();

  constructor(now: () => number = () => Date.now()) {
    this.startedAt = now();
  }

  private bucketModel(model: string): string {
    if (this.byModel.has(model) || this.byModel.size < MAX_DISTINCT_MODELS) return model || 'unknown';
    return 'other';
  }

  private bucketLabel(map: Map<string, unknown>, value: string): string {
    if (map.has(value) || map.size < MAX_DISTINCT_LABEL_VALUES) return value || 'unknown';
    return 'other';
  }

  recordRequest(r: RequestMetricInput): void {
    this.requestsTotal++;
    if (r.cached) this.requestsCached++;
    if (r.status >= 500) this.requestsFailed++;
    this.tokensInput += r.inputTokens;
    this.tokensOutput += r.outputTokens;
    this.tokensSaved += r.tokensSaved;
    this.tokensDeferred += r.deferredTokens;
    this.outputTokensSaved += r.outputTokensSaved ?? 0;
    this.cacheRead += r.cacheReadTokens;
    this.cacheWrite += r.cacheWriteTokens;
    this.usdTotal += r.usd;
    this.usdSaved += r.usdSaved;
    observe(this.latency, r.latencyMs);
    observe(this.overhead, r.overheadMs);
    if (r.ttfbMs !== undefined) observe(this.ttfb, r.ttfbMs);
    const p = this.bucketLabel(this.byProvider, r.provider);
    this.byProvider.set(p, (this.byProvider.get(p) ?? 0) + 1);
    const m = this.bucketModel(r.model);
    const row = this.byModel.get(m) ?? { requests: 0, tokensSaved: 0, inputTokens: 0, outputTokens: 0, usd: 0, usdSaved: 0 };
    row.requests++;
    row.tokensSaved += r.tokensSaved + r.deferredTokens;
    row.inputTokens += r.inputTokens;
    row.outputTokens += r.outputTokens;
    row.usd += r.usd;
    row.usdSaved += r.usdSaved;
    this.byModel.set(m, row);
    const c = this.bucketLabel(this.byClient, r.client);
    const crow = this.byClient.get(c) ?? { requests: 0, tokensSaved: 0 };
    crow.requests++;
    crow.tokensSaved += r.tokensSaved + r.deferredTokens;
    this.byClient.set(c, crow);
    const s = String(r.status);
    this.byStatus.set(s, (this.byStatus.get(s) ?? 0) + 1);
    for (const t of r.transforms) {
      const name = t.split(':').slice(0, 2).join(':');
      const key = this.bucketLabel(this.transforms, name);
      this.transforms.set(key, (this.transforms.get(key) ?? 0) + 1);
      const parts = t.split(':');
      if (parts[0] === 'router' && parts[1]) {
        const k = this.bucketLabel(this.strategyTokens, parts[1]);
        this.strategyTokens.set(k, (this.strategyTokens.get(k) ?? 0) + 1);
      }
    }
  }

  recordCompressionFailed(reason: 'timeout' | 'error'): void {
    this.compressionFailed.set(reason, (this.compressionFailed.get(reason) ?? 0) + 1);
  }

  recordUpstreamError(provider: string): void {
    const p = this.bucketLabel(this.upstreamErrors, provider);
    this.upstreamErrors.set(p, (this.upstreamErrors.get(p) ?? 0) + 1);
  }

  snapshot(now: number): Record<string, unknown> {
    const map = (m: Map<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const k of [...m.keys()].sort()) out[k] = m.get(k);
      return out;
    };
    const tm = (t: Timing): Record<string, number> => ({ sum: t.sum, count: t.count, min: t.count ? t.min : 0, max: t.max, avg: t.count ? t.sum / t.count : 0 });
    const before = this.tokensInput + this.tokensSaved;
    return {
      uptimeSeconds: Math.max(0, Math.round((now - this.startedAt) / 1000)),
      requests: { total: this.requestsTotal, cached: this.requestsCached, rateLimited: this.requestsRateLimited, budgetDenied: this.requestsBudgetDenied, failed: this.requestsFailed, inboundActive: this.inboundActive, inboundTotal: this.inboundTotal, byProvider: map(this.byProvider), byStatus: map(this.byStatus) },
      tokens: { input: this.tokensInput, output: this.tokensOutput, saved: this.tokensSaved, deferred: this.tokensDeferred, headlineSaved: this.tokensSaved + this.tokensDeferred, before, savingsPercent: before > 0 ? ((this.tokensSaved + this.tokensDeferred) / (before + this.tokensDeferred)) * 100 : 0, outputSaved: this.outputTokensSaved, cacheRead: this.cacheRead, cacheWrite: this.cacheWrite },
      cost: { usd: this.usdTotal, usdSaved: this.usdSaved },
      latencyMs: tm(this.latency),
      overheadMs: tm(this.overhead),
      ttfbMs: tm(this.ttfb),
      byModel: map(this.byModel),
      byClient: map(this.byClient),
      transforms: map(this.transforms),
      compressionsByStrategy: map(this.strategyTokens),
      compressionFailed: map(this.compressionFailed),
      upstreamErrors: map(this.upstreamErrors),
      retrieveRounds: this.retrieveRounds,
    };
  }

  /** Prometheus text exposition (version 0.0.4). */
  exportPrometheus(now: number): string {
    const lines: string[] = [];
    const gauge = (name: string, help: string, value: number, labels: Record<string, string> = {}): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${formatLabels(labels)} ${fmt(value)}`);
    };
    const counter = (name: string, help: string, rows: Array<[Record<string, string>, number]>): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      for (const [labels, v] of rows) lines.push(`${name}${formatLabels(labels)} ${fmt(v)}`);
    };
    const timingRows = (name: string, help: string, t: Timing): void => {
      lines.push(`# HELP ${name}_ms ${help} (milliseconds)`, `# TYPE ${name}_ms summary`, `${name}_ms_sum ${fmt(t.sum)}`, `${name}_ms_count ${t.count}`, `${name}_ms_min ${fmt(t.count ? t.min : 0)}`, `${name}_ms_max ${fmt(t.max)}`);
    };
    counter('vg_requests_total', 'Requests handled by the proxy.', [[{}, this.requestsTotal]]);
    counter('vg_requests_cached_total', 'Requests served from the local response cache.', [[{}, this.requestsCached]]);
    counter('vg_requests_rate_limited_total', 'Requests refused by the rate limiter.', [[{}, this.requestsRateLimited]]);
    counter('vg_requests_budget_denied_total', 'Requests refused by the budget guard.', [[{}, this.requestsBudgetDenied]]);
    counter('vg_requests_failed_total', 'Requests that ended in a 5xx.', [[{}, this.requestsFailed]]);
    counter('vg_inbound_requests_total', 'All inbound HTTP requests.', [[{}, this.inboundTotal]]);
    gauge('vg_inbound_requests_active', 'Inbound requests in flight.', this.inboundActive);
    counter('vg_tokens_input_total', 'Input tokens forwarded upstream.', [[{}, this.tokensInput]]);
    counter('vg_tokens_output_total', 'Output tokens returned by upstreams.', [[{}, this.tokensOutput]]);
    counter('vg_tokens_saved_total', 'Input tokens removed by compression (excludes tool-schema deferral).', [[{}, this.tokensSaved]]);
    counter('vg_savings_attributed_tokens_total', 'Tokens saved by source.', [
      [{ source: 'compression', realized: 'true' }, this.tokensSaved],
      [{ source: 'tool_search', realized: 'true' }, this.tokensDeferred],
      [{ source: 'output_shaping', realized: 'false' }, this.outputTokensSaved],
    ]);
    counter('vg_cache_read_tokens_total', 'Provider prompt-cache read tokens.', [[{}, this.cacheRead]]);
    counter('vg_cache_write_tokens_total', 'Provider prompt-cache write tokens.', [[{}, this.cacheWrite]]);
    gauge('vg_cost_usd_total', 'Estimated spend (USD).', this.usdTotal);
    gauge('vg_savings_usd_total', 'Estimated list-priced savings (USD).', this.usdSaved);
    counter('vg_retrieve_rounds_total', 'Server-side retrieval rounds resolved.', [[{}, this.retrieveRounds]]);
    counter('vg_compression_failed_total', 'Compression failures by reason.', [...this.compressionFailed].sort().map(([k, v]) => [{ reason: k }, v]));
    counter('vg_upstream_connection_errors_total', 'Upstream transport errors by provider.', [...this.upstreamErrors].sort().map(([k, v]) => [{ provider: k }, v]));
    counter('vg_requests_by_provider', 'Requests by provider.', [...this.byProvider].sort().map(([k, v]) => [{ provider: k }, v]));
    counter('vg_requests_by_model', 'Requests by model.', [...this.byModel].sort().map(([k, v]) => [{ model: k }, v.requests]));
    counter('vg_tokens_saved_by_model', 'Headline tokens saved by model.', [...this.byModel].sort().map(([k, v]) => [{ model: k }, v.tokensSaved]));
    counter('vg_transforms_total', 'Transform applications by name.', [...this.transforms].sort().map(([k, v]) => [{ transform: k }, v]));
    timingRows('vg_latency', 'End-to-end request latency', this.latency);
    timingRows('vg_overhead', 'Proxy overhead before the upstream call', this.overhead);
    timingRows('vg_ttfb', 'Upstream time to first byte', this.ttfb);
    gauge('vg_uptime_seconds', 'Proxy uptime.', Math.max(0, (now - this.startedAt) / 1000));
    return `${lines.join('\n')}\n`;
  }

  reset(): void {
    const fresh = new Metrics(() => this.startedAt);
    Object.assign(this, fresh);
  }
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  return Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/\.?0+$/, '');
}
