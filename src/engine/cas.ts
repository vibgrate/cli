import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Packr } from 'msgpackr';
import { repositoryIdFromRoot, vibgrateCacheDir } from '../runtime/paths.js';
import { branchGraphSnapshotId } from '../runtime/git-ref.js';
import { shortId } from './hash.js';
import { stableStringify } from './serialize.js';
import type { FileParse } from './types.js';

/**
 * Content-addressed store (CAS) for derived per-file artifacts.
 *
 * The parse cache under `.vibgrate/cache/` is keyed by *path* and pruned to
 * the current tree, so switching from `main` to `feature` evicts every
 * `main`-only parse, a rename re-parses identical bytes, and two worktrees of
 * one clone never share a parse. Vectors were worse: the embeddings sidecar is
 * per graph path and its embed text carried the file path, so a byte-identical
 * symbol on another branch could not reuse its vector.
 *
 * This store addresses derived objects by *content* instead:
 *
 *   - a parse is a pure function of `(bytes, lang, tool version, grammar set)`
 *     and lives under `blobs/<hash[0:2]>/<hash>/parse.<lang>.msgpack`;
 *   - a vector is a pure function of `(model, embed text)` and lives under
 *     `vectors/<model>/<textHash[0:2]>/<textHash>.f32` (raw Float32LE);
 *   - a ref is a *catalog* — `manifests/<snapshotId>.manifest.json` lists the
 *     tree as `path → addr` — so a branch is a set of pointers into the store,
 *     not a private copy of every parse and vector.
 *
 * The store is a pure performance layer: a CAS hit is byte-identical to a cold
 * compute of the same input (the incremental-identity gate enforces it), so
 * the graph is the same whether or not the store was warm. It lives in the
 * machine **cache** tree (`vibgrateCacheDir()/cas/<repoId>/`, evictable),
 * never under `{root}/.vibgrate/`, so one checkout can never evict another's
 * objects. Objects are never pruned to the current tree.
 *
 * Every read tolerates a missing or torn object (returns undefined → recompute)
 * and every write is atomic (temp + rename) and best-effort, so two processes
 * embedding the same new symbol, or a read-only cache dir, never fail a build.
 *
 * Address forms: `b3:<blake3-hex>` for file bytes (the hash the build already
 * computes). Git blob SHAs (`git:<sha1>`) are reserved for a later phase that
 * reads the tree from `git ls-tree` without touching file bytes.
 */

/** Envelope schema for a stored parse; bump when the record layout changes. */
export const CAS_PARSE_SCHEMA = 'vg-cas-parse/1';
/** Manifest schema. */
export const MANIFEST_SCHEMA = 'vg-manifest/1';
/** Embed-text version the vector objects were computed over (see embeddings.ts). */
export const VECTOR_TEXT_VERSION = 2;

/** `VIBGRATE_CAS=0|false|off|no` disables the store entirely (reads and writes). */
export function casEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.VIBGRATE_CAS?.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** Root of the machine-wide store: `$VIBGRATE_CACHE_DIR/cas` (XDG cache by default). */
export function casRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(vibgrateCacheDir(env), 'cas');
}

/** In-process memo of `root → store id` (the common git dir never moves mid-run). */
const repoIdMemo = new Map<string, string>();

/**
 * The store id for a repository. Worktrees of one clone share a git common
 * dir, so they share one store (the same file on two worktrees is one parse);
 * a plain directory falls back to the path-derived repository id.
 */
export function casRepositoryId(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const abs = path.resolve(root);
  const hit = repoIdMemo.get(abs);
  if (hit) return hit;
  let id: string | undefined;
  if (env.VIBGRATE_CAS_NO_GIT !== '1') {
    try {
      const res = spawnSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: abs,
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      const out = (res.stdout ?? '').trim();
      if (res.status === 0 && out) {
        const common = path.resolve(abs, out);
        id = shortId(`cas:${process.platform === 'win32' ? common.replace(/\\/g, '/').toLowerCase() : common}`);
      }
    } catch {
      /* no git — path-derived id below */
    }
  }
  id ??= repositoryIdFromRoot(abs);
  repoIdMemo.set(abs, id);
  return id;
}

/** Tests: forget memoized store ids. */
export function clearCasRepositoryIdCache(): void {
  repoIdMemo.clear();
}

/** Directory holding one repository's objects and manifests. */
export function casRepositoryDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(casRoot(env), casRepositoryId(root, env));
}

export interface CasStats {
  parseHits: number;
  parseMisses: number;
  parseWrites: number;
  vectorHits: number;
  vectorMisses: number;
  vectorWrites: number;
}

/** What a stored parse is a function of — checked on every read. */
export interface ParseKey {
  toolVersion: string;
  grammars: string;
}

interface ParseEnvelope {
  schema: string;
  hash: string;
  lang: string;
  toolVersion: string;
  grammars: string;
  parse: FileParse;
}

export interface OpenCasOptions {
  env?: NodeJS.ProcessEnv;
  /** Bypass reads (`--no-cache`); writes still happen so a verify rebuild can prove identity. */
  noReads?: boolean;
  /** Required for parse objects; vector-only callers may omit it. */
  parseKey?: ParseKey;
}

/**
 * A handle on one repository's store. Never throws: a store that cannot be
 * read or written degrades to "miss" / "skip", never to a failed build.
 */
export class CasStore {
  readonly dir: string;
  readonly readsEnabled: boolean;
  readonly stats: CasStats = {
    parseHits: 0,
    parseMisses: 0,
    parseWrites: 0,
    vectorHits: 0,
    vectorMisses: 0,
    vectorWrites: 0,
  };
  private readonly parseKey: ParseKey | undefined;
  private readonly headersWritten = new Set<string>();

  constructor(dir: string, options: { readsEnabled: boolean; parseKey?: ParseKey }) {
    this.dir = dir;
    this.readsEnabled = options.readsEnabled;
    this.parseKey = options.parseKey;
  }

  // ─── parses ────────────────────────────────────────────────────────────────

  /** Path of the parse object for `(hash, lang)`. */
  parsePath(hash: string, lang: string): string {
    return path.join(this.dir, 'blobs', hash.slice(0, 2), hash, `parse.${safeSegment(lang)}.msgpack`);
  }

  /**
   * The stored parse for these bytes, re-tagged to `rel`. A parse never
   * depends on where its bytes live, so the same object serves a rename, a
   * sibling branch, and another worktree; only the top-level `rel` differs.
   */
  getParse(hash: string, lang: string, rel: string): FileParse | undefined {
    if (!this.readsEnabled || !this.parseKey) return undefined;
    const file = this.parsePath(hash, lang);
    let env: ParseEnvelope | undefined;
    try {
      const buf = fs.readFileSync(file);
      env = newPackr().unpack(buf) as ParseEnvelope;
    } catch {
      env = undefined;
    }
    if (
      !env ||
      env.schema !== CAS_PARSE_SCHEMA ||
      env.hash !== hash ||
      env.lang !== lang ||
      env.toolVersion !== this.parseKey.toolVersion ||
      env.grammars !== this.parseKey.grammars ||
      !env.parse ||
      typeof env.parse !== 'object'
    ) {
      this.stats.parseMisses++;
      return undefined;
    }
    this.stats.parseHits++;
    // Retag: `rel` is the one path-bearing field of a FileParse (see types.ts).
    return { ...env.parse, rel };
  }

  /** Store a parse under its content hash. Best-effort, atomic. */
  putParse(parse: FileParse): void {
    if (!this.parseKey || !parse.hash) return;
    const file = this.parsePath(parse.hash, parse.lang);
    if (fs.existsSync(file)) return; // content-addressed: an existing object is the same object
    const env: ParseEnvelope = {
      schema: CAS_PARSE_SCHEMA,
      hash: parse.hash,
      lang: parse.lang,
      toolVersion: this.parseKey.toolVersion,
      grammars: this.parseKey.grammars,
      parse,
    };
    if (writeAtomic(file, newPackr().pack(env))) this.stats.parseWrites++;
  }

  // ─── vectors ───────────────────────────────────────────────────────────────

  vectorDir(modelId: string): string {
    return path.join(this.dir, 'vectors', safeSegment(modelId));
  }

  vectorPath(modelId: string, textHash: string): string {
    return path.join(this.vectorDir(modelId), textHash.slice(0, 2), `${textHash}.f32`);
  }

  /** The vector `modelId` produced for the embed text with this hash, if stored. */
  getVector(modelId: string, textHash: string): number[] | undefined {
    if (!this.readsEnabled) return undefined;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(this.vectorPath(modelId, textHash));
    } catch {
      this.stats.vectorMisses++;
      return undefined;
    }
    if (buf.length === 0 || buf.length % 4 !== 0) {
      this.stats.vectorMisses++;
      return undefined;
    }
    // Copy into an aligned standalone buffer: a Buffer from the pool may not be 4-byte aligned.
    const copy = Buffer.from(buf);
    const floats = new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4);
    this.stats.vectorHits++;
    return Array.from(floats);
  }

  /** Store a vector for `(modelId, textHash)`. Best-effort, atomic; an existing object is left alone. */
  putVector(modelId: string, textHash: string, vec: number[]): void {
    if (!vec.length) return;
    const file = this.vectorPath(modelId, textHash);
    if (fs.existsSync(file)) return;
    const floats = Float32Array.from(vec);
    const ok = writeAtomic(file, Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength));
    if (!ok) return;
    this.stats.vectorWrites++;
    this.writeVectorHeader(modelId, vec.length);
  }

  /** `header.json` beside a model's vectors — what they are, for `vg doctor` and future readers. */
  private writeVectorHeader(modelId: string, dims: number): void {
    if (this.headersWritten.has(modelId)) return;
    this.headersWritten.add(modelId);
    const file = path.join(this.vectorDir(modelId), 'header.json');
    if (fs.existsSync(file)) return;
    writeAtomic(
      file,
      Buffer.from(stableStringify({ modelId, dims, metric: 'cosine', textVersion: VECTOR_TEXT_VERSION }, 0)),
    );
  }

  // ─── manifests ─────────────────────────────────────────────────────────────

  manifestPath(ref: string): string {
    return path.join(this.dir, 'manifests', `${branchGraphSnapshotId(ref)}.manifest.json`);
  }
}

/** Open the parse side of a repository's store (build path). Null when disabled. */
export function openParseCas(root: string, options: OpenCasOptions & { parseKey: ParseKey }): CasStore | null {
  const env = options.env ?? process.env;
  if (!casEnabled(env)) return null;
  return new CasStore(casRepositoryDir(root, env), { readsEnabled: !options.noReads, parseKey: options.parseKey });
}

/** Open the vector side of a repository's store (embed path). Null when disabled. */
export function openVectorCas(root: string, options: OpenCasOptions = {}): CasStore | null {
  const env = options.env ?? process.env;
  if (!casEnabled(env)) return null;
  return new CasStore(casRepositoryDir(root, env), { readsEnabled: !options.noReads });
}

// ─── ref manifests ───────────────────────────────────────────────────────────

export interface ManifestEntry {
  /** Repo-relative POSIX path. */
  path: string;
  /** Object address (`b3:<hash>`). */
  addr: string;
  size: number;
}

/**
 * A ref is a catalog: the tree it was composed from as `path → addr`, plus the
 * identity of the engine that produced the objects. Sorted by path.
 */
export interface RefManifest {
  schema: typeof MANIFEST_SCHEMA;
  repoId: string;
  /** Branch name, detached SHA, or `current` when not in git. */
  ref: string;
  /** Full HEAD SHA when known. */
  commit?: string;
  /** Repository root at write time (debugging only — never used for identity). */
  root: string;
  engine: string;
  corpusHash: string;
  files: ManifestEntry[];
}

/** Write a manifest for `manifest.ref` into the store. Best-effort; returns the path or null. */
export function writeRefManifest(store: CasStore, manifest: RefManifest): string | null {
  const file = store.manifestPath(manifest.ref);
  const sorted: RefManifest = {
    ...manifest,
    files: [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  return writeAtomic(file, Buffer.from(stableStringify(sorted, 0))) ? file : null;
}

/** Read the manifest last written for `ref` (or `current`) in this repository's store. */
export function loadRefManifest(root: string, ref: string, env: NodeJS.ProcessEnv = process.env): RefManifest | null {
  if (!casEnabled(env)) return null;
  const store = new CasStore(casRepositoryDir(root, env), { readsEnabled: true });
  try {
    const m = JSON.parse(fs.readFileSync(store.manifestPath(ref), 'utf8')) as RefManifest;
    if (m?.schema !== MANIFEST_SCHEMA || !Array.isArray(m.files)) return null;
    return m;
  } catch {
    return null;
  }
}

/** Full HEAD SHA for a checkout, or undefined when not a git repository. */
export function gitHeadCommit(root: string): string | undefined {
  try {
    const res = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const sha = (res.stdout ?? '').trim();
    return res.status === 0 && /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function newPackr(): Packr {
  // A fresh Packr per encode/decode keeps record-id assignment deterministic
  // (same convention as snapshot.ts).
  return new Packr({ useRecords: true });
}

/** `BAAI/bge-small-en-v1.5` → `BAAI__bge-small-en-v1.5`; never a path separator. */
function safeSegment(id: string): string {
  return id.replace(/\//g, '__').replace(/[^A-Za-z0-9._@+-]+/g, '_') || 'unnamed';
}

let tmpSeq = 0;

/** Temp + rename so a concurrent reader never sees a torn object. Returns success. */
function writeAtomic(file: string, data: Buffer): boolean {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    return false;
  }
}
