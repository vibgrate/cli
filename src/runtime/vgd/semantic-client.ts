import { attachVgd, type AttachOptions } from './attach.js';
import { vgdRequest } from './client.js';
import { formatSemanticProgress } from './semantic-status.js';

/**
 * One way to ask the daemon for a semantic ranking, shared by every surface.
 *
 * `vg ask`, `vg serve` and `vg lsp` each grew their own copy of "load the
 * embedder, embed the corpus, rank" — and `engine/refresh-scheduler.ts` records
 * what that costs: the per-server copies diverged, and one of them blocked an
 * editor Ask for ninety seconds. This is the single implementation of the
 * daemon path so that cannot happen again.
 *
 * Long-lived callers (the MCP server, the language server) hold one of these
 * for the process: it attaches once, remembers the slot, and per request sends
 * only the question. Short-lived callers get the same behaviour with the attach
 * folded into the first call.
 *
 * Every failure resolves to `null`, never a throw. `null` means "rank it
 * yourself" — the in-process path each caller already has, which is also what
 * happens when no daemon is running at all.
 */

export interface DaemonRanking {
  ranked: Array<{ id: string; score: number }>;
  /** How many vectors the slot holds — for logging, not correctness. */
  vectors: number;
  model?: string;
}

export interface SemanticProgress {
  state: string;
  vectors: number;
  pending?: number;
  nodeCount?: number;
  model?: string;
  /** One line for a live status spinner. */
  detail: string;
}

export interface RankWaitOptions {
  /** Called whenever the slot's status is sampled during a wait. */
  onProgress?: (status: SemanticProgress) => void;
  /** How often to poll `embed-status` while the index is warming (default 300ms). */
  pollMs?: number;
  /** Give up waiting and return null (default 10 minutes). */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SemanticSessionOptions extends Omit<AttachOptions, 'corpusHash'> {
  /** How long to wait before retrying after a failed attach (default 30s). */
  retryAfterMs?: number;
  now?: () => number;
  /** Injected (tests). */
  attach?: typeof attachVgd;
  request?: typeof vgdRequest;
}

export class DaemonSemanticSession {
  private repositoryId: string | undefined;
  private gitRef: string | undefined;
  private socketPath: string | undefined;
  /** The map the daemon was last told about, so an unchanged one is not resent. */
  private publishedHash: string | undefined;
  /** Do not re-attach before this time — a down daemon must not cost every request. */
  private retryAfter = 0;
  private attaching: Promise<void> | null = null;

  private readonly root: string;
  private readonly options: SemanticSessionOptions;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private readonly attachImpl: typeof attachVgd;
  private readonly requestImpl: typeof vgdRequest;

  constructor(root: string, options: SemanticSessionOptions = {}) {
    this.root = root;
    this.options = options;
    this.retryAfterMs = options.retryAfterMs ?? 30_000;
    this.now = options.now ?? ((): number => Date.now());
    this.attachImpl = options.attach ?? attachVgd;
    this.requestImpl = options.request ?? vgdRequest;
  }

  /** True once a slot is known — useful for a one-line status log. */
  get attached(): boolean {
    return !!this.repositoryId;
  }

  /**
   * Rank `question` against the daemon's index for this repo.
   * `corpusHash` is the caller's current map: when it differs from what the
   * daemon holds, the map is republished before ranking, so a locally
   * refreshed map never ranks against yesterday's vectors.
   */
  async rank(question: string, corpusHash?: string, wait?: RankWaitOptions): Promise<DaemonRanking | null> {
    await this.ensureAttached(corpusHash);
    if (!this.repositoryId) return null;
    try {
      const first = await this.requestRank(question);
      if (first.status === 'ranked') return first.ranking;
      if (first.status === 'empty') return null;
      // Index is warming (or an older daemon returned unavailable). Kick a
      // non-blocking build and poll status so the caller can show progress
      // instead of sitting on a silent socket for tens of seconds.
      await this.requestImpl(
        { op: 'embed-index', repositoryId: this.repositoryId, gitRef: this.gitRef, wait: false },
        { socketPath: this.socketPath },
      );
      const now = wait?.now ?? this.now;
      const sleep = wait?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const deadline = now() + (wait?.timeoutMs ?? 600_000);
      const pollMs = wait?.pollMs ?? 300;
      while (now() < deadline) {
        const progress = await this.readProgress(first);
        if (progress) wait?.onProgress?.(progress);
        if (progress && (progress.state === 'failed' || progress.state === 'unavailable')) return null;
        if (progress && (progress.state === 'ready' || progress.vectors > 0)) {
          const again = await this.requestRank(question);
          if (again.status === 'ranked') return again.ranking;
          if (again.status === 'empty') return null;
        }
        await sleep(pollMs);
      }
      return null;
    } catch {
      // The daemon went away mid-session (a restart, an upgrade). Forget the
      // slot so the next call re-attaches instead of retrying a dead socket.
      this.reset();
      return null;
    }
  }

  private async readProgress(hint?: RankAttempt): Promise<SemanticProgress | null> {
    if (!this.repositoryId) return null;
    try {
      const res = await this.requestImpl(
        { op: 'embed-status', repositoryId: this.repositoryId },
        { socketPath: this.socketPath },
      );
      if (!res.ok || !('semantic' in res)) {
        return hint && hint.status === 'warming' ? warmingProgress(hint) : null;
      }
      const slots = res.semantic.slots ?? [];
      const slot =
        slots.find((s) => s.repositoryId === this.repositoryId && (!this.gitRef || s.gitRef === this.gitRef)) ??
        slots.find((s) => s.repositoryId === this.repositoryId) ??
        slots[0];
      if (!slot) {
        if (res.semantic.worker === 'unavailable') {
          return { state: 'unavailable', vectors: 0, detail: res.semantic.reason ?? 'semantic worker unavailable' };
        }
        return hint && hint.status === 'warming' ? warmingProgress(hint) : null;
      }
      const view = {
        state: slot.state,
        vectors: slot.vectors,
        pending: slot.pending,
        nodeCount: slot.nodeCount,
        model: res.semantic.model,
        error: slot.error,
      };
      return { ...view, detail: formatSemanticProgress(view) };
    } catch {
      return hint && hint.status === 'warming' ? warmingProgress(hint) : null;
    }
  }

  private async requestRank(question: string): Promise<RankAttempt> {
    if (!this.repositoryId) return { status: 'unavailable' };
    const res = await this.requestImpl(
      { op: 'embed-rank', repositoryId: this.repositoryId, gitRef: this.gitRef, text: question },
      { socketPath: this.socketPath },
    );
    if (res.ok && 'ranked' in res) {
      if (res.ranked.length === 0) return { status: 'empty' };
      return { status: 'ranked', ranking: { ranked: res.ranked, vectors: res.vectors, model: res.model } };
    }
    if (!res.ok && res.code === 'semantic_warming') {
      return {
        status: 'warming',
        state: res.state,
        vectors: res.vectors ?? 0,
        pending: res.pending,
        nodeCount: res.nodeCount,
      };
    }
    return { status: 'unavailable' };
  }

  /**
   * The daemon's shared dependency context for this repo — the manifest digest
   * and the dependency records — computed once per daemon instead of once per
   * process. Null whenever the daemon cannot answer, so the caller falls back
   * to computing it locally.
   */
  async depContext(): Promise<{
    manifestHash: string;
    dependencies: Array<{ name: string; ecosystem: string; declared: string; installed?: string }>;
  } | null> {
    await this.ensureAttached();
    if (!this.repositoryId) return null;
    try {
      const res = await this.requestImpl(
        { op: 'dep-context', repositoryId: this.repositoryId },
        { socketPath: this.socketPath },
      );
      if (!res.ok || !('manifestHash' in res)) return null;
      return { manifestHash: res.manifestHash, dependencies: res.dependencies };
    } catch {
      this.reset();
      return null;
    }
  }

  private reset(): void {
    this.repositoryId = undefined;
    this.gitRef = undefined;
    this.publishedHash = undefined;
    this.retryAfter = this.now() + this.retryAfterMs;
  }

  /** Attach once; concurrent callers share the one attempt. */
  private ensureAttached(corpusHash?: string): Promise<void> {
    // Already attached and the map has not moved under us.
    if (this.repositoryId && (!corpusHash || corpusHash === this.publishedHash)) return Promise.resolve();
    if (this.now() < this.retryAfter) return Promise.resolve();
    if (this.attaching) return this.attaching;

    this.attaching = (async () => {
      const result = await this.attachImpl(this.root, { ...this.options, corpusHash });
      if (result.status === 'attached' && result.repositoryId) {
        this.repositoryId = result.repositoryId;
        this.gitRef = result.gitRef;
        this.socketPath = result.socketPath;
        this.publishedHash = corpusHash;
      } else {
        this.reset();
      }
    })().finally(() => {
      this.attaching = null;
    });
    return this.attaching;
  }
}

type RankAttempt =
  | { status: 'ranked'; ranking: DaemonRanking }
  | { status: 'warming'; state?: string; vectors?: number; pending?: number; nodeCount?: number }
  | { status: 'unavailable' }
  | { status: 'empty' };

function warmingProgress(hint: Extract<RankAttempt, { status: 'warming' }>): SemanticProgress {
  const view = {
    state: hint.state ?? 'building',
    vectors: hint.vectors ?? 0,
    pending: hint.pending,
    nodeCount: hint.nodeCount,
  };
  return { ...view, detail: formatSemanticProgress(view) };
}
