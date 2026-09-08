/**
 * Server-sent events plumbing.
 *
 *  - `SseParser` splits a byte stream on `\n\n` / `\r\n\r\n`, decoding only
 *    complete events as strict UTF-8 (a multi-byte character split across TCP
 *    reads must never be lossily decoded), skipping `:` comments, joining
 *    multi-line `data:`.
 *  - `RelayBuffer` keeps the parsed events for reconstruction while the raw
 *    bytes are passed through; past `maxBytes` it flips to `overflowed` and
 *    stops retaining (pass-through only; accounting falls back to estimates).
 *  - `responseToSse` synthesizes a provider-shaped SSE stream from a JSON
 *    response (used after a buffered retrieve turn).
 *  - `bufferedTurn` implements the buffered-CCR wrapper: hold the response
 *    uncommitted for `graceMs` (fast 4xx/429 keep their real status), then
 *    commit as SSE with a heartbeat every `heartbeatMs` until the final body
 *    arrives; post-commit failures become the provider's typed SSE error.
 */

import type { ServerResponse } from 'node:http';
import type { MessageFormat } from '../compress/types.js';

export interface SseEvent {
  event?: string;
  data: string;
  raw: string;
}

const LF2 = Buffer.from('\n\n');
const CRLF2 = Buffer.from('\r\n\r\n');

function findTerminator(buf: Buffer): { index: number; length: number } | null {
  const a = buf.indexOf(LF2);
  const b = buf.indexOf(CRLF2);
  if (a < 0 && b < 0) return null;
  if (a < 0) return { index: b, length: 4 };
  if (b < 0) return { index: a, length: 2 };
  return a <= b ? { index: a, length: 2 } : { index: b, length: 4 };
}

export function parseSseBlock(text: string): SseEvent | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
    let value = colon < 0 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  return { event, data: data.join('\n'), raw: text };
}

export class SseParser {
  private buf: Buffer = Buffer.alloc(0);
  readonly decoder = new TextDecoder('utf-8', { fatal: true });

  /** Push bytes; returns the complete events drained from the buffer. */
  push(chunk: Uint8Array | string): SseEvent[] {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    this.buf = this.buf.length ? Buffer.concat([this.buf, bytes]) : bytes;
    const out: SseEvent[] = [];
    for (;;) {
      const t = findTerminator(this.buf);
      if (!t) break;
      const block = this.buf.subarray(0, t.index);
      this.buf = this.buf.subarray(t.index + t.length);
      const text = this.decoder.decode(block);
      const ev = parseSseBlock(text);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** Salvage a truncated tail (append a terminator and drain). */
  flush(): SseEvent[] {
    if (!this.buf.length) return [];
    return this.push('\n\n');
  }

  get pending(): number {
    return this.buf.length;
  }
}

export class RelayBuffer {
  readonly parser = new SseParser();
  readonly events: SseEvent[] = [];
  overflowed = false;
  bytes = 0;
  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    if (this.overflowed) return;
    if (this.bytes > this.maxBytes) {
      this.overflowed = true;
      this.events.length = 0;
      return;
    }
    try {
      this.events.push(...this.parser.push(chunk));
    } catch {
      // Malformed UTF-8 in a complete event: an upstream protocol bug. Stop
      // reconstructing; the raw bytes still reach the client untouched.
      this.overflowed = true;
      this.events.length = 0;
    }
  }

  finish(): SseEvent[] {
    if (this.overflowed) return [];
    try {
      this.events.push(...this.parser.flush());
    } catch {
      /* ignore trailing garbage */
    }
    return this.events;
  }
}

// ---------------------------------------------------------------------------
// Text extraction for output-token estimation (no usage chunk)
// ---------------------------------------------------------------------------

export const TEXT_CHARS_PER_TOKEN = 4;
export const WIRE_BYTES_PER_TOKEN = 40;

export function extractStreamText(events: SseEvent[]): string {
  let text = '';
  for (const ev of events) {
    if (ev.data === '[DONE]') continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!d || typeof d !== 'object') continue;
    const type = String(d.type ?? '');
    if (type === 'content_block_delta') {
      const delta = (d.delta as Record<string, unknown>) ?? {};
      for (const k of ['text', 'thinking', 'partial_json']) if (typeof delta[k] === 'string') text += delta[k] as string;
      continue;
    }
    if (type.endsWith('.delta') && typeof d.delta === 'string') {
      text += d.delta;
      continue;
    }
    const choices = d.choices as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
    if (delta) {
      for (const k of ['content', 'reasoning_content', 'refusal']) if (typeof delta[k] === 'string') text += delta[k] as string;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown> | undefined;
          if (typeof fn?.arguments === 'string') text += fn.arguments;
        }
      }
    }
  }
  return text;
}

export function estimateOutputTokens(text: string, totalBytes: number): { tokens: number; source: 'estimated_text' | 'estimated_bytes' } {
  if (text.length) return { tokens: Math.max(1, Math.floor(text.length / TEXT_CHARS_PER_TOKEN)), source: 'estimated_text' };
  return { tokens: Math.max(0, Math.floor(Math.max(0, totalBytes) / WIRE_BYTES_PER_TOKEN)), source: 'estimated_bytes' };
}

// ---------------------------------------------------------------------------
// JSON response → SSE
// ---------------------------------------------------------------------------

function frame(event: string | undefined, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return event ? `event: ${event}\ndata: ${payload}\n\n` : `data: ${payload}\n\n`;
}

export function anthropicResponseToSse(resp: Record<string, unknown>): string {
  const content = Array.isArray(resp.content) ? (resp.content as Array<Record<string, unknown>>) : [];
  const usage = (resp.usage as Record<string, unknown>) ?? {};
  const start = { ...resp, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } };
  let out = frame('message_start', { type: 'message_start', message: start });
  content.forEach((block, index) => {
    const type = String(block.type ?? 'text');
    if (type === 'text') {
      out += frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      out += frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: String(block.text ?? '') } });
    } else if (type === 'tool_use' || type === 'server_tool_use') {
      out += frame('content_block_start', { type: 'content_block_start', index, content_block: { type, id: block.id, name: block.name, input: {} } });
      out += frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
    } else if (type === 'thinking') {
      out += frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
      out += frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: String(block.thinking ?? '') } });
      if (typeof block.signature === 'string') out += frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    } else {
      out += frame('content_block_start', { type: 'content_block_start', index, content_block: block });
    }
    out += frame('content_block_stop', { type: 'content_block_stop', index });
  });
  out += frame('message_delta', { type: 'message_delta', delta: { stop_reason: resp.stop_reason ?? 'end_turn', stop_sequence: resp.stop_sequence ?? null }, usage: { output_tokens: Number(usage.output_tokens ?? 0), ...pick(usage, ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) } });
  out += frame('message_stop', { type: 'message_stop' });
  return out;
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export function openAIChatResponseToSse(resp: Record<string, unknown>): string {
  const choices = Array.isArray(resp.choices) ? (resp.choices as Array<Record<string, unknown>>) : [];
  const envelope = { id: resp.id, object: 'chat.completion.chunk', created: resp.created, model: resp.model, system_fingerprint: resp.system_fingerprint };
  let out = '';
  choices.forEach((choice, index) => {
    const message = (choice.message as Record<string, unknown>) ?? {};
    out += frame(undefined, { ...envelope, choices: [{ index, delta: { role: message.role ?? 'assistant' }, finish_reason: null }] });
    if (typeof message.content === 'string' && message.content) out += frame(undefined, { ...envelope, choices: [{ index, delta: { content: message.content }, finish_reason: null }] });
    if (Array.isArray(message.tool_calls)) {
      (message.tool_calls as Array<Record<string, unknown>>).forEach((tc, i) => {
        out += frame(undefined, { ...envelope, choices: [{ index, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: tc.function }] }, finish_reason: null }] });
      });
    }
    out += frame(undefined, { ...envelope, choices: [{ index, delta: {}, finish_reason: choice.finish_reason ?? (Array.isArray(message.tool_calls) && (message.tool_calls as unknown[]).length ? 'tool_calls' : 'stop') }] });
  });
  if (resp.usage) out += frame(undefined, { ...envelope, choices: [], usage: resp.usage });
  out += 'data: [DONE]\n\n';
  return out;
}

export function openAIResponsesResponseToSse(resp: Record<string, unknown>): string {
  let seq = 0;
  let out = frame('response.created', { type: 'response.created', sequence_number: seq++, response: { ...resp, output: [], status: 'in_progress' } });
  const output = Array.isArray(resp.output) ? (resp.output as Array<Record<string, unknown>>) : [];
  output.forEach((item, output_index) => {
    out += frame('response.output_item.added', { type: 'response.output_item.added', sequence_number: seq++, output_index, item });
    if (item.type === 'message' && Array.isArray(item.content)) {
      (item.content as Array<Record<string, unknown>>).forEach((part, content_index) => {
        if (typeof part.text === 'string') out += frame('response.output_text.delta', { type: 'response.output_text.delta', sequence_number: seq++, item_id: item.id, output_index, content_index, delta: part.text });
      });
    } else if (item.type === 'function_call' && typeof item.arguments === 'string') {
      out += frame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', sequence_number: seq++, item_id: item.id, output_index, delta: item.arguments });
    }
    out += frame('response.output_item.done', { type: 'response.output_item.done', sequence_number: seq++, output_index, item });
  });
  out += frame('response.completed', { type: 'response.completed', sequence_number: seq++, response: { ...resp, status: resp.status ?? 'completed' } });
  return out;
}

export function responseToSse(format: MessageFormat, resp: Record<string, unknown>): string {
  if (format === 'anthropic') return anthropicResponseToSse(resp);
  if (format === 'responses') return openAIResponsesResponseToSse(resp);
  return openAIChatResponseToSse(resp);
}

// ---------------------------------------------------------------------------
// Typed SSE errors + heartbeats
// ---------------------------------------------------------------------------

export function anthropicErrorType(status: number): string {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  return 'api_error';
}

export function openAIErrorType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 400 && status < 500) return 'invalid_request_error';
  return 'server_error';
}

export function sseError(format: MessageFormat, status: number, message: string): string {
  if (format === 'anthropic') return frame('error', { type: 'error', error: { type: anthropicErrorType(status), message } });
  if (format === 'responses') return frame('error', { type: 'error', code: openAIErrorType(status), message, sequence_number: 0 });
  return frame(undefined, { error: { type: openAIErrorType(status), message, code: status } });
}

export function heartbeat(format: MessageFormat): string {
  return format === 'anthropic' ? frame('ping', { type: 'ping' }) : ': keepalive\n\n';
}

export const DEFAULT_BUFFERED_GRACE_MS = 5000;
export const HEARTBEAT_INTERVAL_MS = 250;

export interface BufferedOutcome {
  /** Final provider JSON (200) to be synthesized as SSE. */
  json?: Record<string, unknown>;
  /** A non-200 upstream reply to relay verbatim (status, headers, body). */
  passthrough?: { status: number; headers: Record<string, string>; body: string };
  /** Transport-level failure. */
  error?: { status: number; message: string };
}

/**
 * The buffered-turn wrapper. `work` resolves once the (possibly multi-round)
 * upstream exchange is done. Returns `{ committed }` telling the caller
 * whether SSE framing was already sent (true) or the reply was delivered
 * with its real status inside the grace window (false).
 */
export async function bufferedTurn<T extends BufferedOutcome>(
  res: ServerResponse,
  format: MessageFormat,
  work: Promise<T>,
  opts: { graceMs?: number; heartbeatMs?: number; sseHeaders?: Record<string, string>; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout },
): Promise<{ committed: boolean; outcome: T }> {
  const graceMs = opts.graceMs ?? DEFAULT_BUFFERED_GRACE_MS;
  const hb = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const setT = opts.setTimer ?? setTimeout;
  const clearT = opts.clearTimer ?? clearTimeout;
  let committed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let beat: ReturnType<typeof setTimeout> | undefined;
  const commit = (): void => {
    if (committed || res.headersSent) return;
    committed = true;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(opts.sseHeaders ?? {}) });
    res.flushHeaders?.();
    const tick = (): void => {
      if (res.writableEnded || res.destroyed) return;
      res.write(heartbeat(format));
      beat = setT(tick, hb);
      (beat as { unref?: () => void }).unref?.();
    };
    beat = setT(tick, hb);
    (beat as { unref?: () => void }).unref?.();
  };
  if (graceMs > 0) {
    timer = setT(commit, graceMs);
    (timer as { unref?: () => void }).unref?.();
  }
  let outcome: T;
  try {
    outcome = await work;
  } catch (err) {
    outcome = { error: { status: 502, message: (err as Error).message ?? 'upstream failure' } } as T;
  } finally {
    if (timer) clearT(timer);
    if (beat) clearT(beat);
  }
  if (res.destroyed) return { committed, outcome };
  if (committed) {
    if (outcome.json) res.end(responseToSse(format, outcome.json));
    else if (outcome.passthrough) res.end(sseError(format, outcome.passthrough.status, upstreamMessage(outcome.passthrough.body, outcome.passthrough.status)));
    else res.end(sseError(format, outcome.error?.status ?? 502, outcome.error?.message ?? 'upstream failure'));
    return { committed: true, outcome };
  }
  if (outcome.json) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(opts.sseHeaders ?? {}) });
    res.end(responseToSse(format, outcome.json));
  } else if (outcome.passthrough) {
    res.writeHead(outcome.passthrough.status, { ...outcome.passthrough.headers, 'content-length': String(Buffer.byteLength(outcome.passthrough.body)) });
    res.end(outcome.passthrough.body);
  } else {
    const body = JSON.stringify(format === 'anthropic' ? { type: 'error', error: { type: anthropicErrorType(outcome.error?.status ?? 502), message: outcome.error?.message ?? 'upstream failure' } } : { error: { type: openAIErrorType(outcome.error?.status ?? 502), message: outcome.error?.message ?? 'upstream failure' } });
    res.writeHead(outcome.error?.status ?? 502, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
    res.end(body);
  }
  return { committed: false, outcome };
}

function upstreamMessage(body: string, status: number): string {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const err = j.error as Record<string, unknown> | string | undefined;
    if (typeof err === 'string') return err;
    if (err && typeof err.message === 'string') return err.message;
  } catch {
    /* not json */
  }
  return `upstream returned ${status}`;
}
