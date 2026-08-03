/**
 * Multi-branch ActiveGraph cache (Fusion plan §4.1.1).
 *
 * Holds several in-memory graphs for the same repository — one per gitRef
 * (branch or detached SHA). Memory management: after an idle timeout, slots
 * become evictable; among idle slots, LILO (last-in, last-out ≡ FIFO by
 * load order) reclaims the oldest-loaded idle graph first. The currently
 * selected slot for a repository is never evicted.
 */

import type { VgGraph } from '../schema.js';
import { activeGraphSlotKey } from './git-ref.js';

/** Default idle timeout: 20 minutes (within the 15–30 min plan band). */
export const DEFAULT_ACTIVE_GRAPH_IDLE_MS = 20 * 60 * 1000;

export interface ActiveGraphSlot {
  repositoryId: string;
  gitRef: string;
  graph: VgGraph;
  /** When this slot was first loaded into the cache. */
  loadedAt: number;
  /** Last access / select time. */
  lastAccessAt: number;
  /** Approximate size hint for diagnostics (node count). */
  nodeCount: number;
}

export interface ActiveGraphCacheOptions {
  /** Idle duration before a non-selected slot is evictable (default 20 min). */
  idleTimeoutMs?: number;
  /** Max resident graphs per repositoryId (default 8). */
  maxPerRepo?: number;
  /** Max resident graphs process-wide (default 32). */
  maxTotal?: number;
  now?: () => number;
  /**
   * Called for every slot leaving the cache, whatever removed it (idle
   * timeout, overflow, clear). Anything keyed by the same slot — the semantic
   * index in vgd — hangs off this so it can never outlive the graph it
   * describes. Must not throw; a listener error is swallowed rather than
   * corrupting eviction.
   */
  onEvict?: (slot: { repositoryId: string; gitRef: string }) => void;
}

export interface ActiveGraphSlotSummary {
  repositoryId: string;
  gitRef: string;
  loadedAt: number;
  lastAccessAt: number;
  nodeCount: number;
  current: boolean;
  idleMs: number;
  evictable: boolean;
}

/**
 * In-memory multi-branch graph cache. Pure structure — does not load/save disk.
 */
export class ActiveGraphCache {
  private readonly slots = new Map<string, ActiveGraphSlot>();
  /** repositoryId → currently selected gitRef */
  private readonly currentRef = new Map<string, string>();
  private readonly idleTimeoutMs: number;
  private readonly maxPerRepo: number;
  private readonly maxTotal: number;
  private readonly now: () => number;
  private readonly onEvict?: (slot: { repositoryId: string; gitRef: string }) => void;

  constructor(options: ActiveGraphCacheOptions = {}) {
    this.onEvict = options.onEvict;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_ACTIVE_GRAPH_IDLE_MS;
    this.maxPerRepo = options.maxPerRepo ?? 8;
    this.maxTotal = options.maxTotal ?? 32;
    this.now = options.now ?? (() => Date.now());
  }

  size(): number {
    return this.slots.size;
  }

  get(repositoryId: string, gitRef: string): ActiveGraphSlot | undefined {
    const slot = this.slots.get(activeGraphSlotKey(repositoryId, gitRef));
    if (slot) {
      slot.lastAccessAt = this.now();
    }
    return slot;
  }

  /**
   * Insert or replace a graph for (repositoryId, gitRef). Touches access time.
   * Runs eviction if over cap.
   */
  put(repositoryId: string, gitRef: string, graph: VgGraph): ActiveGraphSlot {
    const key = activeGraphSlotKey(repositoryId, gitRef);
    const t = this.now();
    const existing = this.slots.get(key);
    const slot: ActiveGraphSlot = {
      repositoryId,
      gitRef,
      graph,
      loadedAt: existing?.loadedAt ?? t,
      lastAccessAt: t,
      nodeCount: graph.nodes?.length ?? 0,
    };
    this.slots.set(key, slot);
    if (!this.currentRef.has(repositoryId)) {
      this.currentRef.set(repositoryId, gitRef);
    }
    this.evictIfNeeded();
    return slot;
  }

  /**
   * Mark gitRef as the current branch for this repository and touch it.
   * Returns the slot if present.
   */
  select(repositoryId: string, gitRef: string): ActiveGraphSlot | undefined {
    this.currentRef.set(repositoryId, gitRef);
    return this.get(repositoryId, gitRef);
  }

  /** Currently selected gitRef for a repository, if any. */
  selectedRef(repositoryId: string): string | undefined {
    return this.currentRef.get(repositoryId);
  }

  current(repositoryId: string): ActiveGraphSlot | undefined {
    const ref = this.currentRef.get(repositoryId);
    if (!ref) return undefined;
    return this.get(repositoryId, ref);
  }

  /**
   * Drop idle slots past the timeout (LILO among idle).
   * Returns keys of removed slots.
   */
  evictIdle(now: number = this.now()): string[] {
    return this.evict(now, false);
  }

  /** Force eviction of idle slots when over caps (timeout may be ignored for overflow). */
  evictIfNeeded(): string[] {
    return this.evict(this.now(), true);
  }

  list(repositoryId?: string): ActiveGraphSlotSummary[] {
    const t = this.now();
    const out: ActiveGraphSlotSummary[] = [];
    for (const slot of this.slots.values()) {
      if (repositoryId && slot.repositoryId !== repositoryId) continue;
      const current = this.currentRef.get(slot.repositoryId) === slot.gitRef;
      const idleMs = t - slot.lastAccessAt;
      out.push({
        repositoryId: slot.repositoryId,
        gitRef: slot.gitRef,
        loadedAt: slot.loadedAt,
        lastAccessAt: slot.lastAccessAt,
        nodeCount: slot.nodeCount,
        current,
        idleMs,
        evictable: !current && idleMs >= this.idleTimeoutMs,
      });
    }
    return out.sort(
      (a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.gitRef.localeCompare(b.gitRef),
    );
  }

  clear(): void {
    for (const slot of this.slots.values()) this.notifyEvict(slot);
    this.slots.clear();
    this.currentRef.clear();
  }

  private notifyEvict(slot: { repositoryId: string; gitRef: string }): void {
    if (!this.onEvict) return;
    try {
      this.onEvict({ repositoryId: slot.repositoryId, gitRef: slot.gitRef });
    } catch {
      // A listener problem must never break cache maintenance.
    }
  }

  private evict(now: number, forceOverflow: boolean): string[] {
    const removed: string[] = [];

    const removeKey = (key: string): void => {
      const slot = this.slots.get(key);
      if (!slot) return;
      this.slots.delete(key);
      removed.push(key);
      this.notifyEvict(slot);
    };

    // 1) Idle timeout: LILO among idle (earliest loadedAt first).
    const idle = this.idleCandidates(now, this.idleTimeoutMs);
    idle.sort((a, b) => a.loadedAt - b.loadedAt);
    for (const slot of idle) {
      removeKey(activeGraphSlotKey(slot.repositoryId, slot.gitRef));
    }

    // 2) Overflow: if still over maxPerRepo or maxTotal, LILO among any non-current idle-or-all-non-current.
    if (forceOverflow) {
      while (this.slots.size > this.maxTotal) {
        const victim = this.pickLiloVictim(now, /* requireIdleTimeout */ false);
        if (!victim) break;
        removeKey(activeGraphSlotKey(victim.repositoryId, victim.gitRef));
      }
      // Per-repo caps
      const byRepo = new Map<string, ActiveGraphSlot[]>();
      for (const s of this.slots.values()) {
        const list = byRepo.get(s.repositoryId) ?? [];
        list.push(s);
        byRepo.set(s.repositoryId, list);
      }
      for (const [repoId, list] of byRepo) {
        if (list.length <= this.maxPerRepo) continue;
        const nonCurrent = list
          .filter((s) => this.currentRef.get(repoId) !== s.gitRef)
          .sort((a, b) => a.loadedAt - b.loadedAt);
        let excess = list.length - this.maxPerRepo;
        for (const s of nonCurrent) {
          if (excess <= 0) break;
          removeKey(activeGraphSlotKey(s.repositoryId, s.gitRef));
          excess--;
        }
      }
    }

    return removed;
  }

  private idleCandidates(now: number, timeoutMs: number): ActiveGraphSlot[] {
    const out: ActiveGraphSlot[] = [];
    for (const slot of this.slots.values()) {
      if (this.currentRef.get(slot.repositoryId) === slot.gitRef) continue;
      if (now - slot.lastAccessAt >= timeoutMs) out.push(slot);
    }
    return out;
  }

  private pickLiloVictim(now: number, requireIdleTimeout: boolean): ActiveGraphSlot | null {
    let best: ActiveGraphSlot | null = null;
    for (const slot of this.slots.values()) {
      if (this.currentRef.get(slot.repositoryId) === slot.gitRef) continue;
      if (requireIdleTimeout && now - slot.lastAccessAt < this.idleTimeoutMs) continue;
      if (!best || slot.loadedAt < best.loadedAt) best = slot;
    }
    return best;
  }
}
