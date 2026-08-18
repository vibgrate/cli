import * as net from 'node:net';
import { vgdSocketPath } from './paths.js';

/**
 * A long-lived connection that the daemon pushes slot changes down.
 *
 * This is what lets a server stop watching the filesystem itself. `vg serve`
 * and `vg lsp` each ran a recursive `fs.watch` over the whole workspace and
 * their own `RefreshScheduler` on top of it — three processes noticing the
 * same edit, three inotify registrations over the same tree, three incremental
 * rebuilds racing for the same lock. The daemon already does all of it; the
 * only thing missing was a way to tell anyone.
 *
 * Standing down is conditional, and the condition is checked rather than
 * assumed: a subscriber only retires its own watcher once the daemon has
 * confirmed the subscription, and it restarts it the moment the connection
 * drops. A daemon that dies must degrade a client to "watches for itself
 * again", never to "nothing is watching".
 */

export interface SlotChange {
  repositoryId: string;
  gitRef: string;
  nodeCount: number;
  corpusHash: string | null;
}

export interface SlotSubscriptionOptions {
  socketPath?: string;
  /** Only hear about this repository. Omit for every repository. */
  repositoryId?: string;
  /** Called for each pushed change. */
  onChange: (change: SlotChange) => void;
  /**
   * Called when the connection ends for any reason. The subscriber must treat
   * this as "you are watching for yourself again".
   */
  onDetach?: (reason: string) => void;
  log?: (message: string) => void;
  /** Injected (tests). */
  connect?: (socketPath: string) => net.Socket;
}

export interface SlotSubscription {
  /** True once the daemon has acknowledged; false means watch for yourself. */
  readonly active: boolean;
  close(): void;
}

/**
 * Open a subscription. Resolves once the daemon has acknowledged it, or with
 * `active: false` when no daemon answered — never throws, and never leaves the
 * caller unsure whether it must keep watching.
 */
export function subscribeToSlots(options: SlotSubscriptionOptions): Promise<SlotSubscription> {
  const socketPath = options.socketPath ?? vgdSocketPath();
  const log = options.log ?? ((): void => {});
  const connect = options.connect ?? ((p: string) => net.createConnection(p));

  return new Promise<SlotSubscription>((resolve) => {
    let settled = false;
    let active = false;
    let closed = false;
    let buffer = '';
    let socket: net.Socket;

    const handle: SlotSubscription = {
      get active() {
        return active;
      },
      close() {
        closed = true;
        active = false;
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
      },
    };

    const detach = (reason: string): void => {
      const wasActive = active;
      active = false;
      if (!settled) {
        settled = true;
        resolve(handle);
      }
      // A deliberate close is not a detachment the caller must react to.
      if (wasActive && !closed) {
        log(`watch-slots: subscription ended (${reason}) — watching locally again`);
        options.onDetach?.(reason);
      }
    };

    try {
      socket = connect(socketPath);
    } catch (e) {
      detach(e instanceof Error ? e.message : String(e));
      return;
    }

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify({ op: 'watch-slots', repositoryId: options.repositoryId }) + '\n');
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // a corrupt frame is not fatal to the stream
        }
        if (frame.watching === true) {
          active = true;
          if (!settled) {
            settled = true;
            log(`watch-slots: subscribed${options.repositoryId ? ` to ${options.repositoryId}` : ''}`);
            resolve(handle);
          }
          continue;
        }
        if (frame.event === 'slot-changed' && typeof frame.repositoryId === 'string') {
          options.onChange({
            repositoryId: frame.repositoryId,
            gitRef: typeof frame.gitRef === 'string' ? frame.gitRef : 'HEAD',
            nodeCount: typeof frame.nodeCount === 'number' ? frame.nodeCount : 0,
            corpusHash: typeof frame.corpusHash === 'string' ? frame.corpusHash : null,
          });
          continue;
        }
        // An error reply to the subscribe itself: this listener cannot push.
        if (frame.ok === false && !settled) detach(String(frame.error ?? 'subscription refused'));
      }
    });
    socket.on('error', (err: Error) => detach(err.message));
    socket.on('close', () => detach('connection closed'));
  });
}
