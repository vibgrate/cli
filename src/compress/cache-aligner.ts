/**
 * Cache aligner — detector only.
 *
 * Volatile values in the system prompt or the first messages (timestamps,
 * UUIDs, JWTs, hex digests, random request ids) make the provider's prompt
 * cache miss on every turn. This module finds them and reports; it never
 * rewrites (the hot zone is not ours to mutate). Structural checks, no
 * heavy regexes: tokens are split on whitespace and classified by shape.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { enumerateBlocks } from './format.js';
import type { Message } from './types.js';

export type VolatileLabel = 'uuid' | 'iso8601' | 'jwt' | 'hex_hash' | 'request_id';

export interface VolatileFinding {
  label: VolatileLabel;
  /** Truncated sample — never the whole value. */
  sample: string;
  messageIndex: number;
  role: string;
}

export interface CacheAlignerReport {
  findings: VolatileFinding[];
  warnings: string[];
  /** `stable_prefix_hash:<hash>` — the hash of the observed stable prefix, for drift tracking. */
  markersInserted: string[];
  stablePrefixHash: string;
  stablePrefixBytes: number;
  /** 0..100; 10 points per finding. */
  alignmentScore: number;
}

const HEX_LENGTHS = new Set([32, 40, 64]);
const PUNCT = '.,;:!?"\'()[]{}<>';

function isHex(s: string): boolean {
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) return false;
  }
  return true;
}

export function isUuid(token: string): boolean {
  if (token.length !== 36) return false;
  const parts = token.split('-');
  if (parts.length !== 5) return false;
  const lens = [8, 4, 4, 4, 12];
  for (let i = 0; i < 5; i++) if (parts[i].length !== lens[i] || !isHex(parts[i])) return false;
  return true;
}

export function isIso8601(token: string): boolean {
  if (token.length < 10 || token.length > 35) return false;
  // YYYY-MM-DD, optionally T/space + HH:MM(:SS(.fff))(Z|±HH:MM)
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(token);
  if (!m) return false;
  const month = Number.parseInt(m[2], 10);
  const day = Number.parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (m[4] !== undefined && (Number.parseInt(m[4], 10) > 23 || Number.parseInt(m[5], 10) > 59)) return false;
  if (m[6] !== undefined && Number.parseInt(m[6], 10) > 60) return false;
  return true;
}

function isBase64Url(s: string): boolean {
  if (s.length < 4) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95 || c === 61;
    if (!ok) return false;
  }
  return true;
}

export function isJwtShape(token: string): boolean {
  const segs = token.split('.');
  if (segs.length !== 3) return false;
  if (!segs.every(isBase64Url)) return false;
  // Header segment decodes to a JSON object starting with `{` in practically every JWT.
  try {
    const header = Buffer.from(segs[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return header.trimStart().startsWith('{');
  } catch {
    return false;
  }
}

export function isHexHash(token: string): boolean {
  return HEX_LENGTHS.has(token.length) && isHex(token);
}

const ID_FIELD = /^(request|trace|session|correlation|span|run|invocation|conversation)[_-]?id$/i;

/** Classify one token; `previous` is the preceding token (for `request_id: …` pairs). */
export function classifyToken(token: string, previous?: string): VolatileLabel | null {
  if (isUuid(token)) return 'uuid';
  if (token.includes('.') && isJwtShape(token)) return 'jwt';
  if (isIso8601(token)) return 'iso8601';
  if (isHexHash(token)) return 'hex_hash';
  if (previous && ID_FIELD.test(previous.replace(/[:=]$/, '')) && token.length >= 8 && /^[A-Za-z0-9_-]+$/.test(token) && /\d/.test(token)) return 'request_id';
  return null;
}

function splitTokens(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split(/\s+/)) {
    let s = 0;
    let e = raw.length;
    while (s < e && PUNCT.includes(raw[s])) s += 1;
    while (e > s && PUNCT.includes(raw[e - 1])) e -= 1;
    const cleaned = raw.slice(s, e);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function sample(token: string): string {
  return token.length <= 16 ? token : `${token.slice(0, 8)}...${token.slice(-4)}`;
}

/** Findings for one text. */
export function detectVolatileContent(content: string): Array<{ label: VolatileLabel; sample: string }> {
  const out: Array<{ label: VolatileLabel; sample: string }> = [];
  if (!content) return out;
  const tokens = splitTokens(content);
  for (let i = 0; i < tokens.length; i++) {
    const label = classifyToken(tokens[i], tokens[i - 1]);
    if (label) out.push({ label, sample: sample(tokens[i]) });
  }
  return out;
}

const encoder = new TextEncoder();

/**
 * Scan the system prompt(s) and the first `earlyMessages` messages (default 3)
 * past the frozen prefix. Never mutates `messages`.
 */
export function analyzeCachePrefix(messages: Message[], opts: { frozenMessageCount?: number; earlyMessages?: number; system?: string } = {}): CacheAlignerReport {
  const frozen = opts.frozenMessageCount ?? 0;
  const early = opts.earlyMessages ?? 3;
  const findings: VolatileFinding[] = [];
  const stableParts: string[] = [];
  if (opts.system) {
    stableParts.push(opts.system);
    for (const f of detectVolatileContent(opts.system)) findings.push({ ...f, messageIndex: -1, role: 'system' });
  }
  for (const b of enumerateBlocks(messages)) {
    const isSystem = b.role === 'system' || b.role === 'developer';
    if (!isSystem && b.messageIndex >= early) continue;
    if (b.kind === 'other') continue;
    stableParts.push(b.text);
    if (b.messageIndex < frozen) continue;
    for (const f of detectVolatileContent(b.text)) findings.push({ ...f, messageIndex: b.messageIndex, role: b.role });
  }
  const warnings: string[] = [];
  if (findings.length) {
    const counts = new Map<string, number>();
    for (const f of findings) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
    const summary = [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const where = findings.some((f) => f.role === 'system' || f.role === 'developer') ? 'system prompt' : 'early messages';
    warnings.push(`cache_aligner: volatile content in the ${where} (${summary}); the prompt-cache prefix changes every turn. Move dynamic values into the latest user turn to recover cache hits.`);
  }
  const scope = stableParts.join('\n---\n');
  const hash = bytesToHex(sha256(encoder.encode(scope))).slice(0, 16);
  return {
    findings,
    warnings,
    markersInserted: [`stable_prefix_hash:${hash}`],
    stablePrefixHash: hash,
    stablePrefixBytes: Buffer.byteLength(scope, 'utf8'),
    alignmentScore: Math.max(0, Math.min(100, 100 - findings.length * 10)),
  };
}
