import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { reconstructAnthropicFallback, reconstructOpenAIChatFallback, reconstructOpenAIResponsesFallback } from './fallbacks.js';
import { anthropicResponseToSse, bufferedTurn, estimateOutputTokens, extractStreamText, heartbeat, openAIChatResponseToSse, openAIResponsesResponseToSse, parseSseBlock, RelayBuffer, SseParser, sseError, type BufferedOutcome } from './sse.js';
import { anthropicReply, anthropicSseFrames } from './test-util.js';

describe('SseParser', () => {
  it('splits on both terminators, joins multi-line data, skips comments, and never decodes partial UTF-8', () => {
    const p = new SseParser();
    const enc = new TextEncoder();
    const first = p.push(enc.encode('event: a\ndata: {"x":1}\n\n: comment\r\ndata: line1\r\ndata: line2\r\n\r\n'));
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ event: 'a', data: '{"x":1}' });
    expect(first[1].data).toBe('line1\nline2');
    // A multi-byte character split across two pushes must survive intact.
    const euro = enc.encode('data: €');
    expect(p.push(euro.subarray(0, 7))).toHaveLength(0);
    expect(p.push(euro.subarray(7))).toHaveLength(0);
    expect(p.pending).toBeGreaterThan(0);
    const done = p.push(enc.encode('\n\n'));
    expect(done[0].data).toBe('€');
    expect(p.flush()).toHaveLength(0);
    expect(parseSseBlock('event: only')).toBeNull();
  });

  it('RelayBuffer overflows past the cap and stops retaining', () => {
    const b = new RelayBuffer(64);
    b.push(new TextEncoder().encode('data: {"a":1}\n\n'));
    expect(b.overflowed).toBe(false);
    b.push(new TextEncoder().encode('data: ' + 'x'.repeat(100) + '\n\n'));
    expect(b.overflowed).toBe(true);
    expect(b.finish()).toEqual([]);
  });
});

describe('reconstruction + synthesis round trips', () => {
  it('rebuilds an Anthropic message from SSE and re-emits it', () => {
    const p = new SseParser();
    const events = anthropicSseFrames('Hello world', { input_tokens: 100, output_tokens: 7 }).flatMap((f) => p.push(f));
    const msg = reconstructAnthropicFallback(events)!;
    expect(msg.content).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect((msg.usage as Record<string, number>).output_tokens).toBe(7);
    expect(msg.stop_reason).toBe('end_turn');
    const again = new SseParser().push(anthropicResponseToSse(msg));
    const twice = reconstructAnthropicFallback(again)!;
    expect(twice.content).toEqual(msg.content);
    expect(twice.stop_reason).toBe('end_turn');
    // tool_use partial json is accumulated and parsed
    const tool = { ...anthropicReply(''), content: [{ type: 'tool_use', id: 't1', name: 'vg_retrieve', input: { hash: 'abc' } }], stop_reason: 'tool_use' };
    const ev = new SseParser().push(anthropicResponseToSse(tool));
    expect((reconstructAnthropicFallback(ev)!.content as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'tool_use', name: 'vg_retrieve', input: { hash: 'abc' } });
  });

  it('rebuilds OpenAI chat + responses streams', () => {
    const chat = { id: 'c', object: 'chat.completion', created: 1, model: 'gpt-5', choices: [{ index: 0, message: { role: 'assistant', content: 'hey', tool_calls: [{ id: 'x', type: 'function', function: { name: 'vg_retrieve', arguments: '{"hash":"abc"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
    const ev = new SseParser().push(openAIChatResponseToSse(chat));
    const back = reconstructOpenAIChatFallback(ev)!;
    const choice = (back.choices as Array<Record<string, unknown>>)[0];
    expect((choice.message as Record<string, unknown>).content).toBe('hey');
    expect(choice.finish_reason).toBe('tool_calls');
    // `arguments` stays a JSON *string* on the wire, so assert on what it parses to.
    const calls = (choice.message as Record<string, unknown>).tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'x', function: { name: 'vg_retrieve' } });
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ hash: 'abc' });
    expect(back.usage).toEqual(chat.usage);
    const resp = { id: 'r', object: 'response', model: 'gpt-5', output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] }], usage: { input_tokens: 1, output_tokens: 1 } };
    const rev = new SseParser().push(openAIResponsesResponseToSse(resp));
    expect(reconstructOpenAIResponsesFallback(rev)!.output).toEqual(resp.output);
  });

  it('estimates output tokens from text, else wire bytes', () => {
    const events = new SseParser().push(anthropicSseFrames('abcdefghijklmnop').join(''));
    expect(extractStreamText(events)).toBe('abcdefghijklmnop');
    expect(estimateOutputTokens('abcdefghijklmnop', 999)).toEqual({ tokens: 4, source: 'estimated_text' });
    expect(estimateOutputTokens('', 400)).toEqual({ tokens: 10, source: 'estimated_bytes' });
  });

  it('formats typed errors and heartbeats per provider', () => {
    expect(sseError('anthropic', 429, 'slow down')).toContain('"type":"rate_limit_error"');
    expect(sseError('anthropic', 529, 'x')).toContain('overloaded_error');
    expect(sseError('openai', 500, 'x')).toContain('server_error');
    expect(heartbeat('anthropic')).toBe('event: ping\ndata: {"type":"ping"}\n\n');
    expect(heartbeat('openai')).toBe(': keepalive\n\n');
  });
});

class FakeRes extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  flushHeaders(): void {}
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(chunk?: string): this {
    if (chunk) this.chunks.push(chunk);
    this.writableEnded = true;
    return this;
  }
}

describe('bufferedTurn', () => {
  it('delivers a fast reply inside the grace window with its real status', async () => {
    const res = new FakeRes();
    const r = await bufferedTurn(res as unknown as ServerResponse, 'anthropic', Promise.resolve({ passthrough: { status: 429, headers: { 'retry-after': '3' }, body: '{"error":{"type":"rate_limit_error","message":"slow"}}' } }), { graceMs: 5000 });
    expect(r.committed).toBe(false);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('3');
  });

  it('commits to SSE with heartbeats past the grace window, then emits the answer', async () => {
    const res = new FakeRes();
    const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
    let id = 0;
    const setTimer = ((fn: () => void, ms: number) => {
      const t = { fn, ms, id: ++id };
      timers.push(t);
      return t as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const clearTimer = ((t: { id: number }) => {
      const i = timers.findIndex((x) => x.id === t.id);
      if (i >= 0) timers.splice(i, 1);
    }) as unknown as typeof clearTimeout;
    let resolveWork: (v: { json: Record<string, unknown> }) => void = () => {};
    const work = new Promise<{ json: Record<string, unknown> }>((resolve) => (resolveWork = resolve));
    const turn = bufferedTurn(res as unknown as ServerResponse, 'anthropic', work, { graceMs: 5000, heartbeatMs: 250, setTimer, clearTimer, sseHeaders: { 'x-vg-request-id': 'r1' } });
    await Promise.resolve();
    expect(timers[0].ms).toBe(5000);
    timers.shift()!.fn(); // grace elapsed → commit
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['x-vg-request-id']).toBe('r1');
    expect(timers[0].ms).toBe(250);
    timers.shift()!.fn();
    timers.shift()!.fn();
    expect(res.chunks.filter((c) => c.includes('"ping"')).length).toBe(2);
    resolveWork({ json: anthropicReply('done') });
    const r = await turn;
    expect(r.committed).toBe(true);
    expect(res.chunks.join('')).toContain('event: message_stop');
    expect(res.chunks.join('')).toContain('done');
    expect(timers).toHaveLength(0); // heartbeat cleared
  });

  it('translates a post-commit failure into a typed SSE error', async () => {
    const res = new FakeRes();
    let reject: (e: Error) => void = () => {};
    const work = new Promise<{ json: Record<string, unknown> }>((_, rej) => (reject = rej));
    const turn = bufferedTurn(res as unknown as ServerResponse, 'openai', work, { graceMs: 1, heartbeatMs: 1 });
    await new Promise((r) => setTimeout(r, 15));
    reject(new Error('upstream exploded'));
    const r = await turn;
    expect(r.committed).toBe(true);
    expect(res.chunks.join('')).toContain('upstream exploded');
    expect(res.chunks.join('')).toContain('server_error');
  });

  it('grace <= 0 disables the heartbeat and always waits', async () => {
    const res = new FakeRes();
    const late = new Promise<BufferedOutcome>((resolve) => setTimeout(() => resolve({ json: anthropicReply('late') }), 20));
    const r = await bufferedTurn(res as unknown as ServerResponse, 'anthropic', late, { graceMs: 0, heartbeatMs: 1 });
    expect(r.committed).toBe(false);
    expect(res.chunks.some((c) => c.includes('"ping"'))).toBe(false);
    expect(res.chunks.join('')).toContain('late');
  });
});
