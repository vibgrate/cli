import * as net from 'node:net';
import type { VgdRequest, VgdResponse } from './protocol.js';
import { vgdSocketPath } from './paths.js';

export interface VgdClientOptions {
  socketPath?: string;
  /** End-to-end response timeout in ms (default: per-op, see {@link defaultVgdTimeoutMs}). */
  timeoutMs?: number;
}

/**
 * Default response timeout per operation.
 *
 * The timer spans the whole round trip — writing the request, the daemon
 * handling it, and the reply. Liveness probes must fail fast, but a flat 2s
 * default guaranteed false "vgd did not respond" failures on large repos:
 * `put-graph` ships the entire code map as one JSON line (tens of MB for a
 * 40k-file workspace), and the single-threaded daemon needs seconds to read
 * and store it. Ops that ride on a busy daemon's event loop get headroom too.
 */
export function defaultVgdTimeoutMs(op: VgdRequest['op']): number {
  switch (op) {
    case 'ping':
    case 'status':
      return 2000; // liveness probes — fail fast
    case 'put-graph':
    case 'load-graph':
    case 'host-load':
      return 120_000; // large payload / disk load / model load
    case 'host-generate':
      return 300_000; // local model generation
    case 'embed-index':
    case 'embed-rank':
      // First ask on a large repo may have to wait for the slot index (or for
      // a `vg embed` child that already holds the cache lock). 10s made
      // `vg ask` give up and re-embed tens of thousands of nodes in-process.
      return 600_000;
    default:
      return 10_000; // registry + graph queries — may queue behind a put-graph
  }
}

/**
 * Send one request to a running vgd and return the parsed response.
 * Rejects if the daemon is not reachable.
 */
export function vgdRequest(request: VgdRequest, options: VgdClientOptions = {}): Promise<VgdResponse> {
  const socketPath = options.socketPath ?? vgdSocketPath();
  const timeoutMs = options.timeoutMs ?? defaultVgdTimeoutMs(request.op);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let buffer = '';

    const finish = (err?: Error, value?: VgdResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value!);
    };

    const timer = setTimeout(() => finish(new Error(`vgd did not respond within ${timeoutMs}ms`)), timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl).trim();
      try {
        finish(undefined, JSON.parse(line) as VgdResponse);
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });
    socket.on('error', (err) => finish(err));
    socket.on('end', () => {
      if (!settled) finish(new Error('vgd closed the connection before responding'));
    });
  });
}

/** True when a local vgd answers ping. */
export async function vgdIsRunning(options: VgdClientOptions = {}): Promise<boolean> {
  try {
    const res = await vgdRequest({ op: 'ping' }, options);
    return res.ok === true && 'pong' in res && res.pong === true;
  } catch {
    return false;
  }
}
