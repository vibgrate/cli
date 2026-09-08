/**
 * Retrieval loop: find `vg_retrieve` calls in a provider response, execute
 * them against the store, append the tool round to the conversation in the
 * provider's own shape and call upstream again — at most MAX_RETRIEVE_ROUNDS.
 *
 * Mixed turns (retrieve calls next to other tool calls) are handed back to
 * the client untouched: every tool_use needs a matching tool_result and only
 * the retrieve ones can be synthesised here.
 */

import type { Message, MessageFormat, Tokenizer } from '../types.js';
import { normalizeHash } from './markers.js';
import { RETRIEVE_TOOL_NAME } from './tool.js';
import type { CompressionStore, RetrieveOptions } from './store.js';

export const MAX_RETRIEVE_ROUNDS = 3;

export interface RetrieveCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ExtractedCalls {
  retrieve: RetrieveCall[];
  /** Tool calls that are not ours (client must resolve). */
  other: RetrieveCall[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseArgs(v: unknown): Record<string, unknown> {
  if (isObj(v)) return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v) as unknown;
      return isObj(p) ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** All tool calls in a response, split into retrieve vs. other. */
export function extractAllToolCalls(response: Record<string, unknown>, format: MessageFormat): ExtractedCalls {
  const out: ExtractedCalls = { retrieve: [], other: [] };
  const push = (id: string, name: string, args: unknown): void => {
    const call = { id, name, args: parseArgs(args) };
    if (name === RETRIEVE_TOOL_NAME) out.retrieve.push(call);
    else out.other.push(call);
  };
  if (!isObj(response)) return out;
  if (format === 'anthropic') {
    const content = Array.isArray(response.content) ? response.content : [];
    for (const b of content) if (isObj(b) && b.type === 'tool_use') push(String(b.id ?? ''), String(b.name ?? ''), b.input);
  } else if (format === 'responses') {
    const output = Array.isArray(response.output) ? response.output : [];
    for (const item of output) if (isObj(item) && item.type === 'function_call') push(String(item.call_id ?? item.id ?? ''), String(item.name ?? ''), item.arguments);
  } else if (format === 'gemini') {
    const cands = Array.isArray(response.candidates) ? response.candidates : [];
    const first = isObj(cands[0]) ? cands[0] : undefined;
    const content = first && isObj(first.content) ? first.content : undefined;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    for (const p of parts) {
      if (!isObj(p) || !isObj(p.functionCall)) continue;
      const fc = p.functionCall;
      push(String(fc.id ?? fc.name ?? RETRIEVE_TOOL_NAME), String(fc.name ?? ''), fc.args);
    }
  } else {
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const first = isObj(choices[0]) ? choices[0] : undefined;
    const msg = first && isObj(first.message) ? first.message : undefined;
    const calls = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    for (const tc of calls) {
      if (!isObj(tc)) continue;
      const fn = isObj(tc.function) ? tc.function : {};
      push(String(tc.id ?? ''), String(fn.name ?? tc.name ?? ''), fn.arguments ?? tc.arguments);
    }
  }
  return out;
}

/** Only the `vg_retrieve` calls of a response. */
export function extractRetrieveCalls(response: Record<string, unknown>, format: MessageFormat): RetrieveCall[] {
  return extractAllToolCalls(response, format).retrieve;
}

export type ResidualStatus = 'resolved' | 'skipped_mixed_tools' | 'error';

/** After the loop: `resolved` (no retrieve calls left), `skipped_mixed_tools` (client resolves), `error` (lone retrieve calls unresolved). */
export function residualStatus(response: Record<string, unknown>, format: MessageFormat): ResidualStatus {
  const { retrieve, other } = extractAllToolCalls(response, format);
  if (retrieve.length === 0) return 'resolved';
  return other.length > 0 ? 'skipped_mixed_tools' : 'error';
}

function parseLines(v: unknown): [number, number] | undefined {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') return [v[0], v[1]];
  if (typeof v === 'string') {
    const m = /^\s*(\d+)\s*[-:,]\s*(\d+)\s*$/.exec(v);
    if (m) return [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10)];
  }
  return undefined;
}

function intArg(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number.parseInt(v, 10);
  return undefined;
}

/** Retrieve-tool arguments → store options (tolerant of snake/camel case). */
export function retrieveOptionsFromArgs(args: Record<string, unknown>, opts: { maxTokens?: number } = {}): RetrieveOptions {
  const o: RetrieveOptions = {};
  if (typeof args.grep === 'string' && args.grep) o.grep = args.grep;
  const lines = parseLines(args.lines);
  if (lines) o.lines = lines;
  const head = intArg(args.head);
  if (head !== undefined) o.head = head;
  const tail = intArg(args.tail);
  if (tail !== undefined) o.tail = tail;
  const jp = args.json_path ?? args.jsonPath;
  if (typeof jp === 'string' && jp) o.jsonPath = jp;
  const mt = intArg(args.max_tokens ?? args.maxTokens) ?? opts.maxTokens;
  if (mt !== undefined && mt > 0) o.maxTokens = mt;
  return o;
}

/** Execute one retrieve call. `content` is the JSON the model receives. */
export function executeRetrieve(store: CompressionStore, args: Record<string, unknown>, opts: { maxTokens?: number; tokenizer?: Tokenizer } = {}): { content: string; found: boolean; hash?: string; truncated?: boolean } {
  const hash = normalizeHash(args.hash);
  if (!hash) {
    return { content: JSON.stringify({ error: 'hash must be 12 or 24 hex characters from a compression marker', hash: String(args.hash ?? '') }, null, 2), found: false };
  }
  try {
    const r = store.retrieve(hash, retrieveOptionsFromArgs(args, opts));
    if (!r.found) {
      return {
        content: JSON.stringify({ error: `${r.detail ?? 'Entry not found'}. Do not retry the same hash. Re-run the source command or re-read the source file.`, hash, status: r.status, ttl_seconds: store.statusOf(hash).ttlSeconds }, null, 2),
        found: false,
        hash,
      };
    }
    const body: Record<string, unknown> = { hash, original_content: r.content };
    if (r.entry?.originalItemCount !== undefined) body.original_item_count = r.entry.originalItemCount;
    if (r.view !== 'full') body.view = r.view;
    if (r.totalLines !== undefined) body.total_lines = r.totalLines;
    if (r.matchedLines !== undefined) body.matched_lines = r.matchedLines;
    if (r.truncated) body.truncated = true;
    if (r.status === 'redacted') body.note = 'credential-shaped values were redacted before storage';
    return { content: JSON.stringify(body, null, 2), found: true, hash, truncated: r.truncated };
  } catch (err) {
    return { content: JSON.stringify({ error: `Retrieval failed: ${(err as Error).message}`, hash }, null, 2), found: false, hash };
  }
}

/**
 * The assistant round (tool calls) plus the tool results, in the format's own
 * shape: Anthropic → assistant tool_use + user tool_result; OpenAI → assistant
 * tool_calls + one `tool` message per call; Responses → function_call items +
 * function_call_output items; Gemini → model functionCall + user functionResponse.
 */
export function buildRetrieveResultMessages(calls: RetrieveCall[], results: Array<{ content: string }>, format: MessageFormat, assistant?: Record<string, unknown>): Message[] {
  const out: Message[] = [];
  if (format === 'anthropic') {
    out.push(assistant && Array.isArray(assistant.content) ? { role: 'assistant', content: assistant.content } : { role: 'assistant', content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })) });
    out.push({ role: 'user', content: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: results[i]?.content ?? '' })) });
    return out;
  }
  if (format === 'responses') {
    for (const c of calls) out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
    calls.forEach((c, i) => out.push({ type: 'function_call_output', call_id: c.id, output: results[i]?.content ?? '' }));
    return out;
  }
  if (format === 'gemini') {
    out.push({ role: 'model', parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) });
    out.push({ role: 'user', parts: calls.map((c, i) => ({ functionResponse: { name: c.name, response: parseResult(results[i]?.content ?? '') } })) });
    return out;
  }
  const msg: Record<string, unknown> = { role: 'assistant', content: assistant && typeof assistant.content === 'string' ? assistant.content : null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
  out.push(msg);
  calls.forEach((c, i) => out.push({ role: 'tool', tool_call_id: c.id, content: results[i]?.content ?? '' }));
  return out;
}

function parseResult(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return isObj(v) ? v : { content: text };
  } catch {
    return { content: text };
  }
}

/** The assistant message of a response in the format's message shape (whole content, so text next to the calls survives). */
export function assistantMessageOf(response: Record<string, unknown>, format: MessageFormat): Record<string, unknown> | undefined {
  if (format === 'anthropic') return { role: 'assistant', content: Array.isArray(response.content) ? response.content : [] };
  if (format === 'gemini') {
    const cands = Array.isArray(response.candidates) ? response.candidates : [];
    const first = isObj(cands[0]) ? cands[0] : undefined;
    const content = first && isObj(first.content) ? first.content : undefined;
    return { role: 'model', parts: content && Array.isArray(content.parts) ? content.parts : [] };
  }
  if (format === 'responses') return undefined;
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = isObj(choices[0]) ? choices[0] : undefined;
  const msg = first && isObj(first.message) ? first.message : undefined;
  return msg ? { role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls } : undefined;
}

export interface RetrieveLoopOptions {
  store: CompressionStore;
  format: MessageFormat;
  /** Call upstream with the extended conversation; resolves to the next response. */
  call: (messages: Message[]) => Promise<Record<string, unknown>>;
  maxRounds?: number;
  maxTokens?: number;
  /** Observe each executed call (stats). */
  onRetrieve?: (call: RetrieveCall, found: boolean) => void;
}

export interface RetrieveLoopResult {
  response: Record<string, unknown>;
  messages: Message[];
  rounds: number;
  retrievals: number;
  status: ResidualStatus;
  /** True when the loop stopped on an upstream error and the last response still carries retrieve calls. */
  upstreamError?: string;
}

/**
 * Run the retrieval loop. Returns the final response and the conversation as
 * extended by the tool rounds (callers that log or continue need both).
 */
export async function runRetrieveLoop(response: Record<string, unknown>, messages: Message[], opts: RetrieveLoopOptions): Promise<RetrieveLoopResult> {
  const max = Math.max(0, Math.floor(opts.maxRounds ?? MAX_RETRIEVE_ROUNDS));
  let current = response;
  let convo = [...messages];
  let rounds = 0;
  let retrievals = 0;
  let upstreamError: string | undefined;
  while (rounds < max) {
    const { retrieve, other } = extractAllToolCalls(current, opts.format);
    if (retrieve.length === 0) break;
    if (other.length > 0) break; // mixed turn: the client resolves everything
    rounds += 1;
    const results = retrieve.map((c) => {
      const r = executeRetrieve(opts.store, c.args, { maxTokens: opts.maxTokens });
      retrievals += 1;
      opts.onRetrieve?.(c, r.found);
      return { content: r.content };
    });
    if (opts.format === 'responses') {
      const output = Array.isArray(current.output) ? (current.output as Message[]) : [];
      convo = [...convo, ...output, ...retrieve.map((c, i) => ({ type: 'function_call_output', call_id: c.id, output: results[i].content }))];
    } else {
      convo = [...convo, ...buildRetrieveResultMessages(retrieve, results, opts.format, assistantMessageOf(current, opts.format))];
    }
    try {
      current = await opts.call(convo);
    } catch (err) {
      upstreamError = (err as Error).message;
      break;
    }
  }
  const result: RetrieveLoopResult = { response: current, messages: convo, rounds, retrievals, status: residualStatus(current, opts.format) };
  if (upstreamError !== undefined) result.upstreamError = upstreamError;
  return result;
}

function hashOfArgs(args: unknown): string {
  const a = parseArgs(args);
  return normalizeHash(a.hash) ?? '?';
}

function summarizeResult(content: unknown): string {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((x) => (isObj(x) && typeof x.text === 'string' ? x.text : '')).join('') : '';
  return `[retrieved original: ${text.length} chars]`;
}

/**
 * Replace prior-turn retrieve tool calls/results with plain text so the tool
 * can be omitted from a later request without a "tool reference not found"
 * error. Messages are replaced, never dropped, so role alternation holds.
 */
export function neutralizeRetrieveHistory(messages: Message[], format: MessageFormat): Message[] {
  const retrieveIds = new Set<string>();
  const out: Message[] = [];
  for (const m of messages) {
    if (!isObj(m)) {
      out.push(m);
      continue;
    }
    if (format === 'responses') {
      if (m.type === 'function_call' && m.name === RETRIEVE_TOOL_NAME) {
        retrieveIds.add(String(m.call_id ?? m.id ?? ''));
        out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `[retrieved original for hash=${hashOfArgs(m.arguments)}]` }] });
        continue;
      }
      if (m.type === 'function_call_output' && retrieveIds.has(String(m.call_id ?? ''))) {
        out.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: summarizeResult(m.output) }] });
        continue;
      }
      out.push(m);
      continue;
    }
    if (format === 'gemini') {
      const parts = Array.isArray(m.parts) ? m.parts : null;
      if (!parts) {
        out.push(m);
        continue;
      }
      let changed = false;
      const next = parts.map((p) => {
        if (!isObj(p)) return p;
        if (isObj(p.functionCall) && p.functionCall.name === RETRIEVE_TOOL_NAME) {
          changed = true;
          retrieveIds.add(String(p.functionCall.id ?? p.functionCall.name));
          return { text: `[retrieved original for hash=${hashOfArgs(p.functionCall.args)}]` };
        }
        if (isObj(p.functionResponse) && (p.functionResponse.name === RETRIEVE_TOOL_NAME || retrieveIds.has(String(p.functionResponse.id ?? '')))) {
          changed = true;
          const resp = p.functionResponse.response;
          return { text: summarizeResult(typeof resp === 'string' ? resp : JSON.stringify(resp)) };
        }
        return p;
      });
      out.push(changed ? { ...m, parts: next } : m);
      continue;
    }
    // OpenAI chat
    if (Array.isArray(m.tool_calls)) {
      const keep: unknown[] = [];
      const notes: string[] = [];
      for (const tc of m.tool_calls) {
        const fn = isObj(tc) && isObj(tc.function) ? tc.function : undefined;
        if (fn && fn.name === RETRIEVE_TOOL_NAME) {
          retrieveIds.add(String((tc as Record<string, unknown>).id ?? ''));
          notes.push(`[retrieved original for hash=${hashOfArgs(fn.arguments)}]`);
        } else keep.push(tc);
      }
      if (notes.length) {
        const text = [typeof m.content === 'string' ? m.content : '', ...notes].filter(Boolean).join('\n');
        const nm: Record<string, unknown> = { ...m, content: text };
        if (keep.length) nm.tool_calls = keep;
        else delete nm.tool_calls;
        out.push(nm);
        continue;
      }
    }
    if (m.role === 'tool' && retrieveIds.has(String(m.tool_call_id ?? ''))) {
      out.push({ role: 'user', content: summarizeResult(m.content) });
      continue;
    }
    // Anthropic / Vercel blocks
    if (Array.isArray(m.content)) {
      let changed = false;
      const next = m.content.map((b) => {
        if (!isObj(b)) return b;
        if ((b.type === 'tool_use' || b.type === 'tool-call') && (b.name === RETRIEVE_TOOL_NAME || b.toolName === RETRIEVE_TOOL_NAME)) {
          changed = true;
          retrieveIds.add(String(b.id ?? b.toolCallId ?? ''));
          return { type: 'text', text: `[retrieved original for hash=${hashOfArgs(b.input ?? b.args)}]` };
        }
        if (b.type === 'tool_result' && retrieveIds.has(String(b.tool_use_id ?? ''))) {
          changed = true;
          return { type: 'text', text: summarizeResult(b.content) };
        }
        if (b.type === 'tool-result' && (retrieveIds.has(String(b.toolCallId ?? '')) || b.toolName === RETRIEVE_TOOL_NAME)) {
          changed = true;
          const o = isObj(b.output) ? b.output.value : b.output ?? b.result;
          return { type: 'text', text: summarizeResult(typeof o === 'string' ? o : JSON.stringify(o ?? '')) };
        }
        return b;
      });
      out.push(changed ? { ...m, content: next } : m);
      continue;
    }
    out.push(m);
  }
  return out;
}
