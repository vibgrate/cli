/**
 * Lifetime of the parse-worker pool.
 *
 * tinypool keeps its threads alive until `destroy()` settles. A worker stuck
 * in native code, a SIGINT/SIGTERM, or `process.exit` from the progress UI
 * (which runs before this function's `finally`) used to skip that call, so a
 * failed or interrupted `vg build` / `vg scan` left Node workers running and
 * could swallow the error the user needed. This guard always stops the pool,
 * then lets the original failure through.
 */

/** A thread the pool can still be holding after `destroy()` gives up. */
export interface PoolThread {
  terminate?: () => Promise<number>;
  unref?: () => void;
}

/** The slice of tinypool this guard needs. Tests pass a fake. */
export interface ManagedPool {
  destroy(): Promise<void>;
  cancelPendingTasks?(): void;
  threads?: readonly PoolThread[];
  on?(event: 'error', listener: (err: unknown) => void): void;
}

export interface PoolGuardHost {
  prependListener(signal: NodeJS.Signals, listener: () => void): void;
  removeListener(signal: NodeJS.Signals, listener: () => void): void;
  /** Fires when the loop would otherwise drain with workers still tracked. */
  onBeforeExit?(listener: () => void): () => void;
  /**
   * Install a wrapper around the host's hard exit. The returned function
   * restores the previous exit. The wrapper must not itself exit.
   */
  installExit(handler: (code?: number) => void): () => void;
  /** Hard-exit. Called only after workers have been asked to stop. */
  exit(code: number): void;
  writeError(message: string): void;
}

export const PARSE_INTERRUPTED_MESSAGE =
  'interrupted. Parse workers were stopped. Re-run the command to continue.';

export const PARSE_TERMINATED_MESSAGE =
  'terminated. Parse workers were stopped. Re-run the command to continue.';

const DEFAULT_BUDGET_MS = 2_000;

function delay(ms: number, ref: boolean): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!ref) timer.unref?.();
  });
}

async function stopThread(thread: PoolThread, budgetMs: number): Promise<void> {
  try {
    thread.unref?.();
  } catch {
    /* already gone */
  }
  if (!thread.terminate) return;
  await Promise.race([
    thread.terminate().then(
      () => undefined,
      () => undefined,
    ),
    delay(budgetMs, false),
  ]);
  try {
    thread.unref?.();
  } catch {
    /* already gone */
  }
}

async function stopPool(pool: ManagedPool, budgetMs: number): Promise<void> {
  const threads = [...(pool.threads ?? [])];
  for (const thread of threads) {
    try {
      thread.unref?.();
    } catch {
      /* already gone */
    }
  }
  try {
    pool.cancelPendingTasks?.();
  } catch {
    /* already closing */
  }
  await Promise.race([
    pool.destroy().then(
      () => undefined,
      () => undefined,
    ),
    delay(budgetMs, false),
  ]);
  await Promise.all(threads.map((thread) => stopThread(thread, Math.min(budgetMs, 500))));
}

export class ParsePoolGuard {
  private readonly pools = new Set<ManagedPool>();
  private readonly stopping = new Map<ManagedPool, Promise<void>>();
  /** Bodies currently inside `using`. beforeExit must not stop those. */
  private active = 0;
  private armed = false;
  private exitStarted = false;
  private pendingCode = 0;
  private restoreExit: (() => void) | null = null;
  private removeBeforeExit: (() => void) | null = null;

  private readonly onSigint = (): void => {
    this.requestExit(130);
  };

  private readonly onSigterm = (): void => {
    this.requestExit(143);
  };

  private readonly onBeforeExit = (): void => {
    // A live `using()` body is still parsing. Its message ports normally keep
    // the loop alive; if they don't, exiting is what stops unref'd threads.
    // Only a pool that nobody is waiting on needs an explicit stop here.
    if (this.active > 0 || this.pools.size === 0 || this.exitStarted) return;
    void this.releaseAll();
  };

  constructor(
    private readonly host: PoolGuardHost,
    private readonly budgetMs = DEFAULT_BUDGET_MS,
  ) {}

  /** True once a signal or a hard exit has taken over shutdown. */
  get isExiting(): boolean {
    return this.exitStarted;
  }

  track(pool: ManagedPool): void {
    this.pools.add(pool);
    this.arm();
  }

  /** Run `body` with the pool tracked, and always stop the pool afterwards. */
  async using<T>(pool: ManagedPool, body: () => Promise<T>): Promise<T> {
    this.track(pool);
    this.active += 1;
    try {
      return await body();
    } finally {
      this.active -= 1;
      await this.release(pool);
    }
  }

  async release(pool: ManagedPool): Promise<void> {
    const existing = this.stopping.get(pool);
    if (existing) return existing;
    this.pools.delete(pool);
    const job = stopPool(pool, this.budgetMs).finally(() => {
      this.stopping.delete(pool);
      if (this.pools.size === 0 && this.stopping.size === 0 && !this.exitStarted) this.disarm();
    });
    this.stopping.set(pool, job);
    return job;
  }

  private async releaseAll(): Promise<void> {
    const pools = [...this.pools];
    await Promise.all(pools.map((pool) => this.release(pool)));
  }

  private arm(): void {
    if (this.armed) return;
    this.armed = true;
    this.host.prependListener('SIGINT', this.onSigint);
    this.host.prependListener('SIGTERM', this.onSigterm);
    this.removeBeforeExit = this.host.onBeforeExit?.(this.onBeforeExit) ?? null;
    this.restoreExit = this.host.installExit((code) => {
      this.requestExit(typeof code === 'number' ? code : 0);
    });
  }

  private disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    this.host.removeListener('SIGINT', this.onSigint);
    this.host.removeListener('SIGTERM', this.onSigterm);
    this.removeBeforeExit?.();
    this.removeBeforeExit = null;
    this.restoreExit?.();
    this.restoreExit = null;
  }

  private requestExit(code: number): void {
    if (!this.exitStarted) this.pendingCode = code;
    if (this.exitStarted) return;
    this.exitStarted = true;
    if (code === 130) this.host.writeError(`error: ${PARSE_INTERRUPTED_MESSAGE}\n`);
    else if (code === 143) this.host.writeError(`error: ${PARSE_TERMINATED_MESSAGE}\n`);
    const exitBudget = this.budgetMs + 500;
    void Promise.race([this.releaseAll(), delay(exitBudget, true)]).finally(() => {
      this.disarm();
      this.host.exit(this.pendingCode);
    });
  }
}

export function nodePoolGuardHost(): PoolGuardHost {
  return {
    prependListener(signal, listener) {
      process.prependListener(signal, listener);
    },
    removeListener(signal, listener) {
      process.removeListener(signal, listener);
    },
    onBeforeExit(listener) {
      process.on('beforeExit', listener);
      return () => {
        process.removeListener('beforeExit', listener);
      };
    },
    installExit(handler) {
      const previous = process.exit;
      const wrapped = ((code?: number): never => {
        handler(code);
        return undefined as never;
      }) as typeof process.exit;
      process.exit = wrapped;
      return () => {
        if (process.exit === wrapped) process.exit = previous;
      };
    },
    exit(code) {
      process.exit(code);
    },
    writeError(message) {
      try {
        process.stderr.write(message);
      } catch {
        /* stderr already closed */
      }
    },
  };
}

/** Process-wide guard used by the parse pool. Armed only while a pool is live. */
export const parsePoolGuard = new ParsePoolGuard(nodePoolGuardHost());
