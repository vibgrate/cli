import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { EmbedBroker } from './embed-broker.js';
import type { VgGraph } from '../../schema.js';

/**
 * Ranking happens in the daemon because the alternative — shipping the slot's
 * vectors to every caller — is the thing holding them centrally was meant to
 * avoid. These cover the contract callers depend on: a usable ranking, or null
 * so they fall back to their own in-process pass.
 */

/** Answers each text with a vector pointing at a fixed axis, by text order. */
class AxisWorker extends EventEmitter {
  pid = 7;
  embedCalls = 0;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    write: (line: string): boolean => {
      this.embedCalls++;
      const req = JSON.parse(line) as { id: number; texts: string[]; query?: boolean };
      // Documents get one-hot vectors by index; a query gets the axis it names.
      const vectors = req.texts.map((t, i) => (req.query ? axisFor(t) : oneHot(i)));
      queueMicrotask(() =>
        this.stdout.emit('data', JSON.stringify({ id: req.id, ok: true, op: 'embed', vectors }) + '\n'),
      );
      return true;
    },
  };
  kill(): boolean {
    return true;
  }
}

const DIMS = 4;
function oneHot(i: number): number[] {
  return Array.from({ length: DIMS }, (_, d) => (d === i % DIMS ? 1 : 0));
}
function axisFor(text: string): number[] {
  const n = Number.parseInt(text.replace(/\D/g, ''), 10);
  return oneHot(Number.isFinite(n) ? n : 0);
}

function fakeChild(): { worker: AxisWorker; child: ChildProcess } {
  const worker = new AxisWorker();
  (worker.stdout as unknown as { setEncoding: () => void }).setEncoding = () => {};
  (worker.stderr as unknown as { setEncoding: () => void }).setEncoding = () => {};
  return { worker, child: worker as unknown as ChildProcess };
}

function graph(n: number): VgGraph {
  return {
    nodes: Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      name: `sym${i}`,
      qualifiedName: `pkg.sym${i}`,
      kind: 'function',
      file: `src/f${i}.ts`,
      line: 1,
    })),
    edges: [],
    areas: [],
  } as unknown as VgGraph;
}

describe('EmbedBroker.rank', () => {
  it('ranks the slot by cosine and puts the matching node first', async () => {
    const { child } = fakeChild();
    const broker = new EmbedBroker({ spawnWorker: () => child, requestTimeoutMs: 500 });
    await broker.ensureIndex('repoA', 'main', graph(4));

    const result = await broker.rank('repoA', 'main', 'axis 2');

    expect(result).not.toBeNull();
    expect(result!.ranked[0]?.id).toBe('n2');
    expect(result!.ranked[0]?.score).toBeCloseTo(1, 5);
    expect(result!.vectors).toBe(4);
    expect(result!.state).toBe('ready');
  });

  it('drops zero-similarity nodes rather than padding the list', async () => {
    const { child } = fakeChild();
    const broker = new EmbedBroker({ spawnWorker: () => child, requestTimeoutMs: 500 });
    await broker.ensureIndex('repoA', 'main', graph(4));

    const result = await broker.rank('repoA', 'main', 'axis 1');

    // One-hot vectors: only the matching axis has non-zero cosine.
    expect(result!.ranked).toHaveLength(1);
    expect(result!.ranked[0]?.id).toBe('n1');
  });

  it('honours the limit, keeping the strongest candidates', async () => {
    const { child } = fakeChild();
    const broker = new EmbedBroker({ spawnWorker: () => child, requestTimeoutMs: 500 });
    // 8 nodes over 4 axes → two nodes share every axis.
    await broker.ensureIndex('repoA', 'main', graph(8));

    const result = await broker.rank('repoA', 'main', 'axis 3', 1);

    expect(result!.ranked).toHaveLength(1);
    expect(['n3', 'n7']).toContain(result!.ranked[0]?.id);
  });

  it('still ranks a stale slot that kept its vectors after republish', async () => {
    const { child } = fakeChild();
    const broker = new EmbedBroker({ spawnWorker: () => child, requestTimeoutMs: 500 });
    await broker.ensureIndex('repoA', 'main', graph(4));

    broker.onGraphPut('repoA', 'main', graph(4));
    expect(broker.slot('repoA', 'main')?.state).toBe('stale');

    const result = await broker.rank('repoA', 'main', 'axis 2');

    expect(result).not.toBeNull();
    expect(result!.ranked[0]?.id).toBe('n2');
    expect(result!.state).toBe('stale');
  });

  it('returns null for a slot with no index, so the caller ranks locally', async () => {
    const { worker, child } = fakeChild();
    const broker = new EmbedBroker({ spawnWorker: () => child, requestTimeoutMs: 500 });

    expect(await broker.rank('never-published', 'main', 'anything')).toBeNull();
    expect(worker.embedCalls).toBe(0);
  });

  it('returns null when the worker cannot embed the question', async () => {
    const { child } = fakeChild();
    const broker = new EmbedBroker({ spawnWorker: () => child, requestTimeoutMs: 500 });
    await broker.ensureIndex('repoA', 'main', graph(3));

    // Break the worker only after the index exists, so the failure is the query.
    (child as unknown as { stdin: { write: () => boolean } }).stdin.write = () => {
      throw new Error('worker gone');
    };

    expect(await broker.rank('repoA', 'main', 'axis 0')).toBeNull();
  });

  it('is deterministic when scores tie', async () => {
    const { child } = fakeChild();
    const broker = new EmbedBroker({ spawnWorker: () => child, requestTimeoutMs: 500 });
    await broker.ensureIndex('repoA', 'main', graph(8));

    const a = await broker.rank('repoA', 'main', 'axis 0');
    const b = await broker.rank('repoA', 'main', 'axis 0');

    expect(a!.ranked.map((r) => r.id)).toEqual(b!.ranked.map((r) => r.id));
    expect(a!.ranked.map((r) => r.id)).toEqual(['n0', 'n4']);
  });
});
