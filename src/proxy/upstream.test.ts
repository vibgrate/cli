import { describe, expect, it } from 'vitest';
import { bypassesProxy, createTransport, jitterDelayMs, looksAnthropic, parseNoProxy, proxyForTarget, retryAfterMs, transportOptionsFromEnv } from './upstream.js';

const url = (u: string): URL => new URL(u);

describe('provider sniffing', () => {
  it('recognises Anthropic-shaped clients', () => {
    expect(looksAnthropic({ 'x-api-key': 'k' })).toBe(true);
    expect(looksAnthropic({ 'anthropic-version': '2023-06-01' })).toBe(true);
    expect(looksAnthropic({ authorization: 'Bearer sk-ant-abc' })).toBe(true);
    expect(looksAnthropic({ 'user-agent': 'claude-code/1.2.3' })).toBe(true);
    expect(looksAnthropic({ authorization: 'Bearer sk-openai' })).toBe(false);
    expect(looksAnthropic({})).toBe(false);
  });
});

describe('NO_PROXY handling', () => {
  it('parses the list, ignoring blanks and case', () => {
    expect(parseNoProxy(' Example.COM , .internal ,, 127.0.0.1 ')).toEqual(['example.com', '.internal', '127.0.0.1']);
    expect(parseNoProxy(undefined)).toEqual([]);
    expect(parseNoProxy('')).toEqual([]);
  });

  it('always reaches loopback directly', () => {
    // a local model server is the case that matters: `--provider ollama` points
    // at 127.0.0.1:11434, and sending that to a corporate proxy fails on exactly
    // the machines that set HTTPS_PROXY
    for (const u of ['http://127.0.0.1:11434', 'http://localhost:8080', 'http://127.4.5.6:1', 'http://[::1]:9', 'https://api.localhost']) {
      expect(bypassesProxy(url(u)), u).toBe(true);
    }
    expect(bypassesProxy(url('https://api.anthropic.com'))).toBe(false);
  });

  it('matches the usual NO_PROXY forms', () => {
    expect(bypassesProxy(url('https://api.anthropic.com'), ['*'])).toBe(true);
    expect(bypassesProxy(url('https://api.anthropic.com'), ['api.anthropic.com'])).toBe(true);
    // a bare or dotted suffix covers subdomains, but not a lookalike host
    expect(bypassesProxy(url('https://api.anthropic.com'), ['anthropic.com'])).toBe(true);
    expect(bypassesProxy(url('https://api.anthropic.com'), ['.anthropic.com'])).toBe(true);
    expect(bypassesProxy(url('https://notanthropic.com'), ['anthropic.com'])).toBe(false);
    expect(bypassesProxy(url('https://api.openai.com'), ['anthropic.com'])).toBe(false);
    // an entry may pin a port
    expect(bypassesProxy(url('https://host.example:8443'), ['host.example:8443'])).toBe(true);
    expect(bypassesProxy(url('https://host.example:443'), ['host.example:8443'])).toBe(false);
    expect(bypassesProxy(url('https://host.example'), ['host.example:443'])).toBe(true);
  });
});

describe('choosing a proxy per target', () => {
  const opts = { httpProxy: 'http://corp:3128', httpOnlyProxy: 'http://corp-plain:3128', noProxy: ['internal.example'] };

  it('picks by scheme and honours the bypass list', () => {
    expect(proxyForTarget(url('https://api.anthropic.com'), opts)).toBe('http://corp:3128');
    expect(proxyForTarget(url('http://api.example.com'), opts)).toBe('http://corp-plain:3128');
    expect(proxyForTarget(url('https://internal.example/v1'), opts)).toBeUndefined();
    expect(proxyForTarget(url('http://127.0.0.1:11434'), opts)).toBeUndefined();
    // with only HTTPS_PROXY set, a plain-http target falls back to it
    expect(proxyForTarget(url('http://api.example.com'), { httpProxy: 'http://corp:3128' })).toBe('http://corp:3128');
    expect(proxyForTarget(url('https://api.anthropic.com'), {})).toBeUndefined();
  });

  it('reads the conventional environment, with the knob winning', () => {
    const fromEnv = transportOptionsFromEnv({ HTTPS_PROXY: 'http://s:1', HTTP_PROXY: 'http://p:2', NO_PROXY: 'a.example,.b.example' } as NodeJS.ProcessEnv);
    expect(fromEnv).toMatchObject({ httpProxy: 'http://s:1', httpOnlyProxy: 'http://p:2', noProxy: ['a.example', '.b.example'] });
    expect(transportOptionsFromEnv({ https_proxy: 'http://lower:1' } as NodeJS.ProcessEnv).httpProxy).toBe('http://lower:1');
    // an explicit setting applies to both schemes
    const pinned = transportOptionsFromEnv({ VG_PROXY_HTTP_PROXY: 'http://mine:9', HTTPS_PROXY: 'http://s:1' } as NodeJS.ProcessEnv);
    expect(pinned.httpProxy).toBe('http://mine:9');
    expect(pinned.httpOnlyProxy).toBe('http://mine:9');
  });

  it('only takes over from global fetch when it has something to do', () => {
    const plain = createTransport({} as NodeJS.ProcessEnv);
    expect(plain).toBe(globalThis.fetch);
    expect(createTransport({ HTTPS_PROXY: 'http://corp:3128' } as NodeJS.ProcessEnv)).not.toBe(globalThis.fetch);
    expect(createTransport({ VG_PROXY_TLS_STRICT: 'false' } as NodeJS.ProcessEnv)).not.toBe(globalThis.fetch);
  });
});

describe('retry timing', () => {
  it('backs off exponentially, jittering the capped delay by ±50%', () => {
    // the cap bounds the exponential term; jitter then scales it by 0.5–1.5, so
    // an unlucky draw waits half again as long rather than hammering in lockstep
    expect(jitterDelayMs(250, 4000, 0, () => 0.5)).toBe(250);
    expect(jitterDelayMs(250, 4000, 3, () => 0.5)).toBe(2000);
    expect(jitterDelayMs(250, 4000, 0, () => 0)).toBe(125);
    expect(jitterDelayMs(250, 4000, 0, () => 1)).toBe(375);
    expect(jitterDelayMs(250, 400, 10, () => 0.5)).toBe(400);
    expect(jitterDelayMs(250, 4000, 3, () => 0.5)).toBeGreaterThan(jitterDelayMs(250, 4000, 0, () => 0.5));
  });

  it('reads Retry-After in both forms', () => {
    const secs = new Response('', { status: 429, headers: { 'retry-after': '2' } });
    expect(retryAfterMs(secs, 60_000)).toBe(2000);
    const none = new Response('', { status: 429 });
    expect(retryAfterMs(none, 60_000)).toBeNull();
    const silly = new Response('', { status: 429, headers: { 'retry-after': 'soon' } });
    expect(retryAfterMs(silly, 60_000)).toBeNull();
  });
});
