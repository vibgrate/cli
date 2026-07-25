/**
 * Branch-aware graph loading for a single repository worktree (Fusion §4.1.1).
 *
 * Combines {@link detectGitRef}, disk load via {@link loadGraph}, and an
 * {@link ActiveGraphCache} so checkout A → B → A reuses a warm in-memory map
 * when the branch is still resident (LILO idle eviction applies).
 */

import { loadGraph } from '../engine/load.js';
import { repositoryIdFromRoot } from './paths.js';
import { detectGitRef, type GitRunner } from './git-ref.js';
import { ActiveGraphCache } from './active-graph-cache.js';
import type { VgGraph } from '../schema.js';

export interface BranchGraphLoadResult {
  graph: VgGraph | null;
  gitRef: string;
  kind: 'branch' | 'detached' | 'none';
  /** True when the selected ActiveGraph slot changed since the previous ensure. */
  switched: boolean;
  /** True when the graph was served from the in-memory cache. */
  fromCache: boolean;
  repositoryId: string;
}

export interface BranchGraphSessionOptions {
  root: string;
  cache?: ActiveGraphCache;
  /** Optional explicit graph path (CLI `--graph`); bypasses branch keying for disk. */
  graphPath?: string;
  detectGit?: typeof detectGitRef;
  load?: typeof loadGraph;
  gitRun?: GitRunner;
}

/**
 * Stateful helper: call {@link ensureCurrent} at session start and before each
 * agent turn so a mid-session `git checkout` picks up the correct map.
 */
export class BranchGraphSession {
  readonly root: string;
  readonly repositoryId: string;
  readonly cache: ActiveGraphCache;
  private readonly graphPath?: string;
  private readonly detectGit: typeof detectGitRef;
  private readonly load: typeof loadGraph;
  private readonly gitRun?: GitRunner;
  private lastRef = '';

  constructor(options: BranchGraphSessionOptions) {
    this.root = options.root;
    this.repositoryId = repositoryIdFromRoot(options.root);
    this.cache = options.cache ?? new ActiveGraphCache();
    this.graphPath = options.graphPath;
    this.detectGit = options.detectGit ?? detectGitRef;
    this.load = options.load ?? loadGraph;
    this.gitRun = options.gitRun;
  }

  /**
   * Resolve HEAD, activate the matching cache slot (or load from disk), and
   * run idle eviction. Returns null graph when no map exists for this ref.
   */
  ensureCurrent(): BranchGraphLoadResult {
    this.cache.evictIdle();
    const info = this.gitRun ? this.detectGit(this.root, this.gitRun) : this.detectGit(this.root);
    const gitRef = info.ref || 'unknown';
    const switched = this.lastRef !== '' && this.lastRef !== gitRef;
    this.lastRef = gitRef;

    // Explicit --graph path: still track ref for cache identity but load that file.
    if (this.graphPath) {
      const graph = this.load(this.root, this.graphPath);
      if (graph) {
        this.cache.put(this.repositoryId, gitRef, graph);
        this.cache.select(this.repositoryId, gitRef);
      }
      return {
        graph,
        gitRef,
        kind: info.kind,
        switched,
        fromCache: false,
        repositoryId: this.repositoryId,
      };
    }

    const warm = this.cache.get(this.repositoryId, gitRef);
    if (warm) {
      this.cache.select(this.repositoryId, gitRef);
      return {
        graph: warm.graph,
        gitRef,
        kind: info.kind,
        switched,
        fromCache: true,
        repositoryId: this.repositoryId,
      };
    }

    const graph = this.load(this.root);
    if (graph) {
      this.cache.put(this.repositoryId, gitRef, graph);
      this.cache.select(this.repositoryId, gitRef);
    }
    return {
      graph,
      gitRef,
      kind: info.kind,
      switched,
      fromCache: false,
      repositoryId: this.repositoryId,
    };
  }

  /** Diagnostics for daemon status / tests. */
  listSlots() {
    return this.cache.list(this.repositoryId);
  }
}
