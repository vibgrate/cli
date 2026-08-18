import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type * as net from 'node:net';
import { subscribeToSlots } from './slot-subscription.js';
import { startVgdServer } from './server.js';
import { vgdRequest } from './client.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VgGraph } from '../../schema.js';

/**
 * Push is the one thing that lets a server stop watching the filesystem
 * itself, so the property that matters is not "events arrive" but "the client
 * knows, at every moment, whether it is still responsible for watching".
 */

class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  setEncoding(): void {
    /* strings already */
  }
  write(line: string): boolean {
    this.written.push(line);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  /** Deliver a frame as the daemon would. */
  push(frame: unknown): void {
    this.emit('data', JSON.stringify(frame) + '\n');
  }
}

function fake(): { socket: FakeSocket; connect: (p: string) => net.Socket } {
  const socket = new FakeSocket();
  return {
    socket,
    connect: () => {
      queueMicrotask(() => socket.emit('connect'));
      return socket as unknown as net.Socket;
    },
  };
}

describe('subscribeToSlots', () => {
  it('reports active only once the daemon acknowledges', async () => {
    const { socket, connect } = fake();
    const pending = subscribeToSlots({ connect, onChange: () => {} });
    await new Promise((r) => setTimeout(r, 5));
    socket.push({ ok: true, watching: true });

    const sub = await pending;

    expect(sub.active).toBe(true);
    expect(JSON.parse(socket.written[0]!)).toMatchObject({ op: 'watch-slots' });
  });

  it('delivers slot changes with the corpus hash', async () => {
    const { socket, connect } = fake();
    const seen: unknown[] = [];
    const pending = subscribeToSlots({ connect, onChange: (c) => seen.push(c) });
    await new Promise((r) => setTimeout(r, 5));
    socket.push({ ok: true, watching: true });
    await pending;

    socket.push({ ok: true, event: 'slot-changed', repositoryId: 'r1', gitRef: 'main', nodeCount: 9, corpusHash: 'H' });

    expect(seen).toEqual([{ repositoryId: 'r1', gitRef: 'main', nodeCount: 9, corpusHash: 'H' }]);
  });

  it('is inactive — never silently "subscribed" — when no daemon answers', async () => {
    const { socket, connect } = fake();
    const pending = subscribeToSlots({ connect, onChange: () => {} });
    await new Promise((r) => setTimeout(r, 5));
    socket.emit('error', new Error('ECONNREFUSED'));

    const sub = await pending;

    expect(sub.active).toBe(false);
  });

  it('tells the caller to resume watching when the connection drops', async () => {
    const { socket, connect } = fake();
    const detached: string[] = [];
    const pending = subscribeToSlots({ connect, onChange: () => {}, onDetach: (r) => detached.push(r) });
    await new Promise((r) => setTimeout(r, 5));
    socket.push({ ok: true, watching: true });
    const sub = await pending;
    expect(sub.active).toBe(true);

    socket.emit('close');

    expect(sub.active).toBe(false);
    expect(detached).toEqual(['connection closed']);
  });

  it('does not report a detachment for a deliberate close', async () => {
    const { socket, connect } = fake();
    const detached: string[] = [];
    const pending = subscribeToSlots({ connect, onChange: () => {}, onDetach: (r) => detached.push(r) });
    await new Promise((r) => setTimeout(r, 5));
    socket.push({ ok: true, watching: true });
    const sub = await pending;

    sub.close();
    socket.emit('close');

    expect(detached).toEqual([]);
  });

  it('survives a corrupt frame in the stream', async () => {
    const { socket, connect } = fake();
    const seen: unknown[] = [];
    const pending = subscribeToSlots({ connect, onChange: (c) => seen.push(c) });
    await new Promise((r) => setTimeout(r, 5));
    socket.push({ ok: true, watching: true });
    await pending;

    socket.emit('data', 'not json at all\n');
    socket.push({ ok: true, event: 'slot-changed', repositoryId: 'r1', gitRef: 'main', nodeCount: 1, corpusHash: null });

    expect(seen).toHaveLength(1);
  });
});

describe('watch-slots against a real daemon', () => {
  const graph = (n: number): VgGraph =>
    ({
      nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, name: `s${i}`, qualifiedName: `p.s${i}`, kind: 'function', file: 'a.ts' })),
      edges: [],
      areas: [],
      provenance: { corpusHash: `hash-${n}` },
    }) as unknown as VgGraph;

  it('pushes a frame to a subscriber when a map is published', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgd-sub-'));
    const socketPath = path.join(dir, 'vgd.sock');
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
    try {
      const changes: Array<{ repositoryId: string; nodeCount: number }> = [];
      const sub = await subscribeToSlots({
        socketPath,
        onChange: (c) => changes.push({ repositoryId: c.repositoryId, nodeCount: c.nodeCount }),
      });
      expect(sub.active).toBe(true);

      await vgdRequest({ op: 'put-graph', repositoryId: 'repo1', gitRef: 'main', graph: graph(4) }, { socketPath });
      await new Promise((r) => setTimeout(r, 60));

      expect(changes).toEqual([{ repositoryId: 'repo1', nodeCount: 4 }]);
      sub.close();
    } finally {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only pushes the repository a filtered subscriber asked for', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgd-sub-b-'));
    const socketPath = path.join(dir, 'vgd.sock');
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid'), watch: false });
    try {
      const changes: string[] = [];
      const sub = await subscribeToSlots({
        socketPath,
        repositoryId: 'repo1',
        onChange: (c) => changes.push(c.repositoryId),
      });
      expect(sub.active).toBe(true);

      await vgdRequest({ op: 'put-graph', repositoryId: 'other', gitRef: 'main', graph: graph(2) }, { socketPath });
      await vgdRequest({ op: 'put-graph', repositoryId: 'repo1', gitRef: 'main', graph: graph(3) }, { socketPath });
      await new Promise((r) => setTimeout(r, 60));

      expect(changes).toEqual(['repo1']);
      sub.close();
    } finally {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
