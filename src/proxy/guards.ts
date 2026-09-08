/**
 * Network guards: loopback detection (peer *and* Host header — the DNS
 * rebinding defence), CIDR parsing, trusted forwarded headers, the SSRF
 * upstream guard, CORS, security headers and token auth.
 *
 * Pure functions over strings; `isSafeUpstreamUrlAsync` is the one that may
 * resolve DNS (with an injected resolver and a 3 s timeout).
 */

import * as net from 'node:net';
import * as dns from 'node:dns';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

// ---------------------------------------------------------------------------
// IPs & CIDRs
// ---------------------------------------------------------------------------

/** Strip an IPv4-mapped IPv6 prefix (`::ffff:127.0.0.1` → `127.0.0.1`). */
export function normalizeIp(ip: string): string {
  let v = ip.trim();
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  const zone = v.indexOf('%');
  if (zone > 0) v = v.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v);
  return mapped ? mapped[1] : v.toLowerCase();
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const v = normalizeIp(ip);
  if (v === '::1') return true;
  if (net.isIPv4(v)) return v.startsWith('127.');
  return false;
}

/** The `Host:` header names loopback (DNS-rebinding gate). */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  let h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) return false;
    h = h.slice(1, end);
  } else {
    const colon = h.lastIndexOf(':');
    if (colon > 0 && h.indexOf(':') === colon) h = h.slice(0, colon);
  }
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return isLoopbackAddress(h);
}

function ipToBytes(ip: string): Uint8Array | null {
  const v = normalizeIp(ip);
  if (net.isIPv4(v)) return Uint8Array.from(v.split('.').map((p) => Number(p)));
  if (!net.isIPv6(v)) return null;
  const parts = v.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const expandV4 = (segs: string[]): string[] => {
    const out: string[] = [];
    for (const s of segs) {
      if (net.isIPv4(s)) {
        const b = s.split('.').map(Number);
        out.push(((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16));
      } else out.push(s);
    }
    return out;
  };
  const h = expandV4(head);
  const t = expandV4(tail);
  const missing = 8 - h.length - t.length;
  if (missing < 0 || (parts.length === 1 && missing !== 0)) return null;
  const groups = [...h, ...new Array<string>(Math.max(0, missing)).fill('0'), ...t];
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    const n = parseInt(g || '0', 16);
    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  });
  return bytes;
}

export interface Cidr {
  bytes: Uint8Array;
  bits: number;
}

/** Parse `a.b.c.d/n` or `::1/128`; a bare address is a host route. Null when invalid. */
export function parseCidr(text: string): Cidr | null {
  const t = text.trim();
  if (!t) return null;
  const slash = t.indexOf('/');
  const ip = slash >= 0 ? t.slice(0, slash) : t;
  const bytes = ipToBytes(ip);
  if (!bytes) return null;
  const max = bytes.length * 8;
  let bits = max;
  if (slash >= 0) {
    const n = Number(t.slice(slash + 1));
    if (!Number.isInteger(n) || n < 0 || n > max) return null;
    bits = n;
  }
  return { bytes, bits };
}

export function parseCidrs(list: string[]): Cidr[] {
  const out: Cidr[] = [];
  for (const item of list) {
    const c = parseCidr(item);
    if (c) out.push(c);
  }
  return out;
}

export function ipInCidr(ip: string, cidr: Cidr): boolean {
  const b = ipToBytes(ip);
  if (!b || b.length !== cidr.bytes.length) return false;
  const full = Math.floor(cidr.bits / 8);
  for (let i = 0; i < full; i++) if (b[i] !== cidr.bytes[i]) return false;
  const rem = cidr.bits % 8;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (b[full] & mask) === (cidr.bytes[full] & mask);
}

export function ipInCidrs(ip: string, cidrs: Cidr[]): boolean {
  return cidrs.some((c) => ipInCidr(ip, c));
}

/** Loopback, link-local, private, reserved, multicast, unspecified, NAT64-embedded. */
export function isInternalAddress(ip: string): boolean {
  const v = normalizeIp(ip);
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(v)) {
    if (v === '::1' || v === '::') return true;
    if (/^fe[89ab]/i.test(v)) return true; // link-local
    if (/^f[cd]/i.test(v)) return true; // unique local
    if (/^ff/i.test(v)) return true; // multicast
    const bytes = ipToBytes(v);
    if (bytes) {
      // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 in the last 4 bytes.
      if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
        return isInternalAddress(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
      }
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Request-side helpers
// ---------------------------------------------------------------------------

export function peerIp(req: IncomingMessage): string {
  return normalizeIp(req.socket?.remoteAddress ?? '');
}

/**
 * The client IP for rate-limit keys: the forwarded address is honoured only
 * when the direct peer sits inside a trusted gateway CIDR.
 */
export function resolveClientIp(req: IncomingMessage, trustedGateways: Cidr[]): string {
  const peer = peerIp(req);
  if (trustedGateways.length && ipInCidrs(peer, trustedGateways)) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return peer;
}

/** Peer is loopback (or inside the trusted dashboard CIDRs) AND the Host header names loopback. */
export function requestIsLoopback(req: IncomingMessage, trustedDashboard: Cidr[] = []): boolean {
  const peer = peerIp(req);
  const peerOk = isLoopbackAddress(peer) || (trustedDashboard.length > 0 && ipInCidrs(peer, trustedDashboard));
  if (!peerOk) return false;
  const host = req.headers.host;
  if (host === undefined) return true; // HTTP/1.0 clients on loopback
  return isLoopbackHostHeader(host);
}

/**
 * CSRF guard for state-mutating admin POSTs: browsers send Origin (or at
 * least Referer); native clients send neither, which is accepted.
 */
export function requestIsSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin ?? (req.headers.referer ? originOf(req.headers.referer) : undefined);
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    const u = new URL(origin);
    return u.host.toLowerCase() === host.toLowerCase() || (isLoopbackHostHeader(u.host) && isLoopbackHostHeader(host) && u.port === portOf(host));
  } catch {
    return false;
  }
}

function originOf(referer: string): string | undefined {
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

function portOf(host: string): string {
  const i = host.lastIndexOf(':');
  return i > 0 && !host.endsWith(']') ? host.slice(i + 1) : '';
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** `x-vg-token` first, else `Authorization: Bearer`. */
export function readToken(req: IncomingMessage): string | undefined {
  const direct = req.headers['x-vg-token'];
  const d = Array.isArray(direct) ? direct[0] : direct;
  if (d) return d.trim();
  const auth = req.headers.authorization;
  const a = Array.isArray(auth) ? auth[0] : auth;
  if (a && /^bearer\s+/i.test(a)) return a.replace(/^bearer\s+/i, '').trim();
  return undefined;
}

export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Paths that never require the proxy token (probes). */
export const AUTH_EXEMPT_PATHS: ReadonlySet<string> = new Set(['/health', '/healthz', '/ready', '/readyz', '/livez', '/version']);

// ---------------------------------------------------------------------------
// CORS + security headers
// ---------------------------------------------------------------------------

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d+)?$/i;

/** Allowed CORS origin, or undefined when the origin must not be echoed. */
export function corsOrigin(origin: string | undefined, configured: string[]): string | undefined {
  if (!origin) return undefined;
  if (configured.length === 0) return LOOPBACK_ORIGIN.test(origin) ? origin : undefined;
  if (configured.includes('*')) return '*';
  return configured.some((o) => o.toLowerCase() === origin.toLowerCase()) ? origin : undefined;
}

export function corsHeaders(origin: string | undefined, configured: string[]): Record<string, string> {
  const allowed = corsOrigin(origin, configured);
  if (!allowed) return {};
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, x-vg-token, x-vg-session, anthropic-version, anthropic-beta, x-api-key',
    vary: 'Origin',
  };
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

// ---------------------------------------------------------------------------
// SSRF / upstream guard
// ---------------------------------------------------------------------------

/** Hosts the proxy trusts by default (built-in providers). */
export const DEFAULT_UPSTREAM_HOSTS: readonly string[] = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
  'api.githubcopilot.com',
  'api.x.ai',
  'api.mistral.ai',
  'api.deepseek.com',
  'api.groq.com',
  'api.together.xyz',
  'api.fireworks.ai',
  'api.cohere.com',
];

export interface UpstreamGuardOptions {
  /** Strict allow-list of base URLs or hosts; when non-empty nothing else passes. */
  allowedBaseUrls?: string[];
  /** Additional trusted hostnames beyond the built-ins. */
  allowedHosts?: string[];
  /** The proxy's own configured upstream bases — always trusted. */
  configuredBases?: string[];
}

function hostOf(value: string): string | null {
  try {
    const u = value.includes('://') ? new URL(value) : new URL(`https://${value}`);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function tripleOf(u: URL): string {
  const port = u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80');
  return `${u.protocol}//${u.hostname.toLowerCase()}:${port}`;
}

/**
 * Synchronous verdict: `true` safe, `false` unsafe, `null` = hostname needs
 * DNS resolution (use the async variant). Scheme must be http(s)/ws(s).
 */
export function isSafeUpstreamUrl(url: string, opts: UpstreamGuardOptions = {}): boolean | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const allowed = opts.allowedBaseUrls ?? [];
  if (allowed.length) {
    for (const a of allowed) {
      const t = a.trim();
      if (!t) continue;
      if (t.includes('://')) {
        try {
          if (tripleOf(new URL(t)) === tripleOf(u)) return true;
        } catch {
          /* ignore bad entry */
        }
      } else if (hostOf(t) === host) return true;
    }
    return false;
  }
  const trusted = new Set<string>([...DEFAULT_UPSTREAM_HOSTS, ...(opts.allowedHosts ?? []).map((h) => hostOf(h) ?? ''), ...(opts.configuredBases ?? []).map((b) => hostOf(b) ?? '')]);
  if (trusted.has(host)) return true;
  if (net.isIP(host)) return !isInternalAddress(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return false;
  return null;
}

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => {
  const results = await dns.promises.lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

export const UPSTREAM_RESOLVE_TIMEOUT_MS = 3000;

/** Async verdict: resolves the hostname and rejects any internal address. */
export async function isSafeUpstreamUrlAsync(url: string, opts: UpstreamGuardOptions & { resolve?: Resolver; timeoutMs?: number } = {}): Promise<boolean> {
  const sync = isSafeUpstreamUrl(url, opts);
  if (sync !== null) return sync;
  const host = new URL(url).hostname.toLowerCase();
  const resolve = opts.resolve ?? defaultResolver;
  let timer: NodeJS.Timeout | undefined;
  try {
    const addrs = await Promise.race([
      resolve(host),
      new Promise<string[]>((_, reject) => {
        timer = setTimeout(() => reject(new Error('resolve timeout')), opts.timeoutMs ?? UPSTREAM_RESOLVE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (!addrs.length) return false;
    return addrs.every((a) => !isInternalAddress(a));
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Whether a configured upstream base counts as first-party for provider-specific features. */
export function isFirstPartyAnthropic(baseUrl: string): boolean {
  return hostOf(baseUrl) === 'api.anthropic.com';
}
