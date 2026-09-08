/**
 * Typed fallbacks for every dependency in `ProxyDeps`, plus the loader that
 * binds the real modules when they are present.
 *
 * Every fallback is fail-open: compression becomes passthrough, retrieval
 * answers "not found", pricing uses the blended rate, and the ledger writes
 * the §3.2 `SavingsEvent` shape itself so `vg savings` still sees proxy
 * traffic. Nothing here reaches the network.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { countTokens } from '../engine/tokens.js';
import { savingsEventsPath } from '../compress/paths.js';
import type { CompressOptions, CompressResult, Message, MessageFormat, Tokenizer } from '../compress/types.js';
import type { ProxyDeps, RetrieveCall, RetrieveResult, SavingsEventLike, SavingsRollupLike, SseEventLike, StoreLike } from './deps.js';

// ---------------------------------------------------------------------------
// Compression (passthrough)
// ---------------------------------------------------------------------------

export function passthroughResult(messages: Message[], format: MessageFormat, tokens: number): CompressResult {
  return {
    messages,
    tokensBefore: tokens,
    tokensAfter: tokens,
    tokensSaved: 0,
    compressionRatio: 0,
    keptRatio: 1,
    transformsApplied: [],
    transformsSummary: {},
    ccrHashes: [],
    compressed: false,
    manifest: { messagesTotal: messages.length, messagesBelowFrozenFloor: 0, latestUserMessageIndex: null, blockOutcomes: [] },
    markersInserted: [],
    warnings: ['compression module unavailable; passthrough'],
    format,
  };
}

export function detectFormatFallback(messages: Message[]): MessageFormat {
  for (const m of messages) {
    if (typeof m.tool_call_id === 'string' || Array.isArray(m.tool_calls)) return 'openai';
    if (m.role === 'system' || m.role === 'developer' || m.role === 'tool') return 'openai';
    if (Array.isArray(m.content)) {
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (b && (b.type === 'tool_use' || b.type === 'tool_result')) return 'anthropic';
      }
    }
    if (typeof m.type === 'string' && /^(function_call|function_call_output|message)$/.test(m.type)) return 'responses';
  }
  return 'anthropic';
}

export const cl100kTokenizer: Tokenizer = { id: 'cl100k', count: (t) => countTokens(t) };

export function messagesTokens(messages: Message[], tokenizer: Tokenizer = cl100kTokenizer): number {
  let n = 0;
  for (const m of messages) n += tokenizer.count(JSON.stringify(m));
  return n;
}

async function compressPassthrough(messages: Message[], _options?: CompressOptions): Promise<CompressResult> {
  return passthroughResult(messages, detectFormatFallback(messages), messagesTokens(messages));
}

// ---------------------------------------------------------------------------
// Retrieval tool (mirrors ccr/tool.ts shapes; §3.4 markers)
// ---------------------------------------------------------------------------

export const RETRIEVE_TOOL_NAME_FALLBACK = 'vg_retrieve';

const RETRIEVE_DESCRIPTION =
  'Retrieve original uncompressed content that was compressed to save tokens. Use this when you need more data than what is shown in a compressed tool result. The hash is provided in compression markers like "Retrieve original: hash=abc123" or "<<vg-ccr:abc123 …>>".';

const RETRIEVE_PARAMS = {
  type: 'object',
  properties: {
    hash: { type: 'string', description: "Hash key from the compression marker (e.g. 'abc123' from hash=abc123)" },
    grep: { type: 'string', description: 'Optional pattern: return only matching lines' },
    head: { type: 'integer', description: 'Optional: first N lines' },
    tail: { type: 'integer', description: 'Optional: last N lines' },
  },
  required: ['hash'],
};

export function retrieveToolFallback(format: MessageFormat): Record<string, unknown> {
  if (format === 'anthropic') return { name: RETRIEVE_TOOL_NAME_FALLBACK, description: RETRIEVE_DESCRIPTION, input_schema: RETRIEVE_PARAMS };
  if (format === 'responses') return { type: 'function', name: RETRIEVE_TOOL_NAME_FALLBACK, description: RETRIEVE_DESCRIPTION, parameters: RETRIEVE_PARAMS };
  return { type: 'function', function: { name: RETRIEVE_TOOL_NAME_FALLBACK, description: RETRIEVE_DESCRIPTION, parameters: RETRIEVE_PARAMS } };
}

const MARKER_RE = /<<vg-ccr:([a-f0-9]{12,24})\b|Retrieve (?:original|more): hash=([a-f0-9]{12,24})/g;

export function findMarkersFallback(text: string): Array<{ hash: string }> {
  const out: Array<{ hash: string }> = [];
  const seen = new Set<string>();
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(text)) !== null) {
    const hash = (m[1] ?? m[2]).toLowerCase();
    if (!seen.has(hash)) {
      seen.add(hash);
      out.push({ hash });
    }
    if (m[0].length === 0) MARKER_RE.lastIndex++;
  }
  return out;
}

export function extractRetrieveCallsFallback(response: Record<string, unknown>, format: MessageFormat, isRetrieve: (n: string) => boolean): RetrieveCall[] {
  const calls: RetrieveCall[] = [];
  if (format === 'anthropic') {
    const content = response.content;
    if (Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b && b.type === 'tool_use' && typeof b.name === 'string' && isRetrieve(b.name)) {
          calls.push({ id: String(b.id ?? ''), name: b.name, args: (b.input as Record<string, unknown>) ?? {} });
        }
      }
    }
    return calls;
  }
  if (format === 'responses') {
    const output = response.output;
    if (Array.isArray(output)) {
      for (const it of output as Array<Record<string, unknown>>) {
        if (it && it.type === 'function_call' && typeof it.name === 'string' && isRetrieve(it.name)) {
          calls.push({ id: String(it.call_id ?? it.id ?? ''), name: it.name, args: parseArgs(it.arguments) });
        }
      }
    }
    return calls;
  }
  const choices = response.choices;
  if (Array.isArray(choices) && choices[0]) {
    const msg = (choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined;
    const tcs = msg?.tool_calls;
    if (Array.isArray(tcs)) {
      for (const tc of tcs as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn && typeof fn.name === 'string' && isRetrieve(fn.name)) {
          calls.push({ id: String(tc.id ?? ''), name: fn.name, args: parseArgs(fn.arguments) });
        }
      }
    }
  }
  return calls;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Count *all* tool calls in a response (retrieve or not) so mixed turns are passed through. */
export function countToolCalls(response: Record<string, unknown>, format: MessageFormat): number {
  if (format === 'anthropic') {
    const content = response.content;
    return Array.isArray(content) ? (content as Array<Record<string, unknown>>).filter((b) => b && b.type === 'tool_use').length : 0;
  }
  if (format === 'responses') {
    const output = response.output;
    return Array.isArray(output) ? (output as Array<Record<string, unknown>>).filter((b) => b && b.type === 'function_call').length : 0;
  }
  const choices = response.choices;
  if (Array.isArray(choices) && choices[0]) {
    const msg = (choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined;
    return Array.isArray(msg?.tool_calls) ? (msg!.tool_calls as unknown[]).length : 0;
  }
  return 0;
}

export function buildRetrieveResultMessagesFallback(calls: RetrieveCall[], results: Array<{ content: string }>, format: MessageFormat): Message[] {
  if (format === 'anthropic') {
    return [
      { role: 'assistant', content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })) },
      { role: 'user', content: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: results[i]?.content ?? '' })) },
    ];
  }
  if (format === 'responses') {
    const out: Message[] = [];
    calls.forEach((c, i) => {
      out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
      out.push({ type: 'function_call_output', call_id: c.id, output: results[i]?.content ?? '' });
    });
    return out;
  }
  const out: Message[] = [
    { role: 'assistant', content: null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) },
  ];
  calls.forEach((c, i) => out.push({ role: 'tool', tool_call_id: c.id, content: results[i]?.content ?? '' }));
  return out;
}

/** Prior-turn retrieve tool_use/tool_result → plain text (never drop; keeps alternation). */
export function neutralizeRetrieveHistoryFallback(messages: Message[], format: MessageFormat, isRetrieve: (n: string) => boolean): Message[] {
  let changed = false;
  const neutralized = new Set<string>();
  const out = messages.map((m) => {
    if (format === 'anthropic' && Array.isArray(m.content)) {
      const content = (m.content as Array<Record<string, unknown>>).map((b) => {
        if (b && b.type === 'tool_use' && typeof b.name === 'string' && isRetrieve(b.name)) {
          changed = true;
          neutralized.add(String(b.id));
          return { type: 'text', text: `[${b.name} call omitted: tool not available this turn]` };
        }
        if (b && b.type === 'tool_result' && neutralized.has(String(b.tool_use_id))) {
          changed = true;
          const inner = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Array<Record<string, unknown>>).map((x) => (typeof x.text === 'string' ? x.text : '')).join('\n') : '';
          return { type: 'text', text: inner || '[retrieve result omitted]' };
        }
        return b;
      });
      return changed ? { ...m, content } : m;
    }
    if (format === 'openai') {
      if (Array.isArray(m.tool_calls)) {
        const keep: unknown[] = [];
        const texts: string[] = [];
        for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown> | undefined;
          if (fn && typeof fn.name === 'string' && isRetrieve(fn.name)) {
            neutralized.add(String(tc.id));
            texts.push(`[${fn.name} call omitted: tool not available this turn]`);
          } else keep.push(tc);
        }
        if (texts.length) {
          changed = true;
          const base = typeof m.content === 'string' ? m.content : '';
          const next: Message = { ...m, content: [base, ...texts].filter(Boolean).join('\n') };
          if (keep.length) next.tool_calls = keep;
          else delete next.tool_calls;
          return next;
        }
      }
      if (m.role === 'tool' && neutralized.has(String(m.tool_call_id))) {
        changed = true;
        return { role: 'user', content: typeof m.content === 'string' && m.content ? m.content : '[retrieve result omitted]' };
      }
    }
    return m;
  });
  return changed ? out : messages;
}

// ---------------------------------------------------------------------------
// In-memory store fallback
// ---------------------------------------------------------------------------

export class MemoryStoreFallback implements StoreLike {
  private readonly entries = new Map<string, { original: string; createdAt: number; expiresAt: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  put(hash: string, original: string, ttlSeconds = 1800): void {
    const t = this.now();
    this.entries.set(hash.toLowerCase(), { original, createdAt: t, expiresAt: t + ttlSeconds * 1000 });
  }
  exists(hash: string): boolean {
    const e = this.entries.get(hash.toLowerCase());
    return !!e && e.expiresAt > this.now();
  }
  get(hash: string) {
    const e = this.entries.get(hash.toLowerCase());
    if (!e || e.expiresAt <= this.now()) return null;
    return { hash, original: e.original, compressed: '', strategy: 'fallback', originalTokens: countTokens(e.original), compressedTokens: 0, createdAt: e.createdAt, expiresAt: e.expiresAt, status: 'active' };
  }
  stats() {
    return { entries: this.entries.size, backend: 'memory' };
  }
  purgeExpired(): number {
    let n = 0;
    for (const [k, e] of this.entries) if (e.expiresAt <= this.now()) (this.entries.delete(k), n++);
    return n;
  }
}

export function executeRetrieveFallback(store: StoreLike | null, args: Record<string, unknown>, opts?: { maxTokens?: number }) {
  const hash = typeof args.hash === 'string' ? args.hash.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{12,24}$/.test(hash)) return { content: JSON.stringify({ error: 'invalid hash', hash }), found: false };
  const entry = store?.get(hash) ?? null;
  if (!entry) return { content: JSON.stringify({ error: 'Entry not found or expired. Do not retry the same hash; re-run the source command or re-read the file.', hash, status: 'missing' }), found: false, hash };
  let text = entry.original;
  let lines = text.split('\n');
  if (typeof args.grep === 'string' && args.grep) {
    const needle = args.grep.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(needle));
  }
  if (typeof args.head === 'number' && args.head > 0) lines = lines.slice(0, args.head);
  if (typeof args.tail === 'number' && args.tail > 0) lines = lines.slice(-args.tail);
  text = lines.join('\n');
  const max = opts?.maxTokens ?? 25_000;
  let truncated = false;
  if (countTokens(text) > max) {
    text = text.slice(0, max * 3) + '\n…(truncated)';
    truncated = true;
  }
  return { content: text, found: true, hash, truncated };
}

// ---------------------------------------------------------------------------
// SSE reconstruction (mirrors ccr/streaming.ts)
// ---------------------------------------------------------------------------

function parseJson(data: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(data) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function reconstructAnthropicFallback(events: SseEventLike[]): Record<string, unknown> | null {
  let message: Record<string, unknown> | null = null;
  const blocks: Array<Record<string, unknown>> = [];
  const partial: Record<number, string> = {};
  for (const ev of events) {
    const d = parseJson(ev.data);
    if (!d) continue;
    const type = String(d.type ?? ev.event ?? '');
    if (type === 'message_start') {
      const m = d.message as Record<string, unknown> | undefined;
      message = { ...(m ?? {}), content: [] };
    } else if (type === 'content_block_start') {
      const idx = Number(d.index ?? blocks.length);
      const cb = { ...((d.content_block as Record<string, unknown>) ?? {}) };
      if (cb.type === 'text' && typeof cb.text !== 'string') cb.text = '';
      if ((cb.type === 'tool_use' || cb.type === 'server_tool_use') && cb.input === undefined) cb.input = {};
      if (cb.type === 'thinking' && typeof cb.thinking !== 'string') cb.thinking = '';
      blocks[idx] = cb;
    } else if (type === 'content_block_delta') {
      const idx = Number(d.index ?? 0);
      const delta = (d.delta as Record<string, unknown>) ?? {};
      const b = blocks[idx] ?? (blocks[idx] = { type: 'text', text: '' });
      if (delta.type === 'text_delta') b.text = String(b.text ?? '') + String(delta.text ?? '');
      else if (delta.type === 'input_json_delta') partial[idx] = (partial[idx] ?? '') + String(delta.partial_json ?? '');
      else if (delta.type === 'thinking_delta') b.thinking = String(b.thinking ?? '') + String(delta.thinking ?? '');
      else if (delta.type === 'signature_delta') b.signature = String(delta.signature ?? '');
    } else if (type === 'content_block_stop') {
      const idx = Number(d.index ?? 0);
      const b = blocks[idx];
      if (b && partial[idx] !== undefined) {
        b.input = parseJson(partial[idx]) ?? {};
        delete partial[idx];
      }
    } else if (type === 'message_delta') {
      if (!message) message = { content: [] };
      const delta = (d.delta as Record<string, unknown>) ?? {};
      if (delta.stop_reason !== undefined) message.stop_reason = delta.stop_reason;
      if (delta.stop_sequence !== undefined) message.stop_sequence = delta.stop_sequence;
      if (d.usage && typeof d.usage === 'object') message.usage = { ...((message.usage as Record<string, unknown>) ?? {}), ...(d.usage as Record<string, unknown>) };
    } else if (type === 'error') {
      if (!message) message = {};
      message.error = d.error ?? d;
    }
  }
  if (!message) return null;
  message.content = blocks.filter(Boolean);
  if (message.type === undefined) message.type = 'message';
  if (message.role === undefined) message.role = 'assistant';
  return message;
}

export function reconstructOpenAIChatFallback(events: SseEventLike[]): Record<string, unknown> | null {
  let envelope: Record<string, unknown> | null = null;
  let content = '';
  let reasoning = '';
  let role = 'assistant';
  let finish: unknown = null;
  const toolCalls: Array<Record<string, unknown>> = [];
  let usage: unknown;
  for (const ev of events) {
    if (ev.data.trim() === '[DONE]') break;
    const d = parseJson(ev.data);
    if (!d) continue;
    if (!envelope) envelope = { id: d.id, object: 'chat.completion', created: d.created, model: d.model, system_fingerprint: d.system_fingerprint };
    if (d.usage) usage = d.usage;
    const choices = d.choices as Array<Record<string, unknown>> | undefined;
    const ch = choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) finish = ch.finish_reason;
    const delta = (ch.delta as Record<string, unknown>) ?? {};
    if (typeof delta.role === 'string') role = delta.role;
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
        const idx = Number(tc.index ?? toolCalls.length);
        const cur = toolCalls[idx] ?? (toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) cur.id = tc.id;
        const fn = tc.function as Record<string, unknown> | undefined;
        const curFn = cur.function as Record<string, unknown>;
        if (fn?.name) curFn.name = String(curFn.name ?? '') + String(fn.name);
        if (fn?.arguments) curFn.arguments = String(curFn.arguments ?? '') + String(fn.arguments);
      }
    }
  }
  if (!envelope) return null;
  const message: Record<string, unknown> = { role, content: content || (toolCalls.length ? null : '') };
  if (reasoning) message.reasoning_content = reasoning;
  const calls = toolCalls.filter(Boolean);
  if (calls.length) message.tool_calls = calls;
  const out: Record<string, unknown> = { ...envelope, choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : (finish ?? 'stop') }] };
  if (usage) out.usage = usage;
  return out;
}

export function reconstructOpenAIResponsesFallback(events: SseEventLike[]): Record<string, unknown> | null {
  let response: Record<string, unknown> | null = null;
  const outputs: Array<Record<string, unknown>> = [];
  const textByIndex: Record<number, string> = {};
  const argsByIndex: Record<number, string> = {};
  for (const ev of events) {
    const d = parseJson(ev.data);
    if (!d) continue;
    const type = String(d.type ?? ev.event ?? '');
    if (type === 'response.created' || type === 'response.in_progress') response = { ...((d.response as Record<string, unknown>) ?? {}) };
    else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      const r = d.response as Record<string, unknown> | undefined;
      if (r) return r;
    } else if (type === 'response.output_item.added') {
      const idx = Number(d.output_index ?? outputs.length);
      outputs[idx] = { ...((d.item as Record<string, unknown>) ?? {}) };
    } else if (type === 'response.output_text.delta') {
      const idx = Number(d.output_index ?? 0);
      textByIndex[idx] = (textByIndex[idx] ?? '') + String(d.delta ?? '');
    } else if (type === 'response.function_call_arguments.delta') {
      const idx = Number(d.output_index ?? 0);
      argsByIndex[idx] = (argsByIndex[idx] ?? '') + String(d.delta ?? '');
    } else if (type === 'response.output_item.done') {
      const idx = Number(d.output_index ?? outputs.length);
      outputs[idx] = { ...((d.item as Record<string, unknown>) ?? {}) };
    }
  }
  if (!response) return null;
  const output = outputs.filter(Boolean).map((it, idx) => {
    if (it.type === 'message' && textByIndex[idx] !== undefined && !Array.isArray(it.content)) it.content = [{ type: 'output_text', text: textByIndex[idx] }];
    if (it.type === 'function_call' && argsByIndex[idx] !== undefined && !it.arguments) it.arguments = argsByIndex[idx];
    return it;
  });
  response.output = output;
  return response;
}

// ---------------------------------------------------------------------------
// Savings ledger fallback (§3.2 SavingsEvent shape, jsonl 0600)
// ---------------------------------------------------------------------------

export function appendSavingsEventFallback(ev: SavingsEventLike, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const file = savingsEventsPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(ev)}\n`, { mode: 0o600 });
  } catch {
    /* ledger is best-effort */
  }
}

export function readSavingsEventsFallback(env: NodeJS.ProcessEnv = process.env, opts: { sinceMs?: number; now?: number } = {}): SavingsEventLike[] {
  let raw = '';
  try {
    raw = fs.readFileSync(savingsEventsPath(env), 'utf8');
  } catch {
    return [];
  }
  const out: SavingsEventLike[] = [];
  const since = opts.sinceMs ?? 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as SavingsEventLike;
      if (typeof ev.ts === 'number' && ev.ts >= since) out.push(ev);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

function emptyRollup(window: SavingsRollupLike['window']): SavingsRollupLike {
  return { window, requests: 0, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0, usdSaved: 0, byModel: {}, byClient: {}, byProject: {} };
}

function bump(map: Record<string, { requests: number; tokensSaved: number; usdSaved: number }>, key: string, ev: SavingsEventLike): void {
  const row = map[key] ?? (map[key] = { requests: 0, tokensSaved: 0, usdSaved: 0 });
  row.requests++;
  row.tokensSaved += ev.tokensSaved;
  row.usdSaved += ev.usdSaved;
}

export function rollupSavingsFallback(events: SavingsEventLike[], now: number): Record<'today' | '7d' | '30d' | 'all', SavingsRollupLike> {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const cutoffs: Record<'today' | '7d' | '30d' | 'all', number> = { today: startOfDay.getTime(), '7d': now - 7 * 86_400_000, '30d': now - 30 * 86_400_000, all: -Infinity };
  const out = { today: emptyRollup('today'), '7d': emptyRollup('7d'), '30d': emptyRollup('30d'), all: emptyRollup('all') };
  for (const ev of events) {
    for (const w of ['today', '7d', '30d', 'all'] as const) {
      if (ev.ts < cutoffs[w]) continue;
      const r = out[w];
      r.requests++;
      r.tokensBefore += ev.tokensBefore;
      r.tokensAfter += ev.tokensAfter;
      r.tokensSaved += ev.tokensSaved;
      r.usdSaved += ev.usdSaved;
      bump(r.byModel, ev.model || 'unknown', ev);
      bump(r.byClient, ev.client || 'unknown', ev);
      if (ev.project) bump(r.byProject, ev.project, ev);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pricing fallback (blended)
// ---------------------------------------------------------------------------

/** Blended list price used when the pricing table is unavailable (USD per 1M tokens). */
export const BLENDED_PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } as const;

export function priceForFallback(_model: string): { input: number; output: number; cacheRead?: number; cacheWrite?: number } {
  return { ...BLENDED_PRICE };
}

export function costUsdFallback(_model: string, usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): number {
  const p = BLENDED_PRICE;
  return ((usage.input ?? 0) * p.input + (usage.output ?? 0) * p.output + (usage.cacheRead ?? 0) * p.cacheRead + (usage.cacheWrite ?? 0) * p.cacheWrite) / 1e6;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** A complete, self-contained deps object (all fallbacks). Tests start here and override. */
export function fallbackDeps(overrides: Partial<ProxyDeps> = {}): ProxyDeps {
  const isRetrieve = (n: string) => n === RETRIEVE_TOOL_NAME_FALLBACK;
  const store = overrides.store === undefined ? new MemoryStoreFallback(overrides.now ?? (() => Date.now())) : overrides.store;
  const base: ProxyDeps = {
    now: () => Date.now(),
    fetch: globalThis.fetch,
    sleep: defaultSleep,
    compressMessages: compressPassthrough,
    tokenizerFor: () => cl100kTokenizer,
    store,
    retrieveToolName: RETRIEVE_TOOL_NAME_FALLBACK,
    retrieveTool: retrieveToolFallback,
    isRetrieveToolCall: isRetrieve,
    findMarkers: findMarkersFallback,
    executeRetrieve: (args, opts) => executeRetrieveFallback(store, args, opts),
    extractRetrieveCalls: (r, f) => extractRetrieveCallsFallback(r, f, isRetrieve),
    buildRetrieveResultMessages: buildRetrieveResultMessagesFallback,
    neutralizeRetrieveHistory: (m, f) => neutralizeRetrieveHistoryFallback(m, f, isRetrieve),
    maxRetrieveRounds: 3,
    reconstructAnthropic: reconstructAnthropicFallback,
    reconstructOpenAIChat: reconstructOpenAIChatFallback,
    reconstructOpenAIResponses: reconstructOpenAIResponsesFallback,
    appendSavingsEvent: appendSavingsEventFallback,
    readSavingsEvents: readSavingsEventsFallback,
    rollupSavings: rollupSavingsFallback,
    priceFor: priceForFallback,
    costUsd: costUsdFallback,
    memory: null,
  };
  return { ...base, ...overrides };
}

type AnyModule = Record<string, unknown>;

async function tryImport(spec: string): Promise<AnyModule | null> {
  try {
    return (await import(/* @vite-ignore */ spec)) as AnyModule;
  } catch {
    return null;
  }
}

/**
 * Bind the real modules when present (pipeline, ccr, core, memory), keeping a
 * fallback for anything that has not landed. `report` lists what was bound so
 * `vg serve config` / doctor can say which layers are live.
 */
export async function loadDefaultDeps(opts: { env?: NodeJS.ProcessEnv; memory?: boolean; projectRoot?: string; now?: () => number } = {}): Promise<{ deps: ProxyDeps; bound: string[]; missing: string[] }> {
  const env = opts.env ?? process.env;
  const bound: string[] = [];
  const missing: string[] = [];
  const over: Partial<ProxyDeps> = {};
  if (opts.now) over.now = opts.now;

  const pipeline = await tryImport('../compress/pipeline.js');
  if (pipeline && typeof pipeline.compressMessages === 'function') {
    const fn = pipeline.compressMessages as (m: Message[], o?: CompressOptions, d?: unknown) => Promise<CompressResult>;
    over.compressMessages = (m, o) => fn(m, o, { env, now: over.now });
    bound.push('pipeline');
  } else missing.push('pipeline');

  const store = await tryImport('../compress/ccr/store.js');
  if (store && typeof store.defaultStore === 'function') {
    over.store = (store.defaultStore as (e?: NodeJS.ProcessEnv) => StoreLike)(env);
    bound.push('ccr-store');
  } else missing.push('ccr-store');

  const tool = await tryImport('../compress/ccr/tool.js');
  const handler = await tryImport('../compress/ccr/handler.js');
  const markers = await tryImport('../compress/ccr/markers.js');
  if (tool && handler && typeof tool.retrieveToolAnthropic === 'function' && typeof handler.executeRetrieve === 'function') {
    over.retrieveToolName = String(tool.RETRIEVE_TOOL_NAME ?? RETRIEVE_TOOL_NAME_FALLBACK);
    over.retrieveTool = (format) =>
      format === 'anthropic'
        ? (tool.retrieveToolAnthropic as () => Record<string, unknown>)()
        : format === 'responses'
          ? (tool.retrieveToolResponses as () => Record<string, unknown>)()
          : (tool.retrieveToolOpenAI as () => Record<string, unknown>)();
    over.isRetrieveToolCall = tool.isRetrieveToolCall as (n: string) => boolean;
    const realStore = over.store;
    const exec = handler.executeRetrieve as (s: unknown, a: Record<string, unknown>, o?: unknown) => RetrieveResult;
    over.executeRetrieve = (args, o) => exec(realStore, args, o);
    over.extractRetrieveCalls = handler.extractRetrieveCalls as ProxyDeps['extractRetrieveCalls'];
    over.buildRetrieveResultMessages = handler.buildRetrieveResultMessages as ProxyDeps['buildRetrieveResultMessages'];
    over.neutralizeRetrieveHistory = handler.neutralizeRetrieveHistory as ProxyDeps['neutralizeRetrieveHistory'];
    if (typeof handler.MAX_RETRIEVE_ROUNDS === 'number') over.maxRetrieveRounds = handler.MAX_RETRIEVE_ROUNDS;
    bound.push('ccr-handler');
  } else missing.push('ccr-handler');
  if (markers && typeof markers.findMarkers === 'function') {
    over.findMarkers = markers.findMarkers as ProxyDeps['findMarkers'];
    bound.push('ccr-markers');
  } else missing.push('ccr-markers');

  const streaming = await tryImport('../compress/ccr/streaming.js');
  if (streaming && typeof streaming.reconstructAnthropicResponse === 'function') {
    over.reconstructAnthropic = streaming.reconstructAnthropicResponse as ProxyDeps['reconstructAnthropic'];
    over.reconstructOpenAIChat = streaming.reconstructOpenAIChatResponse as ProxyDeps['reconstructOpenAIChat'];
    over.reconstructOpenAIResponses = streaming.reconstructOpenAIResponsesResponse as ProxyDeps['reconstructOpenAIResponses'];
    bound.push('ccr-streaming');
  } else missing.push('ccr-streaming');

  const ledger = await tryImport('../compress/ledger.js');
  if (ledger && typeof ledger.appendSavingsEvent === 'function') {
    over.appendSavingsEvent = ledger.appendSavingsEvent as ProxyDeps['appendSavingsEvent'];
    over.readSavingsEvents = ledger.readSavingsEvents as ProxyDeps['readSavingsEvents'];
    over.rollupSavings = ledger.rollupSavings as ProxyDeps['rollupSavings'];
    bound.push('ledger');
  } else missing.push('ledger');

  const tokenizers = await tryImport('../compress/tokenizers.js');
  if (tokenizers && typeof tokenizers.tokenizerFor === 'function') {
    over.tokenizerFor = tokenizers.tokenizerFor as ProxyDeps['tokenizerFor'];
    bound.push('tokenizers');
  } else missing.push('tokenizers');

  const pricing = await tryImport('../compress/pricing.js');
  if (pricing && typeof pricing.costUsd === 'function') {
    over.priceFor = pricing.priceFor as ProxyDeps['priceFor'];
    over.costUsd = pricing.costUsd as ProxyDeps['costUsd'];
    bound.push('pricing');
  } else missing.push('pricing');

  const router = await tryImport('../compress/router.js');
  if (router && typeof router.warmRouter === 'function') {
    over.warmRouter = router.warmRouter as () => Promise<void>;
    if (typeof router.createRouter === 'function') {
      const r = (router.createRouter as (o?: unknown) => { compress(req: Record<string, unknown>): { content: string } })({ env });
      over.compressText = (text) => {
        try {
          const res = r.compress({ content: text, tokenizer: cl100kTokenizer, injectMarker: false, losslessOnly: false });
          return typeof res.content === 'string' ? res.content : null;
        } catch {
          return null;
        }
      };
    }
    bound.push('router');
  } else missing.push('router');

  if (opts.memory) {
    const memory = await tryImport('../memory/index.js');
    if (memory && typeof memory.MemoryStore === 'function' && typeof memory.buildMemoryInjection === 'function') {
      const Store = memory.MemoryStore as new (o: Record<string, unknown>) => { search(q: string, o?: Record<string, unknown>): Array<{ memory: unknown; score: number }> };
      const ms = new Store({ projectRoot: opts.projectRoot, env, now: over.now });
      const build = memory.buildMemoryInjection as (m: unknown[], o?: Record<string, unknown>) => string;
      const tools = memory.memoryTools as (f: MessageFormat) => Record<string, unknown>[];
      const handle = memory.handleMemoryTool as (s: unknown, n: string, a: Record<string, unknown>) => { content: string; isError?: boolean };
      let learner: { observe(m: Message[], r?: Record<string, unknown>): unknown } | null = null;
      if (typeof memory.TrafficLearner === 'function') {
        try {
          learner = new (memory.TrafficLearner as new (s: unknown) => { observe(m: Message[], r?: Record<string, unknown>): unknown })(ms);
        } catch {
          learner = null;
        }
      }
      over.memory = {
        injection: (query, o) => {
          try {
            const hits = ms.search(query, { topK: o.topK });
            return hits.length ? build(hits.map((h) => h.memory), { maxTokens: o.maxTokens }) : '';
          } catch {
            return '';
          }
        },
        tools: (f) => {
          try {
            return tools(f);
          } catch {
            return [];
          }
        },
        handleTool: (n, a) => {
          try {
            return handle(ms, n, a);
          } catch (err) {
            return { content: `memory tool failed: ${(err as Error).message}`, isError: true };
          }
        },
        observe: (m, r) => {
          try {
            learner?.observe(m, r);
          } catch {
            /* learning is best-effort */
          }
        },
      };
      bound.push('memory');
    } else missing.push('memory');
  }

  return { deps: fallbackDeps(over), bound, missing };
}
