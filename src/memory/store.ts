/**
 * `MemoryStore` — one JSONL file per scope under `memoryDir()`.
 *
 *   <memoryDir>/projects/<projectKey>/memories.jsonl
 *   <memoryDir>/users/<userKey>/memories.jsonl
 *   <memoryDir>/global/memories.jsonl
 *
 * Guarantees:
 *  - redaction at ingest (`redactText`) — a secret pasted into a memory is
 *    masked before it ever touches disk;
 *  - deterministic ids: `id = blake3(scope|kind|text|project)[:16]`, so the
 *    same statement gets the same id on every machine and re-adding it bumps
 *    `evidence` instead of duplicating;
 *  - files `0o600`, directories `0o700`, writes via tmp + rename;
 *  - fail closed on project scope: with no resolvable project root the
 *    project file is the `no-project` sentinel, which `search` never reads.
 *
 * No wall-clock reads: callers inject `now`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalize, hashString } from '../engine/hash.js';
import { redactText } from '../code/secrets.js';
import { memoryGlobalDir, memoryProjectDir, memoryUserDir } from '../compress/paths.js';
import { rankMemories } from './rank.js';
import { resolveProject, type GitRunner, type ResolvedProject } from './project.js';
import {
  DEFAULT_USER,
  NO_PROJECT,
  isMemoryKind,
  isMemoryScope,
  isMemorySource,
  normalizeMemoryText,
  normalizeTags,
  type ListOptions,
  type Memory,
  type MemoryInput,
  type MemoryScope,
  type MemoryStats,
  type SearchHit,
  type SearchOptions,
  type VectorHook,
} from './types.js';

export const MEMORY_FILE = 'memories.jsonl';

export interface MemoryStoreOptions {
  /** Explicit project root (skips git resolution). */
  projectRoot?: string;
  /** Directory the project is resolved from when `projectRoot` is absent (default: cwd). */
  cwd?: string;
  userId?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  git?: GitRunner;
  /** Optional synchronous embedding hook for hybrid search. */
  vectors?: VectorHook;
}

/** Sanitise a user id for use as a directory name. */
export function userKey(userId: string | undefined, env: NodeJS.ProcessEnv): string {
  const raw = (userId ?? env.VG_MEMORY_USER_ID ?? '').trim() || DEFAULT_USER;
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 64);
  return safe || DEFAULT_USER;
}

/** Content hash that defines identity: scope + kind + normalised text (+ project key). */
export function memoryHash(scope: MemoryScope, kind: string, text: string, project?: string): string {
  return hashString(canonicalize({ kind, project: scope === 'project' ? (project ?? '') : undefined, scope, text }));
}

export function memoryIdFromHash(hash: string): string {
  return hash.slice(0, 16);
}

/** Parse one JSONL line into a Memory; null when malformed (tolerant reader). */
export function parseMemoryLine(line: string): Memory | null {
  const t = line.trim();
  if (!t) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== 'string' || !isMemoryScope(r.scope) || !isMemoryKind(r.kind)) return null;
  const text = normalizeMemoryText(r.text);
  if (!text) return null;
  const project = typeof r.project === 'string' ? r.project : undefined;
  const hash = typeof r.hash === 'string' && r.hash.length >= 16 ? r.hash : memoryHash(r.scope, r.kind, text, project);
  const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0;
  const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : createdAt;
  const evidence = typeof r.evidence === 'number' && Number.isFinite(r.evidence) && r.evidence >= 1 ? Math.floor(r.evidence) : 1;
  const m: Memory = {
    id: typeof r.id === 'string' && r.id ? r.id : memoryIdFromHash(hash),
    scope: r.scope,
    kind: r.kind,
    text,
    tags: normalizeTags(Array.isArray(r.tags) ? (r.tags as string[]) : []),
    source: isMemorySource(r.source) ? r.source : 'imported',
    createdAt,
    updatedAt,
    evidence,
    hash,
  };
  if (project) m.project = project;
  return m;
}

/** Canonical JSONL line (sorted keys) for a memory. */
export function serializeMemory(m: Memory): string {
  return canonicalize(m);
}

function compareForFile(a: Memory, b: Memory): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareForList(a: Memory, b: Memory): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

let tmpSeq = 0;

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  tmpSeq += 1;
  const tmp = `${file}.${process.pid}.${tmpSeq}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
}

export class MemoryStore {
  readonly env: NodeJS.ProcessEnv;
  readonly project: ResolvedProject;
  readonly userKey: string;
  private readonly now: () => number;
  private readonly vectors?: VectorHook;
  private readonly loaded = new Map<MemoryScope, Map<string, Memory>>();
  private readonly vectorCache = new Map<string, number[]>();

  constructor(opts: MemoryStoreOptions = {}) {
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => Date.now());
    this.vectors = opts.vectors;
    this.userKey = userKey(opts.userId, this.env);
    this.project = resolveProject(opts.cwd ?? process.cwd(), { env: this.env, git: opts.git, root: opts.projectRoot });
  }

  /** Whether project-scoped memories are readable for injection (fail closed otherwise). */
  get projectResolved(): boolean {
    return this.project.resolved && this.project.key !== NO_PROJECT;
  }

  get projectKey(): string {
    return this.project.key;
  }

  /** Absolute JSONL path for a scope. */
  filePath(scope: MemoryScope): string {
    switch (scope) {
      case 'project':
        return path.join(memoryProjectDir(this.project.key, this.env), MEMORY_FILE);
      case 'user':
        return path.join(memoryUserDir(this.userKey, this.env), MEMORY_FILE);
      default:
        return path.join(memoryGlobalDir(this.env), MEMORY_FILE);
    }
  }

  /** Drop the in-memory cache so the next read re-parses the files. */
  reload(): void {
    this.loaded.clear();
  }

  private scopeMap(scope: MemoryScope): Map<string, Memory> {
    const cached = this.loaded.get(scope);
    if (cached) return cached;
    const map = new Map<string, Memory>();
    const file = this.filePath(scope);
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      raw = '';
    }
    for (const line of raw.split('\n')) {
      const m = parseMemoryLine(line);
      if (!m) continue;
      if (m.scope !== scope) continue;
      const prev = map.get(m.id);
      if (prev) {
        // Duplicate line (e.g. concatenated exports): keep the richer one.
        prev.evidence = Math.max(prev.evidence, m.evidence);
        prev.updatedAt = Math.max(prev.updatedAt, m.updatedAt);
        prev.tags = normalizeTags([...prev.tags, ...m.tags]);
        continue;
      }
      map.set(m.id, m);
    }
    this.loaded.set(scope, map);
    return map;
  }

  private persist(scope: MemoryScope): void {
    const map = this.scopeMap(scope);
    const rows = [...map.values()].sort(compareForFile);
    const file = this.filePath(scope);
    if (rows.length === 0) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* nothing to remove */
      }
      return;
    }
    writeAtomic(file, rows.map(serializeMemory).join('\n') + '\n');
  }

  /**
   * Add (or reinforce) a memory. Identical statements in the same scope +
   * kind merge: evidence accumulates, tags union, `updatedAt` advances.
   */
  add(input: MemoryInput): Memory {
    const text = normalizeMemoryText(redactText(input.text ?? ''));
    if (!text) throw new Error('memory text is empty');
    const scope: MemoryScope = isMemoryScope(input.scope) ? input.scope : 'project';
    const kind = isMemoryKind(input.kind) ? input.kind : 'fact';
    const project = scope === 'project' ? this.project.key : undefined;
    const hash = memoryHash(scope, kind, text, project);
    const id = memoryIdFromHash(hash);
    const now = this.now();
    const map = this.scopeMap(scope);
    const inc = Math.max(1, Math.floor(input.evidence ?? 1));
    const tags = normalizeTags(input.tags);
    const existing = map.get(id);
    if (existing) {
      existing.evidence += inc;
      existing.updatedAt = Math.max(existing.updatedAt, now);
      existing.tags = normalizeTags([...existing.tags, ...tags]);
      this.persist(scope);
      return { ...existing, tags: [...existing.tags] };
    }
    const m: Memory = {
      id,
      scope,
      kind,
      text,
      tags,
      source: isMemorySource(input.source) ? input.source : 'agent',
      createdAt: now,
      updatedAt: now,
      evidence: inc,
      hash,
    };
    if (project) m.project = project;
    map.set(id, m);
    this.persist(scope);
    return { ...m, tags: [...m.tags] };
  }

  get(id: string): Memory | null {
    for (const scope of ['project', 'user', 'global'] as const) {
      const m = this.scopeMap(scope).get(id);
      if (m) return { ...m, tags: [...m.tags] };
    }
    // Prefix lookup (CLI convenience) — unique prefix only.
    const all = this.list();
    const hits = all.filter((m) => m.id.startsWith(id));
    return hits.length === 1 ? hits[0] : null;
  }

  /** Replace a memory's text. The id changes (content-addressed); returns the new memory. */
  update(id: string, text: string, opts: { kind?: Memory['kind']; tags?: string[] } = {}): Memory | null {
    const old = this.get(id);
    if (!old) return null;
    this.delete(old.id);
    return this.add({
      scope: old.scope,
      kind: opts.kind ?? old.kind,
      text,
      tags: opts.tags ?? old.tags,
      source: old.source,
      evidence: old.evidence,
      project: old.project,
    });
  }

  delete(id: string): boolean {
    for (const scope of ['project', 'user', 'global'] as const) {
      const map = this.scopeMap(scope);
      if (map.delete(id)) {
        this.persist(scope);
        return true;
      }
    }
    const resolved = this.get(id);
    if (resolved && resolved.id !== id) return this.delete(resolved.id);
    return false;
  }

  /** Remove every memory in `scope` (or all scopes). Returns the count removed. */
  clear(scope?: MemoryScope): number {
    const scopes: MemoryScope[] = scope ? [scope] : ['project', 'user', 'global'];
    let n = 0;
    for (const s of scopes) {
      const map = this.scopeMap(s);
      n += map.size;
      map.clear();
      this.persist(s);
    }
    return n;
  }

  /** Scopes `search` reads by default: project only when resolved (fail closed). */
  private searchableScopes(requested?: MemoryScope[]): MemoryScope[] {
    const base: MemoryScope[] = requested ?? ['project', 'user', 'global'];
    return base.filter((s) => s !== 'project' || this.projectResolved);
  }

  private candidates(scopes: MemoryScope[], kinds?: Memory['kind'][]): Memory[] {
    const out: Memory[] = [];
    for (const s of scopes) for (const m of this.scopeMap(s).values()) if (!kinds || kinds.includes(m.kind)) out.push(m);
    return out;
  }

  private vectorsFor(memories: Memory[]): ReadonlyMap<string, number[]> | undefined {
    const hook = this.vectors;
    if (!hook) return undefined;
    const missing = memories.filter((m) => !this.vectorCache.has(`${hook.id}:${m.hash}`));
    if (missing.length) {
      let vecs: number[][] = [];
      try {
        vecs = hook.embed(missing.map((m) => m.text));
      } catch {
        return undefined; // fail open: lexical only
      }
      missing.forEach((m, i) => {
        const v = vecs[i];
        if (Array.isArray(v)) this.vectorCache.set(`${hook.id}:${m.hash}`, v);
      });
    }
    const out = new Map<string, number[]>();
    for (const m of memories) {
      const v = this.vectorCache.get(`${hook.id}:${m.hash}`);
      if (v) out.set(m.id, v);
    }
    return out;
  }

  /**
   * Rank memories for `query`. Lexical (BM25) by default; hybrid when a
   * vector hook is configured or `opts.queryVector` is supplied.
   */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const scopes = this.searchableScopes(opts.scope);
    const cands = this.candidates(scopes, opts.kinds);
    if (cands.length === 0) return [];
    let queryVector = opts.queryVector;
    let vectors: ReadonlyMap<string, number[]> | undefined;
    if (this.vectors && !queryVector) {
      try {
        queryVector = this.vectors.embed([query])[0];
      } catch {
        queryVector = undefined;
      }
    }
    if (queryVector) vectors = this.vectorsFor(cands);
    const hits = rankMemories(cands, query, { now: this.now(), topK: opts.topK ?? 10, minScore: opts.minScore, queryVector, vectors });
    return hits.map((h) => ({ memory: { ...h.memory, tags: [...h.memory.tags] }, score: h.score }));
  }

  list(opts: ListOptions = {}): Memory[] {
    const scopes: MemoryScope[] = opts.scope ?? ['project', 'user', 'global'];
    let rows = this.candidates(scopes, opts.kinds);
    if (opts.source) rows = rows.filter((m) => opts.source?.includes(m.source));
    if (opts.tags && opts.tags.length) {
      const want = normalizeTags(opts.tags);
      rows = rows.filter((m) => want.every((t) => m.tags.includes(t)));
    }
    rows.sort(compareForList);
    if (opts.limit !== undefined && opts.limit >= 0) rows = rows.slice(0, opts.limit);
    return rows.map((m) => ({ ...m, tags: [...m.tags] }));
  }

  stats(): MemoryStats {
    const byScope: Record<MemoryScope, number> = { project: 0, user: 0, global: 0 };
    const byKind: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let evidence = 0;
    let total = 0;
    const files: MemoryStats['files'] = [];
    for (const scope of ['project', 'user', 'global'] as const) {
      const map = this.scopeMap(scope);
      byScope[scope] = map.size;
      total += map.size;
      for (const m of map.values()) {
        byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
        bySource[m.source] = (bySource[m.source] ?? 0) + 1;
        evidence += m.evidence;
      }
      const file = this.filePath(scope);
      try {
        const st = fs.statSync(file);
        files.push({ scope, path: file, bytes: st.size });
      } catch {
        /* absent */
      }
    }
    return {
      total,
      byScope,
      byKind: sortRecord(byKind),
      bySource: sortRecord(bySource),
      evidence,
      files,
      project: { key: this.project.key, root: this.project.root, resolved: this.projectResolved },
      user: this.userKey,
    };
  }

  /** JSONL export (all scopes, createdAt then id order). */
  export(): string {
    const rows: Memory[] = [];
    for (const scope of ['project', 'user', 'global'] as const) rows.push(...this.scopeMap(scope).values());
    rows.sort(compareForFile);
    return rows.length ? rows.map(serializeMemory).join('\n') + '\n' : '';
  }

  /**
   * Import JSONL. Rows keep their scope/kind/tags/evidence; project-scoped
   * rows are re-keyed to *this* store's project. Existing ids are skipped
   * (not merged) so an import never inflates evidence.
   */
  import(jsonl: string): { added: number; skipped: number } {
    let added = 0;
    let skipped = 0;
    const touched = new Set<MemoryScope>();
    for (const line of jsonl.split('\n')) {
      const m = parseMemoryLine(line);
      if (!m) {
        if (line.trim()) skipped++;
        continue;
      }
      const text = normalizeMemoryText(redactText(m.text));
      const project = m.scope === 'project' ? this.project.key : undefined;
      const hash = memoryHash(m.scope, m.kind, text, project);
      const id = memoryIdFromHash(hash);
      const map = this.scopeMap(m.scope);
      if (map.has(id)) {
        skipped++;
        continue;
      }
      const now = this.now();
      const row: Memory = {
        id,
        scope: m.scope,
        kind: m.kind,
        text,
        tags: m.tags,
        source: 'imported',
        createdAt: m.createdAt || now,
        updatedAt: m.updatedAt || m.createdAt || now,
        evidence: m.evidence,
        hash,
      };
      if (project) row.project = project;
      map.set(id, row);
      touched.add(m.scope);
      added++;
    }
    for (const s of touched) this.persist(s);
    return { added, skipped };
  }
}

function sortRecord(r: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(r).sort()) out[k] = r[k];
  return out;
}
