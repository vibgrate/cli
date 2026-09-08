/**
 * Tool schema compaction (three layers), tool-search deferral (Anthropic +
 * OpenAI Responses shapes) and the cross-turn history repairs that must run
 * last among tool-array mutators.
 *
 * Accounting: compaction rewrites the array in place, so its delta folds into
 * both token endpoints; deferral removes schemas the message counter never
 * saw, so it is reported additively via `deferredTokens`.
 */

import { createHash } from 'node:crypto';
import { canonicalize } from '../engine/hash.js';
import type { Message } from '../compress/types.js';

export const TOOL_SCHEMA_DROP_KEYS: ReadonlySet<string> = new Set(['$id', '$schema', '$comment', 'deprecated', 'examples', 'example', 'markdownDescription', 'readOnly', 'title', 'writeOnly']);

const SEMANTIC_PARAM_NAMES: ReadonlySet<string> = new Set([
  'query', 'search', 'filter', 'sort', 'order', 'limit', 'offset', 'page', 'per_page', 'perpage', 'cursor', 'after', 'before', 'owner', 'repo', 'repository', 'org', 'organization', 'user', 'username', 'email', 'name', 'title', 'description', 'id', 'number', 'count', 'url', 'path', 'file', 'filename', 'branch', 'tag', 'sha', 'commit', 'ref', 'key', 'token', 'type', 'format', 'state', 'status', 'action', 'method', 'body', 'content', 'message', 'text', 'comment', 'note', 'start', 'end', 'from', 'to', 'direction', 'ascending', 'dry_run', 'verbose', 'force', 'recursive', 'include', 'exclude', 'pattern', 'regex', 'since', 'until',
]);

export function extractToolName(defn: unknown): string | undefined {
  if (!defn || typeof defn !== 'object') return undefined;
  const o = defn as Record<string, unknown>;
  if (typeof o.name === 'string') return o.name;
  const fn = o.function as Record<string, unknown> | undefined;
  if (fn && typeof fn.name === 'string') return fn.name;
  if (typeof o.type === 'string') return o.type;
  return undefined;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function compactBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v));
}

function walkDrop(value: unknown, parentKey: string | null): unknown {
  if (Array.isArray(value)) return value.map((v) => walkDrop(v, null));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (parentKey !== 'properties' && TOOL_SCHEMA_DROP_KEYS.has(k)) continue;
    if (k === 'description' && typeof v === 'string') {
      out[k] = normalizeWs(v);
      continue;
    }
    out[k] = walkDrop(v, k);
  }
  return out;
}

export interface CompactionResult {
  tools: unknown[];
  modified: boolean;
  beforeBytes: number;
  afterBytes: number;
}

/** Layer 1: drop annotation keys (except as property names) and normalize descriptions. */
export function compactTools(tools: unknown): CompactionResult {
  if (!Array.isArray(tools) || tools.length === 0) return { tools: Array.isArray(tools) ? tools : [], modified: false, beforeBytes: 0, afterBytes: 0 };
  const before = compactBytes(tools);
  const next = tools.map((t) => walkDrop(t, null));
  const after = compactBytes(next);
  if (after >= before) return { tools, modified: false, beforeBytes: before, afterBytes: before };
  return { tools: next, modified: true, beforeBytes: before, afterBytes: after };
}

const FIRST_SENTENCE = /^([\s\S]*?[.!?])(?:\s|$)/;

export function truncateDescription(text: string, maxChars: number): string {
  const t = normalizeWs(text);
  if (maxChars <= 0 || t.length <= maxChars) return t;
  const m = FIRST_SENTENCE.exec(t);
  if (m && m[1].length <= maxChars) {
    const first = m[1];
    const rest = t.slice(m[0].length);
    const m2 = FIRST_SENTENCE.exec(rest);
    if (m2) {
      const pair = `${first} ${m2[1]}`;
      if (pair.length <= 1.5 * maxChars) return pair;
    }
    return first;
  }
  return `${t.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function walkDescriptions(value: unknown, maxChars: number, stripSemantic: boolean, parentKey: string | null, grand: string | null): unknown {
  if (Array.isArray(value)) return value.map((v) => walkDescriptions(v, maxChars, stripSemantic, null, parentKey));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'description' && typeof v === 'string') {
      // `properties.<name>.description` where <name> is self-explanatory.
      if (stripSemantic && grand === 'properties' && parentKey && SEMANTIC_PARAM_NAMES.has(parentKey.toLowerCase().replace(/-/g, '_'))) continue;
      out[k] = maxChars > 0 ? truncateDescription(v, maxChars) : v;
      continue;
    }
    out[k] = walkDescriptions(v, maxChars, stripSemantic, k, parentKey);
  }
  return out;
}

/** Layers 2 + 3: truncate descriptions to `maxChars` (0 = off) and strip self-explanatory parameter descriptions. */
export function compactToolDescriptions(tools: unknown, maxChars: number, stripSemantic: boolean): CompactionResult {
  if (!Array.isArray(tools) || tools.length === 0 || (maxChars <= 0 && !stripSemantic)) return { tools: Array.isArray(tools) ? tools : [], modified: false, beforeBytes: 0, afterBytes: 0 };
  const before = compactBytes(tools);
  const next = tools.map((t) => walkDescriptions(t, maxChars, stripSemantic, null, null));
  const after = compactBytes(next);
  if (after >= before) return { tools, modified: false, beforeBytes: before, afterBytes: before };
  return { tools: next, modified: true, beforeBytes: before, afterBytes: after };
}

// --- cache (8 entries, FIFO) ---------------------------------------------------

const CACHE_MAX = 8;
const cache = new Map<string, CompactionResult>();

export function compactToolsCached(tools: unknown, opts: { maxChars: number; stripSemantic: boolean }): CompactionResult {
  if (!Array.isArray(tools) || tools.length === 0) return { tools: [], modified: false, beforeBytes: 0, afterBytes: 0 };
  const key = `${createHash('sha256').update(canonicalize(tools)).digest('hex').slice(0, 16)}|${opts.maxChars}|${opts.stripSemantic ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const l1 = compactTools(tools);
  const l23 = compactToolDescriptions(l1.tools, opts.maxChars, opts.stripSemantic);
  const result: CompactionResult = { tools: l23.tools, modified: l1.modified || l23.modified, beforeBytes: l1.beforeBytes, afterBytes: l23.modified ? l23.afterBytes : l1.afterBytes };
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, result);
  return result;
}

export function invalidateCompactionCache(): void {
  cache.clear();
}

/** Deterministic tool order: by name, then canonical JSON (stable cache prefix). */
export function sortTools(tools: unknown[]): unknown[] {
  return [...tools].sort((a, b) => {
    const na = extractToolName(a) ?? '';
    const nb = extractToolName(b) ?? '';
    if (na !== nb) return na < nb ? -1 : 1;
    const ca = canonicalize(a);
    const cb = canonicalize(b);
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Tool-search deferral
// ---------------------------------------------------------------------------

export const TOOL_SEARCH_CORE_TOOLS: ReadonlySet<string> = new Set(['bash', 'bash_background', 'bash_background_output', 'bash_background_wait', 'bash_background_kill', 'read', 'write', 'edit', 'multiedit', 'apply_patch', 'glob', 'grep', 'task', 'todowrite', 'todoread', 'webfetch', 'question', 'skill', 'toolsearch']);
export const TOOL_SEARCH_DEFAULT_MIN_TOOLS = 12;
const TOOL_SEARCH_TYPE_PREFIX = 'tool_search_tool_';
export const TOOL_SEARCH_DEFAULT_TYPE = 'tool_search_tool_regex_20251119';
export const TOOL_SEARCH_DEFAULT_NAME = 'tool_search_tool_regex';

function residentKey(name: unknown): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/^_+/, '');
}

export interface DeferralResult {
  tools: unknown[];
  deferred: number;
  deferredTokens: number;
  changed: boolean;
}

/** Anthropic: inject the regex search tool at index 0 and defer non-core custom tools. */
export function injectToolSearchDeferral(tools: unknown, opts: { minTools?: number; countTokens: (text: string) => number }): DeferralResult {
  const none: DeferralResult = { tools: Array.isArray(tools) ? tools : [], deferred: 0, deferredTokens: 0, changed: false };
  if (!Array.isArray(tools) || tools.length < (opts.minTools ?? TOOL_SEARCH_DEFAULT_MIN_TOOLS)) return none;
  for (const t of tools) {
    if (t && typeof t === 'object') {
      const o = t as Record<string, unknown>;
      if (String(o.type ?? '').startsWith(TOOL_SEARCH_TYPE_PREFIX) || String(o.name ?? '').toLowerCase().startsWith(TOOL_SEARCH_TYPE_PREFIX)) return none;
    }
  }
  const out: unknown[] = [{ type: TOOL_SEARCH_DEFAULT_TYPE, name: TOOL_SEARCH_DEFAULT_NAME }];
  let deferred = 0;
  let deferredTokens = 0;
  let droppedMarker: Record<string, unknown> | null = null;
  let droppedCc = false;
  let lastResidentReal: Record<string, unknown> | null = null;
  let residentHasCc = false;
  for (const t of tools) {
    const o = t && typeof t === 'object' ? (t as Record<string, unknown>) : null;
    if (!o || o.type || TOOL_SEARCH_CORE_TOOLS.has(residentKey(o.name))) {
      const kept = o && !o.type ? { ...o } : t;
      out.push(kept);
      if (o && !o.type) {
        lastResidentReal = kept as Record<string, unknown>;
        residentHasCc = residentHasCc || Boolean(o.cache_control);
      }
      continue;
    }
    const next: Record<string, unknown> = { ...o, defer_loading: true };
    if (next.cache_control !== undefined) {
      droppedCc = true;
      if (next.cache_control && typeof next.cache_control === 'object') droppedMarker = next.cache_control as Record<string, unknown>;
      delete next.cache_control;
    }
    out.push(next);
    deferred++;
    deferredTokens += opts.countTokens(JSON.stringify(o));
  }
  if (deferred === 0) return none;
  if (droppedCc && !residentHasCc && lastResidentReal) lastResidentReal.cache_control = droppedMarker ? { ...droppedMarker } : { type: 'ephemeral' };
  return { tools: out, deferred, deferredTokens, changed: true };
}

const OPENAI_TOOL_SEARCH_EXCLUDED_CLIENTS = new Set(['codex', 'opencode']);

export function openAIModelSupportsToolSearch(model: string, pattern?: string): boolean {
  if (pattern) {
    try {
      return new RegExp(pattern).test(model);
    } catch {
      /* malformed pattern falls back */
    }
  }
  const m = /^gpt-(\d+)(?:\.(\d+))?/i.exec(model);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 4);
}

/** OpenAI Responses: inject `{type:"tool_search"}`; defer non-core function/mcp tools. */
export function injectToolSearchDeferralOpenAI(tools: unknown, opts: { model: string; client?: string; minTools?: number; modelPattern?: string; countTokens: (text: string) => number }): DeferralResult {
  const none: DeferralResult = { tools: Array.isArray(tools) ? tools : [], deferred: 0, deferredTokens: 0, changed: false };
  if (!Array.isArray(tools) || tools.length < (opts.minTools ?? TOOL_SEARCH_DEFAULT_MIN_TOOLS)) return none;
  if (opts.client && OPENAI_TOOL_SEARCH_EXCLUDED_CLIENTS.has(opts.client.toLowerCase())) return none;
  if (!openAIModelSupportsToolSearch(opts.model, opts.modelPattern)) return none;
  if (tools.some((t) => t && typeof t === 'object' && (t as Record<string, unknown>).type === 'tool_search')) return none;
  const out: unknown[] = [{ type: 'tool_search' }];
  let deferred = 0;
  let deferredTokens = 0;
  for (const t of tools) {
    const o = t && typeof t === 'object' ? (t as Record<string, unknown>) : null;
    const isFn = o?.type === 'function';
    const isMcp = o?.type === 'mcp';
    const core = isFn && (TOOL_SEARCH_CORE_TOOLS.has(residentKey(o?.name)) || residentKey(o?.name) === 'terminal');
    if (!o || (!isFn && !isMcp) || core) {
      out.push(t);
      continue;
    }
    out.push({ ...o, defer_loading: true });
    deferred++;
    deferredTokens += opts.countTokens(JSON.stringify(o));
  }
  if (deferred === 0) return none;
  return { tools: out, deferred, deferredTokens, changed: true };
}

// ---------------------------------------------------------------------------
// Cross-turn repairs
// ---------------------------------------------------------------------------

function referenceNames(content: unknown): string[] {
  const names: string[] = [];
  const list = Array.isArray(content) ? content : content && typeof content === 'object' && Array.isArray((content as Record<string, unknown>).tool_references) ? ((content as Record<string, unknown>).tool_references as unknown[]) : [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const n = typeof o.tool_name === 'string' ? o.tool_name : typeof o.name === 'string' ? o.name : null;
    if (n) names.push(n);
  }
  return names;
}

/**
 * Drop `tool_search_tool_result` blocks whose references cannot be resolved
 * by this request's tools, plus their paired `server_tool_use`. Returns the
 * same array when nothing changed. Label: `router:tool_search_repair:<n>blocks`.
 */
export function stripUnsupportedToolSearchBlocks(messages: Message[], tools: unknown): { messages: Message[]; removed: number } {
  const list = Array.isArray(tools) ? (tools as Array<Record<string, unknown>>) : [];
  const available = new Set<string>();
  let hasSearch = false;
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    if (String(t.type ?? '').startsWith(TOOL_SEARCH_TYPE_PREFIX)) hasSearch = true;
    else if (typeof t.name === 'string') available.add(t.name);
  }
  const dropIds = new Set<string>();
  let removed = 0;
  // Pass 1: find results to drop.
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (!b || b.type !== 'tool_search_tool_result') continue;
      const refs = referenceNames(b.content);
      if (!hasSearch || refs.some((n) => !available.has(n))) dropIds.add(String(b.tool_use_id ?? ''));
    }
  }
  if (!dropIds.size && hasSearch) return { messages, removed: 0 };
  const out: Message[] = [];
  let changed = false;
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const kept = (m.content as Array<Record<string, unknown>>).filter((b) => {
      if (!b) return true;
      if (b.type === 'tool_search_tool_result' && dropIds.has(String(b.tool_use_id ?? ''))) return (removed++, false);
      if (b.type === 'server_tool_use' && (dropIds.has(String(b.id ?? '')) || (!hasSearch && String(b.name ?? '').startsWith(TOOL_SEARCH_TYPE_PREFIX)))) return (removed++, false);
      return true;
    });
    if (kept.length !== (m.content as unknown[]).length) {
      changed = true;
      if (kept.length) out.push({ ...m, content: kept });
    } else out.push(m);
  }
  return changed ? { messages: out, removed } : { messages, removed: 0 };
}
