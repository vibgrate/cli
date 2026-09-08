/**
 * `/api/stats`, `/api/savings`, `/metrics`, `/health`, `/ready`, `/version`.
 */

import type { ServerResponse } from 'node:http';
import { PROFILES } from '../../compress/config.js';
import type { ProxyContext } from '../context.js';
import { sendJson, sendText } from '../http.js';
import { normalizeApiUrl } from '../config.js';

export interface ProxyStats {
  service: 'vg-proxy';
  version: string;
  pid: number;
  uptimeSeconds: number;
  startedAt: number;
  config: Record<string, unknown>;
  metrics: Record<string, unknown>;
  sessions: Record<string, unknown>;
  rateLimiter: Record<string, unknown>;
  cost: Record<string, unknown>;
  responseCache: Record<string, unknown>;
  ccrStore: Record<string, unknown> | null;
  savings: Record<string, unknown>;
  outputSavings: Record<string, unknown>;
  recentRequests: unknown[];
  audit: unknown[];
  layers: { bound: string[]; missing: string[] };
}

export function buildStats(ctx: ProxyContext, opts: { includeRecent: boolean; includeConfig: boolean }): ProxyStats {
  const now = ctx.deps.now();
  const knobs = ctx.runtime.snapshot();
  const cfg = ctx.config;
  const level = knobs.verbosityLevel;
  const estimate = ctx.outputSavings.summary(level);
  let store: Record<string, unknown> | null = null;
  try {
    store = ctx.deps.store ? { ...ctx.deps.store.stats() } : null;
  } catch {
    store = null;
  }
  return {
    service: 'vg-proxy',
    version: ctx.version,
    pid: ctx.pid,
    uptimeSeconds: Math.max(0, Math.round((now - ctx.startedAt) / 1000)),
    startedAt: ctx.startedAt,
    config: opts.includeConfig
      ? { host: cfg.host, port: cfg.port, mode: knobs.mode, profile: knobs.profile, profileDescription: PROFILES[knobs.profile]?.description, optimize: cfg.optimize && knobs.compress, ccr: cfg.ccr && knobs.ccr, lossless: cfg.lossless, memory: knobs.memory && !!ctx.deps.memory, outputShaper: knobs.outputShaper || cfg.outputShaper, verbosityLevel: level, holdout: knobs.holdout, stateless: cfg.stateless, offline: cfg.offline, anthropicUrl: cfg.anthropicUrl, openaiUrl: cfg.openaiUrl, upstreamUrl: cfg.upstreamUrl, provider: cfg.provider ?? 'auto', budgetUsd: cfg.budgetUsd ?? knobs.budgetUsd, budgetPeriod: knobs.budgetPeriod, rpm: knobs.rpm, tpm: knobs.tpm, modelRoutes: { ...cfg.modelRoutes, ...knobs.modelRoutes }, savingsTarget: knobs.savingsTarget, tokenAuth: Boolean(cfg.token) }
      : { mode: knobs.mode, profile: knobs.profile },
    metrics: ctx.metrics.snapshot(now),
    sessions: ctx.sessions.stats(),
    rateLimiter: ctx.rateLimiter.stats(),
    cost: { totalUsd: ctx.cost.totalUsd, savingsUsd: ctx.cost.totalSavingsUsd, cacheAwareSavingsUsd: ctx.cost.totalCacheAwareSavingsUsd, period: ctx.cost.periodBreakdown(knobs.budgetPeriod), byModel: ctx.cost.perModel() },
    responseCache: ctx.semanticCache.stats(),
    ccrStore: store,
    savings: ctx.savings.view(),
    outputSavings: { ...estimate, level },
    recentRequests: opts.includeRecent ? ctx.requestLog.recent(50, knobs.logMessages) : [],
    audit: opts.includeRecent ? ctx.audit.recent.slice(-20) : [],
    layers: { bound: ctx.bound, missing: ctx.missing },
  };
}

export function handleStats(ctx: ProxyContext, res: ServerResponse, loopback: boolean): void {
  sendJson(res, 200, buildStats(ctx, { includeRecent: loopback, includeConfig: loopback }));
}

/** Ledger rollups (today / 7d / 30d / all) plus the durable tracker and the output-savings estimate. */
export function handleSavings(ctx: ProxyContext, res: ServerResponse): void {
  const now = ctx.deps.now();
  let rollups: Record<string, unknown> = {};
  try {
    const events = ctx.deps.readSavingsEvents(ctx.config.env, { now });
    rollups = ctx.deps.rollupSavings(events, now);
  } catch (err) {
    rollups = { error: (err as Error).message };
  }
  const knobs = ctx.runtime.snapshot();
  sendJson(res, 200, { rollups, tracker: ctx.savings.view(), outputSavings: { ...ctx.outputSavings.summary(knobs.verbosityLevel), level: knobs.verbosityLevel }, savingsTarget: knobs.savingsTarget });
}

export function handleMetrics(ctx: ProxyContext, res: ServerResponse): void {
  sendText(res, 200, ctx.metrics.exportPrometheus(ctx.deps.now()), 'text/plain; version=0.0.4; charset=utf-8');
}

const UPSTREAM_CHECK_TTL_MS = 30_000;
let lastUpstreamCheck: { at: number; ok: boolean; error?: string } | null = null;

async function checkUpstream(ctx: ProxyContext): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const e = ctx.config.env;
  if (ctx.config.offline || (e.VG_PROXY_SKIP_UPSTREAM_CHECK ?? '').toLowerCase() === 'true' || e.VG_PROXY_SKIP_UPSTREAM_CHECK === '1') return { ok: true, skipped: true };
  const now = ctx.deps.now();
  if (lastUpstreamCheck && now - lastUpstreamCheck.at < UPSTREAM_CHECK_TTL_MS) return { ok: lastUpstreamCheck.ok, error: lastUpstreamCheck.error };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  timer.unref?.();
  try {
    await ctx.transport(normalizeApiUrl(ctx.config.upstreamUrl ?? ctx.config.anthropicUrl), { method: 'HEAD', signal: controller.signal });
    lastUpstreamCheck = { at: now, ok: true };
  } catch (err) {
    lastUpstreamCheck = { at: now, ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
  return { ok: lastUpstreamCheck.ok, error: lastUpstreamCheck.error };
}

export function resetUpstreamCheck(): void {
  lastUpstreamCheck = null;
}

export function healthPayload(ctx: ProxyContext, loopback: boolean): Record<string, unknown> {
  const now = ctx.deps.now();
  const knobs = ctx.runtime.snapshot();
  const payload: Record<string, unknown> = {
    service: 'vg-proxy',
    status: 'healthy',
    ready: true,
    version: ctx.version,
    pid: ctx.pid,
    timestamp: new Date(now).toISOString(),
    uptime_seconds: Math.max(0, Math.round((now - ctx.startedAt) / 1000)),
    checks: { startup: { ready: true }, sessions: ctx.sessions.stats(), rate_limiter: { enabled: ctx.rateLimiter.enabled }, ccr_store: { enabled: Boolean(ctx.deps.store) }, memory: { enabled: knobs.memory, bound: Boolean(ctx.deps.memory) }, layers: { bound: ctx.bound, missing: ctx.missing } },
  };
  if (loopback) payload.config = buildStats(ctx, { includeRecent: false, includeConfig: true }).config;
  return payload;
}

export function handleHealth(ctx: ProxyContext, res: ServerResponse, loopback: boolean): void {
  sendJson(res, 200, healthPayload(ctx, loopback));
}

export async function handleReady(ctx: ProxyContext, res: ServerResponse, loopback: boolean): Promise<void> {
  const upstream = await checkUpstream(ctx);
  const payload = healthPayload(ctx, loopback);
  (payload.checks as Record<string, unknown>).upstream = upstream;
  payload.ready = upstream.ok;
  payload.status = upstream.ok ? 'healthy' : 'degraded';
  sendJson(res, upstream.ok ? 200 : 503, payload);
}

export function handleVersion(ctx: ProxyContext, res: ServerResponse): void {
  sendJson(res, 200, { service: 'vg-proxy', version: ctx.version, pid: ctx.pid, node: process.version });
}
