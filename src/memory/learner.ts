/**
 * `TrafficLearner` — turns live proxy traffic into memories, zero LLM.
 *
 * Every `observe()` runs the deterministic extractor over the conversation
 * and counts evidence per normalised key. A pattern is promoted into the
 * store once it has been seen `minEvidence` times (default from
 * `VG_MEMORY_MIN_EVIDENCE`, 3). Promoted keys keep bumping the stored row's
 * evidence on later sightings instead of creating duplicates.
 *
 * Proxies resend the whole conversation on every request, so each
 * observation is fingerprinted (tool-call id + output prefix, or the user
 * text) and counted once — re-observing an unchanged history is a no-op.
 *
 * Contradictory path corrections (A→B and B→A) are dropped at promotion
 * time; neither is a stable truth.
 */

import type { Message } from '../compress/types.js';
import { env as knobs } from '../compress/config.js';
import { hashString } from '../engine/hash.js';
import { dropContradictions, extractMemories, extractToolCalls, type ExtractedMemory } from './extract.js';
import type { MemoryStore } from './store.js';
import type { Memory, MemoryScope } from './types.js';

export const DEFAULT_MIN_EVIDENCE = 3;
export const DEDUP_WINDOW = 100;
export const MAX_PENDING = 2048;
export const MAX_SEEN_OBSERVATIONS = 4096;
/** Tag that links a learned memory back to its extraction key (hashed: no case/space issues). */
export const KEY_TAG_PREFIX = 'key:';

export function keyTag(key: string): string {
  return `${KEY_TAG_PREFIX}${hashString(key).slice(0, 16)}`;
}

export interface TrafficLearnerOptions {
  minEvidence?: number;
  /** Scope promoted memories are written to (default: project when resolved, else user). */
  scope?: MemoryScope;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

interface Pending {
  pattern: ExtractedMemory;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export interface TrafficLearnerStats {
  observed: number;
  extracted: number;
  promoted: number;
  pending: number;
  seenObservations: number;
}

export class TrafficLearner {
  readonly minEvidence: number;
  private readonly store: MemoryStore;
  private readonly scope: MemoryScope;
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();
  /** Observation fingerprints already counted (insertion-ordered LRU). */
  private readonly seen = new Set<string>();
  /** Keys already promoted → memory id (evidence bumps go straight to the store). */
  private readonly promoted = new Map<string, string>();
  private observed = 0;
  private extracted = 0;
  private promotedCount = 0;

  constructor(store: MemoryStore, opts: TrafficLearnerOptions = {}) {
    this.store = store;
    const e = opts.env ?? store.env;
    this.minEvidence = Math.max(1, opts.minEvidence ?? knobs.int('VG_MEMORY_MIN_EVIDENCE', e, { min: 1 }) ?? DEFAULT_MIN_EVIDENCE);
    this.scope = opts.scope ?? (store.projectResolved ? 'project' : 'user');
    this.now = opts.now ?? (() => Date.now());
    // Hydrate promoted keys from what the store already holds (learned rows).
    for (const m of store.list({ source: ['learned'] })) {
      const key = m.tags.find((t) => t.startsWith(KEY_TAG_PREFIX));
      if (key) this.promoted.set(key, m.id);
    }
  }

  stats(): TrafficLearnerStats {
    return { observed: this.observed, extracted: this.extracted, promoted: this.promotedCount, pending: this.pending.size, seenObservations: this.seen.size };
  }

  private remember(fingerprint: string): boolean {
    if (this.seen.has(fingerprint)) return false;
    this.seen.add(fingerprint);
    if (this.seen.size > MAX_SEEN_OBSERVATIONS) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    return true;
  }

  /**
   * Observe one request (and optionally the assistant response). Returns the
   * memories promoted or reinforced by this call.
   */
  observe(messages: Message[], response?: Record<string, unknown>): Memory[] {
    this.observed++;
    const out: Memory[] = [];
    const now = this.now();

    // Fingerprint the observations: tool results by id + output prefix, user
    // turns by text. Only genuinely new ones contribute evidence.
    const newFingerprints = new Set<string>();
    for (const call of extractToolCalls(messages, response)) {
      const fp = hashString(`tool|${call.id}|${call.name}|${call.output.slice(0, 200)}`);
      if (this.remember(fp)) newFingerprints.add(`tool:${call.id}`);
    }
    const userTexts: string[] = [];
    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>).map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : '';
      if (text.trim()) userTexts.push(text);
    }
    let freshUserTurns = 0;
    for (const text of userTexts.slice(-3)) if (this.remember(hashString(`user|${text.slice(0, 500)}`))) freshUserTurns++;
    if (newFingerprints.size === 0 && freshUserTurns === 0) return out;

    const patterns = extractMemories(messages, { response });
    for (const p of patterns) {
      // Only count patterns backed by a fresh observation of their kind.
      const isToolDerived = p.key.startsWith('error_recovery|') || p.key.startsWith('environment|');
      if (isToolDerived ? newFingerprints.size === 0 : freshUserTurns === 0) continue;
      this.extracted++;
      const tag = keyTag(p.key);
      const promotedId = this.promoted.get(tag);
      if (promotedId) {
        const existing = this.store.get(promotedId);
        if (existing) {
          out.push(this.store.add({ scope: existing.scope, kind: existing.kind, text: existing.text, tags: existing.tags, source: 'learned' }));
          continue;
        }
        this.promoted.delete(tag);
      }
      const cur = this.pending.get(p.key);
      if (cur) {
        cur.count += 1;
        cur.lastSeen = now;
      } else {
        if (this.pending.size >= MAX_PENDING) {
          const oldest = this.pending.keys().next().value;
          if (oldest !== undefined) this.pending.delete(oldest);
        }
        this.pending.set(p.key, { pattern: p, count: 1, firstSeen: now, lastSeen: now });
      }
    }
    out.push(...this.promote());
    return out;
  }

  /** Promote every pending pattern that reached the evidence bar. */
  promote(): Memory[] {
    const ready = [...this.pending.values()].filter((p) => p.count >= this.minEvidence).map((p) => p.pattern);
    if (ready.length === 0) return [];
    const kept = dropContradictions(ready);
    const dropped = new Set(ready.filter((r) => !kept.includes(r)).map((r) => r.key));
    for (const key of dropped) this.pending.delete(key);
    const out: Memory[] = [];
    for (const p of kept) {
      const pend = this.pending.get(p.key);
      const evidence = pend?.count ?? this.minEvidence;
      const m = this.store.add({ scope: this.scope, kind: p.kind, text: p.text, tags: [...p.tags, keyTag(p.key)], source: 'learned', evidence });
      this.promoted.set(keyTag(p.key), m.id);
      this.pending.delete(p.key);
      this.promotedCount++;
      out.push(m);
    }
    return out;
  }

  /** Pending (not yet promoted) patterns, most evidence first. */
  pendingPatterns(): Array<{ key: string; text: string; count: number }> {
    return [...this.pending.entries()]
      .map(([key, p]) => ({ key, text: p.pattern.text, count: p.count }))
      .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  }
}
