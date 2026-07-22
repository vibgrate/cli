import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockProvider, OpenAiCompatibleProvider, OllamaProvider, redactSecrets, OPENAI_COMPATIBLE } from './providers.js';

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
