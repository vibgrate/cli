import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockProvider, OpenAiCompatibleProvider, OllamaProvider, redactSecrets, relayErrorDetail, statusHint, accumulateOpenAiDelta, newOpenAiStreamAcc, cachedPromptTokensOf, parseReasoningEffort, OPENAI_COMPATIBLE } from './providers.js';

afterEach(() => vi.unstubAllGlobals());

describe('MockProvider', () => {
  it('returns its scripted reply deterministically', async () => {
    const p = new MockProvider('m', 'the reply');
    expect(p.local).toBe(true);
    const r = await p.chat([{ role: 'user', content: 'x' }]);
    expect(r.text).toBe('the reply');
    expect(r.provider).toBe('mock');
  });
});

describe('redactSecrets', () => {
  it('masks common token shapes and bearer headers', () => {
    expect(redactSecrets('key sk-abcdef123456 here')).not.toContain('abcdef123456');
    expect(redactSecrets('Authorization: Bearer abcdefgh12345')).toContain('***redacted***');
  });
});

describe('OpenAiCompatibleProvider', () => {
  it('demands the API key from the environment (never a flag) with an actionable error', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const p = new OpenAiCompatibleProvider('some/model', { ...OPENAI_COMPATIBLE.openrouter, id: 'openrouter' });
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  it('parses an OpenAI-shaped completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'edit blocks' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }), { status: 200 })),
    );
    const p = new OpenAiCompatibleProvider('m', { baseUrl: 'http://local', local: true, label: 'Local', id: 'local' });
    const r = await p.chat([{ role: 'user', content: 'x' }]);
    expect(r.text).toBe('edit blocks');
    expect(r.usage?.promptTokens).toBe(10);
  });

  it('turns an HTTP 401 into an actionable, internals-free error', async () => {
    process.env.OPENAI_API_KEY = 'bad';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const p = new OpenAiCompatibleProvider('m', { ...OPENAI_COMPATIBLE.openai, id: 'openai' });
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/401/);
    delete process.env.OPENAI_API_KEY;
  });
});

describe('tool-calling protocol', () => {
  it('OpenAI-compatible: sends tools and parses tool_calls (JSON-string args)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new OpenAiCompatibleProvider('m', { baseUrl: 'http://local', local: true, label: 'Local', id: 'local' });
    const r = await p.chat([{ role: 'user', content: 'x' }], { tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }] });
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }]);
    // tools were forwarded on the wire
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.tools[0].function.name).toBe('read_file');
  });

  it('Ollama: parses tool_calls with object args and synthesizes an id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'search_code', arguments: { query: 'auth' } } }] } }), { status: 200 })));
    const r = await new OllamaProvider('qwen', 'http://127.0.0.1:11434').chat([{ role: 'user', content: 'x' }], { tools: [] });
    expect(r.toolCalls?.[0]).toMatchObject({ name: 'search_code', arguments: { query: 'auth' } });
    expect(typeof r.toolCalls?.[0].id).toBe('string'); // synthesized
  });

  it('serializes assistant tool_calls and tool results onto the wire', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new OpenAiCompatibleProvider('m', { baseUrl: 'http://local', local: true, label: 'Local', id: 'local' });
    await p.chat(
      [
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }] },
        { role: 'tool', content: 'file body', toolCallId: 'call_1', name: 'read_file' },
      ],
      {},
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.messages[0].tool_calls[0].function.arguments).toBe('{"path":"a.ts"}');
    expect(body.messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'file body' });
  });
});

describe('streaming', () => {
  /** Build a streamed Response body from a list of SSE lines. */
  function sseResponse(lines: string[]): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const l of lines) controller.enqueue(enc.encode(l + '\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  it('OpenAI SSE: assembles text via onToken and parses streamed tool calls', async () => {
    const lines = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":4}}',
      'data: [DONE]',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(lines)));
    const tokens: string[] = [];
    const p = new OpenAiCompatibleProvider('m', { baseUrl: 'http://local', local: true, label: 'Local', id: 'local' });
    const r = await p.chat([{ role: 'user', content: 'x' }], { stream: true, onToken: (t) => tokens.push(t) });
    expect(tokens.join('')).toBe('Hello');
    expect(r.text).toBe('Hello');
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }]);
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 4 });
  });

  it('Ollama NDJSON: assembles streamed content and usage', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(JSON.stringify({ message: { content: 'one ' } }) + '\n'));
        c.enqueue(enc.encode(JSON.stringify({ message: { content: 'two' }, done: true, prompt_eval_count: 5, eval_count: 2 }) + '\n'));
        c.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const tokens: string[] = [];
    const r = await new OllamaProvider('qwen', 'http://127.0.0.1:11434').chat([{ role: 'user', content: 'x' }], { stream: true, onToken: (t) => tokens.push(t) });
    expect(r.text).toBe('one two');
    expect(tokens).toEqual(['one ', 'two']);
    expect(r.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
  });
});

describe('OllamaProvider', () => {
  it('parses an Ollama chat reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: { content: 'done' } }), { status: 200 })));
    const r = await new OllamaProvider('qwen', 'http://127.0.0.1:11434').chat([{ role: 'user', content: 'x' }]);
    expect(r.text).toBe('done');
  });

  it('gives an actionable error when the daemon is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(new OllamaProvider('qwen').chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/ollama serve/);
  });
});

describe('relayErrorDetail', () => {
  it('prefers the server\'s own reason over a status-code guess', () => {
    const body = JSON.stringify({
      error: 'upstream rejected the request',
      detail: 'No endpoints found matching your data policy',
      correlation_id: 'abc-123',
    });
    expect(relayErrorDetail(body)).toBe(
      'upstream rejected the request — No endpoints found matching your data policy (correlation id abc-123)',
    );
  });

  it('renders a JSON detail as a sentence instead of a wall of braces cut mid-token', () => {
    const body = JSON.stringify({
      error: { type: 'relay_model_not_routable', message: 'Relay cannot route this model right now.' },
      detail: JSON.stringify({
        error: {
          message: 'No allowed providers are available for the selected model.',
          code: 404,
          metadata: { available_providers: ['anthropic', 'azure'], requested_providers: ['google-ai-studio'] },
        },
      }),
      correlation_id: 'abc-123',
    });
    const rendered = relayErrorDetail(body);
    expect(rendered).toContain('No allowed providers are available for the selected model.');
    expect(rendered).toContain('routing was restricted to: google-ai-studio');
    expect(rendered).toContain('this model is served by: anthropic, azure');
    expect(rendered).not.toContain('{');
  });

  it('reads the OpenAI-shaped { error: { message } } form', () => {
    expect(relayErrorDetail(JSON.stringify({ error: { message: 'insufficient credits' } }))).toBe('insufficient credits');
  });

  it('does not repeat an identical message and detail', () => {
    expect(relayErrorDetail(JSON.stringify({ error: 'boom', detail: 'boom' }))).toBe('boom');
  });

  it('returns null when there is nothing usable, so the caller keeps its hint', () => {
    expect(relayErrorDetail('')).toBeNull();
    expect(relayErrorDetail('{}')).toBeNull();
    expect(relayErrorDetail(JSON.stringify({ error: {} }))).toBeNull();
    expect(relayErrorDetail(JSON.stringify({ error: '   ' }))).toBeNull();
  });

  it('passes through a short non-JSON body but drops a long one as noise', () => {
    expect(relayErrorDetail('Bad Gateway')).toBe('Bad Gateway');
    expect(relayErrorDetail('x'.repeat(500))).toBeNull();
  });

  it('salvages the title of a long CDN error page instead of dropping it', () => {
    const page = `<!DOCTYPE html><html><head><title>api.vibgrate.com | 502: Bad gateway</title></head><body>${'filler '.repeat(200)}</body></html>`;
    expect(relayErrorDetail(page)).toBe('api.vibgrate.com | 502: Bad gateway');
  });

  it('salvages a Cloudflare error code from a titleless page', () => {
    const page = `<html><body><h1>Worker threw exception</h1><p>Error 1101</p>${'filler '.repeat(200)}</body></html>`;
    expect(relayErrorDetail(page)).toBe('Error 1101');
  });

  it('reads the typed relay error body (nested message + flat detail)', () => {
    const body = JSON.stringify({
      error: { type: 'upstream_rate_limited', message: 'The upstream provider is rate limiting this model right now.', correlation_id: 'rl_9' },
      detail: 'rate limit exceeded',
    });
    expect(relayErrorDetail(body)).toBe(
      'The upstream provider is rate limiting this model right now. — rate limit exceeded (correlation id rl_9)',
    );
  });
});

describe('statusHint', () => {
  it('does not blame the model id for a gateway failure', () => {
    for (const status of [500, 502, 503]) {
      const hint = statusHint(status, 'openai/gpt-5.1', 'VIBGRATE_RELAY_TOKEN');
      expect(hint).toMatch(/upstream\/gateway failure/);
      expect(hint).not.toMatch(/^check the model id/);
    }
  });

  it('blames the model id only when the endpoint says it has no such model', () => {
    expect(statusHint(404, 'openai/gpt-5.1', undefined)).toMatch(/no model "openai\/gpt-5\.1"/);
    expect(statusHint(400, 'openai/gpt-5.1', undefined)).toMatch(/check the model id/);
  });

  it('names the key env var on an auth rejection, and the real cause otherwise', () => {
    expect(statusHint(401, 'm', 'VIBGRATE_RELAY_TOKEN')).toMatch(/VIBGRATE_RELAY_TOKEN/);
    expect(statusHint(402, 'm', undefined)).toMatch(/out of credit/);
    expect(statusHint(429, 'm', undefined)).toMatch(/rate limited/);
    expect(statusHint(504, 'm', undefined)).toMatch(/timed out/);
  });
});

describe('accumulateOpenAiDelta — finish_reason', () => {
  const fresh = () => newOpenAiStreamAcc();

  it('records the terminal finish_reason so a capped reply is distinguishable from a complete one', () => {
    const acc = fresh();
    accumulateOpenAiDelta(acc, { choices: [{ delta: { content: 'partial' }, finish_reason: null }] });
    expect(acc.finishReason).toBeUndefined();
    accumulateOpenAiDelta(acc, { choices: [{ delta: {}, finish_reason: 'length' }] });
    expect(acc.finishReason).toBe('length');
    expect(acc.text).toBe('partial');
  });

  it('keeps a normal stop reason and never overwrites it with a later null', () => {
    const acc = fresh();
    accumulateOpenAiDelta(acc, { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] });
    accumulateOpenAiDelta(acc, { choices: [{ delta: {}, finish_reason: null }] });
    expect(acc.finishReason).toBe('stop');
  });
});

describe('accumulateOpenAiDelta — reasoning channel (v5)', () => {
  it('collects OpenRouter-style `reasoning` deltas without polluting the answer text', () => {
    const acc = newOpenAiStreamAcc();
    const think: string[] = [];
    const say: string[] = [];
    accumulateOpenAiDelta(acc, { choices: [{ delta: { reasoning: 'let me ' } }] }, (t) => say.push(t), (t) => think.push(t));
    accumulateOpenAiDelta(acc, { choices: [{ delta: { reasoning: 'check' } }] }, (t) => say.push(t), (t) => think.push(t));
    accumulateOpenAiDelta(acc, { choices: [{ delta: { content: 'done' } }] }, (t) => say.push(t), (t) => think.push(t));
    expect(acc.reasoning).toBe('let me check');
    expect(acc.text).toBe('done');
    expect(think).toEqual(['let me ', 'check']);
    expect(say).toEqual(['done']);
  });

  it('reads the DeepSeek-style `reasoning_content` spelling of the same channel', () => {
    const acc = newOpenAiStreamAcc();
    accumulateOpenAiDelta(acc, { choices: [{ delta: { reasoning_content: 'hmm' } }] });
    expect(acc.reasoning).toBe('hmm');
    expect(acc.text).toBe('');
  });
});

describe('cachedPromptTokensOf', () => {
  it('reads the nested OpenAI spelling', () => {
    expect(cachedPromptTokensOf({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 64 } })).toBe(64);
  });

  it('reads the flattened proxy spelling', () => {
    expect(cachedPromptTokensOf({ prompt_tokens: 100, cached_tokens: 8 })).toBe(8);
  });

  it('keeps zero distinct from silence, so an estimate never reads "unreported" as "nothing cached"', () => {
    expect(cachedPromptTokensOf({ prompt_tokens_details: { cached_tokens: 0 } })).toBe(0);
    expect(cachedPromptTokensOf({ prompt_tokens: 100 })).toBeUndefined();
    expect(cachedPromptTokensOf(undefined)).toBeUndefined();
    expect(cachedPromptTokensOf({ cached_tokens: 'lots' })).toBeUndefined();
    expect(cachedPromptTokensOf({ cached_tokens: -3 })).toBeUndefined();
  });

  it('lands on the accumulator when the stream reports usage', () => {
    const acc = newOpenAiStreamAcc();
    accumulateOpenAiDelta(acc, {
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 768 } },
    });
    expect(acc.usage).toEqual({ promptTokens: 900, completionTokens: 40, cachedPromptTokens: 768 });
  });
});

describe('parseReasoningEffort', () => {
  it('accepts the three levels, case- and space-insensitively', () => {
    expect(parseReasoningEffort('low')).toBe('low');
    expect(parseReasoningEffort(' HIGH ')).toBe('high');
    expect(parseReasoningEffort('Medium')).toBe('medium');
  });

  it('drops anything else rather than forwarding a value the provider would reject', () => {
    for (const bad of ['max', 'none', '', '  ', undefined, null, 3, true]) {
      expect(parseReasoningEffort(bad)).toBeUndefined();
    }
  });
});
