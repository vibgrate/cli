/**
 * Block-level KV / prompt prefix cache keyed by content hash (Approach B).
 *
 * Pure planning layer + multi-turn prefix cursor (P1/P2). The warm host uses
 * {@link longestWarmPrefix} / {@link SessionPrefixCursor} and may call the
 * binding's `evaluateWithoutGeneratingNewTokens` so RoPE state for warm
 * system/capsule blocks is not rebuilt every turn.
 *
 * schemaVersion: kv-cache/0
 */

import { createHash } from 'node:crypto';

export const KV_CACHE_SCHEMA = 'kv-cache/0' as const;

export interface KvBlockMeta {
  /** Content hash (sha256 hex, truncated in keys for path safety). */
  hash: string;
  /** Human label (system, capsule, tools, …). */
  kind: string;
  /** UTF-8 byte length of the source text. */
  bytes: number;
  /** Approx token count (chars/4 heuristic when unknown). */
  approxTokens: number;
  /** When this block entered the registry. */
  createdAt: number;
}

export interface KvAssemblyPlan {
  schemaVersion: typeof KV_CACHE_SCHEMA;
  /** Blocks to reuse from cache (hashes). */
  hit: string[];
  /** Blocks that must be prefilled (hash + kind). */
  miss: Array<{ hash: string; kind: string; approxTokens: number }>;
  /** Ordered sequence of block hashes for the full prompt. */
  order: string[];
  /** Estimated tokens already “warm” vs total. */
  hitTokens: number;
  totalTokens: number;
  /**
   * P2: tokens that must be re-evaluated because the multi-turn cursor
   * diverged (subset of miss + trailing hits after fork).
   */
  deltaTokens?: number;
  /** How many leading blocks the session cursor already has evaluated. */
  cursorSkipBlocks?: number;
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function blockMeta(kind: string, text: string, now = Date.now()): KvBlockMeta {
  return {
    hash: contentHash(text),
    kind,
    bytes: Buffer.byteLength(text, 'utf8'),
    approxTokens: approxTokens(text),
    createdAt: now,
  };
}

/** In-memory registry of which content hashes are considered warm. */
export class KvBlockRegistry {
  private readonly warm = new Map<string, KvBlockMeta>();

  markWarm(meta: KvBlockMeta): void {
    this.warm.set(meta.hash, meta);
  }

  isWarm(hash: string): boolean {
    return this.warm.has(hash);
  }

  get(hash: string): KvBlockMeta | undefined {
    return this.warm.get(hash);
  }

  clear(): void {
    this.warm.clear();
  }

  size(): number {
    return this.warm.size;
  }

  /**
   * Plan assembly for ordered text segments. Hits reuse warm blocks; misses
   * need prefill. After a successful forward pass, call {@link commit} on miss hashes.
   */
  plan(segments: Array<{ kind: string; text: string }>, cursor?: SessionPrefixCursor): KvAssemblyPlan {
    const order: string[] = [];
    const hit: string[] = [];
    const miss: KvAssemblyPlan['miss'] = [];
    let hitTokens = 0;
    let totalTokens = 0;
    for (const seg of segments) {
      const meta = blockMeta(seg.kind, seg.text);
      order.push(meta.hash);
      totalTokens += meta.approxTokens;
      if (this.isWarm(meta.hash)) {
        hit.push(meta.hash);
        hitTokens += meta.approxTokens;
      } else {
        miss.push({ hash: meta.hash, kind: meta.kind, approxTokens: meta.approxTokens });
      }
    }
    let cursorSkipBlocks = 0;
    let deltaTokens = totalTokens;
    if (cursor) {
      const d = cursor.delta(order, segments);
      cursorSkipBlocks = d.skipBlocks;
      deltaTokens = d.evaluateTokens;
    }
    return {
      schemaVersion: KV_CACHE_SCHEMA,
      hit,
      miss,
      order,
      hitTokens,
      totalTokens,
      cursorSkipBlocks,
      deltaTokens,
    };
  }

  /** After prefill, mark miss segments warm. */
  commit(segments: Array<{ kind: string; text: string }>): void {
    for (const seg of segments) {
      this.markWarm(blockMeta(seg.kind, seg.text));
    }
  }
}

/**
 * Multi-turn cursor: remembers the hash chain last evaluated on the sequence
 * so we only re-evaluate from the first divergence (P2 RoPE-friendly delta).
 */
export class SessionPrefixCursor {
  private chain: string[] = [];

  /** Hashes currently considered evaluated on the sequence. */
  get evaluatedHashes(): readonly string[] {
    return this.chain;
  }

  /**
   * Compute how many leading blocks match the previous chain and how many
   * approx tokens still need evaluate (from the fork point).
   */
  delta(
    order: string[],
    segments: Array<{ kind: string; text: string }>,
  ): { skipBlocks: number; evaluateTokens: number; evaluateText: string } {
    let skip = 0;
    while (skip < order.length && skip < this.chain.length && order[skip] === this.chain[skip]) {
      skip++;
    }
    let evaluateTokens = 0;
    const parts: string[] = [];
    for (let i = skip; i < segments.length; i++) {
      const meta = blockMeta(segments[i].kind, segments[i].text);
      evaluateTokens += meta.approxTokens;
      parts.push(segments[i].text);
    }
    return { skipBlocks: skip, evaluateTokens, evaluateText: parts.join('\n') };
  }

  /** After successful evaluate of full ordered hashes, advance the cursor. */
  commit(order: string[]): void {
    this.chain = [...order];
  }

  /** Reset after sequence dispose / model reload. */
  reset(): void {
    this.chain = [];
  }
}

/**
 * Longest leading run of warm segments (stable system/capsule prefix).
 * Host can skip re-prefilling these when the sequence API allows evaluate-only.
 */
export function longestWarmPrefix(
  registry: KvBlockRegistry,
  segments: Array<{ kind: string; text: string }>,
): {
  count: number;
  tokens: number;
  text: string;
  hashes: string[];
} {
  let count = 0;
  let tokens = 0;
  const hashes: string[] = [];
  const parts: string[] = [];
  for (const seg of segments) {
    const meta = blockMeta(seg.kind, seg.text);
    if (!registry.isWarm(meta.hash)) break;
    count++;
    tokens += meta.approxTokens;
    hashes.push(meta.hash);
    parts.push(seg.text);
  }
  return { count, tokens, text: parts.join('\n'), hashes };
}

/**
 * Speculative draft tokens for quotational spans the graph already knows
 * verbatim (signatures / imports). The big model verifies; high acceptance
 * expected on code. Pure: returns candidate draft strings, does not call a model.
 */
export function graphDraftCandidates(
  knownVerbatim: string[],
  max = 8,
): string[] {
  return knownVerbatim
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 400)
    .slice(0, max);
}
