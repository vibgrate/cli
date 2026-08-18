import { vgdIsRunning, vgdRequest } from './client.js';
import { vgdSocketPath } from './paths.js';
import { publishGraphToVgd, type VgdPublishOutcome } from './publish.js';

/**
 * The one way an ordinary command joins the local runtime.
 *
 * Until now vgd only ever existed because `vg code` or the VS Code extension
 * started it, so a developer running `vg`, `vg build` and `vg ask` all day
 * never had a runtime at all — every invocation re-read the map and re-loaded
 * the embedder from cold. Auto-start makes the daemon the normal case, and
 * publishing on attach makes it hold the thing it is supposed to accelerate.
 *
 * Three rules keep this safe to put in front of every command:
 *
 * - **Never blocking.** `ensureVgdSoft` spawns and waits ~1.5s, not the 30s
 *   `vg daemon ensure` waits. A daemon that is still coming up simply is not
 *   used this time; the command runs its in-process path and finds a warm
 *   runtime on the next call.
 * - **Never fatal.** Every outcome is a value, never a throw. "No daemon" is a
 *   supported configuration, and it must stay one — the fallbacks are the
 *   code paths that exist today.
 * - **Always escapable.** `--no-daemon`, `VG_NO_DAEMON=1`, and `CI` all turn
 *   auto-start off. A one-shot CI job should not leave a background process
 *   behind, and a user who does not want one must be able to say so once.
 */

export type AttachStatus = 'attached' | 'disabled' | 'unavailable';

export interface AttachResult {
  status: AttachStatus;
  /** Why, when not attached — safe to show verbatim. */
  reason?: string;
  /** True when this call is what started the daemon. */
  started?: boolean;
  socketPath?: string;
  repositoryId?: string;
  gitRef?: string;
  /** Outcome of the map publish, when one was requested. */
  published?: VgdPublishOutcome;
}

export interface AttachOptions {
  socketPath?: string;
  /** Spawn a daemon when none is listening (default true). */
  autoStart?: boolean;
  /** How long to wait for a just-spawned daemon before giving up (default 1500ms). */
  readyBudgetMs?: number;
  /** Publish this repo's map after attaching (default true). */
  publish?: boolean;
  /**
   * The corpus hash of the map the caller already holds. When the daemon's
   * slot reports the same hash the publish is skipped entirely.
   *
   * This matters more than it looks: `load-graph` runs the registry's slot
   * funnel, and `onGraphPut` deliberately drops the slot's vectors — so
   * re-publishing an unchanged map on every `vg ask` invalidated and re-seeded
   * the semantic index once per command, for nothing.
   */
  corpusHash?: string;
  /** Also wait for the slot's semantic index (default false — warming is background work). */
  warmSemantic?: boolean;
  gitRef?: string;
  /** Custom `--graph` artifact path. */
  graphPath?: string;
  /** Explicit opt-out from the caller's parsed flags (`--no-daemon`). */
  disabled?: boolean;
  /** Injected (tests). */
  isRunning?: typeof vgdIsRunning;
  request?: typeof vgdRequest;
  ensure?: (socketPath: string, readyBudgetMs: number) => Promise<{ running: boolean; started: boolean }>;
  env?: NodeJS.ProcessEnv;
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}

/**
 * Why auto-start is off, or null when it is on. Exposed so `vg doctor` can
 * explain a missing daemon instead of leaving the user to guess.
 */
export function daemonDisabledReason(
  options: { disabled?: boolean; env?: NodeJS.ProcessEnv } = {},
): string | null {
  const env = options.env ?? process.env;
  if (options.disabled) return 'disabled by --no-daemon';
  if (truthy(env.VG_NO_DAEMON) || truthy(env.VIBGRATE_NO_DAEMON)) return 'disabled by VG_NO_DAEMON';
  // A CI job is one-shot by definition: starting a background daemon there
  // costs a cold start and leaves a process behind for no second call.
  if (truthy(env.CI)) return 'skipped in CI';
  return null;
}

/**
 * Ensure a local vgd is running and knows about this repository's map.
 * Resolves to a description of what happened; never throws.
 */
export async function attachVgd(root: string, options: AttachOptions = {}): Promise<AttachResult> {
  const disabled = daemonDisabledReason(options);
  if (disabled) return { status: 'disabled', reason: disabled };

  const socketPath = options.socketPath ?? vgdSocketPath();
  const isRunning = options.isRunning ?? vgdIsRunning;
  const readyBudgetMs = options.readyBudgetMs ?? 1500;

  try {
    let running = await isRunning({ socketPath });
    let started = false;
    if (!running && options.autoStart !== false) {
      const ensure = options.ensure ?? (await defaultEnsure());
      const r = await ensure(socketPath, readyBudgetMs);
      running = r.running;
      started = r.started;
    }
    if (!running) {
      return {
        status: 'unavailable',
        reason: started ? 'vgd is still starting — this run uses the in-process path' : 'no vgd is running',
        started,
        socketPath,
      };
    }

    const request = options.request ?? vgdRequest;

    // Register even when not publishing: "attached" should always mean the
    // caller knows which slot it is talking to, or `embed-rank` has no target.
    if (options.publish === false) {
      const reg = await request({ op: 'register', root }, { socketPath });
      const workspace = reg.ok && 'workspace' in reg ? reg.workspace : undefined;
      return {
        status: 'attached',
        started,
        socketPath,
        repositoryId: workspace?.id,
        gitRef: workspace?.gitRef,
      };
    }

    // Already current? Then registering is all this call needs to do.
    if (options.corpusHash) {
      const current = await currentSlot(root, socketPath, request);
      if (current && current.corpusHash === options.corpusHash) {
        return {
          status: 'attached',
          started,
          socketPath,
          repositoryId: current.repositoryId,
          gitRef: current.gitRef,
          published: { status: 'current', repositoryId: current.repositoryId, gitRef: current.gitRef },
        };
      }
    }

    const published = await publishGraphToVgd(root, {
      socketPath,
      gitRef: options.gitRef,
      graphPath: options.graphPath,
      warmSemantic: options.warmSemantic,
      isRunning: () => Promise.resolve(true),
      request: options.request,
    });
    return {
      status: 'attached',
      started,
      socketPath,
      repositoryId: published.status === 'published' ? published.repositoryId : undefined,
      gitRef: published.status === 'published' ? published.gitRef : undefined,
      published,
    };
  } catch (e) {
    return { status: 'unavailable', reason: e instanceof Error ? e.message : String(e), socketPath };
  }
}

/**
 * Register the workspace and ask what the daemon already holds for it.
 * Returns null when there is no slot yet (the common first-run case).
 */
async function currentSlot(
  root: string,
  socketPath: string,
  request: typeof vgdRequest,
): Promise<{ repositoryId: string; gitRef: string; corpusHash: string | null } | null> {
  const reg = await request({ op: 'register', root }, { socketPath });
  if (!reg.ok || !('workspace' in reg)) return null;
  const summary = await request({ op: 'graph-summary', repositoryId: reg.workspace.id }, { socketPath });
  if (!summary.ok || !('summary' in summary)) return null;
  return { repositoryId: reg.workspace.id, gitRef: summary.gitRef, corpusHash: summary.summary.corpusHash };
}

async function defaultEnsure(): Promise<(socketPath: string, readyBudgetMs: number) => Promise<{ running: boolean; started: boolean }>> {
  // Imported lazily: `commands/daemon.ts` pulls in commander and the whole
  // daemon command surface, which no fast path should pay for up front.
  const { ensureVgdSoft } = await import('../../commands/daemon.js');
  return (socketPath, readyBudgetMs) => ensureVgdSoft(socketPath, readyBudgetMs);
}
