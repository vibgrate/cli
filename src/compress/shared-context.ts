/**
 * SharedContext — compressed hand-offs between agents.
 *
 * Agent A publishes a large output under a key; agent B receives the
 * compressed form (with retrieval markers) and can ask for the full original
 * on demand. Entries carry a TTL and are LRU-evicted; ids are derived from
 * content so two runs over the same data produce the same hand-off payload.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { countTokens } from '../engine/tokens.js';
import { extractHashes } from './ccr/markers.js';
import { CompressionStore, hashOriginal } from './ccr/store.js';
import { compressMessagesSync, type PipelineDeps } from './pipeline.js';
import type { CompressOptions, Message } from './types.js';

export interface ContextEntry {
  key: string;
  agent?: string;
  original: string;
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  transforms: string[];
  /** Store hashes referenced by markers inside `compressed`, plus the whole-original hash. */
  hashes: string[];
  originalHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface SharedContextStats {
  entries: number;
  agents: number;
  totalOriginalTokens: number;
  totalCompressedTokens: number;
  totalTokensSaved: number;
  savingsPercent: number;
}

export interface HandoffPayload {
  /** Deterministic id: sha256 over (from, to, sorted keys, original hashes). */
  id: string;
  from: string;
  to: string;
  entries: Array<{ key: string; agent?: string; compressed: string; originalHash: string; originalTokens: number; compressedTokens: number }>;
  /** Every retrieval marker hash the receiver may redeem. */
  markers: string[];
  /** Store references (hash → the store's backend/dir) so the receiver knows where to retrieve. */
  storeRefs: Array<{ hash: string; backend: string; dir?: string }>;
  tokensBefore: number;
  tokensAfter: number;
}

export interface SharedContextOptions {
  model?: string;
  ttlSeconds?: number;
  maxEntries?: number;
  now?: () => number;
  store?: CompressionStore;
  /** Pipeline options applied to every publish. */
  compress?: CompressOptions;
  deps?: PipelineDeps;
}

const encoder = new TextEncoder();

export class SharedContext {
  private readonly entries = new Map<string, ContextEntry>();
  private readonly agents = new Map<string, Record<string, unknown>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  readonly store: CompressionStore;
  private readonly model: string;
  private readonly compressOptions: CompressOptions;
  private readonly deps: PipelineDeps;

  constructor(opts: SharedContextOptions = {}) {
    this.ttlMs = Math.max(1, opts.ttlSeconds ?? 3600) * 1000;
    this.maxEntries = Math.max(1, opts.maxEntries ?? 100);
    this.now = opts.now ?? (() => Date.now());
    this.store = opts.store ?? new CompressionStore({ backend: 'memory', now: this.now, ttlSeconds: opts.ttlSeconds ?? 3600 });
    this.model = opts.model ?? '';
    this.compressOptions = opts.compress ?? {};
    this.deps = { ...(opts.deps ?? {}), store: this.store, now: this.now };
  }

  registerAgent(id: string, meta: Record<string, unknown> = {}): void {
    this.agents.set(id, { ...meta });
  }

  agentIds(): string[] {
    return [...this.agents.keys()].sort();
  }

  /** Compress and store content under `key` (an existing key is updated in place). */
  publish(key: string, content: string, opts: { agent?: string; model?: string } = {}): ContextEntry {
    const t = this.now();
    const messages: Message[] = [{ role: 'user', content: 'Summarise the tool output.' }, { role: 'assistant', content: [{ type: 'tool_use', id: `handoff_${hashOriginal(content).slice(0, 12)}`, name: 'handoff', input: { key } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `handoff_${hashOriginal(content).slice(0, 12)}`, content }] }];
    let compressed = content;
    let transforms: string[] = [];
    let originalTokens = countTokens(content);
    let compressedTokens = originalTokens;
    try {
      const r = compressMessagesSync(messages, { ...this.compressOptions, model: opts.model ?? this.model, mode: 'token', minTokensToCompress: 0, minCharsForBlock: 0, protectRecent: 0, protectReads: false, crossTurnDedup: false }, this.deps);
      const last = r.messages[2] as { content?: Array<{ content?: unknown }> };
      const out = last?.content?.[0]?.content;
      if (typeof out === 'string' && out) compressed = out;
      transforms = r.transformsApplied;
      originalTokens = r.tokensBefore;
      compressedTokens = r.tokensAfter;
    } catch {
      /* fail open: uncompressed hand-off */
    }
    const originalHash = this.store.store(content, { compressed, strategy: 'shared_context', toolName: 'handoff', queryContext: key, originalTokens, compressedTokens });
    const hashes = [...new Set([originalHash, ...extractHashes(compressed)])];
    const existing = this.entries.get(key);
    const entry: ContextEntry = { key, original: content, compressed, originalTokens, compressedTokens, transforms, hashes, originalHash, createdAt: existing?.createdAt ?? t, updatedAt: t };
    if (opts.agent !== undefined) entry.agent = opts.agent;
    if (existing) this.entries.delete(key);
    else this.evictIfNeeded(t);
    this.entries.set(key, entry);
    return entry;
  }

  /** Alias for `publish`. */
  put(key: string, content: string, opts: { agent?: string } = {}): ContextEntry {
    return this.publish(key, content, opts);
  }

  get(key: string, opts: { full?: boolean } = {}): string | null {
    const e = this.getEntry(key);
    if (!e) return null;
    return opts.full ? e.original : e.compressed;
  }

  getEntry(key: string): ContextEntry | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (this.now() - e.updatedAt > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    // LRU touch.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e;
  }

  keys(): string[] {
    const t = this.now();
    return [...this.entries.values()].filter((e) => t - e.updatedAt <= this.ttlMs).map((e) => e.key);
  }

  /** Everything `from` published (or all entries when `from` published nothing), as one deterministic payload for `to`. */
  handoff(from: string, to: string, opts: { keys?: string[] } = {}): HandoffPayload {
    const t = this.now();
    let live = [...this.entries.values()].filter((e) => t - e.updatedAt <= this.ttlMs);
    if (opts.keys) live = live.filter((e) => opts.keys!.includes(e.key));
    else {
      const mine = live.filter((e) => e.agent === from);
      if (mine.length) live = mine;
    }
    live.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const markers = [...new Set(live.flatMap((e) => e.hashes))].sort();
    const idInput = JSON.stringify({ from, to, entries: live.map((e) => [e.key, e.originalHash]) });
    const stats = this.store.stats();
    const payload: HandoffPayload = {
      id: bytesToHex(sha256(encoder.encode(idInput))).slice(0, 24),
      from,
      to,
      entries: live.map((e) => {
        const row: HandoffPayload['entries'][number] = { key: e.key, compressed: e.compressed, originalHash: e.originalHash, originalTokens: e.originalTokens, compressedTokens: e.compressedTokens };
        if (e.agent !== undefined) row.agent = e.agent;
        return row;
      }),
      markers,
      storeRefs: markers.map((hash) => (stats.dir ? { hash, backend: stats.backend, dir: stats.dir } : { hash, backend: stats.backend })),
      tokensBefore: live.reduce((n, e) => n + e.originalTokens, 0),
      tokensAfter: live.reduce((n, e) => n + e.compressedTokens, 0),
    };
    return payload;
  }

  stats(): SharedContextStats {
    const t = this.now();
    const live = [...this.entries.values()].filter((e) => t - e.updatedAt <= this.ttlMs);
    const before = live.reduce((n, e) => n + e.originalTokens, 0);
    const after = live.reduce((n, e) => n + e.compressedTokens, 0);
    return { entries: live.length, agents: this.agents.size, totalOriginalTokens: before, totalCompressedTokens: after, totalTokensSaved: Math.max(0, before - after), savingsPercent: before > 0 ? Math.round(((before - after) / before) * 1000) / 10 : 0 };
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private evictIfNeeded(t: number): void {
    for (const [k, e] of [...this.entries.entries()]) if (t - e.updatedAt > this.ttlMs) this.entries.delete(k);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
