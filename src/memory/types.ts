/**
 * Cross-agent memory — shared types.
 *
 * A memory is a short, self-contained statement an AI agent (or the user)
 * wants recalled in later sessions: a preference, a correction, a decision, a
 * gotcha, a working command. Memories are scoped (project / user / global),
 * deduplicated by content hash, and carry an evidence count so repeated
 * observations strengthen a memory instead of duplicating it.
 *
 * Everything here is plain data; the store, ranker, extractor and injector
 * build on it. No I/O, no clock reads.
 */

export type MemoryScope = 'project' | 'user' | 'global';

export type MemoryKind = 'fact' | 'preference' | 'rule' | 'decision' | 'gotcha' | 'command' | 'snippet';

export type MemorySource = 'user' | 'learned' | 'agent' | 'imported';

export const MEMORY_SCOPES: readonly MemoryScope[] = ['project', 'user', 'global'];
export const MEMORY_KINDS: readonly MemoryKind[] = ['fact', 'preference', 'rule', 'decision', 'gotcha', 'command', 'snippet'];
export const MEMORY_SOURCES: readonly MemorySource[] = ['user', 'learned', 'agent', 'imported'];

export interface Memory {
  /** Stable id derived from the content hash (16 hex chars). */
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  /** Redacted, whitespace-normalised statement. */
  text: string;
  /** Sorted, unique, lower-cased tags (entities, tools, categories). */
  tags: string[];
  source: MemorySource;
  /** Milliseconds since the epoch (injected clock). */
  createdAt: number;
  updatedAt: number;
  /** Number of independent observations supporting this memory (≥ 1). */
  evidence: number;
  /** Full content hash (blake3 hex) over scope + kind + normalised text. */
  hash: string;
  /** Project key this memory belongs to (project scope only). */
  project?: string;
}

/** What callers pass to `MemoryStore.add` — ids, hashes and timestamps are derived. */
export type MemoryInput = Omit<Memory, 'id' | 'hash' | 'createdAt' | 'updatedAt' | 'evidence'> & { evidence?: number };

export interface SearchHit {
  memory: Memory;
  /** Final ranking score in [0, 1]. */
  score: number;
}

export interface SearchOptions {
  topK?: number;
  scope?: MemoryScope[];
  kinds?: MemoryKind[];
  /** Minimum final score (default 0). */
  minScore?: number;
  /** Pre-computed query vector (unit or raw) — enables the hybrid path. */
  queryVector?: number[];
}

export interface ListOptions {
  scope?: MemoryScope[];
  kinds?: MemoryKind[];
  tags?: string[];
  source?: MemorySource[];
  limit?: number;
}

export interface MemoryStats {
  total: number;
  byScope: Record<MemoryScope, number>;
  byKind: Record<string, number>;
  bySource: Record<string, number>;
  /** Sum of evidence over all memories. */
  evidence: number;
  /** One entry per scope file that exists on disk. */
  files: Array<{ scope: MemoryScope; path: string; bytes: number }>;
  project: { key: string; root: string | null; resolved: boolean };
  user: string;
}

/**
 * Optional, synchronous embedding hook. The store never requires a model:
 * without a hook, search is purely lexical (BM25 + recency + evidence). With
 * one, lexical and vector scores are blended 50/50 (see `rank.ts`).
 */
export interface VectorHook {
  /** Stable model id — vectors from a different id are recomputed. */
  id: string;
  embed(texts: string[]): number[][];
}

/** Sentinel project key used when no project root can be resolved. */
export const NO_PROJECT = 'no-project';

/** Default user key when none is configured. */
export const DEFAULT_USER = 'default';

/** Collapse whitespace and trim — the canonical text form that feeds the hash. */
export function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Lower-case, trim, dedupe and sort tags; drop empties. */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const out = new Set<string>();
  for (const t of tags) {
    const v = String(t).trim().toLowerCase();
    if (v) out.add(v);
  }
  return [...out].sort();
}

export function isMemoryScope(x: unknown): x is MemoryScope {
  return typeof x === 'string' && (MEMORY_SCOPES as readonly string[]).includes(x);
}

export function isMemoryKind(x: unknown): x is MemoryKind {
  return typeof x === 'string' && (MEMORY_KINDS as readonly string[]).includes(x);
}

export function isMemorySource(x: unknown): x is MemorySource {
  return typeof x === 'string' && (MEMORY_SOURCES as readonly string[]).includes(x);
}
