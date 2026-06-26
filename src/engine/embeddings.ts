import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashString } from './hash.js';
import { cacheDir } from './cache.js';
import type { GraphNode, VgGraph } from '../schema.js';

/**
 * Local-embedding semantic search for `vg ask --semantic`/`--deep` (no API key).
 *
 * The embedding backend is an OPTIONAL, lazily-loaded dependency (`fastembed`,
 * Apache-2.0, local ONNX) so the core install stays lean and `ask` never breaks:
 * if the backend or model isn't available it degrades to (prefix-fuzzy) lexical
 * search with a clear note. Embeddings are query-time + cached under
 * `.vibgrate/cache/` (keyed by node-text hash); they are NEVER written into the
 * committed `graph.json`, so the artifact stays byte-deterministic.
 *
 * `--local` disables the model download (semantic is skipped unless already
 * cached via an injected backend), keeping the air-gapped guarantee.
 */

export interface Embedder {
  /** Stable model id (recorded with cached vectors so a model change invalidates them). */
  id: string;
  /** Embed documents → unit-or-raw vectors (cosine handles normalization). */
  embed(texts: string[]): Promise<number[][]>;
  /** Embed a single query string. */
  embedQuery(text: string): Promise<number[]>;
}

/** Why semantic fell back to lexical — for calm, specific messaging. */
export type EmbedUnavailable = 'not-installed' | 'no-permission' | 'download-failed' | 'init-failed';

export interface LoadEmbedderOptions {
  local?: boolean; // --local: do not download a model
  model?: string; // override the embedding model id
  noDownload?: boolean; // only load if the model is already cached (never fetch)
  showDownloadProgress?: boolean; // let fastembed print its one-time download progress
  onUnavailable?: (reason: EmbedUnavailable) => void; // called (not thrown) when it can't load
}

/** The embedding model id in effect (explicit override → default). */
export function resolveEmbedModel(model?: string): string {
  return model ?? 'bge-small-en-v1.5';
}

/**
 * The **central, per-user** model cache — downloaded once per machine and shared
 * across every repo/folder (devs have many repos; the ~tens-of-MB model should
 * not re-download per project). Uses the XDG standard:
 * `$XDG_CACHE_HOME/vibgrate/models` (or `~/.cache/vibgrate/models`); relocate via
 * the standard `XDG_CACHE_HOME`. NB: fastembed's own default is the relative
 * `./local_cache`, i.e. per-CWD — which we override.
 */
export function modelCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'vibgrate', 'models');
}

/** A machine-global marker written once the model has loaded successfully. */
function modelReadyMarker(modelId: string): string {
  return path.join(modelCacheDir(), `.ready-${safe(modelId)}`);
}

/**
 * Whether the embedding model is already present on this machine (loaded at least
 * once), so it can be used with **no network**. Lets the background warm-up
 * trigger only when it won't surprise-download.
 */
export function isModelReady(modelId = resolveEmbedModel()): boolean {
  return fs.existsSync(modelReadyMarker(modelId));
}

/**
 * A calm, specific, actionable one-liner for why semantic isn't available right
 * now — built to reassure (lexical still works) and inform, never to alarm. No
 * stack traces, no scary words; always names the off switch and the fix.
 */
export function unavailableMessage(reason: EmbedUnavailable): string {
  switch (reason) {
    case 'no-permission':
      return `semantic search couldn't write its model cache at ${modelCacheDir()} — using fast lexical search instead. Relocate it with the standard XDG_CACHE_HOME, or run with --local to stay lexical quietly. (No admin/sudo is ever needed — the cache lives in your home folder.)`;
    case 'download-failed':
      return `the semantic model isn't downloaded yet and couldn't be fetched (offline?) — using fast lexical search. It'll try again next time; run with --local to keep lexical without retrying.`;
    case 'not-installed':
      return `the optional semantic backend isn't available here — using fast lexical search.`;
    case 'init-failed':
    default:
      return `the semantic model couldn't load — using fast lexical search.`;
  }
}

export interface ModelCacheInfo {
  dir: string;
  present: boolean;
  bytes: number;
}

/** Where the shared model lives, whether it's present, and how big it is. */
export function modelCacheInfo(modelId = resolveEmbedModel()): ModelCacheInfo {
  const dir = modelCacheDir();
  return { dir, present: isModelReady(modelId) || fs.existsSync(dir), bytes: dirSize(dir) };
}

/** Remove the shared, re-downloadable model from the central cache. Returns bytes freed. */
export function clearModelCache(): number {
  const dir = modelCacheDir();
  const bytes = dirSize(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  return bytes;
}

function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else {
      try {
        total += fs.statSync(p).size;
      } catch {
        /* skip unreadable */
      }
    }
  }
  return total;
}

function isPermissionError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

/**
 * Whether this repo already has a cached vector set for `modelId` — i.e. semantic
 * search has run here before, so the next run is fast (no first-use download/embed).
 * Lets `ask` show the one-time setup note only when it's actually warranted.
 */
export function embeddingsCached(root: string, modelId: string): boolean {
  return fs.existsSync(path.join(cacheDir(root), `embeddings-${safe(modelId)}.json`));
}

/**
 * Try to load the optional local embedding backend. Returns null (→ caller falls
 * back to lexical) when running `--local`, when the dependency isn't installed,
 * or when the model can't initialize.
 */
export async function loadEmbedder(options: LoadEmbedderOptions = {}): Promise<Embedder | null> {
  // `--local` forces the deterministic lexical floor with no model load/download
  // (air-gapped guarantee; also how tests stay offline).
  if (options.local) return null;
  const modelId = resolveEmbedModel(options.model);
  // noDownload (used by the background warm-up): never fetch — bail if not cached.
  if (options.noDownload && !isModelReady(modelId)) return null;
  const fail = (reason: EmbedUnavailable): null => {
    options.onUnavailable?.(reason);
    return null;
  };

  // Lazy, optional dependency (native ONNX): loaded only for `vg ask`/`embed`,
  // never by build/verify, so the graph artifact stays deterministic.
  const mod: any = await import('fastembed' as string).catch(() => null);
  if (!mod?.FlagEmbedding) return fail('not-installed');

  const cache = modelCacheDir(); // central, shared across all repos
  try {
    fs.mkdirSync(cache, { recursive: true });
  } catch (e) {
    return fail(isPermissionError(e) ? 'no-permission' : 'init-failed');
  }

  try {
    const model = await mod.FlagEmbedding.init({
      model: mapModel(mod, modelId),
      cacheDir: cache,
      showDownloadProgress: options.showDownloadProgress ?? false,
    });
    // Record machine-global readiness so future builds can warm up offline.
    try {
      fs.writeFileSync(modelReadyMarker(modelId), new Date(0).toISOString());
    } catch {
      /* marker is best-effort */
    }
    return {
      id: modelId,
      async embed(texts) {
        const out: number[][] = [];
        for await (const batch of model.embed(texts, 64)) {
          for (const v of batch) out.push(Array.from(v as ArrayLike<number>));
        }
        return out;
      },
      async embedQuery(text) {
        const v = await model.queryEmbed(text);
        return Array.from(v as ArrayLike<number>);
      },
    };
  } catch (e) {
    return fail(isPermissionError(e) ? 'no-permission' : 'download-failed');
  }
}

function mapModel(mod: any, id: string): unknown {
  const m = mod.EmbeddingModel ?? {};
  if (/bge-small/i.test(id)) return m.BGESmallENV15 ?? m.BGESmallEN ?? id;
  if (/bge-base/i.test(id)) return m.BGEBaseENV15 ?? id;
  if (/all-minilm/i.test(id)) return m.AllMiniLML6V2 ?? id;
  return id;
}

/** Path segments that carry no semantic signal — dropped from embed context. */
const PATH_NOISE = new Set([
  'src', 'app', 'apps', 'lib', 'libs', 'dist', 'build', 'out', 'index', 'main',
  'packages', 'pkg', 'test', 'tests', '__tests__', 'spec', 'node_modules', 'internal',
  'com', 'example', 'demo', 'java', 'net', 'org', 'www',
]);

/** Meaningful path context for a node: a couple of parent dirs + the filename stem. */
function pathContext(file: string): string {
  const parts = file.split('/');
  const stem = (parts.pop() ?? '').replace(/\.[^.]+$/, '');
  const dirs = parts.filter((p) => p && !PATH_NOISE.has(p.toLowerCase()));
  return [...dirs.slice(-2), stem].filter(Boolean).join(' ');
}

/**
 * The text we embed for a node. Alongside identity + signature we add the
 * strongest available signal — the node's **doc-comment / docstring** summary —
 * plus lightweight context already on the graph (file-path words, area label), so
 * a tersely-named symbol (`Table`, `NotificationJob`) a concept query can reach.
 * Only the short, truncated doc summary is used (captured at build time); no full
 * file bodies, so the graph artifact stays deterministic.
 */
export function nodeEmbedText(node: GraphNode, areaLabel?: string): string {
  return [node.qualifiedName, node.kind, node.signature ?? '', node.doc ?? '', pathContext(node.file), areaLabel ?? '']
    .filter(Boolean)
    .join(' ');
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface EmbedCache {
  model: string;
  entries: Record<string, { hash: string; vec: number[] }>;
}

/** Reports embedding progress: how many of `total` nodes are done so far. */
export type EmbedProgress = (done: number, total: number) => void;

/** Nodes embedded per chunk — bounds memory and gives progress granularity. */
const EMBED_CHUNK = 256;
/** Min gap between incremental cache writes (ms) — caps IO on big repos. */
const CACHE_WRITE_INTERVAL_MS = 1500;
/** A lock older than this is presumed dead (crashed process). */
const LOCK_STALE_MS = 15 * 60 * 1000;

function vectorCachePath(root: string, modelId: string): string {
  return path.join(cacheDir(root), `embeddings-${safe(modelId)}.json`);
}

/**
 * How many searchable nodes still need embedding for `modelId` — cheap (hashes
 * the embed-text, reads only the cache; never loads the model). Lets the embed
 * command / background warm-up exit instantly when nothing changed.
 */
export function countPending(graph: VgGraph, root: string, modelId: string): number {
  const entries = readCacheEntries(vectorCachePath(root, modelId), modelId);
  const areaLabel = new Map(graph.areas.map((a) => [a.id, a.label] as const));
  let pending = 0;
  for (const n of graph.nodes) {
    if (n.kind === 'file' || n.kind === 'external') continue;
    const h = hashString(nodeEmbedText(n, areaLabel.get(n.area)));
    const cached = entries[n.id];
    if (!cached || cached.hash !== h) pending++;
  }
  return pending;
}

function readCacheEntries(file: string, modelId: string): EmbedCache['entries'] {
  if (!fs.existsSync(file)) return {};
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8')) as EmbedCache;
    if (loaded.model === modelId && loaded.entries) return loaded.entries;
  } catch {
    /* treat as empty */
  }
  return {};
}

// ── Single-writer lock so a foreground `ask` and a background `embed` never both
//    embed the same repo at once (which would race on the cache file). ──

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, just not ours to signal
  }
}

function lockIsStale(file: string): boolean {
  try {
    const { pid, at } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; at?: number };
    if (typeof at === 'number' && Date.now() - at > LOCK_STALE_MS) return true;
    if (typeof pid === 'number' && !isProcessAlive(pid)) return true;
    return false;
  } catch {
    return true; // unreadable/corrupt → reclaim it
  }
}

/** Take the embed lock (O_EXCL), reclaiming a stale/dead one. Returns success. */
function acquireLock(file: string): boolean {
  const write = (): boolean => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };
  if (write()) return true;
  if (lockIsStale(file)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* another process may have reclaimed it */
    }
    return write();
  }
  return false;
}

function releaseLock(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Node embeddings for the searchable (non-file/external) nodes, cache-backed:
 * only nodes whose embed-text changed are re-embedded. The first run embeds in
 * chunks, **persists the cache incrementally** (so an interrupted/timed-out run
 * resumes instead of wasting the work), and reports progress via `onProgress`.
 */
export async function getNodeEmbeddings(
  graph: VgGraph,
  embedder: Embedder,
  root: string,
  onProgress?: EmbedProgress,
): Promise<Map<string, number[]>> {
  const file = vectorCachePath(root, embedder.id);
  let cache: EmbedCache = { model: embedder.id, entries: {} };
  if (fs.existsSync(file)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8')) as EmbedCache;
      if (loaded.model === embedder.id && loaded.entries) cache = loaded;
    } catch {
      /* rebuild */
    }
  }

  const areaLabel = new Map(graph.areas.map((a) => [a.id, a.label] as const));
  const targets = graph.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'external');
  const toEmbed: { id: string; text: string; hash: string }[] = [];
  const vectors = new Map<string, number[]>();
  for (const n of targets) {
    const text = nodeEmbedText(n, areaLabel.get(n.area));
    const h = hashString(text);
    const cached = cache.entries[n.id];
    if (cached && cached.hash === h) vectors.set(n.id, cached.vec);
    else toEmbed.push({ id: n.id, text, hash: h });
  }

  // Atomic write (temp + rename) so a reader never sees a half-written cache.
  const persist = (): void => {
    try {
      fs.mkdirSync(cacheDir(root), { recursive: true });
      const tmp = `${file}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, file);
    } catch {
      /* cache write best-effort */
    }
  };

  if (toEmbed.length) {
    // Single-writer: if another process (e.g. a background warm-up) is already
    // embedding this repo, don't double-work or race the cache — return what's
    // cached so far (lexical floor still applies). It will be complete next run.
    const lock = `${file}.lock`;
    if (!acquireLock(lock)) return vectors;
    try {
      onProgress?.(0, toEmbed.length);
      let lastWrite = Date.now();
      for (let i = 0; i < toEmbed.length; i += EMBED_CHUNK) {
        const slice = toEmbed.slice(i, i + EMBED_CHUNK);
        const vecs = await embedder.embed(slice.map((t) => t.text));
        slice.forEach((t, j) => {
          const vec = vecs[j] ?? [];
          vectors.set(t.id, vec);
          cache.entries[t.id] = { hash: t.hash, vec };
        });
        onProgress?.(Math.min(i + EMBED_CHUNK, toEmbed.length), toEmbed.length);
        // Persist periodically so a crash/timeout resumes from here next run.
        if (Date.now() - lastWrite >= CACHE_WRITE_INTERVAL_MS) {
          persist();
          lastWrite = Date.now();
        }
      }
      // prune entries for nodes no longer present, then a final authoritative write
      const live = new Set(targets.map((n) => n.id));
      for (const id of Object.keys(cache.entries)) if (!live.has(id)) delete cache.entries[id];
      persist();
    } finally {
      releaseLock(lock);
    }
  }

  return vectors;
}

function safe(id: string): string {
  return id.replace(/[^a-z0-9.-]+/gi, '_');
}
