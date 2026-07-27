/**
 * Session boundary between VG Code and the Fusion Runtime daemon (`vgd`).
 *
 * Replaces the old {@link GraphProcess} (`vg serve` child) for the interactive
 * coding REPL. Behaviour:
 *
 * 1. If a local vgd is already running — register this workspace and leave the
 *    daemon running when the session ends (unregister only).
 * 2. Otherwise — start an **in-process** vgd for the life of the session and
 *    tear it down on dispose. No second OS process, no `vg serve` spawn.
 *
 * Never throws: a failure to attach degrades to “no runtime session” and the
 * agent continues with the in-process graph only (same safety as GraphProcess).
 */

import { startVgdServer, vgdIsRunning, vgdRequest, type VgdServer } from '../runtime/vgd/index.js';
import type { WorkspaceRecord } from '../runtime/vgd/protocol.js';

export type RuntimeSessionKind = 'attached' | 'owned' | 'none';

export interface RuntimeSessionOptions {
  root: string;
  /** Override socket path (tests). */
  socketPath?: string;
  /** Injectable connect/start hooks (tests). */
  isRunning?: (socketPath?: string) => Promise<boolean>;
  request?: typeof vgdRequest;
  startServer?: (opts: { socketPath?: string }) => Promise<VgdServer>;
}

export interface CodeRuntimeSession {
  readonly kind: RuntimeSessionKind;
  /** Daemon pid when known (attached status or owned process). */
  readonly pid: number | undefined;
  readonly workspace: WorkspaceRecord | undefined;
  readonly socketPath: string | undefined;
  /** Human label for the REPL intro line. */
  readonly label: string;
  dispose(): Promise<void>;
}

/**
 * Attach VG Code to vgd for one coding session. Always resolves (never throws).
 */
export async function startCodeRuntimeSession(options: RuntimeSessionOptions): Promise<CodeRuntimeSession> {
  const socketPath = options.socketPath;
  const isRunning = options.isRunning ?? ((sp?: string) => vgdIsRunning({ socketPath: sp }));
  const request = options.request ?? vgdRequest;
  const startServer = options.startServer ?? ((opts: { socketPath?: string }) => startVgdServer(opts));

  try {
    if (await isRunning(socketPath)) {
      return await attachExisting(options.root, socketPath, request);
    }
    return await startOwned(options.root, socketPath, startServer, request);
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

async function startOwned(
  root: string,
  socketPath: string | undefined,
  startServer: (opts: { socketPath?: string }) => Promise<VgdServer>,
  request: typeof vgdRequest,
): Promise<CodeRuntimeSession> {
  const server = await startServer({ socketPath });
  const clientOpts = { socketPath: server.socketPath };
  let workspace: WorkspaceRecord | undefined;
  try {
    const reg = await request({ op: 'register', root }, clientOpts);
    if (reg.ok && 'workspace' in reg) workspace = reg.workspace;
  } catch {
    /* registry optional for an empty session */
  }
  let disposed = false;
  return {
    kind: 'owned',
    pid: process.pid,
    workspace,
    socketPath: server.socketPath,
    label: `vgd (session)`,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await server.close();
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
