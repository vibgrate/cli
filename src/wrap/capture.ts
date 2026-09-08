/**
 * Capture records for a captured compression session: one JSON line per
 * request/response exchange (plus session markers), redacted at ingest so
 * the file can be shared or replayed offline for benchmarking.
 *
 * Deliberately JSONL so the proxy, tests and future packet-capture tooling
 * can all emit the same records without a heavy dependency. Bodies are
 * reduced to a SHA-256, a size and a bounded, redacted preview; sensitive
 * headers and query parameters are masked.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { redactText } from '../code/secrets.js';

export const SENSITIVE_HEADER_PARTS = ['authorization', 'api-key', 'apikey', 'token', 'secret', 'cookie'] as const;
export const SENSITIVE_QUERY_PARTS = ['key', 'token', 'secret', 'signature', 'code'] as const;
export const MAX_BODY_PREVIEW_CHARS = 1200;
export const REDACTED = '***redacted***';

export type CaptureLane = 'direct' | 'wrapped';

export interface CapturedExchange {
  kind: 'exchange';
  lane: CaptureLane;
  sequence: number;
  ts?: number;
  method: string;
  url: string;
  host: string;
  path: string;
  requestHeaders: Record<string, string>;
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  requestBodySha256: string | null;
  requestBodySize: number;
  requestBodyPreview: string | null;
  responseBodySha256?: string | null;
  responseBodySize?: number;
  responseBodyPreview?: string | null;
  /** Compression summary when known (proxy-side). */
  tokensBefore?: number;
  tokensAfter?: number;
  model?: string;
}

export interface CaptureSession {
  kind: 'session';
  event: 'start' | 'end';
  ts: number;
  agent: string;
  proxyUrl: string;
  cwd?: string;
  exitCode?: number;
}

export type CaptureRecord = CapturedExchange | CaptureSession;

export function sanitizeHeaders(headers: Record<string, string | string[] | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    const value = Array.isArray(v) ? v.join(', ') : v;
    out[lower] = SENSITIVE_HEADER_PARTS.some((p) => lower.includes(p)) ? REDACTED : redactText(value);
  }
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k]!;
  return sorted;
}

/** Mask sensitive query parameters; the rest of the URL is kept verbatim. */
export function sanitizeUrl(url: string): { url: string; host: string; path: string } {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (SENSITIVE_QUERY_PARTS.some((p) => lower.includes(p))) u.searchParams.set(key, REDACTED);
    }
    if (u.username || u.password) {
      u.username = u.username ? u.username : '';
      u.password = u.password ? REDACTED : '';
    }
    return { url: u.toString(), host: u.host, path: u.pathname };
  } catch {
    return { url: redactText(url), host: '', path: url.split('?')[0] ?? url };
  }
}

export function bodyDigest(body: string | Uint8Array | null | undefined): { sha256: string | null; size: number; preview: string | null } {
  if (body === null || body === undefined) return { sha256: null, size: 0, preview: null };
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  const text = typeof body === 'string' ? body : bytes.toString('utf8');
  const preview = redactText(text.slice(0, MAX_BODY_PREVIEW_CHARS));
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, preview };
}

export interface ExchangeInput {
  lane: CaptureLane;
  sequence: number;
  ts?: number;
  method: string;
  url: string;
  requestHeaders?: Record<string, string | string[] | undefined>;
  requestBody?: string | Uint8Array | null;
  responseStatus?: number | null;
  responseHeaders?: Record<string, string | string[] | undefined>;
  responseBody?: string | Uint8Array | null;
  tokensBefore?: number;
  tokensAfter?: number;
  model?: string;
}

/** Build a redacted exchange record. Pure. */
export function captureExchange(input: ExchangeInput): CapturedExchange {
  const u = sanitizeUrl(input.url);
  const req = bodyDigest(input.requestBody);
  const rec: CapturedExchange = {
    kind: 'exchange',
    lane: input.lane,
    sequence: input.sequence,
    method: input.method.toUpperCase(),
    url: u.url,
    host: u.host,
    path: u.path,
    requestHeaders: sanitizeHeaders(input.requestHeaders),
    responseStatus: input.responseStatus ?? null,
    responseHeaders: sanitizeHeaders(input.responseHeaders),
    requestBodySha256: req.sha256,
    requestBodySize: req.size,
    requestBodyPreview: req.preview,
  };
  if (input.ts !== undefined) rec.ts = input.ts;
  if (input.responseBody !== undefined) {
    const res = bodyDigest(input.responseBody);
    rec.responseBodySha256 = res.sha256;
    rec.responseBodySize = res.size;
    rec.responseBodyPreview = res.preview;
  }
  if (input.tokensBefore !== undefined) rec.tokensBefore = input.tokensBefore;
  if (input.tokensAfter !== undefined) rec.tokensAfter = input.tokensAfter;
  if (input.model !== undefined) rec.model = input.model;
  return rec;
}

export function routeKey(r: CapturedExchange): string {
  return `${r.method} ${r.host}${r.path}`;
}

export function pathKey(r: CapturedExchange): string {
  return `${r.method} ${r.path}`;
}

/** Append-only JSONL writer; the file is created 0600. */
export class CaptureWriter {
  private sequence = 0;
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }

  nextSequence(): number {
    return ++this.sequence;
  }

  write(record: CaptureRecord): void {
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  exchange(input: Omit<ExchangeInput, 'sequence'> & { sequence?: number }): CapturedExchange {
    const rec = captureExchange({ ...input, sequence: input.sequence ?? this.nextSequence() });
    this.write(rec);
    return rec;
  }

  session(event: 'start' | 'end', info: Omit<CaptureSession, 'kind' | 'event'>): void {
    this.write({ kind: 'session', event, ...info });
  }
}

export function readCaptureFile(file: string, fallbackLane: CaptureLane = 'wrapped'): CaptureRecord[] {
  const out: CaptureRecord[] = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (rec.kind === 'session') out.push(rec as unknown as CaptureSession);
      else if (typeof rec.method === 'string' && typeof rec.url === 'string') {
        out.push({ ...(rec as unknown as CapturedExchange), kind: 'exchange', lane: rec.lane === 'direct' || rec.lane === 'wrapped' ? rec.lane : fallbackLane });
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return out;
}

export interface CaptureDiff {
  directCount: number;
  wrappedCount: number;
  onlyDirect: string[];
  onlyWrapped: string[];
  paired: Array<{ key: string; direct: number; wrapped: number; requestBytesDirect: number; requestBytesWrapped: number; sameBody: boolean }>;
}

/** Pair exchanges from two lanes by path (default) or full route. Deterministic ordering. */
export function compareCaptures(direct: CaptureRecord[], wrapped: CaptureRecord[], pairBy: 'path' | 'route' = 'path'): CaptureDiff {
  const keyOf = pairBy === 'route' ? routeKey : pathKey;
  const group = (recs: CaptureRecord[]): Map<string, CapturedExchange[]> => {
    const m = new Map<string, CapturedExchange[]>();
    for (const r of recs) {
      if (r.kind !== 'exchange') continue;
      const k = keyOf(r);
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };
  const d = group(direct);
  const w = group(wrapped);
  const keys = [...new Set([...d.keys(), ...w.keys()])].sort();
  const diff: CaptureDiff = { directCount: [...d.values()].reduce((n, v) => n + v.length, 0), wrappedCount: [...w.values()].reduce((n, v) => n + v.length, 0), onlyDirect: [], onlyWrapped: [], paired: [] };
  for (const k of keys) {
    const a = d.get(k);
    const b = w.get(k);
    if (a && !b) diff.onlyDirect.push(k);
    else if (!a && b) diff.onlyWrapped.push(k);
    else if (a && b) {
      const bytes = (xs: CapturedExchange[]): number => xs.reduce((n, x) => n + x.requestBodySize, 0);
      const sameBody = a.length === b.length && a.every((x, i) => x.requestBodySha256 === b[i]!.requestBodySha256);
      diff.paired.push({ key: k, direct: a.length, wrapped: b.length, requestBytesDirect: bytes(a), requestBytesWrapped: bytes(b), sameBody });
    }
  }
  return diff;
}
