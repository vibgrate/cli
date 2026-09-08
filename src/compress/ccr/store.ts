/**
 * CompressionStore — where dropped originals live until they are retrieved.
 *
 * Two backends behind one API: `memory` (per process) and `disk` (shared by
 * every vg process on the machine; one `<hash>.json` per entry under
 * `ccrStoreDir()` plus an `index.json` for TTL/LRU bookkeeping). Keys are
 * content-derived (`sha256(original)[:24]`) so identical originals share one
 * entry and a marker written by one process resolves in another.
 *
 * Guarantees:
 *  - redaction at ingest (`redactText`); entries that were altered carry
 *    `status: 'redacted'` and stay retrievable;
 *  - every file `0o600`, every directory `0o700`, atomic tmp+rename writes;
 *  - TTL (default 1800 s) and LRU eviction (default 1000 entries) driven by
 *    an injected clock, so tests and hashes are deterministic;
 *  - a bare marker is never persisted as an "original";
 *  - `exists()` is pure (no TTL sweep); `get()`/`retrieve()` observe TTL and
 *    record why an entry is gone (`expired` | `evicted` | `missing`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { redactText } from '../../code/secrets.js';
import { countTokens, truncateToTokens } from '../../engine/tokens.js';
import { env as knobs } from '../config.js';
import { ccrStoreDir } from '../paths.js';
import type { CcrSink, CcrStoreMeta } from '../types.js';
import { MARKER_PREFIX, MARKER_SUFFIX, isValidHash } from './markers.js';

export type EntryStatus = 'active' | 'expired' | 'evicted' | 'missing' | 'redacted';

export interface StoredEntry {
  hash: string;
  original: string;
  compressed: string;
  strategy: string;
  originalTokens: number;
  compressedTokens: number;
  originalItemCount?: number;
  compressedItemCount?: number;
  toolName?: string;
  toolCallId?: string;
  queryContext?: string;
  createdAt: number;
  expiresAt: number;
  status: EntryStatus;
  /** Times `retrieve()` returned this entry. */
  retrievalCount?: number;
  lastAccessedAt?: number;
}

export interface StoreOptions {
  backend?: 'memory' | 'disk';
  dir?: string;
  ttlSeconds?: number;
  maxEntries?: number;
  maxEntryBytes?: number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export interface RetrieveOptions {
  /** Case-insensitive literal; returns matching lines with `N:` prefixes. */
  grep?: string;
  /** 1-based inclusive line range. */
  lines?: [number, number];
  head?: number;
  tail?: number;
  /** Dotted path with `[i]` indexes into a JSON original (`items[0].name`). */
  jsonPath?: string;
  maxTokens?: number;
}

export interface RetrieveResult {
  found: boolean;
  hash: string;
  status: EntryStatus;
  content: string;
  truncated: boolean;
  /** Which targeted view produced `content` (`full` when none). */
  view: 'full' | 'grep' | 'lines' | 'head' | 'tail' | 'jsonPath';
  totalLines?: number;
  matchedLines?: number;
  entry?: StoredEntry;
  /** Human-readable reason on a miss. */
  detail?: string;
}

export interface StoreStats {
  backend: 'memory' | 'disk';
  entries: number;
  maxEntries: number;
  ttlSeconds: number;
  maxEntryBytes: number;
  totalOriginalTokens: number;
  totalCompressedTokens: number;
  totalRetrievals: number;
  redacted: number;
  bytes: number;
  dir?: string;
}

/** Thrown by `store()` when an original exceeds `maxEntryBytes`; callers fail open (block stays uncompressed). */
export class CcrEntryTooLargeError extends Error {
  constructor(
    public readonly bytes: number,
    public readonly limit: number,
  ) {
    super(`original is ${bytes} bytes; store limit is ${limit}`);
    this.name = 'CcrEntryTooLargeError';
  }
}

export const DEFAULT_TTL_SECONDS = 1800;
export const DEFAULT_MAX_ENTRIES = 1000;
export const DEFAULT_MAX_ENTRY_BYTES = 5_000_000;

const encoder = new TextEncoder();

/** `sha256(text)` hex, first 24 chars (96 bits). */
export function hashOriginal(text: string): string {
  return bytesToHex(sha256(encoder.encode(text))).slice(0, 24);
}

/** 12-char form used inside opaque markers. */
export function shortHash(hash: string): string {
  return hash.toLowerCase().slice(0, 12);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isBareMarker(original: string): boolean {
  const s = original.trim();
  return s.startsWith(MARKER_PREFIX) && s.endsWith(MARKER_SUFFIX) && !s.includes('\n');
}

interface IndexRow {
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  bytes: number;
}

/** Storage abstraction: never checks TTL (the store does). */
interface Backend {
  readonly kind: 'memory' | 'disk';
  get(hash: string): StoredEntry | null;
  set(entry: StoredEntry): void;
  delete(hash: string): boolean;
  has(hash: string): boolean;
  keys(): string[];
  clear(): void;
  bytes(): number;
  dir?: string;
}

class MemoryBackend implements Backend {
  readonly kind = 'memory' as const;
  private readonly map = new Map<string, StoredEntry>();
  get(hash: string): StoredEntry | null {
    const e = this.map.get(hash);
    return e ? { ...e } : null;
  }
  set(entry: StoredEntry): void {
    this.map.set(entry.hash, { ...entry });
  }
  delete(hash: string): boolean {
    return this.map.delete(hash);
  }
  has(hash: string): boolean {
    return this.map.has(hash);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
  clear(): void {
    this.map.clear();
  }
  bytes(): number {
    let n = 0;
    for (const e of this.map.values()) n += byteLength(e.original) + byteLength(e.compressed);
    return n;
  }
}

let tmpCounter = 0;

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  tmpCounter += 1;
  const tmp = `${file}.${process.pid}.${tmpCounter.toString(36)}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* non-POSIX */
  }
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const ENTRY_KEYS: ReadonlyArray<keyof StoredEntry> = [
  'hash',
  'original',
  'compressed',
  'strategy',
  'originalTokens',
  'compressedTokens',
  'originalItemCount',
  'compressedItemCount',
  'toolName',
  'toolCallId',
  'queryContext',
  'createdAt',
  'expiresAt',
  'status',
  'retrievalCount',
  'lastAccessedAt',
];

function coerceEntry(raw: unknown): StoredEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.hash !== 'string' || typeof r.original !== 'string') return null;
  const out: Record<string, unknown> = {};
  for (const k of ENTRY_KEYS) if (r[k] !== undefined) out[k] = r[k];
  const e = out as unknown as StoredEntry;
  e.compressed = typeof e.compressed === 'string' ? e.compressed : '';
  e.strategy = typeof e.strategy === 'string' ? e.strategy : 'unknown';
  e.originalTokens = typeof e.originalTokens === 'number' ? e.originalTokens : 0;
  e.compressedTokens = typeof e.compressedTokens === 'number' ? e.compressedTokens : 0;
  e.createdAt = typeof e.createdAt === 'number' ? e.createdAt : 0;
  e.expiresAt = typeof e.expiresAt === 'number' ? e.expiresAt : 0;
  e.status = e.status === 'redacted' ? 'redacted' : 'active';
  return e;
}

class DiskBackend implements Backend {
  readonly kind = 'disk' as const;
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private file(hash: string): string {
    return path.join(this.dir, `${hash}.json`);
  }
  get(hash: string): StoredEntry | null {
    if (!isValidHash(hash)) return null;
    return coerceEntry(readJson(this.file(hash)));
  }
  set(entry: StoredEntry): void {
    writeAtomic(this.file(entry.hash), JSON.stringify(entry));
  }
  delete(hash: string): boolean {
    if (!isValidHash(hash)) return false;
    try {
      fs.rmSync(this.file(hash), { force: true });
      return true;
    } catch {
      return false;
    }
  }
  has(hash: string): boolean {
    return isValidHash(hash) && fs.existsSync(this.file(hash));
  }
  keys(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.json') && f !== 'index.json' && isValidHash(f.slice(0, -5)))
        .map((f) => f.slice(0, -5))
        .sort();
    } catch {
      return [];
    }
  }
  clear(): void {
    for (const k of this.keys()) this.delete(k);
    try {
      fs.rmSync(path.join(this.dir, 'index.json'), { force: true });
    } catch {
      /* ignore */
    }
  }
  bytes(): number {
    let n = 0;
    for (const k of this.keys()) {
      try {
        n += fs.statSync(this.file(k)).size;
      } catch {
        /* raced */
      }
    }
    return n;
  }
}

export class CompressionStore implements CcrSink {
  readonly ttlSeconds: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  private readonly backend: Backend;
  private readonly now: () => number;
  /** hash → bookkeeping (authoritative for LRU order; mirrors index.json on disk). */
  private index = new Map<string, IndexRow>();
  /** Why a hash is gone, for actionable miss messages. */
  private readonly tombstones = new Map<string, 'expired' | 'evicted'>();
  private totalRetrievals = 0;

  constructor(opts: StoreOptions = {}) {
    const e = opts.env ?? process.env;
    this.now = opts.now ?? (() => Date.now());
    this.ttlSeconds = positive(opts.ttlSeconds, knobs.int('VG_CCR_TTL_SECONDS', e), DEFAULT_TTL_SECONDS);
    this.maxEntries = positive(opts.maxEntries, knobs.int('VG_CCR_MAX_ENTRIES', e), DEFAULT_MAX_ENTRIES);
    this.maxEntryBytes = positive(opts.maxEntryBytes, knobs.int('VG_CCR_MAX_ENTRY_BYTES', e), DEFAULT_MAX_ENTRY_BYTES);
    const backend = opts.backend ?? 'memory';
    if (backend === 'disk') {
      this.backend = new DiskBackend(opts.dir ?? ccrStoreDir(e));
      this.loadIndex();
    } else {
      this.backend = new MemoryBackend();
    }
  }

  get backendKind(): 'memory' | 'disk' {
    return this.backend.kind;
  }

  get dir(): string | undefined {
    return this.backend.dir;
  }

  // --- CcrSink ------------------------------------------------------------

  store(original: string, meta: CcrStoreMeta): string {
    const explicit = meta.explicitHash;
    let hash: string;
    if (explicit !== undefined) {
      if (!isValidHash(explicit)) throw new Error(`explicitHash must be 12 or 24 hex chars, got ${JSON.stringify(explicit)}`);
      hash = explicit.toLowerCase();
    } else {
      hash = hashOriginal(original);
    }
    if (isBareMarker(original)) return hash; // never persist a marker as an "original"
    const bytes = byteLength(original);
    if (bytes > this.maxEntryBytes) throw new CcrEntryTooLargeError(bytes, this.maxEntryBytes);

    const redacted = redactText(original);
    const status: EntryStatus = redacted === original ? 'active' : 'redacted';
    const t = this.now();
    const ttl = positive(meta.ttlSeconds, undefined, this.ttlSeconds);
    const existed = this.index.has(hash) || this.backend.has(hash);
    if (!existed) this.evictIfNeeded(t);
    const entry: StoredEntry = {
      hash,
      original: redacted,
      compressed: meta.compressed,
      strategy: String(meta.strategy),
      originalTokens: meta.originalTokens ?? countTokens(redacted),
      compressedTokens: meta.compressedTokens ?? countTokens(meta.compressed),
      createdAt: t,
      expiresAt: t + ttl * 1000,
      status,
      retrievalCount: existed ? (this.backend.get(hash)?.retrievalCount ?? 0) : 0,
    };
    if (meta.originalItemCount !== undefined) entry.originalItemCount = meta.originalItemCount;
    if (meta.compressedItemCount !== undefined) entry.compressedItemCount = meta.compressedItemCount;
    if (meta.toolName) entry.toolName = meta.toolName;
    if (meta.toolCallId) entry.toolCallId = meta.toolCallId;
    if (meta.queryContext) entry.queryContext = meta.queryContext.slice(0, 2000);
    this.backend.set(entry);
    this.index.set(hash, { createdAt: t, expiresAt: entry.expiresAt, lastAccessedAt: t, bytes });
    this.tombstones.delete(hash);
    this.persistIndex();
    return hash;
  }

  exists(hash: string): boolean {
    const h = this.resolveKey(hash);
    if (!h) return false;
    return this.index.has(h) || this.backend.has(h);
  }

  /**
   * Store key for a marker hash: exact for 24-char hashes; a 12-char short
   * hash resolves to its own key when stored explicitly, else to the unique
   * 24-char key it prefixes (markers carry the short form of the full key).
   */
  resolveKey(hash: unknown): string | null {
    if (!isValidHash(hash)) return null;
    const h = hash.toLowerCase();
    if (h.length === 24 || this.index.has(h) || this.backend.has(h)) return h;
    let found: string | null = null;
    for (const key of this.allKeys()) {
      if (!key.startsWith(h)) continue;
      if (found !== null) return null; // ambiguous
      found = key;
    }
    return found ?? h;
  }

  // --- reads --------------------------------------------------------------

  /** Entry when active (or redacted); null when expired/evicted/missing (status recorded for `statusOf`). */
  get(hash: string): StoredEntry | null {
    const h = this.resolveKey(hash);
    if (!h) return null;
    const entry = this.backend.get(h);
    if (!entry) {
      this.index.delete(h);
      return null;
    }
    if (this.isExpired(entry)) {
      this.dropEntry(h, 'expired');
      return null;
    }
    if (!this.index.has(h)) this.index.set(h, { createdAt: entry.createdAt, expiresAt: entry.expiresAt, lastAccessedAt: entry.createdAt, bytes: byteLength(entry.original) });
    return entry;
  }

  /** Status of a hash without touching it: `active|redacted|expired|evicted|missing`. */
  statusOf(hash: string): { status: EntryStatus; ttlSeconds: number; ageSeconds?: number; createdAt?: number; expiresAt?: number } {
    const h = this.resolveKey(hash);
    if (!h) return { status: 'missing', ttlSeconds: this.ttlSeconds };
    const entry = this.backend.get(h);
    if (entry) {
      const age = Math.max(0, (this.now() - entry.createdAt) / 1000);
      const ttl = Math.max(0, Math.round((entry.expiresAt - entry.createdAt) / 1000));
      return { status: this.isExpired(entry) ? 'expired' : entry.status, ttlSeconds: ttl, ageSeconds: age, createdAt: entry.createdAt, expiresAt: entry.expiresAt };
    }
    const tomb = this.tombstones.get(h);
    return { status: tomb ?? 'missing', ttlSeconds: this.ttlSeconds };
  }

  /** Actionable miss text for the model. */
  missDetail(hash: string): string {
    const s = this.statusOf(hash);
    if (s.status === 'expired') {
      return s.ageSeconds !== undefined
        ? `Entry expired (retrieval TTL: ${s.ttlSeconds} seconds; age: ${Math.round(s.ageSeconds)} seconds)`
        : `Entry expired (retrieval TTL: ${s.ttlSeconds} seconds)`;
    }
    if (s.status === 'evicted') return `Entry evicted (store holds at most ${this.maxEntries} originals)`;
    return `Entry not found (retrieval TTL: ${this.ttlSeconds} seconds)`;
  }

  /** Full or targeted retrieval; bumps access bookkeeping on a hit. */
  retrieve(hash: string, opts: RetrieveOptions = {}): RetrieveResult {
    const h = this.resolveKey(hash) ?? String(hash ?? '');
    const entry = this.get(h);
    if (!entry) {
      const status = this.statusOf(h).status;
      return { found: false, hash: h, status, content: '', truncated: false, view: 'full', detail: this.missDetail(h) };
    }
    const t = this.now();
    entry.retrievalCount = (entry.retrievalCount ?? 0) + 1;
    entry.lastAccessedAt = t;
    this.backend.set(entry);
    const row = this.index.get(h);
    if (row) row.lastAccessedAt = t;
    this.totalRetrievals += 1;
    this.persistIndex();

    const view = targetedView(entry.original, opts);
    let content = view.content;
    let truncated = false;
    if (opts.maxTokens !== undefined && opts.maxTokens > 0) {
      const tr = truncateToTokens(content, opts.maxTokens, '\n…(truncated; narrow with grep/lines/head/tail)');
      content = tr.text;
      truncated = tr.truncated;
    }
    return { found: true, hash: h, status: entry.status, content, truncated, view: view.view, totalLines: view.totalLines, matchedLines: view.matchedLines, entry };
  }

  // --- maintenance --------------------------------------------------------

  delete(hash: string): boolean {
    const h = this.resolveKey(hash);
    if (!h) return false;
    const had = this.backend.delete(h);
    const hadIndex = this.index.delete(h);
    if (had || hadIndex) this.persistIndex();
    return had || hadIndex;
  }

  /** Remove expired entries; returns how many. */
  purgeExpired(): number {
    let n = 0;
    for (const h of this.allKeys()) {
      const entry = this.backend.get(h);
      if (!entry) {
        this.index.delete(h);
        continue;
      }
      if (this.isExpired(entry)) {
        this.dropEntry(h, 'expired', false);
        n += 1;
      }
    }
    if (n) this.persistIndex();
    return n;
  }

  clear(): void {
    this.backend.clear();
    this.index.clear();
    this.tombstones.clear();
    this.persistIndex();
  }

  stats(): StoreStats {
    let totalOriginalTokens = 0;
    let totalCompressedTokens = 0;
    let redacted = 0;
    let entries = 0;
    for (const h of this.allKeys()) {
      const e = this.backend.get(h);
      if (!e || this.isExpired(e)) continue;
      entries += 1;
      totalOriginalTokens += e.originalTokens;
      totalCompressedTokens += e.compressedTokens;
      if (e.status === 'redacted') redacted += 1;
    }
    const out: StoreStats = {
      backend: this.backend.kind,
      entries,
      maxEntries: this.maxEntries,
      ttlSeconds: this.ttlSeconds,
      maxEntryBytes: this.maxEntryBytes,
      totalOriginalTokens,
      totalCompressedTokens,
      totalRetrievals: this.totalRetrievals,
      redacted,
      bytes: this.backend.bytes(),
    };
    if (this.backend.dir) out.dir = this.backend.dir;
    return out;
  }

  /** Live entries sorted by createdAt, then hash. */
  list(): StoredEntry[] {
    const out: StoredEntry[] = [];
    for (const h of this.allKeys()) {
      const e = this.backend.get(h);
      if (e && !this.isExpired(e)) out.push(e);
    }
    out.sort((a, b) => a.createdAt - b.createdAt || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    return out;
  }

  // --- internals ----------------------------------------------------------

  private allKeys(): string[] {
    const keys = new Set<string>(this.index.keys());
    for (const k of this.backend.keys()) keys.add(k);
    return [...keys].sort();
  }

  private isExpired(entry: StoredEntry): boolean {
    return this.now() > entry.expiresAt;
  }

  private dropEntry(hash: string, why: 'expired' | 'evicted', persist = true): void {
    this.backend.delete(hash);
    this.index.delete(hash);
    this.tombstones.set(hash, why);
    if (this.tombstones.size > 4096) {
      const first = this.tombstones.keys().next().value;
      if (first !== undefined) this.tombstones.delete(first);
    }
    if (persist) this.persistIndex();
  }

  /** Called before inserting a NEW key: sweep expired, then LRU-evict down to maxEntries-1. */
  private evictIfNeeded(t: number): void {
    for (const [h, row] of [...this.index.entries()]) {
      if (t > row.expiresAt) this.dropEntry(h, 'expired', false);
    }
    if (this.index.size < this.maxEntries) return;
    const rows = [...this.index.entries()].sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt || a[1].createdAt - b[1].createdAt || (a[0] < b[0] ? -1 : 1));
    let i = 0;
    while (this.index.size >= this.maxEntries && i < rows.length) {
      this.dropEntry(rows[i][0], 'evicted', false);
      i += 1;
    }
  }

  private loadIndex(): void {
    if (!this.backend.dir) return;
    const raw = readJson<Record<string, IndexRow>>(path.join(this.backend.dir, 'index.json'));
    this.index = new Map();
    if (raw && typeof raw === 'object') {
      for (const [h, row] of Object.entries(raw)) {
        if (isValidHash(h) && row && typeof row === 'object' && typeof row.expiresAt === 'number') this.index.set(h, row);
      }
    }
    // Pick up entries written by other processes since the index was saved.
    for (const h of this.backend.keys()) {
      if (this.index.has(h)) continue;
      const e = this.backend.get(h);
      if (e) this.index.set(h, { createdAt: e.createdAt, expiresAt: e.expiresAt, lastAccessedAt: e.lastAccessedAt ?? e.createdAt, bytes: byteLength(e.original) });
    }
  }

  private persistIndex(): void {
    if (!this.backend.dir) return;
    const sorted: Record<string, IndexRow> = {};
    for (const h of [...this.index.keys()].sort()) sorted[h] = this.index.get(h)!;
    try {
      writeAtomic(path.join(this.backend.dir, 'index.json'), JSON.stringify(sorted));
    } catch {
      /* best effort: the per-entry files remain authoritative */
    }
  }
}

function positive(explicit: number | undefined, fromEnv: number | undefined, fallback: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  if (fromEnv !== undefined && Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return fallback;
}

// --- targeted views ---------------------------------------------------------

function targetedView(original: string, opts: RetrieveOptions): { content: string; view: RetrieveResult['view']; totalLines?: number; matchedLines?: number } {
  if (opts.jsonPath !== undefined && opts.jsonPath !== '') {
    const picked = jsonPathPick(original, opts.jsonPath);
    if (picked !== undefined) return { content: picked, view: 'jsonPath' };
  }
  const lines = original.split('\n');
  const total = lines.length;
  if (opts.grep) {
    const needle = opts.grep.toLowerCase();
    const hits: string[] = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(needle)) hits.push(`${i + 1}:${lines[i]}`);
    return { content: hits.join('\n'), view: 'grep', totalLines: total, matchedLines: hits.length };
  }
  if (opts.lines) {
    const a = Math.max(1, Math.floor(opts.lines[0]));
    const b = Math.min(total, Math.floor(opts.lines[1]));
    if (b >= a) return { content: lines.slice(a - 1, b).join('\n'), view: 'lines', totalLines: total, matchedLines: b - a + 1 };
    return { content: '', view: 'lines', totalLines: total, matchedLines: 0 };
  }
  if (opts.head !== undefined && opts.head > 0) {
    const n = Math.min(total, Math.floor(opts.head));
    return { content: lines.slice(0, n).join('\n'), view: 'head', totalLines: total, matchedLines: n };
  }
  if (opts.tail !== undefined && opts.tail > 0) {
    const n = Math.min(total, Math.floor(opts.tail));
    return { content: lines.slice(total - n).join('\n'), view: 'tail', totalLines: total, matchedLines: n };
  }
  return { content: original, view: 'full', totalLines: total };
}

/** `a.b[0].c` over parsed JSON; undefined when the original is not JSON or the path misses. */
export function jsonPathPick(original: string, jsonPath: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(original);
  } catch {
    return undefined;
  }
  const segs = jsonPath
    .replace(/^\$\.?/, '')
    .split(/\.|\[|\]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const seg of segs) {
    if (value === null || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
      if (!/^\d+$/.test(seg)) return undefined;
      value = value[Number.parseInt(seg, 10)];
    } else {
      value = (value as Record<string, unknown>)[seg];
    }
    if (value === undefined) return undefined;
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

// --- singleton ---------------------------------------------------------------

const singletons = new Map<string, CompressionStore>();

/** Process-wide store honoring `VG_CCR_BACKEND` (disk by default) and `VG_CCR_STORE_DIR`/`VG_CONTEXT_DIR`. */
export function defaultStore(env: NodeJS.ProcessEnv = process.env): CompressionStore {
  const backend = knobs.enum<'memory' | 'disk'>('VG_CCR_BACKEND', env);
  const dir = backend === 'disk' ? ccrStoreDir(env) : '';
  const key = `${backend}:${dir}`;
  let s = singletons.get(key);
  if (!s) {
    try {
      s = new CompressionStore({ backend, dir: dir || undefined, env });
    } catch {
      s = new CompressionStore({ backend: 'memory', env });
    }
    singletons.set(key, s);
  }
  return s;
}

/** Test hook: forget every singleton. */
export function resetDefaultStores(): void {
  singletons.clear();
}
