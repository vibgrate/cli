/**
 * `startProxy` — assembles the context, binds the listener and dispatches
 * requests through the middleware order: security headers → CORS preflight →
 * auth (token; loopback exempt) → route match (admin off-loopback → 404) →
 * body cap → handler. DESIGN.md §3.3.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import { VERSION } from '../version.js';
import { env as knobEnv } from '../compress/config.js';
import { verbosityProfilePath } from '../compress/paths.js';
import type { CompressionSession } from '../compress/pipeline.js';
import { AuditLog } from './audit.js';
import { BudgetGuard } from './budget.js';
import { isLoopbackBind, type ProxyConfig } from './config.js';
import type { ProxyContext } from './context.js';
import { CostTracker } from './cost.js';
import type { ProxyDeps, StoreLike } from './deps.js';
import { fallbackDeps, loadDefaultDeps } from './fallbacks.js';
import { AUTH_EXEMPT_PATHS, corsHeaders, parseCidrs, readToken, requestIsLoopback, SECURITY_HEADERS, tokenMatches } from './guards.js';
import { BodyTooLarge, errorBody, headerMap, readBody, sendJson, sendText } from './http.js';
import { writeProxyState, removeProxyState, type ProxyState } from './lifecycle.js';
import { Metrics } from './metrics.js';
import { OutputSavingsRecorder } from './output-savings.js';
import { RateLimiter } from './rate-limit.js';
import { ProxyLogger, RequestLogger } from './request-log.js';
import { matchRoute, pathKnown } from './routes.js';
import { RuntimeEnv } from './runtime-env.js';
import { SavingsTracker } from './savings-tracker.js';
import { SemanticCache } from './semantic-cache.js';
import { SessionEngine } from './session.js';
import { createTransport } from './upstream.js';
import { DEFAULT_BUFFERED_GRACE_MS, HEARTBEAT_INTERVAL_MS } from './sse.js';
import { dashboardHtml } from './dashboard.html.js';
import { handleChat } from './handlers/chat.js';
import { anthropicAdapter } from './handlers/anthropic.js';
import { openAIChatAdapter } from './handlers/openai-chat.js';
import { openAIResponsesAdapter } from './handlers/openai-responses.js';
import { handlePassthrough } from './handlers/passthrough.js';
import { handleCompress, handleRetrieve } from './handlers/compress.js';
import { handleCacheClear, handleCcrEntry, handleClients, handleSettingsGet, handleSettingsPost, handleShutdown, handleStatsReset } from './handlers/admin.js';
import { buildStats, handleHealth, handleMetrics, handleReady, handleSavings, handleStats, handleVersion, type ProxyStats } from './handlers/stats.js';
import { MAX_MESSAGE_ARRAY_LENGTH } from './context.js';

export type { ProxyStats } from './handlers/stats.js';

export interface RunningProxy {
  close(): Promise<void>;
  port: number;
  host: string;
  url: string;
  pid: number;
  startedAt: number;
  stats(): ProxyStats;
  /** The assembled context (for tests and the CLI). */
  context: ProxyContext;
}

/** §3.3 deps plus any structural override of the dependency bundle (tests). */
export type StartProxyDeps = {
  now?: () => number;
  fetch?: typeof fetch;
  session?: CompressionSession;
  /**
   * The retrievable-original store. Typed structurally (`StoreLike`) rather than
   * as `CompressionStore`: the proxy only ever calls `exists`/`get`/`stats`, so a
   * real store, the in-memory fallback, and a test double are all acceptable.
   */
  store?: StoreLike | null;
} & Partial<Omit<ProxyDeps, 'now' | 'fetch' | 'store'>> & {
  /** When true (default) the real compress/ccr/memory modules are bound where present. */
  bindModules?: boolean;
  /** Foreground: echo log lines to stderr. */
  stderr?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
  pinnedKnobs?: string[];
};

export async function startProxy(config: ProxyConfig, deps: StartProxyDeps = {}): Promise<RunningProxy> {
  if (!isLoopbackBind(config.host) && !config.token) {
    throw new Error(`refusing to bind ${config.host} without a token: set VG_PROXY_TOKEN or pass --token (non-loopback binds require client authentication)`);
  }
  const env = config.env;
  const { session, store, bindModules, stderr, baseEnv, pinnedKnobs, ...overrides } = deps;
  let bound: string[] = [];
  let missing: string[] = [];
  let bundle: ProxyDeps;
  if (bindModules === false) bundle = fallbackDeps({ ...overrides, ...(store !== undefined ? { store } : {}) });
  else {
    const loaded = await loadDefaultDeps({ env, memory: config.memory, projectRoot: config.workspace, now: overrides.now });
    bound = loaded.bound;
    missing = loaded.missing;
    bundle = { ...loaded.deps, ...overrides, ...(store !== undefined ? { store } : {}) };
  }
  if (session) bundle.compressMessages = (m, o) => session.compress(m, o);
  if (overrides.fetch) bundle.fetch = overrides.fetch;
  if (config.offline) bundle.warmRouter = bundle.warmRouter; // no network anyway; kept for symmetry
  try {
    await bundle.warmRouter?.();
  } catch {
    /* warm-up is best effort */
  }

  const now = bundle.now;
  const runtime = new RuntimeEnv(env, baseEnv ?? process.env, pinnedKnobs ?? []);
  const knobs = runtime.snapshot();
  const logger = new ProxyLogger({ level: knobs.logLevel, file: config.stateless ? undefined : (config.logFile ?? undefined), stderr: stderr ?? false, now });
  const requestLog = new RequestLogger(config.stateless || !config.logFile ? undefined : `${config.logFile}.requests.jsonl`);
  const cost = new CostTracker(bundle, env, now);
  const metrics = new Metrics(now);
  const transport = overrides.fetch ? bundle.fetch : createTransport(env, bundle.fetch);
  const ctx: ProxyContext = {
    config,
    deps: bundle,
    runtime,
    metrics,
    sessions: new SessionEngine({ maxSessions: knobEnv.int('VG_PROXY_MAX_SESSIONS', env, { min: 1 }), ttlSeconds: knobEnv.int('VG_PROXY_SESSION_TTL_SECONDS', env, { min: 1 }), now }),
    rateLimiter: new RateLimiter(config.rpm ?? knobs.rpm, config.tpm ?? knobs.tpm, now),
    cost,
    budget: new BudgetGuard(cost),
    savings: new SavingsTracker(bundle, env, { stateless: config.stateless, now }),
    outputSavings: new OutputSavingsRecorder(env, { stateless: config.stateless }),
    requestLog,
    logger,
    audit: new AuditLog(env, { enabled: () => runtime.snapshot().audit, stateless: config.stateless, now }),
    semanticCache: new SemanticCache({ ttlSeconds: knobs.semanticCacheTtl, now }),
    transport,
    limits: {
      maxBodyBytes: knobEnv.int('VG_PROXY_MAX_BODY_BYTES', env, { min: 1024 }),
      bodyTooLargeStatus: clampStatus(knobEnv.int('VG_PROXY_BODY_TOO_LARGE_STATUS', env), 413),
      sseBufferMaxBytes: knobEnv.int('VG_PROXY_SSE_BUFFER_MAX_BYTES', env, { min: 1024 }),
      requestTimeoutMs: Math.round(knobEnv.float('VG_PROXY_REQUEST_TIMEOUT', env, { min: 0 }) * 1000),
      bufferedGraceMs: graceMs(knobEnv.float('VG_CCR_BUFFERED_GRACE_SECONDS', env)),
      heartbeatMs: HEARTBEAT_INTERVAL_MS,
      maxMessages: MAX_MESSAGE_ARRAY_LENGTH,
      retryMaxAttempts: 3,
    },
    trustedGateways: parseCidrs(knobEnv.list('VG_PROXY_TRUSTED_GATEWAY_CIDRS', env)),
    trustedDashboard: parseCidrs(knobEnv.list('VG_PROXY_TRUSTED_DASHBOARD_CLIENT_CIDRS', env)),
    corsOrigins: knobEnv.list('VG_PROXY_CORS_ORIGINS', env),
    stripInternalHeaders: knobEnv.bool('VG_PROXY_STRIP_INTERNAL_HEADERS', env),
    metricsEnabled: knobEnv.bool('VG_PROXY_METRICS', env),
    startedAt: now(),
    pid: process.pid,
    version: VERSION,
    bound,
    missing,
    requestCounter: 0,
    inflight: 0,
    learnedVerbosity: readLearnedVerbosity(env),
    requestShutdown: () => {
      void close();
    },
  };

  const server = http.createServer((req, res) => {
    void dispatch(ctx, req, res).catch((err: unknown) => {
      logger.error('request_failed', { path: req.url, message: (err as Error).message });
      if (!res.headersSent) sendJson(res, 500, errorBody('generic', 'internal_error', 'internal proxy error'));
      else if (!res.writableEnded) res.end();
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const hostForUrl = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  const url = `http://${hostForUrl}:${port}`;
  ctx.config = { ...config, port };
  const state: ProxyState = { pid: process.pid, port, host: config.host, url, version: VERSION, startedAt: ctx.startedAt, mode: knobs.mode, profile: knobs.profile, ...(config.token ? { token: config.token } : {}) };
  if (!config.stateless) {
    try {
      writeProxyState(state, env);
    } catch (err) {
      logger.warn('state_file_failed', { message: (err as Error).message });
    }
  }
  logger.info('proxy_started', { url, mode: knobs.mode, profile: knobs.profile, pid: process.pid, bound: bound.join('+') || 'fallbacks', missing: missing.join('+') || 'none' });
  if (!isLoopbackBind(config.host)) logger.warn('proxy_open_bind', { host: config.host, tokenAuth: true });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = new Promise<void>((resolve) => {
      try {
        ctx.savings.flush();
        ctx.outputSavings.flush();
      } catch {
        /* best effort */
      }
      if (!config.stateless) removeProxyState(port, env);
      server.closeAllConnections?.();
      server.close(() => resolve());
      const t = setTimeout(resolve, 2000);
      t.unref?.();
    });
    return closing;
  };

  return { close, port, host: config.host, url, pid: process.pid, startedAt: ctx.startedAt, stats: () => buildStats(ctx, { includeRecent: true, includeConfig: true }), context: ctx };
}

/** `<= 0` disables the heartbeat (always full fidelity); NaN → the default. */
function graceMs(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_BUFFERED_GRACE_MS;
  return seconds > 0 ? Math.round(seconds * 1000) : 0;
}

function clampStatus(v: number, fallback: number): number {
  return v >= 400 && v < 600 ? v : fallback;
}

function readLearnedVerbosity(env: NodeJS.ProcessEnv): number | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(verbosityProfilePath(env), 'utf8')) as Record<string, unknown>;
    const v = raw.verbosity_level ?? raw.verbosityLevel ?? raw.level;
    return typeof v === 'number' && v >= 0 && v <= 4 ? v : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatch(ctx: ProxyContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  ctx.metrics.inboundTotal++;
  ctx.metrics.inboundActive++;
  res.on('finish', () => {
    ctx.metrics.inboundActive = Math.max(0, ctx.metrics.inboundActive - 1);
  });
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url ?? '/', 'http://proxy.local');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = (req.method ?? 'GET').toUpperCase();
  const headers = headerMap(req);
  const cors = corsHeaders(headers.origin, ctx.corsOrigins);
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
  if (method === 'OPTIONS') {
    res.writeHead(Object.keys(cors).length ? 204 : 403, { 'access-control-max-age': '600' });
    res.end();
    return;
  }
  const loopback = requestIsLoopback(req, ctx.trustedDashboard);
  const route = matchRoute(method, pathname);
  if (!route) {
    if (pathKnown(pathname)) sendJson(res, 405, errorBody('generic', 'method_not_allowed', `${method} not allowed on ${pathname}`), { allow: 'GET, POST' });
    else sendJson(res, 404, errorBody('generic', 'not_found', `no route for ${method} ${pathname}`));
    return;
  }
  // Admin routes are invisible off-loopback.
  if (route.guard === 'admin' && !loopback) {
    sendJson(res, 404, errorBody('generic', 'not_found', `no route for ${method} ${pathname}`));
    return;
  }
  // Token auth: required off-loopback whenever a token is configured; probes exempt.
  if (ctx.config.token && route.guard !== 'open' && !AUTH_EXEMPT_PATHS.has(pathname) && !loopback) {
    if (!tokenMatches(readToken(req), ctx.config.token)) {
      ctx.logger.warn('proxy_auth_rejected', { path: pathname });
      sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="vg-proxy"' });
      return;
    }
  }
  if (route.name === 'metrics' && !ctx.metricsEnabled) {
    sendJson(res, 404, errorBody('generic', 'not_found', 'metrics disabled'));
    return;
  }

  let body: Buffer = Buffer.alloc(0);
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    try {
      body = await readBody(req, ctx.limits.maxBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        sendJson(res, ctx.limits.bodyTooLargeStatus, errorBody(route.name === 'anthropic_messages' ? 'anthropic' : 'openai', 'request_too_large', `request body exceeds ${ctx.limits.maxBodyBytes} bytes`));
        return;
      }
      sendJson(res, 400, errorBody('generic', 'invalid_request_error', `could not read body: ${(err as Error).message}`));
      return;
    }
  }

  switch (route.name) {
    case 'health':
      return handleHealth(ctx, res, loopback);
    case 'ready':
      return handleReady(ctx, res, loopback);
    case 'version':
      return handleVersion(ctx, res);
    case 'dashboard':
      return sendText(res, 200, dashboardHtml(), 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:" });
    case 'stats':
      return handleStats(ctx, res, loopback);
    case 'savings':
      return handleSavings(ctx, res);
    case 'settings_get':
      return handleSettingsGet(ctx, res);
    case 'settings_post':
      return handleSettingsPost(ctx, req, res, body);
    case 'metrics':
      return handleMetrics(ctx, res);
    case 'ccr_entry':
      return handleCcrEntry(ctx, res, route.params.hash ?? '');
    case 'compress':
      return handleCompress(ctx, res, body, headers);
    case 'retrieve':
      return handleRetrieve(ctx, res, body);
    case 'retrieve_get':
      return handleRetrieve(ctx, res, body, route.params.hash);
    case 'anthropic_messages':
      return handleChat(ctx, req, res, anthropicAdapter, body, headers, route.upstreamPath ?? pathname);
    case 'openai_chat':
      return handleChat(ctx, req, res, openAIChatAdapter, body, headers, route.upstreamPath ?? pathname);
    case 'openai_responses':
      return handleChat(ctx, req, res, openAIResponsesAdapter, body, headers, route.upstreamPath ?? pathname);
    case 'anthropic_count_tokens':
    case 'passthrough':
      return handlePassthrough(ctx, req, res, body, headers, pathname);
    case 'shutdown':
      return handleShutdown(ctx, req, res);
    case 'clients':
      return handleClients(ctx, res);
    case 'cache_clear':
      return handleCacheClear(ctx, req, res);
    case 'stats_reset':
      return handleStatsReset(ctx, req, res);
    default:
      sendJson(res, 404, errorBody('generic', 'not_found', 'no route'));
  }
}
