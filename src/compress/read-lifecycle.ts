/**
 * Read lifecycle: stale and superseded file reads, plus hold-back maturation.
 *
 * A read is STALE when the same path is edited/written later in the
 * conversation (the bytes in context are wrong), SUPERSEDED when a later read
 * fully covers its range (redundant). Both are replaced by a short marker
 * naming the path and the message that superseded it; the original is stored
 * for retrieval. Fresh reads are never touched. Anything inside the frozen
 * prefix stays byte-identical.
 *
 * Maturation (opt-in, session-scoped): a fresh, large read is held verbatim
 * while its file is active and matures into a marker once the file has been
 * quiet for `quiesceTurns` assistant turns (or `maxHoldTurns` elapsed). Once
 * matured, the same marker is replayed deterministically every turn.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { EDIT_TOOL_NAMES, READ_TOOL_NAMES } from './config.js';
import { enumerateBlocks, toolArgsIndex } from './format.js';
import type { CcrSink, Message } from './types.js';
import { retrieveHint } from './ccr/markers.js';

export type ReadState = 'fresh' | 'stale' | 'superseded';

export interface FileOperation {
  messageIndex: number;
  toolCallId: string;
  toolName: string;
  filePath: string;
  operation: 'read' | 'edit';
  offset?: number;
  limit?: number;
}

export interface ReadClassification {
  messageIndex: number;
  toolCallId: string;
  filePath: string;
  state: ReadState;
  /** Message index of the operation that made it stale/superseded. */
  supersededBy?: number;
}

export interface ReadLifecycleResult {
  transforms: string[];
  ccrHashes: string[];
  reads: number;
  stale: number;
  superseded: number;
  replaced: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface ReadLifecycleRunOptions {
  frozenMessageCount?: number;
  compressStale?: boolean;
  compressSuperseded?: boolean;
  minSizeBytes?: number;
  store?: CcrSink | null;
  /** Tokens counter for the retrieval hint. */
  countTokens?: (text: string) => number;
}

export const DEFAULT_READ_MIN_SIZE_BYTES = 512;
export const DEFAULT_READ_LIMIT_LINES = 2000;

const encoder = new TextEncoder();

function sha24(text: string): string {
  return bytesToHex(sha256(encoder.encode(text))).slice(0, 24);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const READ_SET = new Set(READ_TOOL_NAMES);
const EDIT_SET = new Set(EDIT_TOOL_NAMES);

function pathOf(args: unknown): string | undefined {
  if (!isObj(args)) return undefined;
  for (const k of ['file_path', 'path', 'filePath', 'filename', 'file']) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function intOf(args: unknown, key: string): number | undefined {
  if (!isObj(args)) return undefined;
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** All read/edit operations by path, from tool calls anywhere in the conversation. */
export function fileOperations(messages: Message[]): Map<string, FileOperation[]> {
  const args = toolArgsIndex(messages);
  const out = new Map<string, FileOperation[]>();
  for (const b of enumerateBlocks(messages)) {
    if (b.kind !== 'other' || !b.toolCallId || !b.toolName) continue;
    if (!['tool_use', 'tool_call', 'tool-call', 'function_call'].includes(b.blockType)) continue;
    const isRead = READ_SET.has(b.toolName);
    const isEdit = EDIT_SET.has(b.toolName);
    if (!isRead && !isEdit) continue;
    const a = args.get(b.toolCallId);
    const filePath = pathOf(a);
    if (!filePath) continue;
    const op: FileOperation = { messageIndex: b.messageIndex, toolCallId: b.toolCallId, toolName: b.toolName, filePath, operation: isRead ? 'read' : 'edit' };
    if (isRead) {
      const offset = intOf(a, 'offset');
      const limit = intOf(a, 'limit');
      if (offset !== undefined) op.offset = offset;
      if (limit !== undefined) op.limit = limit;
    }
    const list = out.get(filePath) ?? [];
    list.push(op);
    out.set(filePath, list);
  }
  return out;
}

/** Does `later` fully cover the line range of `earlier`? */
export function readCovers(later: FileOperation, earlier: FileOperation): boolean {
  if (later.offset === undefined && later.limit === undefined) return true;
  if (earlier.offset === undefined && earlier.limit === undefined) return false;
  const ls = later.offset ?? 0;
  const le = ls + (later.limit ?? DEFAULT_READ_LIMIT_LINES);
  const es = earlier.offset ?? 0;
  const ee = es + (earlier.limit ?? DEFAULT_READ_LIMIT_LINES);
  return ls <= es && le >= ee;
}

export function classifyReads(messages: Message[], opts: { compressStale?: boolean; compressSuperseded?: boolean; frozenMessageCount?: number } = {}): ReadClassification[] {
  const compressStale = opts.compressStale !== false;
  const compressSuperseded = opts.compressSuperseded === true;
  const frozen = opts.frozenMessageCount ?? 0;
  const out: ReadClassification[] = [];
  const ops = fileOperations(messages);
  for (const [filePath, list] of [...ops.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const reads = list.filter((o) => o.operation === 'read');
    const edits = list.filter((o) => o.operation === 'edit');
    for (const r of reads) {
      let state: ReadState = 'fresh';
      let by: number | undefined;
      if (compressStale) {
        const e = edits.filter((x) => x.messageIndex > r.messageIndex).sort((a, b) => a.messageIndex - b.messageIndex)[0];
        if (e) {
          state = 'stale';
          by = e.messageIndex;
        }
      }
      if (state === 'fresh' && compressSuperseded) {
        const later = reads.filter((x) => x.messageIndex > r.messageIndex && readCovers(x, r)).sort((a, b) => a.messageIndex - b.messageIndex)[0];
        if (later) {
          state = 'superseded';
          by = later.messageIndex;
        }
      }
      // The tool result lives in the message after the call; both must sit past the frozen floor.
      if (state !== 'fresh' && r.messageIndex + 1 < frozen) state = 'fresh';
      const c: ReadClassification = { messageIndex: r.messageIndex, toolCallId: r.toolCallId, filePath, state };
      if (by !== undefined) c.supersededBy = by;
      out.push(c);
    }
  }
  return out;
}

/** Marker text for a stale/superseded read (design §3.4). */
export function lifecycleMarker(state: 'stale' | 'superseded' | 'matured', filePath: string, supersededBy?: number): string {
  if (state === 'stale') return `[file ${filePath} read here; superseded by an edit at message #${supersededBy ?? '?'}. Re-read if needed.]`;
  if (state === 'superseded') return `[file ${filePath} read here; superseded by a later read at message #${supersededBy ?? '?'}. Re-read if needed.]`;
  return `[file ${filePath} read here; compressed after use. Re-read if needed.]`;
}

function storeOriginal(store: CcrSink | null | undefined, content: string, meta: { toolCallId: string; strategy: string; tokens: number; marker: string; markerTokens: number }): string | null {
  const hash = sha24(content);
  if (!store) return null;
  try {
    return store.store(content, { compressed: meta.marker, strategy: meta.strategy, toolName: 'Read', toolCallId: meta.toolCallId, explicitHash: hash, originalTokens: meta.tokens, compressedTokens: meta.markerTokens });
  } catch {
    return null;
  }
}

/**
 * Replace stale/superseded reads in `messages` (mutated in place via block
 * setters). Only tool results with string content are replaced.
 */
export function applyReadLifecycle(messages: Message[], opts: ReadLifecycleRunOptions = {}): ReadLifecycleResult {
  const result: ReadLifecycleResult = { transforms: [], ccrHashes: [], reads: 0, stale: 0, superseded: 0, replaced: 0, bytesBefore: 0, bytesAfter: 0 };
  const minSize = opts.minSizeBytes ?? DEFAULT_READ_MIN_SIZE_BYTES;
  const count = opts.countTokens ?? ((t: string): number => Math.ceil(t.length / 4));
  const classes = classifyReads(messages, opts);
  result.reads = classes.length;
  const replacements = new Map<string, ReadClassification>();
  for (const c of classes) {
    if (c.state === 'stale') result.stale += 1;
    else if (c.state === 'superseded') result.superseded += 1;
    if (c.state !== 'fresh') replacements.set(c.toolCallId, c);
  }
  if (replacements.size === 0) return result;
  const frozen = opts.frozenMessageCount ?? 0;
  for (const b of enumerateBlocks(messages)) {
    if (b.kind !== 'tool_result' || !b.toolCallId) continue;
    if (b.messageIndex < frozen) continue;
    const c = replacements.get(b.toolCallId);
    if (!c) continue;
    const content = b.text;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes < minSize) continue;
    if (content.includes('Retrieve original: hash=') || content.includes('Retrieve more: hash=')) continue;
    const tokens = count(content);
    let marker = lifecycleMarker(c.state as 'stale' | 'superseded', c.filePath, c.supersededBy);
    const markerTokens = count(marker);
    const hash = storeOriginal(opts.store, content, { toolCallId: b.toolCallId, strategy: `read_lifecycle:${c.state}`, tokens, marker, markerTokens });
    if (hash) {
      marker += `\n${retrieveHint(hash, { originalTokens: tokens, compressedTokens: markerTokens })}`;
      result.ccrHashes.push(hash);
    }
    b.set(marker);
    result.transforms.push(`read_lifecycle:${c.state}:${c.filePath}`);
    result.replaced += 1;
    result.bytesBefore += bytes;
    result.bytesAfter += Buffer.byteLength(marker, 'utf8');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Maturation
// ---------------------------------------------------------------------------

export interface MaturationOptions {
  quiesceTurns?: number;
  maxHoldTurns?: number;
  minSizeBytes?: number;
}

export interface MaturationResult {
  holdingMessageIndices: number[];
  holding: number;
  newlyMatured: number;
  replaced: number;
  transforms: string[];
  ccrHashes: string[];
  bytesSaved: number;
}

export const DEFAULT_QUIESCE_TURNS = 2;
export const DEFAULT_MAX_HOLD_TURNS = 6;
export const DEFAULT_MATURATION_MIN_SIZE_BYTES = 4096;

const TOUCH_SET = new Set([...READ_TOOL_NAMES, ...EDIT_TOOL_NAMES]);

interface Activity {
  /** tool call id → (path, assistant turn of the read). */
  reads: Map<string, { filePath: string; turn: number }>;
  /** path → assistant turn of its latest touch. */
  lastTouch: Map<string, number>;
  assistantTurns: number;
}

function scanActivity(messages: Message[]): Activity {
  const args = toolArgsIndex(messages);
  const act: Activity = { reads: new Map(), lastTouch: new Map(), assistantTurns: 0 };
  let lastMsg = -1;
  for (const b of enumerateBlocks(messages)) {
    if (b.role !== 'assistant') continue;
    if (b.messageIndex !== lastMsg) {
      lastMsg = b.messageIndex;
      act.assistantTurns += 1;
    }
    if (b.kind !== 'other' || !b.toolCallId || !b.toolName || !TOUCH_SET.has(b.toolName)) continue;
    if (!['tool_use', 'tool_call', 'tool-call', 'function_call'].includes(b.blockType)) continue;
    const fp = pathOf(args.get(b.toolCallId));
    if (fp) act.lastTouch.set(fp, act.assistantTurns);
    if (READ_SET.has(b.toolName)) act.reads.set(b.toolCallId, { filePath: fp ?? '', turn: act.assistantTurns });
  }
  return act;
}

/** Per-session hold-back state: matured markers by tool call id. */
export class ReadMaturation {
  private readonly matured = new Map<string, { marker: string; hash: string | null }>();
  private readonly quiesceTurns: number;
  private readonly maxHoldTurns: number;
  private readonly minSizeBytes: number;

  constructor(opts: MaturationOptions = {}) {
    this.quiesceTurns = Math.max(1, opts.quiesceTurns ?? DEFAULT_QUIESCE_TURNS);
    this.maxHoldTurns = Math.max(1, opts.maxHoldTurns ?? DEFAULT_MAX_HOLD_TURNS);
    this.minSizeBytes = Math.max(0, opts.minSizeBytes ?? DEFAULT_MATURATION_MIN_SIZE_BYTES);
  }

  get maturedCount(): number {
    return this.matured.size;
  }

  reset(): void {
    this.matured.clear();
  }

  apply(messages: Message[], opts: { frozenMessageCount?: number; store?: CcrSink | null; countTokens?: (t: string) => number } = {}): MaturationResult {
    const result: MaturationResult = { holdingMessageIndices: [], holding: 0, newlyMatured: 0, replaced: 0, transforms: [], ccrHashes: [], bytesSaved: 0 };
    const frozen = opts.frozenMessageCount ?? 0;
    const count = opts.countTokens ?? ((t: string): number => Math.ceil(t.length / 4));
    const act = scanActivity(messages);
    for (const b of enumerateBlocks(messages)) {
      if (b.kind !== 'tool_result' || !b.toolCallId || b.messageIndex < frozen) continue;
      const read = act.reads.get(b.toolCallId);
      if (!read) continue;
      const content = b.text;
      const prior = this.matured.get(b.toolCallId);
      if (prior) {
        if (content !== prior.marker) {
          b.set(prior.marker);
          result.replaced += 1;
          result.bytesSaved += Math.max(0, content.length - prior.marker.length);
          result.transforms.push(`read_maturation:replay:${read.filePath}`);
          if (prior.hash) result.ccrHashes.push(prior.hash);
        }
        continue;
      }
      if (Buffer.byteLength(content, 'utf8') < this.minSizeBytes) continue;
      if (content.includes('Retrieve original: hash=') || content.includes('Retrieve more: hash=')) continue;
      const lastTouch = act.lastTouch.get(read.filePath) ?? read.turn;
      const quiet = act.assistantTurns - lastTouch;
      const held = act.assistantTurns - read.turn;
      if (quiet < this.quiesceTurns && held < this.maxHoldTurns) {
        result.holding += 1;
        if (!result.holdingMessageIndices.includes(b.messageIndex)) result.holdingMessageIndices.push(b.messageIndex);
        continue;
      }
      const tokens = count(content);
      let marker = lifecycleMarker('matured', read.filePath || 'unknown');
      const markerTokens = count(marker);
      const hash = storeOriginal(opts.store, content, { toolCallId: b.toolCallId, strategy: 'read_maturation', tokens, marker, markerTokens });
      if (hash) marker += `\n${retrieveHint(hash, { originalTokens: tokens, compressedTokens: markerTokens })}`;
      this.matured.set(b.toolCallId, { marker, hash });
      b.set(marker);
      result.newlyMatured += 1;
      result.replaced += 1;
      result.bytesSaved += Math.max(0, content.length - marker.length);
      result.transforms.push(`read_maturation:matured:${read.filePath}`);
      if (hash) result.ccrHashes.push(hash);
    }
    return result;
  }
}

/**
 * Park the trailing message-level cache breakpoint before held reads so the
 * verbatim bytes are never cache-written. Strips `cache_control` from blocks
 * at/after the earliest holding message and re-anchors one breakpoint (TTL
 * carried forward) on the last block of the latest eligible earlier message.
 * Total breakpoints never increase. Returns the input when nothing to do.
 */
export function relocateCacheBreakpoint(messages: Message[], holdingMessageIndices: number[]): Message[] {
  if (holdingMessageIndices.length === 0) return messages;
  const earliest = Math.min(...holdingMessageIndices);
  const out = [...messages];
  let stripped = false;
  let held: Record<string, unknown> | undefined;
  for (let i = earliest; i < out.length; i++) {
    const m = out[i];
    if (!isObj(m) || !Array.isArray(m.content)) continue;
    if (!m.content.some((b) => isObj(b) && 'cache_control' in b)) continue;
    for (const b of m.content) if (isObj(b) && isObj(b.cache_control)) held = b.cache_control;
    out[i] = {
      ...m,
      content: m.content.map((b) => {
        if (!isObj(b)) return b;
        const { cache_control: _cc, ...rest } = b;
        return rest;
      }),
    };
    stripped = true;
  }
  if (!stripped) return out;
  for (let i = earliest - 1; i >= 0; i--) {
    const m = out[i];
    if (!isObj(m) || !Array.isArray(m.content) || m.content.length === 0) continue;
    const last = m.content[m.content.length - 1];
    if (!isObj(last)) continue;
    const content = [...m.content];
    content[content.length - 1] = { ...last, cache_control: held ? { ...held } : { type: 'ephemeral' } };
    out[i] = { ...m, content };
    break;
  }
  return out;
}
