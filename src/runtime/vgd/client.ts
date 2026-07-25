import * as net from 'node:net';
import type { VgdRequest, VgdResponse } from './protocol.js';
import { vgdSocketPath } from './paths.js';

export interface VgdClientOptions {
  socketPath?: string;
  /** Connect timeout in ms (default 2000). */
  timeoutMs?: number;
}

/**
 * Send one request to a running vgd and return the parsed response.
 * Rejects if the daemon is not reachable.
 */
export function vgdRequest(request: VgdRequest, options: VgdClientOptions = {}): Promise<VgdResponse> {
  const socketPath = options.socketPath ?? vgdSocketPath();
  const timeoutMs = options.timeoutMs ?? 2000;

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
