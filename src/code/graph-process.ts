/**
 * The VG Code ⇄ Vibgrate Graph process boundary (VG-CLI-CODE §11).
 *
 * When VG Code enters coding mode it spawns Vibgrate Graph (`vg serve`, the
 * local-first AI-context MCP server) as a **separate child process** and kills
 * it when the session ends — so the code map is served for the life of the
 * session and never outlives it. The child is launched with `--client vg-code`
 * so anything it records is attributed to VG Code.
 *
 * Per-model savings themselves are recorded in-process by the session (it is the
 * only side that knows which model made the call; see session.ts + savings.ts),
 * into the same local ledger `vg serve --savings` and `vg savings` use — so the
 * subprocess and the in-process recording never double-count.
 *
 * The spawner is injectable, so the lifecycle (spawn args, kill-on-dispose,
 * idempotent dispose, spawn-failure handling) is unit-tested without launching a
 * real process.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { detectServeLaunch } from '../install/registry.js';

export type SpawnLike = (command: string, args: string[], options: { cwd: string; stdio: 'ignore'; detached: boolean }) => ChildProcess;

export interface GraphProcessOptions {
  root: string;
  /** Client label the child attributes its activity to (default `vg-code`). */
  client?: string;
  /** Injectable spawn (defaults to node:child_process spawn). */
  spawnImpl?: SpawnLike;
  /** Injectable launch resolution (defaults to detectServeLaunch()). */
  launch?: { command: string; args: string[] };
}

/**
 * A managed `vg serve` child. `start` returns null (never throws) if the process
 * can't be spawned — VG Code degrades to using the in-process graph only, so a
 * spawn failure never breaks a coding session.
 */
export class GraphProcess {
  private child: ChildProcess | null;
  private disposed = false;
  readonly command: string;
  readonly args: string[];

  private constructor(child: ChildProcess, command: string, args: string[]) {
    this.child = child;
    this.command = command;
    this.args = args;
    // If the child dies on its own, forget it so dispose is a no-op.
    child.once('exit', () => {
      this.child = null;
    });
  }

  static start(options: GraphProcessOptions): GraphProcess | null {
    const launch = options.launch ?? detectServeLaunch();
    const client = options.client ?? 'vg-code';
    // `vg serve --client vg-code`: the map is served for the session, attributed
    // to VG Code. (No `--savings` here — the session records per-model savings
    // in-process, so enabling it on the child would double-count.)
    const args = [...launch.args, '--client', client];
    const spawnImpl = options.spawnImpl ?? (nodeSpawn as unknown as SpawnLike);
    try {
      const child = spawnImpl(launch.command, args, { cwd: options.root, stdio: 'ignore', detached: false });
      if (!child || typeof child.pid !== 'number') return null;
      child.on('error', () => {
        /* never let a child spawn/runtime error surface as an unhandled event */
      });
      return new GraphProcess(child, launch.command, args);
    } catch {
      return null;
    }
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** True while the child is believed to be running. */
  get running(): boolean {
    return this.child !== null && !this.disposed;
  }

  /** Kill the child. Idempotent and safe to call after the child already exited. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
