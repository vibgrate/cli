import { attachVgd, type AttachOptions } from './attach.js';
import { vgdRequest } from './client.js';

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
  async rank(question: string, corpusHash?: string): Promise<DaemonRanking | null> {
    await this.ensureAttached(corpusHash);
    if (!this.repositoryId) return null;
    try {
      const res = await this.requestImpl(
        { op: 'embed-rank', repositoryId: this.repositoryId, gitRef: this.gitRef, text: question },
        { socketPath: this.socketPath },
      );
      if (!res.ok || !('ranked' in res) || res.ranked.length === 0) return null;
      return { ranked: res.ranked, vectors: res.vectors, model: res.model };
    } catch {
      // The daemon went away mid-session (a restart, an upgrade). Forget the
      // slot so the next call re-attaches instead of retrying a dead socket.
      this.reset();
      return null;
    }
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
