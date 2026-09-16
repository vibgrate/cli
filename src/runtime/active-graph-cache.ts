/**
 * Multi-branch ActiveGraph cache (Fusion plan §4.1.1).
 *
 * Holds several in-memory graphs for the same repository — one per gitRef
 * (branch or detached SHA). Memory management: after an idle timeout, slots
 * become evictable; among idle slots, LILO (last-in, last-out ≡ FIFO by
 * load order) reclaims the oldest-loaded idle graph first. The currently
 * selected slot for a repository is never evicted.
 *
 * A process RSS budget is the extra brake: when `rssUsedBytes()` is over
 * `rssBudgetBytes`, overflow eviction runs even if count caps are not hit.
 */

import type { VgGraph } from '../schema.js';
import { activeGraphSlotKey } from './git-ref.js';

export const DEFAULT_ACTIVE_GRAPH_IDLE_MS = 20 * 60 * 1000;

export interface ActiveGraphSlot {
  repositoryId: string;
  gitRef: string;
  graph: VgGraph;
  loadedAt: number;
  lastAccessAt: number;
  nodeCount: number;
}

export interface ActiveGraphCacheOptions {
  idleTimeoutMs?: number;
  maxPerRepo?: number;
  maxTotal?: number;
  /**
   * Process RSS ceiling in bytes. When `rssUsedBytes()` is above this,
   * overflow LILO runs. 0 / unset skips the RSS check (count caps still apply).
   */
  rssBudgetBytes?: number;
  /** Current process RSS. Defaults to `process.memoryUsage().rss`. */
  rssUsedBytes?: () => number;
  now?: () => number;
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

export class ActiveGraphCache {
  private readonly slots = new Map<string, ActiveGraphSlot>();
  private readonly currentRef = new Map<string, string>();
  /**
   * Repos with a real `select()` call, as opposed to `put()`'s "first load
   * defaults to current" convenience. Overflow eviction (RSS or count caps)
   * only treats a slot as protected-current once it has been explicitly
   * selected — otherwise a repo with a single warm branch that was loaded
   * once and never revisited would be immune to the RSS budget forever,
   * which is exactly the "five published maps on a 2 GiB box" case the
   * budget exists for. The idle-timeout sweep still honors the implicit
   * default: it protects a just-loaded sibling branch before its caller has
   * had a chance to call `select()`.
   */
  private readonly explicitlySelected = new Set<string>();
  private readonly idleTimeoutMs: number;
  private readonly maxPerRepo: number;
  private readonly maxTotal: number;
  private readonly rssBudgetBytes: number;
  private readonly rssUsedBytes: () => number;
  private readonly now: () => number;
  private readonly onEvict?: (slot: { repositoryId: string; gitRef: string }) => void;

  constructor(options: ActiveGraphCacheOptions = {}) {
    this.onEvict = options.onEvict;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_ACTIVE_GRAPH_IDLE_MS;
    this.maxPerRepo = options.maxPerRepo ?? 8;
    this.maxTotal = options.maxTotal ?? 32;
    this.rssBudgetBytes = options.rssBudgetBytes ?? 0;
    this.rssUsedBytes = options.rssUsedBytes ?? (() => process.memoryUsage().rss);
    this.now = options.now ?? (() => Date.now());
  }

  size(): number {
    return this.slots.size;
  }

  get(repositoryId: string, gitRef: string): ActiveGraphSlot | undefined {
    const slot = this.slots.get(activeGraphSlotKey(repositoryId, gitRef));
    if (slot) slot.lastAccessAt = this.now();
    return slot;
  }

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
    if (!this.currentRef.has(repositoryId)) this.currentRef.set(repositoryId, gitRef);
    this.evictIfNeeded();
    return slot;
  }

  select(repositoryId: string, gitRef: string): ActiveGraphSlot | undefined {
    this.currentRef.set(repositoryId, gitRef);
    this.explicitlySelected.add(repositoryId);
    return this.get(repositoryId, gitRef);
  }

  selectedRef(repositoryId: string): string | undefined {
    return this.currentRef.get(repositoryId);
  }

  current(repositoryId: string): ActiveGraphSlot | undefined {
    const ref = this.currentRef.get(repositoryId);
    if (!ref) return undefined;
    return this.get(repositoryId, ref);
  }

  evictIdle(now: number = this.now()): string[] {
    return this.evict(now, false);
  }

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

  evictRepository(repositoryId: string): string[] {
    const removed: string[] = [];
    for (const slot of [...this.slots.values()]) {
      if (slot.repositoryId !== repositoryId) continue;
      const key = activeGraphSlotKey(slot.repositoryId, slot.gitRef);
      this.slots.delete(key);
      removed.push(key);
      this.notifyEvict(slot);
    }
    this.currentRef.delete(repositoryId);
    this.explicitlySelected.delete(repositoryId);
    return removed;
  }

  private notifyEvict(slot: { repositoryId: string; gitRef: string }): void {
    if (!this.onEvict) return;
    try {
      this.onEvict({ repositoryId: slot.repositoryId, gitRef: slot.gitRef });
    } catch {
      /* listener must never break cache maintenance */
    }
  }

  private overRssBudget(): boolean {
    return this.rssBudgetBytes > 0 && this.rssUsedBytes() > this.rssBudgetBytes;
  }

  private isProtectedCurrent(repositoryId: string, gitRef: string): boolean {
    return this.explicitlySelected.has(repositoryId) && this.currentRef.get(repositoryId) === gitRef;
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

    const idle = this.idleCandidates(now, this.idleTimeoutMs);
    idle.sort((a, b) => a.loadedAt - b.loadedAt);
    for (const slot of idle) removeKey(activeGraphSlotKey(slot.repositoryId, slot.gitRef));

    // 2) Overflow: count caps or RSS budget. Timeout is ignored so a burst of
    // publishes cannot sit on a 2 GiB box until the idle clock runs out.
    if (forceOverflow) {
      const overCap = () => this.slots.size > this.maxTotal || this.overRssBudget();
      while (overCap()) {
        const victim = this.pickLiloVictim(now, /* requireIdleTimeout */ false);
        if (!victim) break;
        removeKey(activeGraphSlotKey(victim.repositoryId, victim.gitRef));
      }
      const byRepo = new Map<string, ActiveGraphSlot[]>();
      for (const s of this.slots.values()) {
        const list = byRepo.get(s.repositoryId) ?? [];
        list.push(s);
        byRepo.set(s.repositoryId, list);
      }
      for (const [repoId, list] of byRepo) {
        if (list.length <= this.maxPerRepo) continue;
        const nonCurrent = list
          .filter((s) => !this.isProtectedCurrent(repoId, s.gitRef))
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
      if (this.isProtectedCurrent(slot.repositoryId, slot.gitRef)) continue;
      if (requireIdleTimeout && now - slot.lastAccessAt < this.idleTimeoutMs) continue;
      if (!best || slot.loadedAt < best.loadedAt) best = slot;
    }
    return best;
  }
}
