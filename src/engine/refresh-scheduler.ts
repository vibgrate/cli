import { refreshIfStale, type RefreshOutcome } from './refresh.js';

/**
 * Debounced, single-flight, budget-capped auto-refresh.
 *
 * `refreshIfStale` is expensive and **synchronous in its hot half**: the
 * freshness probe walks the whole corpus (`discover` + `discoverDocs`) and
 * `statSync`s every file before anything can drift-check, and a real drift then
 * runs a full incremental `buildGraph`. On a 22k-file repo that is seconds for a
 * clean tree and over a minute for a dirty one.
 *
 * No interactive surface may pay that inline. This scheduler is the shared
 * discipline that keeps it off the request path, and it exists as one module
 * precisely because the previous per-server copies diverged: `vg serve` (MCP)
 * grew the guard while `vg lsp` kept a bare `await refreshIfStale(...)`, which
 * made a single editor Ask block for ~90s on a large workspace.
 *
 * Four properties, all load-bearing:
 * - **Single-flight** — concurrent callers share one refresh, never stack.
 * - **Debounced** — at most one probe per `probeIntervalMs`.
 * - **Self-tuning** — the interval grows with the *measured* cost of the last
 *   refresh, so probe/rebuild work stays under ~1/`PROBE_DUTY_FACTOR` of wall
 *   time however big the repo is.
 * - **Budget-capped** — a caller waits `refreshBudgetMs` at most, then proceeds
 *   with the map it already has. A warm probe lands inside the budget; a
 *   rebuild never does, and shouldn't.
 *
 * Answering from a map that is one edit stale is always better than making the
 * user wait: the rebuild lands for the next call.
 */

export type RefreshImpl = typeof refreshIfStale;

/** Min gap between freshness probes — bounds stat-walk cost under bursty calls. */
export const PROBE_INTERVAL_MS = 2000;
/** Ceiling for the self-tuned probe interval on very large repos. */
export const MAX_PROBE_INTERVAL_MS = 30_000;
/** Probe/rebuild may consume at most ~1/PROBE_DUTY_FACTOR of wall-time (20 → ≤5%). */
export const PROBE_DUTY_FACTOR = 20;
/**
 * How long a caller waits for an in-flight refresh before answering from the
 * current map. Deliberately small: warm lookups are sub-10ms, so a multi-second
 * budget turns every call during a large-repo rebuild into a multi-second stall.
 */
export const REFRESH_BUDGET_MS = 100;
/** After a refresh failure (e.g. read-only checkout), don't retry for this long. */
export const FAILURE_COOLDOWN_MS = 60_000;

export interface RefreshSchedulerOptions {
  /** Workspace root for freshness probes and rebuilds. */
  root: string;
  /**
   * The already-resolved map path, or a getter for it. Passing it through spares
   * `refreshIfStale` a `defaultGraphPath` re-resolution (which consults git).
   */
  graphPath?: string | (() => string | undefined);
  /** Min gap between probes. `0` probes every call (tests). */
  probeIntervalMs?: number;
  /** Max wait before a caller gives up and uses the current map. */
  refreshBudgetMs?: number;
  /** Tests only: inject a slow/fake refresh to assert the micro-budget. */
  refreshImpl?: RefreshImpl;
  /** Force single-threaded parsing on a rebuild (constrained hosts / tests). */
  inline?: boolean;
  /**
   * Called when a refresh settles, with the outcome (`null` if it threw) and the
   * ms timestamp the refresh started at. Lets an owner react — invalidate a
   * cached graph, clear a pending-change set — without re-implementing any of
   * the scheduling above.
   */
  onSettled?: (outcome: RefreshOutcome | null, startedAt: number) => void;
}

export class RefreshScheduler {
  private lastProbeAt = 0;
  private failedUntil = 0;
  private inflight: Promise<void> | null = null;
  /** Self-tuned: grows with measured probe/rebuild cost so huge repos aren't penalized. */
  private tunedIntervalMs = PROBE_INTERVAL_MS;
  private readonly refreshImpl: RefreshImpl;

  constructor(private readonly opts: RefreshSchedulerOptions) {
    this.refreshImpl = opts.refreshImpl ?? refreshIfStale;
  }

  /** The interval currently in force — diagnostics and tests. */
  get probeIntervalMs(): number {
    return this.opts.probeIntervalMs ?? this.tunedIntervalMs;
  }

  /** Is a refresh running right now? Lets a caller report "refreshing" state. */
  get busy(): boolean {
    return this.inflight !== null;
  }

  /**
   * Re-arm the next probe regardless of the debounce interval — for a watcher
   * event or an explicit user action, where waiting out the interval would feel
   * broken. Clears the failure cooldown too: a real event is evidence the tree
   * moved, not a poll, and the condition that failed may be exactly what
   * changed. Does not itself start a refresh; the next `maybeRefresh` does.
   */
  arm(): void {
    this.lastProbeAt = 0;
    this.failedUntil = 0;
  }

  /**
   * Probe/rebuild if due, and wait at most the budget for it. Never throws —
   * a refresh problem must degrade to "answer from the current map", not break
   * the caller.
   */
  async maybeRefresh(): Promise<void> {
    const now = Date.now();
    if (!this.inflight) {
      if (now < this.failedUntil || now - this.lastProbeAt < this.probeIntervalMs) return;
      this.lastProbeAt = now;
      const graphPath =
        typeof this.opts.graphPath === 'function' ? this.opts.graphPath() : this.opts.graphPath;
      this.inflight = this.refreshImpl(this.opts.root, { graphPath, inline: this.opts.inline })
        .then((outcome) => {
          if (outcome.status === 'error') this.failedUntil = Date.now() + FAILURE_COOLDOWN_MS;
          this.tune(outcome, now);
          this.opts.onSettled?.(outcome, now);
        })
        .catch(() => {
          this.failedUntil = Date.now() + FAILURE_COOLDOWN_MS;
          this.tune(null, now);
          this.opts.onSettled?.(null, now);
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    await Promise.race([this.inflight, sleep(this.opts.refreshBudgetMs ?? REFRESH_BUDGET_MS)]);
  }

  /**
   * Back off proportionally to what the refresh actually cost — including a
   * multi-second rebuild. Tuning off probe-only outcomes alone would re-arm
   * after the floor and make every sequential call pay the budget again for the
   * whole duration of a large rebuild.
   */
  private tune(outcome: RefreshOutcome | null, startedAt: number): void {
    const elapsed = Date.now() - startedAt;
    const cost =
      outcome?.status === 'refreshed' && typeof outcome.ms === 'number'
        ? Math.max(outcome.ms, elapsed)
        : elapsed;
    this.tunedIntervalMs = Math.min(
      MAX_PROBE_INTERVAL_MS,
      Math.max(PROBE_INTERVAL_MS, cost * PROBE_DUTY_FACTOR),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
