/**
 * Structured proxy log + per-request records, both redacted.
 *
 *  - `ProxyLogger`: level-filtered `event=…` lines to stderr (foreground) and
 *    a rotating file (10 MB × 5). Header values are logged only from an
 *    allow-list; everything else is dropped, and every free-text field goes
 *    through `redactText`.
 *  - `RequestLogger`: in-memory ring (500) + optional JSONL file. Message
 *    previews are opt-in, redacted, and image payloads > 1 KiB are replaced
 *    by a placeholder.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactText } from '../code/secrets.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const ROTATE_BYTES = 10 * 1024 * 1024;
export const ROTATE_BACKUPS = 5;

/** Header names whose values may appear in logs; every other value is dropped. */
export const LOGGABLE_HEADERS: ReadonlySet<string> = new Set(['content-type', 'content-length', 'accept', 'user-agent', 'anthropic-version', 'anthropic-beta', 'x-client', 'x-vg-session', 'x-vg-project', 'x-vg-agent', 'retry-after', 'x-request-id', 'request-id']);

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(headers).sort()) {
    const key = k.toLowerCase();
    out[key] = LOGGABLE_HEADERS.has(key) ? redactText(headers[k]).slice(0, 256) : '[REDACTED]';
  }
  return out;
}

export const IMAGE_BASE64_REDACT_THRESHOLD_BYTES = 1024;
const IMAGE_FIELDS = new Set(['data', 'url', 'image_url', 'image']);

/** Replace large image payloads; leave everything else verbatim (after secret redaction). */
export function redactPayload(value: unknown, parentKey: string | null = null): unknown {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value);
    if (bytes > IMAGE_BASE64_REDACT_THRESHOLD_BYTES && (value.startsWith('data:image/') || (parentKey !== null && IMAGE_FIELDS.has(parentKey)))) return `<image:base64-redacted bytes=${bytes}>`;
    return redactText(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactPayload(v, null));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactPayload(v, k);
    return out;
  }
  return value;
}

class RotatingFile {
  private size = 0;
  private ready = false;
  constructor(private readonly file: string) {}

  private ensure(): void {
    if (this.ready) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      this.size = fs.statSync(this.file).size;
    } catch {
      this.size = 0;
    }
    this.ready = true;
  }

  append(line: string): void {
    try {
      this.ensure();
      const bytes = Buffer.byteLength(line);
      if (this.size + bytes > ROTATE_BYTES) this.rotate();
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.size += bytes;
    } catch {
      /* logging never breaks a request */
    }
  }

  private rotate(): void {
    for (let i = ROTATE_BACKUPS - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      const to = `${this.file}.${i + 1}`;
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch {
        /* ignore */
      }
    }
    try {
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      /* ignore */
    }
    this.size = 0;
  }
}

export class ProxyLogger {
  private readonly file: RotatingFile | null;
  level: LogLevel;
  readonly recent: string[] = [];
  constructor(opts: { level?: LogLevel; file?: string; stderr?: boolean; now?: () => number } = {}) {
    this.level = opts.level ?? 'info';
    this.file = opts.file ? new RotatingFile(opts.file) : null;
    this.stderr = opts.stderr ?? false;
    this.now = opts.now ?? (() => Date.now());
  }
  private readonly stderr: boolean;
  private readonly now: () => number;

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const parts = [`ts=${new Date(this.now()).toISOString()}`, `level=${level}`, `event=${event}`];
    for (const k of Object.keys(fields).sort()) {
      const v = fields[k];
      if (v === undefined) continue;
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      parts.push(`${k}=${JSON.stringify(redactText(text)).replace(/^"|"$/g, '')}`);
    }
    const line = `${parts.join(' ')}\n`;
    this.recent.push(line);
    if (this.recent.length > 200) this.recent.shift();
    if (this.stderr) process.stderr.write(line);
    this.file?.append(line);
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.log('debug', event, fields);
  }
  info(event: string, fields?: Record<string, unknown>): void {
    this.log('info', event, fields);
  }
  warn(event: string, fields?: Record<string, unknown>): void {
    this.log('warn', event, fields);
  }
  error(event: string, fields?: Record<string, unknown>): void {
    this.log('error', event, fields);
  }
}

export interface RequestRecord {
  requestId: string;
  timestamp: string;
  provider: string;
  model: string;
  client: string;
  project?: string;
  status: number;
  stream: boolean;
  inputTokensOriginal: number;
  inputTokensOptimized: number;
  outputTokens: number;
  tokensSaved: number;
  deferredTokens: number;
  savingsPercent: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  optimizationMs: number;
  totalMs: number;
  ttfbMs?: number;
  transforms: string[];
  cached: boolean;
  retrieveRounds: number;
  usd: number;
  usdSaved: number;
  outputTokensSaved?: number;
  requestPreview?: unknown;
  responsePreview?: unknown;
}

export const REQUEST_LOG_RING = 500;

export class RequestLogger {
  private readonly ring: RequestRecord[] = [];
  private readonly file: RotatingFile | null;
  redactions = 0;
  constructor(file?: string) {
    this.file = file ? new RotatingFile(file) : null;
  }

  record(rec: RequestRecord): void {
    const safe: RequestRecord = { ...rec };
    if (safe.requestPreview !== undefined) {
      safe.requestPreview = redactPayload(safe.requestPreview);
      this.redactions++;
    }
    if (safe.responsePreview !== undefined) {
      safe.responsePreview = redactPayload(safe.responsePreview);
      this.redactions++;
    }
    this.ring.push(safe);
    while (this.ring.length > REQUEST_LOG_RING) this.ring.shift();
    this.file?.append(`${JSON.stringify(safe)}\n`);
  }

  recent(n = 50, withPreviews = false): RequestRecord[] {
    const slice = this.ring.slice(-Math.max(0, n)).reverse();
    if (withPreviews) return slice;
    return slice.map((r) => {
      const { requestPreview: _rp, responsePreview: _sp, ...rest } = r;
      return rest;
    });
  }

  get size(): number {
    return this.ring.length;
  }
}

/** `[<id>] PERF model=… msgs=… tok_before=… tok_after=… tok_saved=… …` line for `vg savings --benchmark`. */
export function perfLine(rec: RequestRecord, messages: number): string {
  const cacheHitPct = rec.inputTokensOptimized > 0 ? Math.round((rec.cacheReadTokens / rec.inputTokensOptimized) * 100) : 0;
  return `[${rec.requestId}] PERF model=${rec.model} msgs=${messages} tok_before=${rec.inputTokensOriginal} tok_after=${rec.inputTokensOptimized} tok_saved=${rec.tokensSaved} tool_saved=${rec.deferredTokens} total_saved=${rec.tokensSaved + rec.deferredTokens} cache_read=${rec.cacheReadTokens} cache_write=${rec.cacheWriteTokens} cache_hit_pct=${cacheHitPct} opt_ms=${Math.round(rec.optimizationMs)} total_ms=${Math.round(rec.totalMs)} tok_out=${rec.outputTokens} ttfb_ms=${rec.ttfbMs === undefined ? 0 : Math.round(rec.ttfbMs)} transforms=${summarizeTransforms(rec.transforms)} client=${rec.client}${rec.cached ? ' cached=1' : ''}`;
}

/** Collapse repeats to `name*N`, keep first-seen order. */
export function summarizeTransforms(transforms: string[]): string {
  if (!transforms.length) return 'none';
  const counts = new Map<string, number>();
  for (const t of transforms) {
    const name = t.includes(',') ? t.split(':').slice(0, 2).join(':') : t;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k}*${n}` : k)).join(',');
}
