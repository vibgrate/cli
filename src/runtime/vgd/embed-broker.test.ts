import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { EmbedBroker } from './embed-broker.js';
import { WorkspaceRegistry } from './registry.js';
import type { VgGraph } from '../../schema.js';

/** A scriptable stand-in for the worker child. */
class FakeWorker extends EventEmitter {
  pid = 4242;
  written: string[] = [];
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    write: (line: string): boolean => {
      this.written.push(line);
      const req = JSON.parse(line) as { id: number; texts: string[] };
      if (this.mode === 'answer') {
        // One deterministic vector per text so assertions can count them.
        queueMicrotask(() =>
          this.reply({ id: req.id, ok: true, op: 'embed', vectors: req.texts.map((_, i) => [i, 1, 2]) }),
        );
      } else if (this.mode === 'error') {
        queueMicrotask(() => this.reply({ id: req.id, ok: false, error: 'backend unavailable' }));
      } else if (this.mode === 'crash') {
        queueMicrotask(() => this.die('SIGTRAP'));
      }
      return true;
    },
  };
  mode: 'answer' | 'error' | 'crash' | 'silent' = 'answer';
  killed = false;

  reply(res: unknown): void {
    this.stdout.emit('data', JSON.stringify(res) + '\n');
  }
  die(signal: NodeJS.Signals | null, code: number | null = null): void {
    this.emit('exit', code, signal);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  // The broker only calls setEncoding on the streams.
  setEncoding(): void {
    /* streams are already strings in the fake */
  }
}

function fakeChild(): { worker: FakeWorker; child: ChildProcess } {
  const worker = new FakeWorker();
  (worker.stdout as unknown as { setEncoding: () => void }).setEncoding = () => {};
  (worker.stderr as unknown as { setEncoding: () => void }).setEncoding = () => {};
  return { worker, child: worker as unknown as ChildProcess };
}

function graph(nodeCount: number, prefix = 'n'): VgGraph {
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: `${prefix}${i}`,
      name: `sym${i}`,
      qualifiedName: `pkg.sym${i}`,
      kind: 'function',
      file: `src/f${i}.ts`,
      line: 1,
    })),
    edges: [],
  } as unknown as VgGraph;
}

function brokerWith(worker: () => ChildProcess, log: string[] = []) {
  return new EmbedBroker({ spawnWorker: worker, log: (m) => log.push(m), requestTimeoutMs: 500 });
}

describe('EmbedBroker — index building', () => {
  it('builds a per-slot index and reports it ready', async () => {
    const { child } = fakeChild();
    const logs: string[] = [];
    const broker = brokerWith(() => child, logs);

    const idx = await broker.ensureIndex('repoA', 'main', graph(3));
    expect(idx.state).toBe('ready');
    expect(idx.vectors.size).toBe(3);
    expect(logs.some((l) => l.includes('index ready for repoA@main'))).toBe(true);
  });

  it('keeps separate indexes per ref and never mixes them', async () => {
    const { child } = fakeChild();
    const broker = brokerWith(() => child);

    await broker.ensureIndex('repoA', 'main', graph(2, 'm'));
    await broker.ensureIndex('repoA', 'feature', graph(5, 'f'));

    expect(broker.slot('repoA', 'main')?.vectors.size).toBe(2);
    expect(broker.slot('repoA', 'feature')?.vectors.size).toBe(5);
    expect([...(broker.slot('repoA', 'main')?.vectors.keys() ?? [])].every((k) => k.startsWith('m'))).toBe(true);
    expect([...(broker.slot('repoA', 'feature')?.vectors.keys() ?? [])].every((k) => k.startsWith('f'))).toBe(true);
  });

  it('does not rebuild an index that is already ready', async () => {
    const { worker, child } = fakeChild();
    const broker = brokerWith(() => child);
    await broker.ensureIndex('repoA', 'main', graph(2));
    const writes = worker.written.length;
    await broker.ensureIndex('repoA', 'main', graph(2));
    expect(worker.written.length).toBe(writes);
  });
});

describe('EmbedBroker — the index follows the graph slot', () => {
  it('invalidates on republish: new graph, no stale vectors', async () => {
    const { child } = fakeChild();
    const logs: string[] = [];
    const broker = brokerWith(() => child, logs);

    await broker.ensureIndex('repoA', 'main', graph(3));
    expect(broker.slot('repoA', 'main')?.state).toBe('ready');

    broker.onGraphPut('repoA', 'main', graph(4));
    const after = broker.slot('repoA', 'main');
    expect(after?.state).toBe('stale');
    expect(after?.vectors.size).toBe(0);
    expect(logs.some((l) => l.includes('graph republished'))).toBe(true);
  });

  it('drops the index when the graph slot is evicted', async () => {
    const { child } = fakeChild();
    const broker = brokerWith(() => child);
    await broker.ensureIndex('repoA', 'main', graph(2));
    broker.onGraphEvict('repoA', 'main');
    expect(broker.slot('repoA', 'main')).toBeUndefined();
  });

  it('warms the newly current slot on select, in the background', async () => {
    const { child } = fakeChild();
    const logs: string[] = [];
    const broker = brokerWith(() => child, logs);
    broker.setGraphProvider((_repo, ref) => (ref === 'feature' ? graph(2, 'f') : graph(1, 'm')));

    broker.onGraphSelect('repoA', 'feature');
    await new Promise((r) => setTimeout(r, 20));

    expect(broker.slot('repoA', 'feature')?.state).toBe('ready');
    expect(logs.some((l) => l.includes('current slot → repoA@feature'))).toBe(true);
  });

  it('is driven by the registry, so put/select/evict cannot diverge', async () => {
    const { child } = fakeChild();
    const broker = brokerWith(() => child);
    const registry = new WorkspaceRegistry();
    registry.setSlotListener(broker);
    broker.setGraphProvider((repositoryId, gitRef) => registry.graphs.get(repositoryId, gitRef)?.graph);

    registry.putGraph('repoA', 'main', graph(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(broker.slot('repoA', 'main')?.state).toBe('ready');

    // Evicting the graph through the cache must take the index with it.
    registry.graphs.clear();
    expect(broker.slot('repoA', 'main')).toBeUndefined();
  });
});

describe('EmbedBroker — graceful degradation', () => {
  it('returns a failed index (never throws) when the worker errors', async () => {
    const { worker, child } = fakeChild();
    worker.mode = 'error';
    const logs: string[] = [];
    const broker = brokerWith(() => child, logs);

    const idx = await broker.ensureIndex('repoA', 'main', graph(2));
    expect(idx.state).toBe('failed');
    expect(idx.error).toMatch(/backend unavailable/);
    expect(logs.some((l) => l.includes('fall back to lexical'))).toBe(true);
  });

  it('returns null from embedQuery instead of throwing', async () => {
    const { worker, child } = fakeChild();
    worker.mode = 'error';
    const broker = brokerWith(() => child);
    await expect(broker.embedQuery('where is billing')).resolves.toBeNull();
  });

  it('gives up after repeated worker crashes and stays lexical', async () => {
    const logs: string[] = [];
    const children: FakeWorker[] = [];
    const broker = new EmbedBroker({
      log: (m) => logs.push(m),
      maxCrashes: 2,
      requestTimeoutMs: 300,
      spawnWorker: () => {
        const { worker, child } = fakeChild();
        worker.mode = 'crash';
        children.push(worker);
        return child;
      },
    });

    await broker.ensureIndex('repoA', 'main', graph(1));
    await broker.ensureIndex('repoA', 'other', graph(1));

    expect(broker.unavailable()).toBe(true);
    expect(children.length).toBe(2);
    expect(logs.some((l) => l.includes('semantic search is off for this daemon'))).toBe(true);
    // Everything after the give-up resolves as unavailable, never hangs.
    await expect(broker.embedQuery('x')).resolves.toBeNull();
    const idx = await broker.ensureIndex('repoA', 'third', graph(1));
    expect(idx.state).toBe('failed');
  });

  it('fails in-flight requests when the worker dies mid-build', async () => {
    const { worker, child } = fakeChild();
    worker.mode = 'silent';
    const broker = brokerWith(() => child);
    const pending = broker.ensureIndex('repoA', 'main', graph(2));
    await new Promise((r) => setTimeout(r, 5));
    worker.die('SIGKILL');
    const idx = await pending;
    expect(idx.state).toBe('failed');
    expect(idx.error).toMatch(/SIGKILL/);
  });

  it('times out a silent worker rather than hanging a caller', async () => {
    const { worker, child } = fakeChild();
    worker.mode = 'silent';
    const broker = brokerWith(() => child);
    const idx = await broker.ensureIndex('repoA', 'main', graph(1));
    expect(idx.state).toBe('failed');
    expect(idx.error).toMatch(/timed out/);
  });

  it('stops the worker on shutdown so no child is orphaned', async () => {
    const { worker, child } = fakeChild();
    const broker = brokerWith(() => child);
    await broker.ensureIndex('repoA', 'main', graph(1));
    broker.stop();
    expect(worker.killed).toBe(true);
  });
});

describe('EmbedBroker — status', () => {
  it('reports worker state and per-slot index rows', async () => {
    const { child } = fakeChild();
    const broker = brokerWith(() => child);
    await broker.ensureIndex('repoA', 'main', graph(2));
    const status = broker.status();
    expect(status.worker).toBe('ready');
    expect(status.slots).toHaveLength(1);
    expect(status.slots[0]).toMatchObject({ repositoryId: 'repoA', gitRef: 'main', state: 'ready', vectors: 2 });
  });
});

describe('EmbedBroker — worker that cannot start', () => {
  it('counts a failed spawn against the crash budget and settles on lexical', async () => {
    const logs: string[] = [];
    const broker = new EmbedBroker({
      log: (m) => logs.push(m),
      maxCrashes: 2,
      spawnWorker: () => {
        throw new Error('embedding worker not found at /dist/embed-worker-main.js');
      },
    });
    const first = await broker.ensureIndex('repoA', 'main', graph(1));
    expect(first.state).toBe('failed');
    expect(broker.unavailable()).toBe(false);

    const second = await broker.ensureIndex('repoA', 'other', graph(1));
    expect(second.state).toBe('failed');
    expect(broker.unavailable()).toBe(true);
    expect(logs.some((l) => l.includes('semantic search is off for this daemon'))).toBe(true);
  });
});
