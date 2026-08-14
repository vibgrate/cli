import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashString } from './hash.js';
import { cacheDir } from './cache.js';
import { resolveGraphPath } from './artifacts.js';
import { acquireLock, releaseLock } from './lock.js';
import type { GraphNode, VgGraph } from '../schema.js';

/**
 * Local-embedding semantic search for `vg ask --semantic`/`--deep` (no API key).
 *
 * The embedding backend is OPTIONAL and lazily loaded (the vendored
 * `src/vendor/fastembed` dense backend over `onnxruntime-node`, local ONNX)
 * so the core install stays lean and `ask` never breaks:
 * if the backend or model isn't available it degrades to (prefix-fuzzy) lexical
 * search with a clear note. Per-repo vectors live in a binary `*.embeddings`
 * file **alongside the code map** (global store under Application Support /
 * XDG data, or `.vibgrate/embeddings` in-repo) — never model-named, never under
 * `.vibgrate/cache/`, and NEVER inside the committed `graph.json`, so the map
 * stays byte-deterministic. The model id is recorded inside the file header so
 * a model change still invalidates the cache without putting the name in the
 * path.
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
  /**
   * Called (not thrown) when the backend can't load. `detail` carries the
   * underlying loader error when there is one, so a host can log something
   * actionable instead of a bare category.
   */
  onUnavailable?: (reason: EmbedUnavailable, detail?: string) => void;
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
 * Checks the binary sidecar next to the map (and the legacy JSON path once).
 */
export function embeddingsCached(root: string, modelId: string): boolean {
  const file = vectorCachePath(root);
  if (fs.existsSync(file) && readCacheHeader(file)?.model === modelId) return true;
  // One-shot legacy: pre-binary caches lived under `.vibgrate/cache/embeddings-<model>.json`.
  return fs.existsSync(legacyVectorCachePath(root, modelId));
}

/**
 * Path of the binary embeddings file for this repo's current map — always named
 * `embeddings` (or `<snapshot>.embeddings` next to a branch-keyed graph), never
 * after the model. Exported for `vg embed --where` and tests.
 */
export function embeddingsPath(root: string): string {
  return vectorCachePath(root);
}

/** Sidecar path next to a map file: `…/branch-main.graph.json` → `…/branch-main.embeddings`. */
export function embeddingsPathFor(graphPath: string): string {
  // Branch-keyed global maps: `…/graphs/branch-main.graph.json` → `…/graphs/branch-main.embeddings`.
  if (graphPath.endsWith('.graph.json')) return `${graphPath.slice(0, -'.graph.json'.length)}.embeddings`;
  if (graphPath.endsWith('.graph.snap')) return `${graphPath.slice(0, -'.graph.snap'.length)}.embeddings`;
  // In-repo map is exactly `…/graph.json` (or `graph.snap`) → plain `…/embeddings`.
  const base = path.basename(graphPath);
  if (base === 'graph.json' || base === 'graph.snap') {
    return path.join(path.dirname(graphPath), 'embeddings');
  }
  if (graphPath.endsWith('.json')) return `${graphPath.slice(0, -5)}.embeddings`;
  if (graphPath.endsWith('.snap')) return `${graphPath.slice(0, -5)}.embeddings`;
  return `${graphPath}.embeddings`;
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
  const fail = (reason: EmbedUnavailable, detail?: string): null => {
    options.onUnavailable?.(reason, detail);
    return null;
  };

  // Lazy, optional dependency (native ONNX): loaded only for `vg ask`/`embed`,
  // never by build/verify, so the graph artifact stays deterministic.
  const backend = await importEmbedBackend();
  const mod: any = backend.mod;
  if (!mod?.FlagEmbedding) return fail('not-installed', backend.error);

  const cache = modelCacheDir(); // central, shared across all repos
  try {
    fs.mkdirSync(cache, { recursive: true });
  } catch (e) {
    return fail(isPermissionError(e) ? 'no-permission' : 'init-failed');
  }

  try {
    // First use fetches the model. A refused connection fails fast, but a
    // black-holing proxy (common on corporate networks) would hang the first
    // `vg ask` / MCP query_graph forever — bound the wait and fall back to
    // lexical instead. Cached loads are local disk and get the same generous
    // ceiling without ever hitting it.
    const model: any = await withTimeout(
      mod.FlagEmbedding.init({
        model: mapModel(mod, modelId),
        cacheDir: cache,
        showDownloadProgress: options.showDownloadProgress ?? false,
      }) as Promise<unknown>,
      embedInitTimeoutMs(),
      'embedding model init timed out',
    );
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
    return fail(isPermissionError(e) ? 'no-permission' : 'download-failed', errText(e));
  }
}

/**
 * Import the optional embedding backend — the VENDORED dense backend
 * (src/vendor/fastembed). It still needs the optional native deps
 * (`onnxruntime-node`, `@anush008/tokenizers`, `tar`), which a host can supply
 * out-of-tree via `VIBGRATE_EMBEDDER_PATH` — a directory whose `node_modules`
 * contains them. Editor integrations use this when their bundled engine ships
 * without the native optional dependencies (the VS Code extension installs
 * them into its own storage on consent); the host dir wins over this package's
 * own dependency tree so the copies the user consented to are the ones that
 * load (see `ensureNativeDeps` in the vendored module).
 *
 * Legacy host contract: a host dir holding a whole upstream `fastembed`
 * install (what older extension versions set up) is still honored, and wins,
 * so an engine upgrade never breaks a backend the user already consented to.
 * Any resolution failure falls through — never throws.
 */
async function importEmbedBackend(): Promise<{ mod: any | null; error?: string }> {
  const hostDir = process.env.VIBGRATE_EMBEDDER_PATH;
  let error: string | undefined;
  if (hostDir) {
    try {
      const req = createRequire(path.join(hostDir, 'package.json'));
      let entry: string | null = null;
      try {
        entry = req.resolve('fastembed');
      } catch {
        // No upstream fastembed in the host dir — the normal state under the
        // current contract (the host supplies only the native deps, resolved
        // by the vendored backend below). Not an error worth reporting.
      }
      if (entry) {
        const mod: any = await import(pathToFileURL(entry).href);
        const resolved = unwrapBackend(mod);
        if (resolved) return { mod: resolved };
        error = `${hostDir}: fastembed loaded but exported no FlagEmbedding`;
      }
    } catch (e) {
      // Keep the reason. A host-supplied backend that resolves but won't load
      // (native binary built for another ABI, a half-extracted tree, a missing
      // transitive dep) is indistinguishable from "never installed" once the
      // error is dropped — and that is the one failure a user cannot act on.
      error = `${hostDir}: ${errText(e)}`;
    }
  }
  try {
    const mod: any = await import('../vendor/fastembed/index.js');
    const resolved = unwrapBackend(mod);
    if (!resolved) return { mod: null, error: error ?? 'embed backend exported no FlagEmbedding' };
    // Load the native deps now (host dir first — see the vendored module), so
    // a missing or broken install surfaces here as "not-installed" with the
    // real reason instead of failing later mid-init.
    if (typeof resolved.ensureNativeDeps === 'function') await resolved.ensureNativeDeps();
    return { mod: resolved };
  } catch (e) {
    return { mod: null, error: error ?? errText(e) };
  }
}

/** A CJS entry imported over ESM may nest its exports one or two `default`s deep. */
function unwrapBackend(mod: any): any | null {
  for (const candidate of [mod, mod?.default, mod?.default?.default]) {
    if (candidate?.FlagEmbedding) return candidate;
  }
  return null;
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Ceiling for the one-time model fetch/init; override via VG_EMBED_TIMEOUT_MS. */
function embedInitTimeoutMs(): number {
  const n = Number(process.env.VG_EMBED_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/** Reject `promise` if it hasn't settled within `ms` (the work itself is not cancelled). */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
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
 *
 * `document` nodes (markdown, manifests, Docker, CI, OpenAPI, …) put the
 * scrubbed body in `doc` — that body is the primary embed signal so `vg ask`
 * can answer project-context questions, not only code symbols.
 */
export function nodeEmbedText(node: GraphNode, areaLabel?: string): string {
  if (node.kind === 'document') {
    const category = (node.signature ?? 'document').replace(/^document:/, '');
    // Category keywords help ops/config queries land on the right file type.
    const categoryHints: Record<string, string> = {
      manifest: 'package dependencies scripts install dependencies versions',
      docker: 'dockerfile container image build runtime',
      compose: 'docker-compose services containers networking volumes',
      ci: 'continuous integration github actions workflow pipeline test build deploy',
      'build-config': 'typescript tsconfig bundler vite webpack eslint prettier test',
      'api-contract': 'openapi swagger graphql protobuf api schema endpoints',
      'task-runner': 'makefile justfile tasks build test run commands',
      workspace: 'monorepo workspace packages pnpm turbo nx',
      infra: 'deploy infrastructure kubernetes kubernetes terraform helm kubernetes',
      'env-example': 'environment variables configuration secrets template',
      markdown: 'documentation readme guide',
    };
    const hint = categoryHints[category] ?? category;
    return [
      node.qualifiedName,
      'document',
      category,
      hint,
      pathContext(node.file),
      (node.doc ?? '').slice(0, 5000),
    ]
      .filter(Boolean)
      .join('\n');
  }
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

/**
 * Binary embeddings format (local cache next to the map, never committed):
 *
 *   MAGIC "VGEMB1\0" · u16 version · u16 modelLen · model utf8 ·
 *   u32 dims · u32 count ·
 *   for each entry: u16 idLen · id · u16 hashLen · hash ·
 *   then contiguous Float32LE vectors [count × dims]
 *
 * Why binary: a medium map (~4k nodes × 384 dims) is ~6 MB of floats but was
 * ~30 MB of JSON with full decimal text — slow to parse and noisy in source
 * control if it ever landed under the repo. The filename is always
 * `embeddings` / `<snapshot>.embeddings`; the model id lives only in the header.
 */
/** 8-byte little-endian-friendly magic (same width as graph `VGSNAP1\0`). */
const EMB_MAGIC = Buffer.from('VGEMB01\0', 'latin1');
const EMB_VERSION = 1;

function vectorCachePath(root: string): string {
  return embeddingsPathFor(resolveGraphPath(root));
}

/** Pre-binary path: `.vibgrate/cache/embeddings-<model>.json` (read once to migrate). */
function legacyVectorCachePath(root: string, modelId: string): string {
  return path.join(cacheDir(root), `embeddings-${safe(modelId)}.json`);
}

/**
 * How many searchable nodes still need embedding for `modelId` — cheap (hashes
 * the embed-text, reads only the cache; never loads the model). Lets the embed
 * command / background warm-up exit instantly when nothing changed.
 */
export function countPending(graph: VgGraph, root: string, modelId: string): number {
  const entries = loadCache(root, modelId).entries;
  const areaLabel = new Map(graph.areas.map((a) => [a.id, a.label] as const));
  let pending = 0;
  for (const n of graph.nodes) {
    // file/external stay out of the index; document (docs/env examples) are in.
    if (n.kind === 'file' || n.kind === 'external') continue;
    const h = hashString(nodeEmbedText(n, areaLabel.get(n.area)));
    const cached = entries[n.id];
    if (!cached || cached.hash !== h) pending++;
  }
  return pending;
}

function loadCache(root: string, modelId: string): EmbedCache {
  const file = vectorCachePath(root);
  const binary = readBinaryCache(file, modelId);
  if (binary) return binary;

  // Migrate legacy JSON if present (once) — keep working after upgrade without
  // re-embedding the whole repo.
  const legacy = legacyVectorCachePath(root, modelId);
  if (fs.existsSync(legacy)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(legacy, 'utf8')) as EmbedCache;
      if (loaded.model === modelId && loaded.entries) {
        return { model: modelId, entries: loaded.entries };
      }
    } catch {
      /* treat as empty */
    }
  }
  return { model: modelId, entries: {} };
}

interface EmbedHeader {
  model: string;
  dims: number;
  count: number;
}

/** Cheap header-only peek (no vectors) for `embeddingsCached` / diagnostics. */
function readCacheHeader(file: string): EmbedHeader | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const prefix = Buffer.alloc(8 + 2 + 2 + 512); // magic + ver + modelLen + model (capped)
    const n = fs.readSync(fd, prefix, 0, prefix.length, 0);
    if (n < EMB_MAGIC.length + 4 || !prefix.subarray(0, EMB_MAGIC.length).equals(EMB_MAGIC)) return null;
    let o = EMB_MAGIC.length;
    const version = prefix.readUInt16LE(o);
    o += 2;
    if (version !== EMB_VERSION) return null;
    const modelLen = prefix.readUInt16LE(o);
    o += 2;
    if (o + modelLen + 8 > n) {
      // model spills past our prefix — re-read exactly
      const full = Buffer.alloc(EMB_MAGIC.length + 2 + 2 + modelLen + 8);
      fs.readSync(fd, full, 0, full.length, 0);
      return parseHeaderPrefix(full);
    }
    return parseHeaderPrefix(prefix);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function parseHeaderPrefix(buf: Buffer): EmbedHeader | null {
  try {
    if (!buf.subarray(0, EMB_MAGIC.length).equals(EMB_MAGIC)) return null;
    let o = EMB_MAGIC.length;
    if (buf.readUInt16LE(o) !== EMB_VERSION) return null;
    o += 2;
    const modelLen = buf.readUInt16LE(o);
    o += 2;
    if (o + modelLen + 8 > buf.length) return null;
    const model = buf.subarray(o, o + modelLen).toString('utf8');
    o += modelLen;
    const dims = buf.readUInt32LE(o);
    o += 4;
    const count = buf.readUInt32LE(o);
    return { model, dims, count };
  } catch {
    return null;
  }
}

function readBinaryCache(file: string, modelId: string): EmbedCache | null {
  if (!fs.existsSync(file)) return null;
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < EMB_MAGIC.length + 4 || !buf.subarray(0, EMB_MAGIC.length).equals(EMB_MAGIC)) return null;
    let o = EMB_MAGIC.length;
    if (buf.readUInt16LE(o) !== EMB_VERSION) return null;
    o += 2;
    const modelLen = buf.readUInt16LE(o);
    o += 2;
    const model = buf.subarray(o, o + modelLen).toString('utf8');
    o += modelLen;
    if (model !== modelId) return null;
    const dims = buf.readUInt32LE(o);
    o += 4;
    const count = buf.readUInt32LE(o);
    o += 4;
    if (dims === 0 || count === 0) return { model, entries: {} };

    const ids: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < count; i++) {
      const idLen = buf.readUInt16LE(o);
      o += 2;
      ids.push(buf.subarray(o, o + idLen).toString('utf8'));
      o += idLen;
      const hashLen = buf.readUInt16LE(o);
      o += 2;
      hashes.push(buf.subarray(o, o + hashLen).toString('utf8'));
      o += hashLen;
    }
    const floatsNeeded = count * dims;
    const bytesNeeded = floatsNeeded * 4;
    if (o + bytesNeeded > buf.length) return null;
    // Copy into a standalone ArrayBuffer so Float32Array views are safe after buf is GC'd.
    const floatBuf = Buffer.from(buf.subarray(o, o + bytesNeeded));
    const floats = new Float32Array(floatBuf.buffer, floatBuf.byteOffset, floatsNeeded);

    const entries: EmbedCache['entries'] = {};
    for (let i = 0; i < count; i++) {
      const start = i * dims;
      const vec = Array.from(floats.subarray(start, start + dims));
      entries[ids[i]!] = { hash: hashes[i]!, vec };
    }
    return { model, entries };
  } catch {
    return null;
  }
}

function writeBinaryCache(file: string, cache: EmbedCache): void {
  const ids = Object.keys(cache.entries);
  const count = ids.length;
  let dims = 0;
  for (const id of ids) {
    const d = cache.entries[id]!.vec.length;
    if (d > 0) {
      dims = d;
      break;
    }
  }
  // Empty or all-zero-dim cache: still write a valid header so "cached" is true.
  const modelBuf = Buffer.from(cache.model, 'utf8');
  if (modelBuf.length > 0xffff) throw new Error('embed model id too long');

  // Index size (ids + hashes)
  let indexBytes = 0;
  const idBufs: Buffer[] = [];
  const hashBufs: Buffer[] = [];
  for (const id of ids) {
    const ib = Buffer.from(id, 'utf8');
    const hb = Buffer.from(cache.entries[id]!.hash, 'utf8');
    if (ib.length > 0xffff || hb.length > 0xffff) throw new Error('embed entry key too long');
    idBufs.push(ib);
    hashBufs.push(hb);
    indexBytes += 2 + ib.length + 2 + hb.length;
  }

  const headerBytes = EMB_MAGIC.length + 2 + 2 + modelBuf.length + 4 + 4;
  const vecBytes = count * dims * 4;
  const out = Buffer.allocUnsafe(headerBytes + indexBytes + vecBytes);
  let o = 0;
  EMB_MAGIC.copy(out, o);
  o += EMB_MAGIC.length;
  out.writeUInt16LE(EMB_VERSION, o);
  o += 2;
  out.writeUInt16LE(modelBuf.length, o);
  o += 2;
  modelBuf.copy(out, o);
  o += modelBuf.length;
  out.writeUInt32LE(dims, o);
  o += 4;
  out.writeUInt32LE(count, o);
  o += 4;

  for (let i = 0; i < count; i++) {
    const ib = idBufs[i]!;
    const hb = hashBufs[i]!;
    out.writeUInt16LE(ib.length, o);
    o += 2;
    ib.copy(out, o);
    o += ib.length;
    out.writeUInt16LE(hb.length, o);
    o += 2;
    hb.copy(out, o);
    o += hb.length;
  }

  if (dims > 0 && count > 0) {
    const floats = new Float32Array(count * dims);
    for (let i = 0; i < count; i++) {
      const vec = cache.entries[ids[i]!]!.vec;
      const base = i * dims;
      for (let d = 0; d < dims; d++) floats[base + d] = vec[d] ?? 0;
    }
    Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).copy(out, o);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
}

/** Best-effort drop of the old model-named JSON caches under `.vibgrate/cache/`. */
function purgeLegacyJsonCaches(root: string): void {
  const dir = cacheDir(root);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (/^embeddings-.+\.json$/.test(name) || /^embeddings-.+\.json\.lock$/.test(name)) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

// Single-writer lock (shared helper — see ./lock.ts) so a foreground `ask`
// and a background `embed` never both embed the same repo at once (which
// would race on the cache file).

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
  const file = vectorCachePath(root);
  const cache = loadCache(root, embedder.id);

  const areaLabel = new Map(graph.areas.map((a) => [a.id, a.label] as const));
  // Include document nodes (markdown/txt/env examples) so ask can retrieve docs.
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
      writeBinaryCache(file, cache);
      purgeLegacyJsonCaches(root);
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
  } else if (!fs.existsSync(file) && Object.keys(cache.entries).length > 0) {
    // Migrating from legacy JSON with a full hit set — rewrite as binary once
    // so the next run never reads the old path again.
    persist();
  }

  return vectors;
}

function safe(id: string): string {
  return id.replace(/[^a-z0-9.-]+/gi, '_');
}
