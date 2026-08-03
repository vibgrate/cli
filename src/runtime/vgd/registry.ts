import * as path from 'node:path';
import { repositoryIdFromRoot, globalGraphPathForRef, globalGraphPath } from '../paths.js';
import { detectGitRef } from '../git-ref.js';
import { ActiveGraphCache } from '../active-graph-cache.js';
import type { WorkspaceRecord } from './protocol.js';
import type { VgGraph } from '../../schema.js';

/** Slot-scoped resource that must track the graph cache exactly. */
export interface GraphSlotListener {
  onGraphPut(repositoryId: string, gitRef: string, graph: VgGraph): void;
  onGraphSelect(repositoryId: string, gitRef: string): void;
  onGraphEvict(repositoryId: string, gitRef: string): void;
}

/**
 * In-memory workspace registry for the vgd prototype.
 *
 * Tracks which repository roots the daemon knows about and where their
 * graphs live. Holds a multi-branch {@link ActiveGraphCache} so several
 * git refs of the same repo can stay warm (Fusion §4.1.1).
 */
export class WorkspaceRegistry {
  private readonly byId = new Map<string, WorkspaceRecord>();
  /**
   * Anything keyed by the same (repositoryId, gitRef) slot as the graph — the
   * semantic index — attaches here. Wiring it through the registry rather than
   * the cache directly means every put/select/evict passes one funnel, so an
   * index can never describe a ref its graph no longer holds.
   */
  private slotListener?: GraphSlotListener;
  /** Multi-branch in-memory graphs (shared across registered workspaces). */
  readonly graphs = new ActiveGraphCache({
    onEvict: (slot) => this.slotListener?.onGraphEvict(slot.repositoryId, slot.gitRef),
  });

  /** Attach the semantic index (or any slot-scoped resource) to graph lifecycle. */
  setSlotListener(listener: GraphSlotListener | undefined): void {
    this.slotListener = listener;
  }

  register(
    root: string,
    now: () => Date = () => new Date(),
    meta: { label?: string; role?: 'primary' | 'member'; gitRef?: string } = {},
  ): WorkspaceRecord {
    const resolved = path.resolve(root);
    const id = repositoryIdFromRoot(resolved);
    const git = meta.gitRef ? { ref: meta.gitRef, kind: 'branch' as const } : detectGitRef(resolved);
    const graphPath =
      git.kind !== 'none' && git.ref ? globalGraphPathForRef(resolved, git.ref) : globalGraphPath(resolved);
    const record: WorkspaceRecord = {
      id,
      root: resolved,
      graphPath,
      registeredAt: now().toISOString(),
      label: meta.label,
      role: meta.role,
      gitRef: git.ref || undefined,
    };
    this.byId.set(id, record);
    if (git.ref) this.graphs.select(id, git.ref);
    return record;
  }

  /**
   * Activate or insert an in-memory graph for a workspace branch.
   * Call after load/build; runs LILO idle eviction as needed.
   */
  putGraph(repositoryId: string, gitRef: string, graph: VgGraph): void {
    this.graphs.put(repositoryId, gitRef, graph);
    this.graphs.select(repositoryId, gitRef);
    // Invalidate before anyone can query: the old vectors describe the old graph.
    this.slotListener?.onGraphPut(repositoryId, gitRef, graph);
    this.slotListener?.onGraphSelect(repositoryId, gitRef);
  }

  /** Switch the current branch slot for a repository (no load). */
  selectGitRef(repositoryId: string, gitRef: string): void {
    this.graphs.select(repositoryId, gitRef);
    this.slotListener?.onGraphSelect(repositoryId, gitRef);
  }

  /** Register every member of a federation (primary + members). */
  registerFederation(
    members: Array<{ root: string; label?: string; role?: 'primary' | 'member' }>,
    now: () => Date = () => new Date(),
  ): WorkspaceRecord[] {
    return members.map((m) => this.register(m.root, now, { label: m.label, role: m.role }));
  }

  unregister(root: string): boolean {
    const id = repositoryIdFromRoot(path.resolve(root));
    return this.byId.delete(id);
  }

  list(): WorkspaceRecord[] {
    return [...this.byId.values()].sort((a, b) => a.root.localeCompare(b.root));
  }

  get(root: string): WorkspaceRecord | undefined {
    return this.byId.get(repositoryIdFromRoot(path.resolve(root)));
  }

  /** Lookup by stable repository id. */
  getById(repositoryId: string): WorkspaceRecord | undefined {
    return this.byId.get(repositoryId);
  }

  size(): number {
    return this.byId.size;
  }

  /**
   * Resolve an ActiveGraph for query/impact: prefer the named gitRef, else the
   * selected current slot, else any warm slot for the repository.
   */
  resolveGraph(repositoryId: string, gitRef?: string): { graph: VgGraph; gitRef: string } | null {
    if (gitRef) {
      const slot = this.graphs.get(repositoryId, gitRef);
      if (slot) return { graph: slot.graph, gitRef: slot.gitRef };
    }
    const current = this.graphs.current(repositoryId);
    if (current) return { graph: current.graph, gitRef: current.gitRef };
    // Fall back to any warm slot for this repo (deterministic: earliest loaded).
    const any = this.graphs
      .list(repositoryId)
      .slice()
      .sort((a, b) => a.loadedAt - b.loadedAt)[0];
    if (any) {
      const slot = this.graphs.get(repositoryId, any.gitRef);
      if (slot) return { graph: slot.graph, gitRef: slot.gitRef };
    }
    return null;
  }
}
