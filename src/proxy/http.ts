/**
 * Small `node:http` helpers shared by every route: bounded body reading with
 * bounded decompression, JSON responses, and a header view.
 */

import * as zlib from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLarge';
  }
}

/**
 * Decompress with `maxOutputLength` pinned to the cap so a compression bomb
 * is refused by zlib before it is ever materialized (the sync APIs abort with
 * ERR_BUFFER_TOO_LARGE the moment output would exceed the bound).
 */
function inflateBounded(raw: Buffer, encoding: string, limit: number): Buffer {
  let fn: ((b: Buffer, o: zlib.ZlibOptions & zlib.BrotliOptions) => Buffer) | null = null;
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      fn = zlib.gunzipSync;
      break;
    case 'deflate':
      fn = zlib.inflateSync;
      break;
    case 'br':
      fn = zlib.brotliDecompressSync;
      break;
    default:
      return raw;
  }
  try {
    const out = fn(raw, { maxOutputLength: limit + 1 });
    if (out.length > limit) throw new BodyTooLarge(limit);
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new BodyTooLarge(limit);
    throw err;
  }
}

/**
 * Read the whole request body, refusing anything past `limit` bytes both on
 * the wire and after decompression. Resolves to the decoded bytes.
 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLarge(limit));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge(limit));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const enc = String(req.headers['content-encoding'] ?? '').trim().toLowerCase();
      if (!enc || enc === 'identity') {
        resolve(raw);
        return;
      }
      try {
        resolve(inflateBounded(raw, enc, limit));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function parseJsonBody(buf: Buffer): Record<string, unknown> | null {
  try {
    const v = JSON.parse(buf.toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers });
  res.end(text);
}

export function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8', headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(Buffer.byteLength(text)), ...headers });
  res.end(text);
}

/** First value of a header, lower-cased key lookup. */
export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Copy incoming headers into a plain string map (first value wins). */
export function headerMap(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

/** Error envelope in the style of the provider the request targeted. */
export function errorBody(format: 'anthropic' | 'openai' | 'generic', type: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (format === 'anthropic') return { type: 'error', error: { type, message, ...extra } };
  if (format === 'openai') return { error: { type, message, code: type, ...extra } };
  return { error: { type, message, ...extra } };
}
