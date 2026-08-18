import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { EmbedBroker } from './embed-broker.js';
import { getNodeEmbeddings, type Embedder } from '../../engine/embeddings.js';
import type { VgGraph } from '../../schema.js';

/**
 * The daemon's slot index and the on-disk index are the same index. These
 * cover the half that was missing: vgd re-derived vectors the disk cache
 * already held (over a different embed-text, so they were not even the same
 * vectors), which is what made a `vg build` warm-up and a vgd warm race each
 * other over the identical work.
 */

class FakeWorker extends EventEmitter {
  pid = 99;
  calls = 0;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    write: (line: string): boolean => {
      this.calls++;
      const req = JSON.parse(line) as { id: number; texts: string[] };
      queueMicrotask(() =>
        this.stdout.emit(
          'data',
          JSON.stringify({ id: req.id, ok: true, op: 'embed', vectors: req.texts.map(() => [9, 9, 9]) }) + '\n',
        ),
      );
      return true;
    },
  };
  kill(): boolean {
    return true;
  }
}

function fakeChild(): { worker: FakeWorker; child: ChildProcess } {
  const worker = new FakeWorker();
  (worker.stdout as unknown as { setEncoding: () => void }).setEncoding = () => {};
  (worker.stderr as unknown as { setEncoding: () => void }).setEncoding = () => {};
  return { worker, child: worker as unknown as ChildProcess };
}

/** Must match `resolveEmbedModel()` — the cache header records the model id. */
const MODEL = 'bge-small-en-v1.5';

const fakeEmbedder: Embedder = {
  id: MODEL,
  embed: (texts) => Promise.resolve(texts.map((_, i) => [1, i, 2])),
  embedQuery: () => Promise.resolve([1, 0, 2]),
};

function graph(nodeCount: number): VgGraph {
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
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

let root: string;
let prevInRepo: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgd-seed-'));
  fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
  prevInRepo = process.env.VIBGRATE_GRAPH_IN_REPO;
  // Keep every artifact inside the temp root, never the user's global store.
  process.env.VIBGRATE_GRAPH_IN_REPO = '1';
});

afterEach(() => {
  if (prevInRepo === undefined) delete process.env.VIBGRATE_GRAPH_IN_REPO;
  else process.env.VIBGRATE_GRAPH_IN_REPO = prevInRepo;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('EmbedBroker — reuse of the on-disk index', () => {
  it('seeds a slot from vectors `vg embed` already wrote, without touching the worker', async () => {
    const g = graph(4);
    await getNodeEmbeddings(g, fakeEmbedder, root);

    const { worker, child } = fakeChild();
    const logs: string[] = [];
    const broker = new EmbedBroker({ spawnWorker: () => child, log: (m) => logs.push(m), requestTimeoutMs: 500 });
    broker.setRootProvider(() => root);

    const idx = await broker.ensureIndex('repoA', 'main', g);

    expect(idx.state).toBe('ready');
    expect(idx.vectors.size).toBe(4);
    expect(worker.calls).toBe(0);
    expect(logs.some((l) => l.includes('seeded repoA@main from the on-disk index'))).toBe(true);
  });

  it('embeds only what the disk cache is missing', async () => {
    const cached = graph(2);
    await getNodeEmbeddings(cached, fakeEmbedder, root);

    const { worker, child } = fakeChild();
    const broker = new EmbedBroker({ spawnWorker: () => child, requestTimeoutMs: 500 });
    broker.setRootProvider(() => root);

    // Same repo, two more symbols than the cache covers.
    const idx = await broker.ensureIndex('repoA', 'main', graph(5));

    expect(idx.state).toBe('ready');
    expect(idx.vectors.size).toBe(5);
    // One batch, carrying the three uncached nodes — not all five.
    expect(worker.calls).toBe(1);
  });

  it('stands down while another process is writing the cache, and says so', async () => {
    const g = graph(3);
    // The lock `vg embed` holds while it writes this repo's vectors.
    const { embeddingsPath } = await import('../../engine/embeddings.js');
    const lock = `${embeddingsPath(root)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));

    const { worker, child } = fakeChild();
    const logs: string[] = [];
    const broker = new EmbedBroker({ spawnWorker: () => child, log: (m) => logs.push(m), requestTimeoutMs: 500 });
    broker.setRootProvider(() => root);

    const idx = await broker.ensureIndex('repoA', 'main', g);

    expect(worker.calls).toBe(0);
    expect(idx.state).not.toBe('ready');
    expect(idx.pending).toBe(3);
    expect(logs.some((l) => l.includes('another process is writing the on-disk index'))).toBe(true);

    // Once the writer is gone the same slot warms on the next request.
    fs.rmSync(lock, { force: true });
    const again = await broker.ensureIndex('repoA', 'main', g);
    expect(again.state).toBe('ready');
    expect(again.vectors.size).toBe(3);
  });

  it('waits for the on-disk writer when a blocking caller asks', async () => {
    const g = graph(3);
    const { embeddingsPath } = await import('../../engine/embeddings.js');
    const lock = `${embeddingsPath(root)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));

    const { worker, child } = fakeChild();
    const logs: string[] = [];
    const broker = new EmbedBroker({
      spawnWorker: () => child,
      log: (m) => logs.push(m),
      requestTimeoutMs: 500,
      sleep: async () => {
        fs.rmSync(lock, { force: true });
        await getNodeEmbeddings(g, fakeEmbedder, root);
      },
    });
    broker.setRootProvider(() => root);

    const idx = await broker.ensureIndex('repoA', 'main', g, { waitForWriter: true });

    expect(idx.state).toBe('ready');
    expect(idx.vectors.size).toBe(3);
    expect(worker.calls).toBe(0);
    expect(logs.some((l) => l.includes('waiting for another process'))).toBe(true);
  });

  it('builds from scratch when the daemon has no root for the repository', async () => {
    const { worker, child } = fakeChild();
    const broker = new EmbedBroker({ spawnWorker: () => child, requestTimeoutMs: 500 });

    const idx = await broker.ensureIndex('synthetic', 'main', graph(2));

    expect(idx.state).toBe('ready');
    expect(idx.vectors.size).toBe(2);
    expect(worker.calls).toBe(1);
  });
});
