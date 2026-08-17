/**
 * Session boundary between VG Code and the Fusion Runtime daemon (`vgd`).
 *
 * Replaces the old {@link GraphProcess} (`vg serve` child) for the interactive
 * coding REPL. There is one standalone daemon:
 *
 * 1. If a local vgd is already running — register this workspace.
 * 2. Otherwise — `vg daemon ensure` (detached `daemon start`) and attach.
 *
 * The session never owns vgd. Dispose unregisters the workspace and leaves the
 * daemon running for other clients (VS Code, `vg`, the next `vg code`).
 *
 * Never throws: a failure to attach degrades to “no runtime session” and the
 * agent continues with the in-process graph only (same safety as GraphProcess).
 */

import { vgdIsRunning, vgdRequest, vgdSocketPath } from '../runtime/vgd/index.js';
import type { WorkspaceRecord } from '../runtime/vgd/protocol.js';

export type RuntimeSessionKind = 'attached' | 'none';

export interface RuntimeSessionOptions {
  root: string;
  /** Override socket path (tests). */
  socketPath?: string;
  /** Injectable connect/start hooks (tests). */
  isRunning?: (socketPath?: string) => Promise<boolean>;
  request?: typeof vgdRequest;
  /** Start the standalone daemon if needed (tests). Default: `ensureVgd`. */
  ensureDaemon?: (socketPath?: string) => Promise<void>;
}

export interface CodeRuntimeSession {
  readonly kind: RuntimeSessionKind;
  /** Daemon pid when known. */
  readonly pid: number | undefined;
  readonly workspace: WorkspaceRecord | undefined;
  readonly socketPath: string | undefined;
  /** Human label for the REPL intro line. */
  readonly label: string;
  dispose(): Promise<void>;
}

async function defaultEnsure(socketPath?: string): Promise<void> {
  const { ensureVgd } = await import('../commands/daemon.js');
  await ensureVgd(socketPath ?? vgdSocketPath());
}

/**
 * Attach VG Code to the standalone vgd for one coding session.
 * Always resolves (never throws).
 */
export async function startCodeRuntimeSession(options: RuntimeSessionOptions): Promise<CodeRuntimeSession> {
  const socketPath = options.socketPath;
  const isRunning = options.isRunning ?? ((sp?: string) => vgdIsRunning({ socketPath: sp }));
  const request = options.request ?? vgdRequest;
  const ensure = options.ensureDaemon ?? defaultEnsure;

  try {
    if (!(await isRunning(socketPath))) {
      await ensure(socketPath);
    }
    return await attachExisting(options.root, socketPath, request);
  } catch {
    return noneSession();
  }
}

async function attachExisting(
  root: string,
  socketPath: string | undefined,
  request: typeof vgdRequest,
): Promise<CodeRuntimeSession> {
  const clientOpts = { socketPath };
  const reg = await request({ op: 'register', root }, clientOpts);
  if (!reg.ok || !('workspace' in reg)) return noneSession();
  const status = await request({ op: 'status' }, clientOpts).catch(() => null);
  const pid = status && status.ok && 'pid' in status ? status.pid : undefined;
  let disposed = false;
  return {
    kind: 'attached',
    pid,
    workspace: reg.workspace,
    socketPath: status && status.ok && 'socketPath' in status ? status.socketPath : socketPath,
    label: pid != null ? `vgd ${pid}` : 'vgd',
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await request({ op: 'unregister', root }, clientOpts);
      } catch {
        /* best-effort */
      }
    },
  };
}

function noneSession(): CodeRuntimeSession {
  return {
    kind: 'none',
    pid: undefined,
    workspace: undefined,
    socketPath: undefined,
    label: '',
    async dispose() {
      /* no-op */
    },
  };
}
