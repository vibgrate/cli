/**
 * Streaming support for the retrieval loop.
 *
 * `SseBuffer` accumulates a server-sent-events byte stream and splits it into
 * events at frame boundaries (`\n\n`, CRLF tolerated) — decoding only after a
 * boundary is found so multi-byte characters split across reads survive. The
 * `reconstruct*` functions turn an event list back into the provider's
 * non-streaming response object (tool_use inputs re-assembled from
 * `input_json_delta`, usage carried) so the handler loop can run on it.
 * `responseToSse` re-emits a resolved response as a stream.
 */

export interface SseEvent {
  event?: string;
  data: string;
  raw: string;
  id?: string;
}

export const DEFAULT_SSE_MAX_BYTES = 8 * 1024 * 1024;
/** Seconds a buffered streaming turn waits before committing to SSE + heartbeats. */
export const BUFFERED_GRACE_SECONDS = 5;
/** Seconds between heartbeat frames once committed. */
export const HEARTBEAT_INTERVAL_SECONDS = 0.25;

export class SseBuffer {
  private chunks: Buffer[] = [];
  private length = 0;
  private readonly maxBytes: number;
  /** Set once more than `maxBytes` were pushed; callers should stop buffering and pass the stream through. */
  overflowed = false;
  private parsed: SseEvent[] = [];
  private remainder: Buffer = Buffer.alloc(0);

  constructor(opts: { maxBytes?: number } = {}) {
    this.maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_SSE_MAX_BYTES);
  }

  get bytes(): number {
    return this.length;
  }

  push(chunk: Uint8Array | string): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.length += buf.length;
    if (this.length > this.maxBytes) this.overflowed = true;
    this.chunks.push(buf);
    this.remainder = this.remainder.length ? Buffer.concat([this.remainder, buf]) : buf;
    this.splitFrames();
  }

  private splitFrames(): void {
    let buf = this.remainder;
    for (;;) {
      const lf = buf.indexOf('\n\n');
      const crlf = buf.indexOf('\r\n\r\n');
      let end: number;
      let skip: number;
      if (lf === -1 && crlf === -1) break;
      if (crlf !== -1 && (lf === -1 || crlf < lf)) {
        end = crlf;
        skip = 4;
      } else {
        end = lf;
        skip = 2;
      }
      const frame = buf.subarray(0, end).toString('utf8');
      buf = buf.subarray(end + skip);
      const ev = parseSseFrame(frame);
      if (ev) this.parsed.push(ev);
    }
    this.remainder = buf;
  }

  /** Complete events seen so far (partial trailing frame excluded). */
  events(): SseEvent[] {
    return [...this.parsed];
  }

  /** Everything pushed so far as one string (raw passthrough on fallback). */
  drain(): string {
    const all = Buffer.concat(this.chunks).toString('utf8');
    this.chunks = [];
    this.length = 0;
    this.parsed = [];
    this.remainder = Buffer.alloc(0);
    return all;
  }

  /** Raw bytes pushed so far without clearing. */
  raw(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Text of the incomplete trailing frame, if any. */
  pending(): string {
    return this.remainder.toString('utf8');
  }
}

/** Parse one SSE frame (lines separated by \n or \r\n). Comments (`: ping`) yield null. */
export function parseSseFrame(frame: string): SseEvent | null {
  const lines = frame.split(/\r?\n/);
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  let sawField = false;
  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    sawField = true;
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  if (!sawField) return null;
  const ev: SseEvent = { data: data.join('\n'), raw: frame };
  if (event !== undefined) ev.event = event;
  if (id !== undefined) ev.id = id;
  return ev;
}

/** Split a complete SSE body into events (convenience over SseBuffer). */
export function parseSseText(text: string): SseEvent[] {
  const b = new SseBuffer({ maxBytes: Number.MAX_SAFE_INTEGER });
  b.push(text);
  if (!text.endsWith('\n\n') && !text.endsWith('\r\n\r\n')) b.push('\n\n');
  return b.events();
}

function parseJson(data: string): Record<string, unknown> | null {
  const t = data.trim();
  if (!t || t === '[DONE]') return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Anthropic `message_start`/`content_block_*`/`message_delta` events → a `message` object. */
export function reconstructAnthropicResponse(events: Array<{ event?: string; data: string }>): Record<string, unknown> | null {
  let message: Record<string, unknown> | null = null;
  const blocks = new Map<number, Record<string, unknown>>();
  const partialJson = new Map<number, string>();
  let usage: Record<string, unknown> | undefined;
  let sawAny = false;
  for (const ev of events) {
    const d = parseJson(ev.data);
    if (!d) continue;
    const type = typeof d.type === 'string' ? d.type : ev.event;
    if (type === 'message_start') {
      const m = isObj(d.message) ? d.message : {};
      message = { ...m, content: [] };
      if (isObj(m.usage)) usage = { ...m.usage };
      sawAny = true;
    } else if (type === 'content_block_start') {
      const idx = typeof d.index === 'number' ? d.index : blocks.size;
      const cb: Record<string, unknown> = isObj(d.content_block) ? { ...d.content_block } : { type: 'text', text: '' };
      if (cb.type === 'tool_use' || cb.type === 'server_tool_use') {
        cb.input = isObj(cb.input) ? cb.input : {};
        partialJson.set(idx, '');
      } else if (cb.type === 'text' && typeof cb.text !== 'string') cb.text = '';
      else if (cb.type === 'thinking' && typeof cb.thinking !== 'string') cb.thinking = '';
      blocks.set(idx, cb);
      sawAny = true;
    } else if (type === 'content_block_delta') {
      const idx = typeof d.index === 'number' ? d.index : -1;
      const cb = blocks.get(idx);
      const delta = isObj(d.delta) ? d.delta : {};
      if (!cb) continue;
      switch (delta.type) {
        case 'text_delta':
          cb.text = `${typeof cb.text === 'string' ? cb.text : ''}${typeof delta.text === 'string' ? delta.text : ''}`;
          break;
        case 'input_json_delta':
          partialJson.set(idx, `${partialJson.get(idx) ?? ''}${typeof delta.partial_json === 'string' ? delta.partial_json : ''}`);
          break;
        case 'thinking_delta':
          cb.thinking = `${typeof cb.thinking === 'string' ? cb.thinking : ''}${typeof delta.thinking === 'string' ? delta.thinking : ''}`;
          break;
        case 'signature_delta':
          cb.signature = `${typeof cb.signature === 'string' ? cb.signature : ''}${typeof delta.signature === 'string' ? delta.signature : ''}`;
          break;
        case 'citations_delta':
          if (!Array.isArray(cb.citations)) cb.citations = [];
          (cb.citations as unknown[]).push(delta.citation);
          break;
        default:
          break;
      }
    } else if (type === 'content_block_stop') {
      const idx = typeof d.index === 'number' ? d.index : -1;
      const cb = blocks.get(idx);
      if (cb && partialJson.has(idx)) {
        const raw = partialJson.get(idx) ?? '';
        if (raw.trim()) {
          try {
            cb.input = JSON.parse(raw);
          } catch {
            cb.input = {};
          }
        }
        partialJson.delete(idx);
      }
    } else if (type === 'message_delta') {
      if (!message) message = { type: 'message', role: 'assistant', content: [] };
      const delta = isObj(d.delta) ? d.delta : {};
      for (const k of ['stop_reason', 'stop_sequence', 'stop_details']) if (delta[k] !== undefined) message[k] = delta[k];
      if (isObj(d.usage)) usage = { ...(usage ?? {}), ...d.usage };
    } else if (type === 'error') {
      if (!message) message = { type: 'error', error: d.error };
    }
  }
  if (!message && !sawAny) return null;
  if (!message) message = { type: 'message', role: 'assistant', content: [] };
  message.content = [...blocks.keys()].sort((a, b) => a - b).map((k) => blocks.get(k)!);
  if (usage) message.usage = usage;
  return message;
}

/** OpenAI `chat.completion.chunk` events → a `chat.completion` object. */
export function reconstructOpenAIChatResponse(events: Array<{ data: string }>): Record<string, unknown> | null {
  let envelope: Record<string, unknown> | null = null;
  let content = '';
  let role = 'assistant';
  let finish: string | null = null;
  let usage: Record<string, unknown> | undefined;
  let refusal = '';
  let reasoning = '';
  const toolCalls = new Map<number, { id?: string; type: string; function: { name: string; arguments: string } }>();
  for (const ev of events) {
    const d = parseJson(ev.data);
    if (!d) continue;
    if (!envelope) {
      envelope = {};
      for (const k of ['id', 'created', 'model', 'system_fingerprint', 'service_tier']) if (d[k] !== undefined) envelope[k] = d[k];
    }
    if (isObj(d.usage)) usage = d.usage;
    const choices = Array.isArray(d.choices) ? d.choices : [];
    const first = isObj(choices[0]) ? choices[0] : undefined;
    if (!first) continue;
    if (typeof first.finish_reason === 'string') finish = first.finish_reason;
    const delta = isObj(first.delta) ? first.delta : null;
    if (!delta) continue;
    if (typeof delta.role === 'string') role = delta.role;
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.refusal === 'string') refusal += delta.refusal;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!isObj(tc)) continue;
        const idx = typeof tc.index === 'number' ? tc.index : toolCalls.size;
        let cur = toolCalls.get(idx);
        if (!cur) {
          cur = { type: 'function', function: { name: '', arguments: '' } };
          toolCalls.set(idx, cur);
        }
        if (typeof tc.id === 'string') cur.id = tc.id;
        if (typeof tc.type === 'string') cur.type = tc.type;
        const fn = isObj(tc.function) ? tc.function : {};
        if (typeof fn.name === 'string') cur.function.name += fn.name;
        if (typeof fn.arguments === 'string') cur.function.arguments += fn.arguments;
      }
    }
  }
  if (!envelope) return null;
  const message: Record<string, unknown> = { role, content: content || null };
  if (refusal) message.refusal = refusal;
  if (reasoning) message.reasoning_content = reasoning;
  const calls = [...toolCalls.keys()].sort((a, b) => a - b).map((k) => toolCalls.get(k)!);
  if (calls.length) message.tool_calls = calls;
  const out: Record<string, unknown> = { ...envelope, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : (finish ?? 'stop'), logprobs: null }] };
  if (usage) out.usage = usage;
  return out;
}

/** OpenAI Responses stream (`response.*` events) → a `response` object. */
export function reconstructOpenAIResponsesResponse(events: Array<{ event?: string; data: string }>): Record<string, unknown> | null {
  let response: Record<string, unknown> | null = null;
  const items = new Map<number, Record<string, unknown>>();
  const argBuf = new Map<number, string>();
  const textBuf = new Map<string, string>();
  for (const ev of events) {
    const d = parseJson(ev.data);
    if (!d) continue;
    const type = typeof d.type === 'string' ? d.type : (ev.event ?? '');
    if (type === 'response.created' || type === 'response.in_progress') {
      if (isObj(d.response)) response = { ...d.response };
    } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      if (isObj(d.response)) {
        // The final event carries the authoritative object; prefer it wholesale.
        return { ...d.response };
      }
    } else if (type === 'response.output_item.added') {
      const idx = typeof d.output_index === 'number' ? d.output_index : items.size;
      const item = isObj(d.item) ? { ...d.item } : {};
      if (item.type === 'function_call') {
        argBuf.set(idx, typeof item.arguments === 'string' ? item.arguments : '');
      }
      items.set(idx, item);
    } else if (type === 'response.function_call_arguments.delta') {
      const idx = typeof d.output_index === 'number' ? d.output_index : -1;
      argBuf.set(idx, `${argBuf.get(idx) ?? ''}${typeof d.delta === 'string' ? d.delta : ''}`);
    } else if (type === 'response.function_call_arguments.done') {
      const idx = typeof d.output_index === 'number' ? d.output_index : -1;
      if (typeof d.arguments === 'string') argBuf.set(idx, d.arguments);
    } else if (type === 'response.output_text.delta') {
      const key = `${typeof d.output_index === 'number' ? d.output_index : 0}:${typeof d.content_index === 'number' ? d.content_index : 0}`;
      textBuf.set(key, `${textBuf.get(key) ?? ''}${typeof d.delta === 'string' ? d.delta : ''}`);
    } else if (type === 'response.output_text.done') {
      const key = `${typeof d.output_index === 'number' ? d.output_index : 0}:${typeof d.content_index === 'number' ? d.content_index : 0}`;
      if (typeof d.text === 'string') textBuf.set(key, d.text);
    } else if (type === 'response.output_item.done') {
      const idx = typeof d.output_index === 'number' ? d.output_index : -1;
      if (isObj(d.item)) items.set(idx, { ...d.item });
    }
  }
  if (!response && items.size === 0) return null;
  const output: Record<string, unknown>[] = [];
  for (const idx of [...items.keys()].sort((a, b) => a - b)) {
    const item = { ...items.get(idx)! };
    if (item.type === 'function_call' && argBuf.has(idx)) item.arguments = argBuf.get(idx);
    if (item.type === 'message') {
      const content = Array.isArray(item.content) ? [...item.content] : [];
      for (const [key, text] of textBuf) {
        const [oi, ci] = key.split(':').map((n) => Number.parseInt(n, 10));
        if (oi !== idx) continue;
        const existing: Record<string, unknown> = isObj(content[ci]) ? { ...(content[ci] as Record<string, unknown>) } : { type: 'output_text', annotations: [] };
        existing.text = text;
        content[ci] = existing;
      }
      item.content = content;
    }
    output.push(item);
  }
  const out: Record<string, unknown> = { ...(response ?? { object: 'response' }), output };
  if (!out.status) out.status = 'completed';
  return out;
}

/** Re-emit a resolved (non-streaming) response as SSE text for the client. */
export function responseToSse(response: Record<string, unknown>, format: 'anthropic' | 'openai' | 'responses'): string {
  const frames: string[] = [];
  const frame = (event: string | undefined, data: unknown): void => {
    frames.push(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
  };
  if (format === 'anthropic') {
    const { content, usage, ...head } = response;
    const blocks = Array.isArray(content) ? content : [];
    frame('message_start', { type: 'message_start', message: { ...head, content: [], usage: isObj(usage) ? { ...usage, output_tokens: 0 } : undefined } });
    blocks.forEach((b, i) => {
      if (!isObj(b)) return;
      if (b.type === 'text') {
        frame('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
        frame('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: typeof b.text === 'string' ? b.text : '' } });
      } else if (b.type === 'tool_use') {
        frame('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        frame('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } });
      } else if (b.type === 'thinking') {
        frame('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } });
        frame('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: typeof b.thinking === 'string' ? b.thinking : '' } });
        if (typeof b.signature === 'string') frame('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: b.signature } });
      } else {
        frame('content_block_start', { type: 'content_block_start', index: i, content_block: b });
      }
      frame('content_block_stop', { type: 'content_block_stop', index: i });
    });
    frame('message_delta', { type: 'message_delta', delta: { stop_reason: response.stop_reason ?? 'end_turn', stop_sequence: response.stop_sequence ?? null }, usage: isObj(usage) ? { output_tokens: usage.output_tokens ?? 0 } : { output_tokens: 0 } });
    frame('message_stop', { type: 'message_stop' });
    return frames.join('');
  }
  if (format === 'responses') {
    frame('response.created', { type: 'response.created', response: { ...response, output: [] } });
    const output = Array.isArray(response.output) ? response.output : [];
    output.forEach((item, i) => {
      frame('response.output_item.added', { type: 'response.output_item.added', output_index: i, item });
      frame('response.output_item.done', { type: 'response.output_item.done', output_index: i, item });
    });
    frame('response.completed', { type: 'response.completed', response });
    return frames.join('');
  }
  const { choices, usage, ...envelope } = response;
  const first = Array.isArray(choices) && isObj(choices[0]) ? choices[0] : {};
  const msg = isObj(first.message) ? first.message : {};
  const base = { ...envelope, object: 'chat.completion.chunk' };
  frame(undefined, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  if (typeof msg.content === 'string' && msg.content) frame(undefined, { ...base, choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }] });
  if (Array.isArray(msg.tool_calls)) {
    msg.tool_calls.forEach((tc, i) => frame(undefined, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, ...(isObj(tc) ? tc : {}) }] }, finish_reason: null }] }));
  }
  frame(undefined, { ...base, choices: [{ index: 0, delta: {}, finish_reason: first.finish_reason ?? 'stop' }], ...(usage ? { usage } : {}) });
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

/** Heartbeat frame for a buffered streaming turn (a comment line: invisible to SSE clients). */
export function heartbeatFrame(): string {
  return ': vg-heartbeat\n\n';
}

/** Cheap byte-level check: does a partially-buffered stream already mention our tool? */
export function streamMentionsRetrieveTool(buffer: SseBuffer): boolean {
  const raw = buffer.raw();
  return raw.includes('vg_retrieve') && (raw.includes('"tool_use"') || raw.includes('"tool_calls"') || raw.includes('"function_call"') || raw.includes('functionCall'));
}
