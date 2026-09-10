import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { proxyStatePath } from '../compress/paths.js';
import type { CompressResult, Message } from '../compress/types.js';
import { STEERING_SENTINEL } from './output-shaper.js';
import { MemoryStoreFallback, passthroughResult } from './fallbacks.js';
import { anthropicReply, anthropicSseFrames, call, fakeUpstream, jsonResponse, sseResponse, startTestProxy, type TestProxy } from './test-util.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function up(opts: Parameters<typeof startTestProxy>[0] = {}): Promise<TestProxy> {
  const t = await startTestProxy(opts);
  cleanups.push(t.close);
  return t;
}

const anthropicBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Hello there, what is 2+2?' }], ...extra });

/** A fake pipeline that halves every tool_result and reports the delta. */
async function fakeCompress(messages: Message[]): Promise<CompressResult> {
  let before = 0;
  let after = 0;
  const out = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const content = (m.content as Array<Record<string, unknown>>).map((b) => {
      if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 40) {
        before += b.content.length;
        const kept = b.content.slice(0, 20);
        after += kept.length;
        return { ...b, content: `${kept}\nRetrieve original: hash=${'a'.repeat(24)} (100 → 10 tokens)` };
      }
      return b;
    });
    return { ...m, content };
  });
  const r = passthroughResult(out, 'anthropic', Math.round(after / 4));
  return { ...r, tokensBefore: Math.round(before / 4), tokensSaved: Math.round((before - after) / 4), compressed: before > after, transformsApplied: before > after ? ['router:smart_crusher:0.20'] : [], ccrHashes: before > after ? ['a'.repeat(24)] : [], warnings: [] };
}

describe('proxy server: probes, guards, auth', () => {
  it('serves /health, /version and the dashboard without external assets', async () => {
    const t = await up();
    const h = await call(t.url, '/health');
    expect(h.status).toBe(200);
    expect(h.json?.service).toBe('vg-proxy');
    expect(h.json?.config).toBeTruthy(); // loopback sees the config block
    const v = await call(t.url, '/version');
    expect(v.json?.service).toBe('vg-proxy');
    const d = await call(t.url, '/');
    expect(d.status).toBe(200);
    expect(d.headers.get('content-type')).toContain('text/html');
    expect(d.text).not.toMatch(/https?:\/\/(?!proxy\.local)/);
    expect(d.text).toContain('Vibgrate CLI');
    expect(d.text).not.toMatch(/headroom/i);
    expect(d.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('writes a 0600 state file on start and removes it on close', async () => {
    const t = await up();
    const file = proxyStatePath(t.proxy.port, t.env);
    const stat = fs.statSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(state.pid).toBe(process.pid);
    expect(state.url).toBe(t.url);
    expect('token' in state).toBe(false);
    await t.proxy.close();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses a non-loopback bind without a token', async () => {
    const { tempEnv } = await import('./test-util.js');
    const { resolveProxyConfig } = await import('./config.js');
    const { startProxy } = await import('./server.js');
    const e = tempEnv();
    const cfg = resolveProxyConfig({ host: '0.0.0.0', port: 0 }, e.env);
    await expect(startProxy(cfg, { bindModules: false, baseEnv: {} })).rejects.toThrow(/token/);
    e.cleanup();
  });

  it('returns 404 (not 403) for admin routes when the Host header is not loopback', async () => {
    const t = await up();
    // undici drops a caller-set Host header, so use the raw client (DNS-rebinding shape).
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: t.proxy.port, path: '/api/settings', method: 'GET', headers: { host: 'evil.example.com' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.once('error', reject);
      req.end();
    });
    expect(status).toBe(404);
    const ok = await call(t.url, '/api/settings');
    expect(ok.status).toBe(200);
  });

  it('requires the token off-loopback but exempts probes; loopback peers are exempt', async () => {
    const t = await up({ overrides: { token: 'secret-token' } });
    // Loopback peer: never challenged even without the token.
    expect((await call(t.url, '/api/stats')).status).toBe(200);
    // Token via header is also accepted.
    expect((await call(t.url, '/api/stats', { headers: { 'x-vg-token': 'secret-token' } })).status).toBe(200);
    expect((await call(t.url, '/api/stats', { headers: { authorization: 'Bearer secret-token' } })).status).toBe(200);
    const state = JSON.parse(fs.readFileSync(proxyStatePath(t.proxy.port, t.env), 'utf8')) as Record<string, unknown>;
    expect(state.token).toBe('secret-token');
  });

  it('caps the request body with the configured status', async () => {
    const t = await up({ env: { VG_PROXY_MAX_BODY_BYTES: '2048', VG_PROXY_BODY_TOO_LARGE_STATUS: '413' } });
    const big = anthropicBody({ messages: [{ role: 'user', content: 'x'.repeat(5000) }] });
    const r = await call(t.url, '/v1/messages', { method: 'POST', json: big });
    expect(r.status).toBe(413);
    expect((r.json?.error as Record<string, unknown>)?.type).toBe('request_too_large');
  });

  it('answers CORS preflight only for allowed origins', async () => {
    const t = await up({ env: { VG_PROXY_CORS_ORIGINS: 'https://dash.example.com' } });
    const ok = await fetch(`${t.url}/api/stats`, { method: 'OPTIONS', headers: { origin: 'https://dash.example.com' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://dash.example.com');
    const bad = await fetch(`${t.url}/api/stats`, { method: 'OPTIONS', headers: { origin: 'https://other.example.com' } });
    expect(bad.status).toBe(403);
  });

  it('404s unknown routes and 405s a wrong method', async () => {
    const t = await up();
    expect((await call(t.url, '/nope')).status).toBe(404);
    expect((await call(t.url, '/v1/messages')).status).toBe(405);
  });
});

describe('proxy server: /v1/messages', () => {
  it('forwards a non-streaming request, strips x-vg-* headers, keeps auth, and reports savings headers', async () => {
    const upstream = fakeUpstream(() => jsonResponse(anthropicReply('4')));
    const store = new MemoryStoreFallback();
    store.put('a'.repeat(24), 'file-'.repeat(200)); // ownership: only hashes this proxy stored advertise the tool
    const t = await up({ deps: { fetch: upstream.fetch, compressMessages: fakeCompress, store } });
    const body = anthropicBody({
      messages: [
        { role: 'user', content: 'run ls' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file-'.repeat(200) }, { type: 'text', text: 'what files?' }] },
      ],
    });
    const r = await call(t.url, '/v1/messages', { method: 'POST', json: body, headers: { 'x-api-key': 'sk-ant-api03-test', 'anthropic-version': '2023-06-01', 'x-vg-session': 's1', 'x-vg-project': 'demo' } });
    expect(r.status).toBe(200);
    expect(r.json?.type).toBe('message');
    expect(Number(r.headers.get('x-vg-tokens-before'))).toBeGreaterThan(Number(r.headers.get('x-vg-tokens-after')));
    expect(Number(r.headers.get('x-vg-tokens-saved'))).toBeGreaterThan(0);
    expect(r.headers.get('x-vg-transforms')).toContain('router:smart_crusher');
    expect(r.headers.get('x-vg-usd-saved')).toMatch(/^\d+\.\d{6}$/);
    expect(upstream.calls).toHaveLength(1);
    const c = upstream.calls[0];
    expect(c.url).toBe('https://api.anthropic.com/v1/messages');
    expect(c.headers['x-api-key']).toBe('sk-ant-api03-test');
    expect(c.headers['anthropic-version']).toBe('2023-06-01');
    expect(Object.keys(c.headers).some((k) => k.startsWith('x-vg-'))).toBe(false);
    const sent = c.body as Record<string, unknown>;
    const tools = sent.tools as Array<Record<string, unknown>>;
    expect(tools.some((x) => x.name === 'vg_retrieve')).toBe(true); // marker → retrieve tool injected
    const stats = t.proxy.stats();
    expect((stats.metrics.requests as Record<string, number>).total).toBe(1);
    expect((stats.savings.lifetime as Record<string, number>).requests).toBe(1);
    expect((stats.savings.byProject as Record<string, unknown>).demo).toBeTruthy();
  });

  it('passes an upstream error through verbatim', async () => {
    const upstream = fakeUpstream(() => jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 400));
    const t = await up({ deps: { fetch: upstream.fetch } });
    const r = await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody() });
    expect(r.status).toBe(400);
    expect((r.json?.error as Record<string, unknown>).message).toBe('bad');
  });

  it('fails open when compression throws', async () => {
    const upstream = fakeUpstream(() => jsonResponse(anthropicReply('ok')));
    const t = await up({ deps: { fetch: upstream.fetch, compressMessages: async () => { throw new Error('boom'); } } });
    const r = await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody() });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-vg-tokens-saved')).toBe('0');
    expect((upstream.calls[0].body as Record<string, unknown>).messages).toEqual(anthropicBody().messages);
    expect((t.proxy.stats().metrics.compressionFailed as Record<string, number>).error).toBe(1);
  });

  it('relays SSE byte-for-byte and reconstructs usage for accounting', async () => {
    const frames = anthropicSseFrames('Hello world', { input_tokens: 100, output_tokens: 7 });
    const upstream = fakeUpstream(() => sseResponse(frames));
    const t = await up({ deps: { fetch: upstream.fetch } });
    const r = await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody({ stream: true }) });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(r.text).toBe(frames.join(''));
    expect(r.headers.get('x-vg-request-id')).toMatch(/^vg_/);
    expect((upstream.calls[0].body as Record<string, unknown>).stream).toBe(true);
    const m = t.proxy.stats().metrics.tokens as Record<string, number>;
    expect(m.output).toBe(7);
    const recent = t.proxy.stats().recentRequests as Array<Record<string, unknown>>;
    expect(recent[0].outputTokens).toBe(7);
    expect(recent[0].stream).toBe(true);
  });

  it('resolves a retrieve tool call server-side (buffered turn) and re-emits the final answer as SSE', async () => {
    const store = new MemoryStoreFallback();
    const hash = 'a'.repeat(24);
    store.put(hash, 'THE ORIGINAL FULL OUTPUT lines...');
    const replies = [
      { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'tu_1', name: 'vg_retrieve', input: { hash } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
      anthropicReply('final answer after retrieval', { input_tokens: 30, output_tokens: 9 }),
    ];
    const upstream = fakeUpstream((_c, i) => jsonResponse(replies[Math.min(i, 1)]));
    const t = await up({ env: { VG_CCR_BUFFERED_GRACE_SECONDS: '5' }, deps: { fetch: upstream.fetch, compressMessages: fakeCompress, store } });
    const body = anthropicBody({
      stream: true,
      messages: [
        { role: 'user', content: 'run ls' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file-'.repeat(200) }, { type: 'text', text: 'what files?' }] },
      ],
    });
    const r = await call(t.url, '/v1/messages', { method: 'POST', json: body });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(r.text).toContain('final answer after retrieval');
    expect(r.text).toContain('event: message_stop');
    expect(upstream.calls).toHaveLength(2);
    expect((upstream.calls[0].body as Record<string, unknown>).stream).toBe(false);
    const second = upstream.calls[1].body as Record<string, unknown>;
    const msgs = second.messages as Message[];
    const last = msgs[msgs.length - 1];
    const results = last.content as Array<Record<string, unknown>>;
    expect(results[0].type).toBe('tool_result');
    expect(String(results[0].content)).toContain('THE ORIGINAL FULL OUTPUT');
    expect(t.proxy.stats().metrics.retrieveRounds).toBe(1);
    const recent = t.proxy.stats().recentRequests as Array<Record<string, unknown>>;
    expect(recent[0].retrieveRounds).toBe(1);
  });

  it('leaves mixed tool turns to the client', async () => {
    const store = new MemoryStoreFallback();
    store.put('b'.repeat(24), 'orig');
    const mixed = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'vg_retrieve', input: { hash: 'b'.repeat(24) } }, { type: 'tool_use', id: 'y', name: 'bash', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } };
    const upstream = fakeUpstream(() => jsonResponse(mixed));
    const t = await up({ deps: { fetch: upstream.fetch, store } });
    const r = await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody() });
    expect(r.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect((r.json?.content as unknown[]).length).toBe(2);
  });

  it('injects the verbosity steering block in token mode and assigns holdout arms deterministically', async () => {
    const upstream = fakeUpstream(() => jsonResponse(anthropicReply('ok')));
    const t = await up({ overrides: { mode: 'token', outputShaper: true }, env: { VG_OUTPUT_VERBOSITY_LEVEL: 'L3', VG_OUTPUT_HOLDOUT: '0.5' }, deps: { fetch: upstream.fetch } });
    const bodies = ['alpha question', 'beta question', 'gamma question', 'delta question', 'epsilon question', 'zeta question'].map((q) => anthropicBody({ messages: [{ role: 'user', content: q }] }));
    for (const b of bodies) await call(t.url, '/v1/messages', { method: 'POST', json: b });
    const arms = upstream.calls.map((c) => ((c.body as Record<string, unknown>).system ? 'treatment' : 'control'));
    // Same conversation → same arm on replay.
    for (const b of bodies) await call(t.url, '/v1/messages', { method: 'POST', json: b });
    const replay = upstream.calls.slice(6).map((c) => ((c.body as Record<string, unknown>).system ? 'treatment' : 'control'));
    expect(replay).toEqual(arms);
    const treated = upstream.calls.find((c) => (c.body as Record<string, unknown>).system);
    expect(treated).toBeTruthy();
    const system = (treated!.body as Record<string, unknown>).system as Array<Record<string, unknown>>;
    expect(String(system[system.length - 1].text)).toContain(STEERING_SENTINEL);
    expect(String(system[system.length - 1].text)).toContain('cite the exact file path and line');
    const transforms = (t.proxy.stats().recentRequests as Array<Record<string, unknown>>).map((r) => r.transforms as string[]);
    expect(transforms.every((tr) => tr.some((x) => x.startsWith('output_shaper:stratum:') || x.startsWith('output_shaper:control:')))).toBe(true);
    expect(transforms.some((tr) => tr.includes('output_shaper:verbosity:L3'))).toBe(true);
  });

  it('never steers in cache mode', async () => {
    const upstream = fakeUpstream(() => jsonResponse(anthropicReply('ok')));
    const t = await up({ overrides: { mode: 'cache', outputShaper: true }, env: { VG_OUTPUT_VERBOSITY_LEVEL: 'L4' }, deps: { fetch: upstream.fetch } });
    await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody() });
    expect((upstream.calls[0].body as Record<string, unknown>).system).toBeUndefined();
  });

  it('enforces the budget with 402 and the rate limit with 429', async () => {
    const upstream = fakeUpstream(() => jsonResponse(anthropicReply('ok', { input_tokens: 1_000_000, output_tokens: 1_000_000 })));
    const t = await up({ overrides: { budgetUsd: 1 }, deps: { fetch: upstream.fetch } });
    const first = await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody() });
    expect(first.status).toBe(200);
    const second = await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody() });
    expect(second.status).toBe(402);
    expect((second.json?.error as Record<string, unknown>).type).toBe('budget_exceeded');
    expect((second.json?.error as Record<string, unknown>).period).toBe('day');

    const t2 = await up({ overrides: { rpm: 2 }, deps: { fetch: upstream.fetch } });
    expect((await call(t2.url, '/v1/messages', { method: 'POST', json: anthropicBody() })).status).toBe(200);
    expect((await call(t2.url, '/v1/messages', { method: 'POST', json: anthropicBody() })).status).toBe(200);
    const limited = await call(t2.url, '/v1/messages', { method: 'POST', json: anthropicBody() });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((limited.json?.error as Record<string, unknown>).message).toMatch(/^Rate limited\. Retry after \d+\.\ds$/);
  });

  it('rewrites the model through the route map and honours bypass', async () => {
    const upstream = fakeUpstream(() => jsonResponse(anthropicReply('ok')));
    const t = await up({ overrides: { modelRoutes: { 'claude-opus-4': 'claude-sonnet-4-5', 'gpt-*': 'gpt-5-mini' } }, deps: { fetch: upstream.fetch } });
    await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody({ model: 'claude-opus-4' }) });
    expect((upstream.calls[0].body as Record<string, unknown>).model).toBe('claude-sonnet-4-5');
    const r = await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody({ model: 'gpt-5.1' }), headers: { 'x-vg-bypass': 'true' } });
    expect(r.headers.get('x-vg-transforms')).toContain('bypass');
    expect((upstream.calls[1].body as Record<string, unknown>).model).toBe('gpt-5-mini');
  });

  it('serves identical non-streaming requests from the response cache when enabled', async () => {
    const upstream = fakeUpstream(() => jsonResponse(anthropicReply('cached answer')));
    const t = await up({ env: { VG_PROXY_SEMANTIC_CACHE: 'true' }, deps: { fetch: upstream.fetch } });
    const a = await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody() });
    const b = await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody() });
    expect(a.status).toBe(200);
    expect(b.headers.get('x-vg-cache')).toBe('hit');
    expect(upstream.calls).toHaveLength(1);
    expect((t.proxy.stats().metrics.requests as Record<string, number>).cached).toBe(1);
  });

  it('keeps anthropic-beta tokens sticky across a session', async () => {
    const upstream = fakeUpstream(() => jsonResponse(anthropicReply('ok')));
    const t = await up({ deps: { fetch: upstream.fetch } });
    await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody(), headers: { 'x-vg-session': 'beta', 'anthropic-beta': 'tools-2024-05-16' } });
    await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody(), headers: { 'x-vg-session': 'beta', 'anthropic-beta': 'prompt-caching-2024-07-31' } });
    expect(upstream.calls[1].headers['anthropic-beta']).toBe('tools-2024-05-16,prompt-caching-2024-07-31');
  });
});

describe('proxy server: OpenAI shapes and pass-through', () => {
  it('handles /v1/chat/completions with usage headers and reasoning-safe usage extraction', async () => {
    const upstream = fakeUpstream(() => jsonResponse({ id: 'c1', object: 'chat.completion', model: 'gpt-5', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 20 } } }));
    const t = await up({ deps: { fetch: upstream.fetch } });
    const r = await call(t.url, '/v1/chat/completions', { method: 'POST', json: { model: 'gpt-5', messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hey' }] }, headers: { authorization: 'Bearer sk-test' } });
    expect(r.status).toBe(200);
    expect(upstream.calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(upstream.calls[0].headers.authorization).toBe('Bearer sk-test');
    expect(r.headers.get('x-vg-tokens-saved')).toBe('0');
    const m = t.proxy.stats().metrics.tokens as Record<string, number>;
    expect(m.cacheRead).toBe(20);
    expect(m.output).toBe(3);
  });

  it('handles /v1/responses (string input normalized) and the unprefixed aliases', async () => {
    const upstream = fakeUpstream(() => jsonResponse({ id: 'r1', object: 'response', model: 'gpt-5', output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] }], usage: { input_tokens: 9, output_tokens: 2 } }));
    const t = await up({ deps: { fetch: upstream.fetch } });
    const r = await call(t.url, '/responses', { method: 'POST', json: { model: 'gpt-5', input: 'hello' } });
    expect(r.status).toBe(200);
    expect(upstream.calls[0].url).toBe('https://api.openai.com/v1/responses');
    expect((upstream.calls[0].body as Record<string, unknown>).input).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('passes count_tokens and models through untouched', async () => {
    const upstream = fakeUpstream((c) => jsonResponse({ echoed: c.body, method: c.method }));
    const t = await up({ deps: { fetch: upstream.fetch } });
    const r = await call(t.url, '/v1/messages/count_tokens', { method: 'POST', json: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'x' }] }, headers: { 'x-api-key': 'k' } });
    expect(r.status).toBe(200);
    expect((r.json?.echoed as Record<string, unknown>).model).toBe('claude-sonnet-4-5');
    expect(upstream.calls[0].url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    const models = await call(t.url, '/v1/models', { headers: { authorization: 'Bearer sk-x' } });
    expect(models.status).toBe(200);
    expect(upstream.calls[1].url).toBe('https://api.openai.com/v1/models');
    expect(upstream.calls[1].method).toBe('GET');
  });

  it('passes Gemini-native calls through with the query string, so Gemini CLI streams and authenticates', async () => {
    // Gemini CLI (GOOGLE_GEMINI_BASE_URL) speaks /v1beta/models/<m>:streamGenerateContent?alt=sse
    // with x-goog-api-key. This used to 404 (no route) and, for the routes
    // that existed, the query string was dropped on the way upstream.
    const upstream = fakeUpstream((c) => jsonResponse({ echoed: c.body, url: c.url }));
    const t = await up({ deps: { fetch: upstream.fetch } });
    const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    const r = await call(t.url, '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse', { method: 'POST', json: body, headers: { 'x-goog-api-key': 'g-key' } });
    expect(r.status).toBe(200);
    expect(upstream.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    expect(upstream.calls[0].headers['x-goog-api-key']).toBe('g-key');
    expect((r.json?.echoed as Record<string, unknown>).contents).toEqual(body.contents);
    const list = await call(t.url, '/v1beta/models?key=g-key', { headers: {} });
    expect(list.status).toBe(200);
    expect(upstream.calls[1].url).toBe('https://generativelanguage.googleapis.com/v1beta/models?key=g-key');
    expect(upstream.calls[1].method).toBe('GET');
  });

  it('uses the generic upstream override for OpenAI-shaped routes', async () => {
    const upstream = fakeUpstream(() => jsonResponse({ choices: [{ message: { role: 'assistant', content: 'x' } }] }));
    const t = await up({ overrides: { upstreamUrl: 'http://127.0.0.1:11434/v1' }, deps: { fetch: upstream.fetch } });
    await call(t.url, '/v1/chat/completions', { method: 'POST', json: { model: 'llama3', messages: [{ role: 'user', content: 'hi' }] } });
    expect(upstream.calls[0].url).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });
});

describe('proxy server: sidecar, admin, stats, metrics', () => {
  it('compresses via /v1/compress and retrieves via /v1/retrieve', async () => {
    const store = new MemoryStoreFallback();
    store.put('c'.repeat(24), 'line one\nline two\nline three');
    const t = await up({ deps: { compressMessages: fakeCompress, store } });
    const messages: Message[] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(400) }] }];
    const r = await call(t.url, '/v1/compress', { method: 'POST', json: { messages, model: 'claude-sonnet-4-5' } });
    expect(r.status).toBe(200);
    expect(Number(r.json?.tokensSaved)).toBeGreaterThan(0);
    expect(r.headers.get('x-vg-tokens-saved')).toBe(String(r.json?.tokensSaved));
    const bad = await call(t.url, '/v1/compress', { method: 'POST', json: { nope: 1 } });
    expect(bad.status).toBe(400);
    const got = await call(t.url, '/v1/retrieve', { method: 'POST', json: { hash: 'c'.repeat(24), grep: 'two' } });
    expect(got.status).toBe(200);
    expect(got.json?.original_content).toBe('line two');
    const miss = await call(t.url, '/v1/retrieve', { method: 'POST', json: { hash: 'd'.repeat(24) } });
    expect(miss.status).toBe(404);
    const entry = await call(t.url, `/api/ccr/${'c'.repeat(24)}`);
    expect(entry.status).toBe(200);
    expect(entry.json?.original).toContain('line one');
  });

  it('validates settings updates and applies hot knobs on the next request', async () => {
    const upstream = fakeUpstream(() => jsonResponse(anthropicReply('ok')));
    const t = await up({ deps: { fetch: upstream.fetch } });
    const unknown = await call(t.url, '/api/settings', { method: 'POST', json: { values: { VG_NOPE: '1' } } });
    expect(unknown.status).toBe(400);
    expect(unknown.json?.unknown_keys).toEqual(['VG_NOPE']);
    const invalid = await call(t.url, '/api/settings', { method: 'POST', json: { values: { VG_PROXY_RPM: 'many' } } });
    expect(invalid.status).toBe(422);
    expect((invalid.json?.field_errors as Record<string, string>).VG_PROXY_RPM).toContain('integer');
    const ok = await call(t.url, '/api/settings', { method: 'POST', json: { values: { VG_PROXY_RPM: 1, VG_PROXY_LOG_FILE: '/tmp/x.log' } } });
    expect(ok.status).toBe(200);
    expect(ok.json?.changed_keys).toEqual(['VG_PROXY_LOG_FILE', 'VG_PROXY_RPM']);
    expect(ok.json?.needs_restart).toEqual(['VG_PROXY_LOG_FILE']);
    const view = await call(t.url, '/api/settings');
    expect((view.json?.settings as Record<string, unknown>).VG_PROXY_RPM).toBe('1');
    expect((view.json?.effective as Record<string, unknown>).VG_PROXY_RPM).toBe('1');
    // Hot knob applied: rpm=1 → second request is rate limited.
    expect((await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody() })).status).toBe(200);
    expect((await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody() })).status).toBe(429);
    const cross = await fetch(`${t.url}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' }, body: JSON.stringify({ values: {} }) });
    expect(cross.status).toBe(403);
  });

  it('exposes Prometheus metrics with the vg_ prefix and no upstream project names', async () => {
    const upstream = fakeUpstream(() => jsonResponse(anthropicReply('ok')));
    const t = await up({ deps: { fetch: upstream.fetch } });
    await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody() });
    const m = await call(t.url, '/metrics');
    expect(m.status).toBe(200);
    expect(m.headers.get('content-type')).toContain('version=0.0.4');
    expect(m.text).toContain('# TYPE vg_requests_total counter');
    expect(m.text).toMatch(/vg_requests_total 1/);
    expect(m.text).toMatch(/vg_requests_by_model\{model="claude-sonnet-4-5"\} 1/);
    expect(m.text).toContain('vg_latency_ms_count 1');
    expect(m.text).not.toMatch(/headroom/i);
  });

  it('reports rollups on /api/savings and reflects hits on /api/stats', async () => {
    const upstream = fakeUpstream(() => jsonResponse(anthropicReply('ok')));
    const t = await up({ deps: { fetch: upstream.fetch, compressMessages: fakeCompress } });
    await call(t.url, '/v1/messages', { method: 'POST', json: anthropicBody({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'bash', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'z'.repeat(500) }] }] }) });
    const s = await call(t.url, '/api/savings');
    expect(s.status).toBe(200);
    const rollups = s.json?.rollups as Record<string, Record<string, number>>;
    expect(rollups.today.requests).toBe(1);
    expect(rollups.all.tokensSaved).toBeGreaterThan(0);
    const stats = await call(t.url, '/api/stats');
    expect((stats.json?.metrics as Record<string, Record<string, number>>).tokens.saved).toBeGreaterThan(0);
    expect(fs.existsSync(`${t.env.VG_CONTEXT_DIR}/savings-events.jsonl`)).toBe(true);
    expect(fs.statSync(`${t.env.VG_CONTEXT_DIR}/savings-events.jsonl`).mode & 0o777).toBe(0o600);
  });

  it('shuts down via the admin route and lists clients', async () => {
    const t = await up();
    const clients = await call(t.url, '/api/proxy/clients');
    expect(clients.json?.clients).toEqual([]);
    const r = await call(t.url, '/api/proxy/shutdown', { method: 'POST', json: {} });
    expect(r.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const alive = await new Promise<boolean>((resolve) => {
      const s = net.connect(t.proxy.port, '127.0.0.1');
      s.once('connect', () => (s.destroy(), resolve(true)));
      s.once('error', () => resolve(false));
    });
    expect(alive).toBe(false);
  });
});
