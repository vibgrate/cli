/**
 * Upstream resolution and transport.
 *
 *  - `resolveUpstream` picks the provider + base URL for a route from the
 *    request headers and the configuration (anthropic, openai, azure, gemini,
 *    ollama, openrouter, bedrock/vertex passthrough shapes, generic).
 *  - `upstreamHeaders` applies the outbound header policy: hop-by-hop and
 *    framing headers dropped, `x-vg-*` internal headers stripped, provider
 *    auth forwarded untouched (never read, never stored).
 *  - `fetchWithRetry` retries 429/529 (honouring `Retry-After`), 5xx and
 *    transport errors with jittered exponential backoff (injected sleep + rng),
 *    returns 4xx immediately, and preserves the final upstream status.
 *  - `createTransport` returns a `fetch`-shaped function that honours
 *    `VG_PROXY_HTTP_PROXY` (CONNECT tunnel) and `VG_PROXY_TLS_STRICT=false`
 *    via `node:http(s)`; otherwise global `fetch` is used.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import { Readable } from 'node:stream';
import { env as knobEnv } from '../compress/config.js';
import type { ProxyConfig } from './config.js';
import { normalizeApiUrl } from './config.js';

export type Provider = 'anthropic' | 'openai' | 'azure' | 'gemini' | 'ollama' | 'openrouter' | 'bedrock' | 'vertex' | 'generic';

export interface Upstream {
  provider: Provider;
  baseUrl: string;
  /** Full URL for the current request path. */
  url: string;
}

const PROVIDER_DEFAULT_BASE: Partial<Record<Provider, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
  ollama: 'http://127.0.0.1:11434',
  openrouter: 'https://openrouter.ai/api',
};

/** Anthropic-shaped auth or client, per the reference heuristic. */
export function looksAnthropic(headers: Record<string, string>): boolean {
  if (headers['x-api-key'] || headers['anthropic-version']) return true;
  const auth = headers.authorization ?? '';
  if (/^bearer\s+sk-ant-/i.test(auth)) return true;
  const ua = headers['user-agent'] ?? '';
  return /claude-code\/|claude-cli\//i.test(ua);
}

/** Family of the route being served — decides which base applies. */
export function routeFamily(path: string): 'anthropic' | 'openai' | 'gemini' | 'unknown' {
  if (path.startsWith('/v1/messages')) return 'anthropic';
  if (path.startsWith('/v1beta/')) return 'gemini';
  if (path.startsWith('/v1/chat/completions') || path.startsWith('/v1/responses') || path.startsWith('/v1/embeddings') || path.startsWith('/v1/models') || path === '/chat/completions' || path === '/responses') return 'openai';
  return 'unknown';
}

/**
 * Resolve the upstream for a request. Order: forced provider → generic
 * upstream override → header sniffing (Azure `api-key`, Gemini `x-goog-api-key`,
 * Anthropic auth) → route family default.
 */
export function resolveUpstream(path: string, headers: Record<string, string>, cfg: Pick<ProxyConfig, 'anthropicUrl' | 'openaiUrl' | 'upstreamUrl' | 'provider'>, pathOverride?: string): Upstream {
  const family = routeFamily(path);
  const forced = (cfg.provider ?? '').trim().toLowerCase();
  let provider: Provider;
  let base: string;
  if (forced && forced !== 'auto') {
    provider = (['anthropic', 'openai', 'azure', 'gemini', 'ollama', 'openrouter', 'bedrock', 'vertex', 'generic'] as string[]).includes(forced) ? (forced as Provider) : 'generic';
    base = cfg.upstreamUrl ?? (provider === 'anthropic' ? cfg.anthropicUrl : provider === 'openai' ? cfg.openaiUrl : (PROVIDER_DEFAULT_BASE[provider] ?? cfg.openaiUrl));
  } else if (cfg.upstreamUrl && family !== 'anthropic') {
    provider = headers['api-key'] ? 'azure' : 'generic';
    base = cfg.upstreamUrl;
  } else if (cfg.upstreamUrl && family === 'anthropic' && looksAnthropic(headers) === false) {
    provider = 'generic';
    base = cfg.upstreamUrl;
  } else if (headers['x-goog-api-key'] || family === 'gemini') {
    provider = 'gemini';
    base = PROVIDER_DEFAULT_BASE.gemini!;
  } else if (family === 'anthropic' || (family === 'unknown' && looksAnthropic(headers))) {
    provider = 'anthropic';
    base = cfg.anthropicUrl;
  } else if (headers['api-key'] && cfg.upstreamUrl) {
    provider = 'azure';
    base = cfg.upstreamUrl;
  } else {
    provider = 'openai';
    base = cfg.openaiUrl;
  }
  base = normalizeApiUrl(base);
  const effectivePath = pathOverride ?? path;
  const url = joinUrl(base, provider, effectivePath);
  return { provider, baseUrl: base, url };
}

function joinUrl(base: string, provider: Provider, path: string): string {
  // Copilot / OpenRouter / Azure bases already carry their own prefix; the
  // Anthropic and OpenAI bases have `/v1` stripped and the route adds it back.
  if (provider === 'gemini') return `${base}${path}`;
  if (provider === 'azure') return `${base}${path.replace(/^\/v1/, '')}`;
  return `${base}${path}`;
}

// ---------------------------------------------------------------------------
// Header policy
// ---------------------------------------------------------------------------

const DROP_INBOUND = new Set(['host', 'content-length', 'content-encoding', 'transfer-encoding', 'accept-encoding', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'upgrade', 'expect']);
const FRAMING_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'server']);

/** Headers forwarded to the upstream; auth passes verbatim, `x-vg-*` is stripped. */
export function upstreamHeaders(inbound: Record<string, string>, opts: { stripInternal: boolean; bodyBytes?: number; contentType?: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inbound)) {
    const key = k.toLowerCase();
    if (DROP_INBOUND.has(key)) continue;
    if (opts.stripInternal && key.startsWith('x-vg-')) continue;
    out[key] = v;
  }
  if (opts.contentType) out['content-type'] = opts.contentType;
  if (opts.bodyBytes !== undefined) out['content-length'] = String(opts.bodyBytes);
  return out;
}

/** Response headers relayed to the client (framing headers dropped; extras removable). */
export function clientResponseHeaders(upstream: Headers, drop: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const extra = new Set(drop.map((d) => d.toLowerCase()));
  upstream.forEach((v, k) => {
    const key = k.toLowerCase();
    if (FRAMING_RESPONSE.has(key) || extra.has(key)) return;
    out[key] = v;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export interface RetryOptions {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Uniform [0,1) source for jitter (injected for determinism). */
  rng?: () => number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; status?: number; error?: string; delayMs: number }) => void;
}

export const RETRYABLE_OVERLOAD = new Set([429, 529]);

export function retryAfterMs(res: Response, maxMs: number, now: () => number = () => Date.now()): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, maxMs);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - now(), maxMs));
  return null;
}

/** `min(base·2^attempt, max) · (0.5 + rng())`. */
export function jitterDelayMs(baseMs: number, maxMs: number, attempt: number, rng: () => number): number {
  return Math.round(Math.min(baseMs * 2 ** attempt, maxMs) * (0.5 + rng()));
}

export class UpstreamUnreachable extends Error {
  constructor(message: string, readonly attempts: number) {
    super(message);
    this.name = 'UpstreamUnreachable';
  }
}

/**
 * Fetch with the reference retry policy. The body must be a string/Buffer so
 * it can be re-sent. Returns the final response (5xx/429 preserved verbatim
 * once attempts are exhausted); throws `UpstreamUnreachable` when every
 * attempt failed at the transport layer.
 */
export async function fetchWithRetry(url: string, init: RequestInit & { body?: string | Uint8Array }, opts: RetryOptions): Promise<Response> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 4000;
  const rng = opts.rng ?? (() => 0.5);
  let lastError = '';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await withTimeout(opts.fetch(url, init), opts.timeoutMs, opts.signal);
    } catch (err) {
      lastError = (err as Error).message ?? String(err);
      if (opts.signal?.aborted) throw err;
      if (attempt + 1 >= maxAttempts) break;
      const delay = jitterDelayMs(base, max, attempt, rng);
      opts.onRetry?.({ attempt, error: lastError, delayMs: delay });
      await opts.sleep(delay);
      continue;
    }
    if (RETRYABLE_OVERLOAD.has(res.status) || res.status >= 500) {
      if (attempt + 1 >= maxAttempts) return res;
      const ra = RETRYABLE_OVERLOAD.has(res.status) ? retryAfterMs(res, max) : null;
      const delay = ra ?? jitterDelayMs(base, max, attempt, rng);
      opts.onRetry?.({ attempt, status: res.status, delayMs: delay });
      try {
        await res.body?.cancel();
      } catch {
        /* body already consumed */
      }
      await opts.sleep(delay);
      continue;
    }
    return res;
  }
  throw new UpstreamUnreachable(`upstream unreachable after ${maxAttempts} attempt(s): ${lastError}`, maxAttempts);
}

function withTimeout<T>(p: Promise<T>, ms: number | undefined, signal?: AbortSignal): Promise<T> {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`upstream timeout after ${ms} ms`)), ms);
    t.unref?.();
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Transport (HTTP proxy tunnel + relaxed TLS via node:http(s))
// ---------------------------------------------------------------------------

export interface TransportOptions {
  /** Proxy for https targets (`VG_PROXY_HTTP_PROXY`, else `HTTPS_PROXY`). */
  httpProxy?: string;
  /** Proxy for plain-http targets (`VG_PROXY_HTTP_PROXY`, else `HTTP_PROXY`). */
  httpOnlyProxy?: string;
  /** `NO_PROXY` entries: hosts that must be reached directly. */
  noProxy?: string[];
  tlsStrict?: boolean;
  connectTimeoutMs?: number;
}

/** Transport options from the knob registry, falling back to the conventional environment. */
export function transportOptionsFromEnv(e: NodeJS.ProcessEnv): TransportOptions {
  const explicit = knobEnv.string('VG_PROXY_HTTP_PROXY', e);
  return {
    httpProxy: explicit ?? e.HTTPS_PROXY ?? e.https_proxy ?? undefined,
    httpOnlyProxy: explicit ?? e.HTTP_PROXY ?? e.http_proxy ?? undefined,
    noProxy: parseNoProxy(e.NO_PROXY ?? e.no_proxy),
    tlsStrict: knobEnv.bool('VG_PROXY_TLS_STRICT', e),
    connectTimeoutMs: Math.round(knobEnv.float('VG_PROXY_CONNECT_TIMEOUT_SECONDS', e, { min: 0 }) * 1000),
  };
}

export function parseNoProxy(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether `target` must be reached directly rather than through a proxy.
 *
 * Loopback is always direct, as every other HTTP client treats it: a local
 * model server (`--provider ollama` → `127.0.0.1:11434`) would otherwise be
 * sent to a corporate proxy and refused on exactly the machines that set
 * `HTTPS_PROXY`. Beyond that the usual `NO_PROXY` forms apply — `*`, an exact
 * host, a `.suffix` or bare suffix, and an optional `:port`.
 */
export function bypassesProxy(target: URL, noProxy: readonly string[] = []): boolean {
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || isLoopbackHost(host)) return true;
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  for (const raw of noProxy) {
    if (raw === '*') return true;
    let entry = raw;
    // an entry may pin a port: `example.com:8443`
    const colon = entry.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) {
      if (entry.slice(colon + 1) !== port) continue;
      entry = entry.slice(0, colon);
    }
    if (entry.startsWith('.')) {
      if (host === entry.slice(1) || host.endsWith(entry)) return true;
      continue;
    }
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

function isLoopbackHost(host: string): boolean {
  if (host === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  const v4 = mapped ? mapped[1] : host;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** The proxy to use for one target, or undefined to connect directly. */
export function proxyForTarget(target: URL, opts: TransportOptions): string | undefined {
  if (bypassesProxy(target, opts.noProxy)) return undefined;
  return target.protocol === 'https:' ? opts.httpProxy : (opts.httpOnlyProxy ?? opts.httpProxy);
}

function tunnel(proxyUrl: string, target: URL, timeoutMs: number): Promise<import('node:net').Socket> {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const headers: Record<string, string> = { host: `${target.hostname}:${port}` };
    if (proxy.username || proxy.password) headers['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
    const mod = proxy.protocol === 'https:' ? https : http;
    const req = mod.request({ host: proxy.hostname, port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)), method: 'CONNECT', path: `${target.hostname}:${port}`, headers, timeout: timeoutMs || undefined });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.once('timeout', () => {
      req.destroy(new Error('proxy CONNECT timeout'));
    });
    req.once('error', reject);
    req.end();
  });
}

/**
 * A `fetch`-compatible function over `node:http(s)` so an outbound HTTP proxy
 * and a relaxed TLS mode can be honoured. Only the subset the proxy uses is
 * implemented (method, headers, string/bytes body, streaming response body).
 */
export function nodeFetch(opts: TransportOptions): typeof fetch {
  return async (input, init = {}) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url);
    const isTls = target.protocol === 'https:';
    const mod = isTls ? https : http;
    const headers: Record<string, string> = {};
    const h = new Headers(init.headers ?? {});
    h.forEach((v, k) => (headers[k] = v));
    const body = init.body as string | Uint8Array | undefined;
    if (body !== undefined && headers['content-length'] === undefined) headers['content-length'] = String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength);
    let socket: import('node:net').Socket | undefined;
    const proxyUrl = proxyForTarget(target, opts);
    if (proxyUrl) socket = await tunnel(proxyUrl, target, opts.connectTimeoutMs ?? 10_000);
    return new Promise<Response>((resolve, reject) => {
      const reqOpts: https.RequestOptions = {
        method: init.method ?? 'GET',
        host: target.hostname,
        port: Number(target.port || (isTls ? 443 : 80)),
        path: `${target.pathname}${target.search}`,
        headers,
        timeout: opts.connectTimeoutMs || undefined,
        rejectUnauthorized: opts.tlsStrict !== false,
      };
      if (socket) {
        reqOpts.createConnection = () => socket!;
        if (isTls) {
          // Upgrade the tunnelled socket to TLS.
          reqOpts.createConnection = () => tls.connect({ socket, servername: target.hostname, rejectUnauthorized: opts.tlsStrict !== false });
        }
      }
      const req = mod.request(reqOpts, (res) => {
        const respHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          if (Array.isArray(v)) for (const x of v) respHeaders.append(k, x);
          else respHeaders.set(k, v);
        }
        const stream = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
        const status = res.statusCode ?? 502;
        resolve(new Response(status === 204 || status === 304 ? null : stream, { status, statusText: res.statusMessage ?? '', headers: respHeaders }));
      });
      req.once('timeout', () => req.destroy(new Error('connect timeout')));
      req.once('error', reject);
      init.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
}

/** Pick the transport: node:http(s) when a proxy or relaxed TLS is configured, else global fetch. */
export function createTransport(e: NodeJS.ProcessEnv, fallback: typeof fetch = globalThis.fetch): typeof fetch {
  const opts = transportOptionsFromEnv(e);
  if (opts.httpProxy || opts.httpOnlyProxy || opts.tlsStrict === false) return nodeFetch(opts);
  return fallback;
}
