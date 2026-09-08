/**
 * Local response cache for identical non-streaming requests (opt-in).
 *
 * Key: sha256 of the canonical JSON of {model, messages, system, tools,
 * tool_choice, temperature, top_p, top_k, max_tokens, stop, thinking,
 * output_config} with `cache_control` stripped recursively — a moved
 * breakpoint never changes the completion, so it must not fragment the key.
 * LRU + TTL, bounded.
 */

import { createHash } from 'node:crypto';
import { canonicalize } from '../engine/hash.js';

const KEY_FIELDS = ['model', 'messages', 'system', 'tools', 'tool_choice', 'temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens', 'stop', 'stop_sequences', 'thinking', 'output_config', 'input', 'instructions', 'reasoning'] as const;

export function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'cache_control') continue;
    out[k] = stripCacheControl(v);
  }
  return out;
}

export function semanticCacheKey(body: Record<string, unknown>): string {
  const subset: Record<string, unknown> = {};
  for (const f of KEY_FIELDS) if (body[f] !== undefined) subset[f] = stripCacheControl(body[f]);
  return createHash('sha256').update(canonicalize(subset)).digest('hex').slice(0, 32);
}

export interface CacheEntry {
  body: string;
  headers: Record<string, string>;
  createdAt: number;
  ttlSeconds: number;
  hits: number;
  tokensSavedPerHit: number;
}

export class SemanticCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalHits = 0;
  constructor(
    private readonly opts: { maxEntries?: number; ttlSeconds?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? (() => Date.now()))();
  }

  get(key: string): CacheEntry | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (this.now() - e.createdAt > e.ttlSeconds * 1000) {
      this.entries.delete(key);
      return null;
    }
    e.hits++;
    this.totalHits++;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e;
  }

  set(key: string, body: string, headers: Record<string, string>, tokensSavedPerHit = 0, ttlSeconds?: number): void {
    this.entries.delete(key);
    const max = Math.max(1, this.opts.maxEntries ?? 1000);
    while (this.entries.size >= max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { body, headers, createdAt: this.now(), ttlSeconds: ttlSeconds ?? this.opts.ttlSeconds ?? 3600, hits: 0, tokensSavedPerHit });
  }

  clear(): number {
    const n = this.entries.size;
    this.entries.clear();
    return n;
  }

  stats(): { entries: number; maxEntries: number; totalHits: number; ttlSeconds: number; bytes: number } {
    let bytes = 0;
    for (const e of this.entries.values()) bytes += e.body.length;
    return { entries: this.entries.size, maxEntries: this.opts.maxEntries ?? 1000, totalHits: this.totalHits, ttlSeconds: this.opts.ttlSeconds ?? 3600, bytes };
  }
}
