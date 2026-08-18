import { inventory, type DriftInventory } from '../../engine/drift.js';
import { manifestHash } from '../../lsp/scan-cache.js';

/**
 * The repository's dependency context, computed once per daemon rather than
 * once per process, per call.
 *
 * Two things read the same manifests from the same tree and neither knew about
 * the other: `manifestHash(root)` (the language server's scan-cache key) walks
 * every manifest and hashes its bytes, and `inventory(root)` walks the same
 * tree and parses them. Measured on this repository: 12.6ms and 10.5ms, each
 * paid independently, in each process that wants them.
 *
 * Deliberately *not* on a timer. The daemon already watches these files —
 * `FreshnessSupervisor` classifies a manifest or lockfile write and rebuilds
 * for it — so the entry is dropped by the component that knows it moved. A
 * cache invalidated by an actual filesystem event has no staleness window to
 * argue about, which a TTL cannot say.
 *
 * Not everything under "shared caching" belongs here, and measurement decided
 * which: lockfile→version resolution is 0.10ms a call (there is nothing to
 * share), and the hosted-docs TTL cache is already a file under
 * `.vibgrate/cache/`, so it is already shared by every process on the machine.
 */

export interface DepContext {
  /** Digest of every manifest and lockfile in the tree — the LSP's scan key. */
  manifestHash: string;
  /** Declared/installed dependency records. */
  inventory: DriftInventory;
  /** When this was computed, for diagnostics. */
  builtAt: number;
}

export interface DepCacheOptions {
  log?: (message: string) => void;
  now?: () => number;
  /** Injected (tests). */
  computeHash?: (root: string) => string;
  computeInventory?: (root: string) => DriftInventory;
}

export class DepContextCache {
  private readonly entries = new Map<string, DepContext>();
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly computeHash: (root: string) => string;
  private readonly computeInventory: (root: string) => DriftInventory;

  constructor(options: DepCacheOptions = {}) {
    this.log = options.log ?? ((): void => {});
    this.now = options.now ?? ((): number => Date.now());
    this.computeHash = options.computeHash ?? manifestHash;
    this.computeInventory = options.computeInventory ?? inventory;
  }

  /** Compute or reuse the context for a repository root. Never throws. */
  get(repositoryId: string, root: string): DepContext | null {
    const hit = this.entries.get(repositoryId);
    if (hit) return hit;
    const started = this.now();
    try {
      const context: DepContext = {
        manifestHash: this.computeHash(root),
        inventory: this.computeInventory(root),
        builtAt: this.now(),
      };
      this.entries.set(repositoryId, context);
      this.log(
        `deps: context for ${repositoryId} built in ${context.builtAt - started}ms — ${context.inventory.records.length} dependency(ies)`,
      );
      return context;
    } catch (err) {
      this.log(`deps: could not build context for ${repositoryId} — ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Forget a repository's context. Called from the freshness watcher when a
   * manifest or lockfile is written, so the next reader recomputes.
   */
  invalidate(repositoryId: string): void {
    if (this.entries.delete(repositoryId)) this.log(`deps: context for ${repositoryId} invalidated by a manifest change`);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
