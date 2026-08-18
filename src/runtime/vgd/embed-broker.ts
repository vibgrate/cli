/**
 * Semantic warm inside vgd (docs/VGD-SEMANTIC-WARM-SPEC.md).
 *
 * vgd already keeps the code map warm per repo-and-ref and local LLM weights
 * warm per path. The embedding model and the vector index were the gap: every
 * consumer — `vg lsp`, `vg code`, the CLI — loaded its own copy, so
 * `vg daemon status` could report a warm graph slot while the editor announced
 * "warming semantic search" on a fresh process, again.
 *
 * Two invariants shape everything here.
 *
 * **The addon lives in a child.** {@link EmbedBroker} never imports the
 * embedding backend; it talks NDJSON to `embed-worker.ts`. The backend can
 * abort its process (see `engine/embed-health.ts`) and no try/catch survives a
 * signal — so the worst case must be a dead worker vgd can restart, not a dead
 * daemon. A worker that dies repeatedly is given up on, and every caller falls
 * back to lexical exactly as it does when vgd is absent.
 *
 * **The index follows the graph slot.** Vectors are keyed by the same
 * `(repositoryId, gitRef)` slot key the graph uses, and the cache's eviction
 * hook drops them together. A branch switch selects a different index the same
 * moment it selects a different graph; a re-published graph invalidates the
 * vectors for exactly that slot and nothing else. Ranking against vectors that
 * belong to another ref would be a silent correctness bug, so the two are
 * never allowed to drift apart.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { activeGraphSlotKey } from '../git-ref.js';
// Pure helpers only: `embeddings.ts` loads the native backend lazily, inside
// `loadEmbedder`, so importing the target/cache side of it here does not pull
// the addon into the daemon. The worker remains the only thing that loads it.
import { cosine, embedTargets, readCachedVectors, type EmbedTarget } from '../../engine/embeddings.js';
import type { VgGraph } from '../../schema.js';

/** How a slot's index is doing — surfaced by `embed-status` and the daemon log. */
export type SlotIndexState = 'absent' | 'building' | 'ready' | 'stale' | 'failed';

export interface SlotIndex {
  repositoryId: string;
  gitRef: string;
  state: SlotIndexState;
  /** nodeId → vector. Empty until the first build completes. */
  vectors: Map<string, number[]>;
  nodeCount: number;
  /** Targets still missing a vector — non-zero on a slot that stopped short. */
  pending?: number;
  builtAt?: number;
  buildMs?: number;
  error?: string;
}

export interface SlotIndexSummary {
  repositoryId: string;
  gitRef: string;
  state: SlotIndexState;
  vectors: number;
  nodeCount: number;
  pending?: number;
  builtAt?: number;
  buildMs?: number;
  error?: string;
}

export interface EmbedBrokerStatus {
  /** Worker process state. */
  worker: 'stopped' | 'starting' | 'ready' | 'unavailable';
  pid?: number;
  model?: string;
  /** Consecutive worker deaths; at the cap the broker stops restarting. */
  crashes: number;
  reason?: string;
  slots: SlotIndexSummary[];
}

export type EmbedBrokerLog = (message: string) => void;

export interface EmbedBrokerOptions {
  /** Diagnostic sink — the daemon's log. */
  log?: EmbedBrokerLog;
  /** Injected worker spawn (tests). */
  spawnWorker?: () => ChildProcess;
  /** Consecutive crashes tolerated before the broker gives up (default 3). */
  maxCrashes?: number;
  /** Per-request timeout in ms (default 120s — a cold model load is slow). */
  requestTimeoutMs?: number;
  /** Documents per embed request (default 256). */
  batchSize?: number;
  now?: () => number;
}

interface Pending {
  resolve: (vectors: number[][]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EmbedBroker {
  private child: ChildProcess | null = null;
  private starting = false;
  private gaveUp = false;
  private crashes = 0;
  private reason: string | undefined;
  private model: string | undefined;
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, Pending>();
  private readonly indexes = new Map<string, SlotIndex>();
  /** Slot keys with a build in flight, so warms are not duplicated. */
  private readonly building = new Set<string>();
  /** The slot most recently made current — logged on change. */
  private currentKey: string | undefined;
  private graphProvider?: (repositoryId: string, gitRef: string) => VgGraph | undefined;
  private rootProvider?: (repositoryId: string) => string | undefined;

  private readonly log: EmbedBrokerLog;
  private readonly spawnWorker: () => ChildProcess;
  private readonly maxCrashes: number;
  private readonly requestTimeoutMs: number;
  private readonly batchSize: number;
  private readonly now: () => number;

  constructor(options: EmbedBrokerOptions = {}) {
    this.log = options.log ?? ((): void => {});
    this.spawnWorker = options.spawnWorker ?? defaultSpawnWorker;
    this.maxCrashes = options.maxCrashes ?? 3;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.batchSize = options.batchSize ?? 256;
    this.now = options.now ?? ((): number => Date.now());
  }

  status(): EmbedBrokerStatus {
    return {
      worker: this.gaveUp ? 'unavailable' : this.child ? 'ready' : this.starting ? 'starting' : 'stopped',
      pid: this.child?.pid,
      model: this.model,
      crashes: this.crashes,
      reason: this.reason,
      slots: this.listSlots(),
    };
  }

  listSlots(repositoryId?: string): SlotIndexSummary[] {
    const out: SlotIndexSummary[] = [];
    for (const idx of this.indexes.values()) {
      if (repositoryId && idx.repositoryId !== repositoryId) continue;
      out.push({
        repositoryId: idx.repositoryId,
        gitRef: idx.gitRef,
        state: idx.state,
        vectors: idx.vectors.size,
        nodeCount: idx.nodeCount,
        pending: idx.pending,
        builtAt: idx.builtAt,
        buildMs: idx.buildMs,
        error: idx.error,
      });
    }
    return out.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.gitRef.localeCompare(b.gitRef));
  }

  slot(repositoryId: string, gitRef: string): SlotIndex | undefined {
    return this.indexes.get(activeGraphSlotKey(repositoryId, gitRef));
  }

  /** True once the broker has stopped trying — callers should go lexical. */
  unavailable(): boolean {
    return this.gaveUp;
  }

  /**
   * A graph slot was published or replaced. The vectors for that slot no
   * longer describe its graph, so they are dropped and a rebuild is queued.
   * Called from the same funnel that stores the graph, so the two can never
   * disagree about which ref they belong to.
   */
  onGraphPut(repositoryId: string, gitRef: string, graph: VgGraph): void {
    const key = activeGraphSlotKey(repositoryId, gitRef);
    const existing = this.indexes.get(key);
    const nodeCount = graph.nodes?.length ?? 0;
    if (existing && existing.state === 'ready') {
      this.log(`semantic: ${repositoryId}@${gitRef} graph republished — index stale (${existing.vectors.size} vectors dropped)`);
    }
    this.indexes.set(key, {
      repositoryId,
      gitRef,
      state: 'stale',
      vectors: new Map(),
      nodeCount,
    });
  }

  /**
   * Supplies the graph for a slot so a select can warm without the caller
   * threading it through. Set by the daemon to read its own cache.
   */
  setGraphProvider(provider: (repositoryId: string, gitRef: string) => VgGraph | undefined): void {
    this.graphProvider = provider;
  }

  /**
   * Supplies the absolute repository root for a slot, so the broker can read
   * that repo's on-disk vector cache. It cannot come from the graph:
   * `meta.root` is deliberately relative (`.`) so snapshots stay portable
   * across machines. The registry holds the real path.
   */
  setRootProvider(provider: (repositoryId: string) => string | undefined): void {
    this.rootProvider = provider;
  }

  /**
   * A slot became current — a branch switch, a new repo, a fresh publish.
   * The matching index is swapped in, and warmed in the background if it is
   * not ready, so the first Ask after a switch is not the one that pays.
   */
  onGraphSelect(repositoryId: string, gitRef: string): void {
    const key = activeGraphSlotKey(repositoryId, gitRef);
    if (this.currentKey !== key) {
      this.currentKey = key;
      const idx = this.indexes.get(key);
      this.log(
        `semantic: current slot → ${repositoryId}@${gitRef} · index ${idx ? `${idx.state} (${idx.vectors.size} vectors)` : 'absent'}`,
      );
    }
    if (this.gaveUp) return;
    const idx = this.indexes.get(key);
    if (idx?.state === 'ready' || this.building.has(key)) return;
    const graph = this.graphProvider?.(repositoryId, gitRef);
    if (!graph) return;
    // Fire and forget: warming must never block the op that triggered it.
    void this.ensureIndex(repositoryId, gitRef, graph);
  }

  /** A graph slot was evicted — its index goes with it, never outliving it. */
  onGraphEvict(repositoryId: string, gitRef: string): void {
    const key = activeGraphSlotKey(repositoryId, gitRef);
    const idx = this.indexes.get(key);
    if (!idx) return;
    this.indexes.delete(key);
    this.log(`semantic: ${repositoryId}@${gitRef} index evicted with its graph slot (${idx.vectors.size} vectors freed)`);
  }

  /** Drop everything (daemon shutdown / registry clear). */
  clear(): void {
    this.indexes.clear();
    this.building.clear();
  }

  /**
   * Ensure the slot has vectors, building them if needed. Resolves when the
   * index is ready or has definitively failed; never throws.
   */
  async ensureIndex(repositoryId: string, gitRef: string, graph: VgGraph): Promise<SlotIndex> {
    const key = activeGraphSlotKey(repositoryId, gitRef);
    let idx = this.indexes.get(key);
    if (!idx) {
      idx = { repositoryId, gitRef, state: 'stale', vectors: new Map(), nodeCount: graph.nodes?.length ?? 0 };
      this.indexes.set(key, idx);
    }
    if (idx.state === 'ready') return idx;
    if (this.gaveUp) {
      idx.state = 'failed';
      idx.error = this.reason ?? 'embedding worker unavailable';
      return idx;
    }
    if (this.building.has(key)) return idx;

    this.building.add(key);
    idx.state = 'building';
    const started = this.now();

    // Seed from the on-disk vector cache first. `vg embed` (and the `vg build`
    // warm-up child) already wrote vectors for this repo, over the same
    // targets and the same embed-text, so re-deriving them here would be pure
    // duplicated work — usually the *whole* index. A repo that is already
    // warm on disk therefore goes `ready` in milliseconds, with no worker.
    const seeded = this.seedFromDisk(repositoryId, graph);
    const targets = seeded?.pending ?? embedTargets(graph);
    const vectors = seeded ? seeded.vectors : new Map<string, number[]>();
    const nodeCount = seeded ? seeded.vectors.size + seeded.pending.length : targets.length;
    idx.nodeCount = nodeCount;

    if (seeded && seeded.vectors.size) {
      this.log(
        `semantic: seeded ${repositoryId}@${gitRef} from the on-disk index — ${seeded.vectors.size} vectors, ${seeded.pending.length} pending`,
      );
    }

    // Another process is mid-write on this repo's cache (the `vg build`
    // warm-up child). Take what is there and stand down rather than embedding
    // the same nodes a second time; `vg embed` calls `embed-index` when it
    // finishes, which brings the slot the rest of the way.
    if (seeded?.writerBusy && targets.length) {
      idx.vectors = vectors;
      idx.pending = targets.length;
      idx.state = vectors.size ? 'stale' : 'absent';
      this.building.delete(key);
      this.log(
        `semantic: ${repositoryId}@${gitRef} left at ${targets.length} pending — another process is writing the on-disk index; re-warming when it reports in`,
      );
      return idx;
    }

    this.log(`semantic: building index for ${repositoryId}@${gitRef} (${targets.length} of ${nodeCount} nodes)…`);

    try {
      for (let i = 0; i < targets.length; i += this.batchSize) {
        const batch = targets.slice(i, i + this.batchSize);
        const out = await this.embed(batch.map((t: EmbedTarget) => t.text));
        batch.forEach((t: EmbedTarget, j: number) => {
          const v = out[j];
          if (v) vectors.set(t.id, v);
        });
        // A slot evicted or republished mid-build must not be resurrected with
        // vectors describing the graph it no longer has.
        const live = this.indexes.get(key);
        if (!live || live !== idx) {
          this.log(`semantic: index build for ${repositoryId}@${gitRef} abandoned — slot changed underneath it`);
          return idx;
        }
      }
      idx.vectors = vectors;
      idx.pending = undefined;
      idx.state = 'ready';
      idx.builtAt = this.now();
      idx.buildMs = idx.builtAt - started;
      idx.error = undefined;
      this.log(`semantic: index ready for ${repositoryId}@${gitRef} — ${vectors.size} vectors in ${idx.buildMs}ms`);
    } catch (err) {
      // Vectors seeded from disk stay usable even when the worker never ran:
      // a partial index still ranks better than nothing.
      idx.vectors = vectors;
      idx.pending = targets.length;
      idx.state = 'failed';
      idx.error = err instanceof Error ? err.message : String(err);
      this.log(`semantic: index build failed for ${repositoryId}@${gitRef} — ${idx.error}; callers fall back to lexical`);
    } finally {
      this.building.delete(key);
    }
    return idx;
  }

  /**
   * Read this slot's vectors out of the repo's on-disk cache. Needs the repo
   * root from the registry; a repository the daemon has no root for (a
   * synthetic publish in a test) simply builds from scratch.
   */
  private seedFromDisk(
    repositoryId: string,
    graph: VgGraph,
  ): { vectors: Map<string, number[]>; pending: EmbedTarget[]; writerBusy: boolean } | null {
    const root = this.rootProvider?.(repositoryId);
    if (!root) return null;
    try {
      const read = readCachedVectors(graph, root);
      if (!this.model) this.model = read.model;
      return { vectors: read.vectors, pending: read.pending, writerBusy: read.writerBusy };
    } catch (err) {
      this.log(`semantic: could not read the on-disk index — ${err instanceof Error ? err.message : String(err)}; embedding from scratch`);
      return null;
    }
  }

  /**
   * Rank a slot's nodes against one question, inside the daemon.
   *
   * This is the op that makes the resident index worth holding. The
   * alternative — shipping the vectors to the caller so it can rank locally —
   * moves tens of megabytes over a socket per ask; ranking here moves one
   * question in and a few hundred (id, score) pairs out.
   *
   * Only the *order* of this list reaches the caller's rank fusion, so
   * truncating at `limit` is not an approximation of the answer: a candidate
   * ranked past a few hundred cannot reach a 12-row result under RRF.
   *
   * Returns null whenever semantic is unavailable — a caller that gets null
   * runs its own in-process pass, exactly as it does with no daemon at all.
   */
  async rank(
    repositoryId: string,
    gitRef: string,
    text: string,
    limit = 200,
  ): Promise<{ ranked: Array<{ id: string; score: number }>; state: SlotIndexState; vectors: number } | null> {
    const idx = this.slot(repositoryId, gitRef);
    if (!idx || idx.vectors.size === 0) return null;
    const queryVec = await this.embedQuery(text);
    if (!queryVec) return null;
    const scored: Array<{ id: string; score: number }> = [];
    for (const [id, vec] of idx.vectors) {
      const score = cosine(queryVec, vec);
      if (score > 0) scored.push({ id, score });
    }
    // Deterministic: ties break on node id, never on Map insertion order.
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { ranked: scored.slice(0, limit), state: idx.state, vectors: idx.vectors.size };
  }

  /** Embed one query string. Returns null when semantic is not available. */
  async embedQuery(text: string): Promise<number[] | null> {
    if (this.gaveUp) return null;
    try {
      const [vector] = await this.embed([text], true);
      return vector ?? null;
    } catch (err) {
      this.log(`semantic: query embedding failed — ${err instanceof Error ? err.message : String(err)}; using lexical`);
      return null;
    }
  }

  /** Stop the worker (daemon shutdown). Safe to call when already stopped. */
  stop(): void {
    const child = this.child;
    this.child = null;
    this.starting = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('embedding worker stopped'));
    }
    this.pending.clear();
    if (child) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }

  // ── worker plumbing ────────────────────────────────────────────────────

  private ensureWorker(): ChildProcess {
    if (this.child) return this.child;
    this.starting = true;
    const child = this.spawnWorker();
    this.child = child;
    this.starting = false;
    this.buffer = '';
    this.log(`semantic: embedding worker started (pid ${child.pid ?? '?'})`);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onData(chunk));
    // The worker's stderr is diagnostic only; surface it so a failing backend
    // is visible in the daemon log rather than silently swallowed.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const text = String(chunk).trim();
      if (text) this.log(`semantic worker: ${text.slice(0, 500)}`);
    });
    child.on('exit', (code, signal) => this.onExit(code, signal));
    child.on('error', (err: Error) => {
      this.log(`semantic: embedding worker could not start — ${err.message}`);
      this.onExit(null, null);
    });
    return child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let res: { id?: number; ok?: boolean; vectors?: number[][]; error?: string; model?: string };
      try {
        res = JSON.parse(line) as typeof res;
      } catch {
        continue; // a corrupt frame is not fatal to the stream
      }
      if (typeof res.model === 'string') this.model = res.model;
      const id = res.id;
      if (typeof id !== 'number') continue;
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (res.ok && Array.isArray(res.vectors)) p.resolve(res.vectors);
      else p.reject(new Error(res.error || 'embedding worker returned no vectors'));
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasRunning = !!this.child;
    this.child = null;
    if (!wasRunning) return;

    this.crashes++;
    const how = signal ? `signal ${signal}` : `code ${code ?? 'null'}`;
    // Fail every in-flight request rather than letting callers hang: each one
    // has a lexical fallback waiting.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`embedding worker exited (${how})`));
    }
    this.pending.clear();

    if (this.crashes >= this.maxCrashes) {
      this.gaveUp = true;
      this.reason =
        `the embedding worker exited (${how}) ${this.crashes} times — semantic search is off for this daemon; ` +
        `everything falls back to lexical. A native backend that aborts like this is usually a blocked ` +
        `onnxruntime-node postinstall (see \`vg embed --where\`).`;
      this.log(`semantic: ${this.reason}`);
      return;
    }
    this.log(`semantic: embedding worker exited (${how}) — restarting on next use (${this.crashes}/${this.maxCrashes})`);
  }

  private embed(texts: string[], query = false): Promise<number[][]> {
    if (this.gaveUp) return Promise.reject(new Error(this.reason ?? 'embedding worker unavailable'));
    if (!texts.length) return Promise.resolve([]);
    let child: ChildProcess;
    try {
      child = this.ensureWorker();
    } catch (err) {
      // A worker that cannot even be spawned counts against the crash budget,
      // so a permanently broken install settles into "lexical" instead of
      // retrying (and re-logging) on every request.
      const error = err instanceof Error ? err : new Error(String(err));
      this.crashes++;
      if (this.crashes >= this.maxCrashes) {
        this.gaveUp = true;
        this.reason = `the embedding worker could not start (${error.message}) — semantic search is off for this daemon`;
        this.log(`semantic: ${this.reason}`);
      } else {
        this.log(`semantic: embedding worker could not start — ${error.message} (${this.crashes}/${this.maxCrashes})`);
      }
      return Promise.reject(error);
    }
    const id = this.nextId++;
    return new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`embedding request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      // Do not hold the daemon open on this timer.
      (timer as unknown as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin?.write(JSON.stringify({ id, op: 'embed', texts, query }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** A successful exchange clears the crash streak — used after a good build. */
  noteHealthy(): void {
    this.crashes = 0;
  }
}

/**
 * Spawn the real worker: the compiled sibling entry (a tsup entry point, like
 * `parse-worker`), run by the same Node binary. Under a TS-only runner the
 * compiled file does not exist — the same situation `engine/pool.ts` handles —
 * so this throws rather than spawning something that cannot start, and the
 * broker reports the failure like any other and callers go lexical.
 */
function defaultSpawnWorker(): ChildProcess {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.join(here, 'embed-worker-main.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`embedding worker not found at ${entry} — semantic runs lexically`);
  }
  return spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Never inherit loader flags or a debugger port: this child exists to be
    // expendable, and anything that changes how it loads defeats the point.
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}
