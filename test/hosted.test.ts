import { describe, it, expect, afterEach } from 'vitest';
import { fetchHostedDocs, hostedBase } from '../src/engine/hosted.js';

const okJson = (body: unknown): typeof fetch =>
  (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

describe('hostedBase', () => {
  const prev = process.env.VIBGRATE_LIB_HOST;
  afterEach(() => {
    if (prev === undefined) delete process.env.VIBGRATE_LIB_HOST;
    else process.env.VIBGRATE_LIB_HOST = prev;
  });

  it('defaults to the regional ingest host (same as scans), honors region/ingest/env/base', () => {
    delete process.env.VIBGRATE_LIB_HOST;
    expect(hostedBase()).toBe('https://us.ingest.vibgrate.com'); // default region = us
    expect(hostedBase({ region: 'eu' })).toBe('https://eu.ingest.vibgrate.com');
    expect(hostedBase({ ingest: 'https://custom.example.com' })).toBe('https://custom.example.com');
    expect(hostedBase({ base: 'https://x.test/' })).toBe('https://x.test'); // explicit base, slash stripped
    process.env.VIBGRATE_LIB_HOST = 'https://env.test';
    expect(hostedBase()).toBe('https://env.test'); // env override
  });

  it('falls back to the us host on an invalid region (never throws)', () => {
    delete process.env.VIBGRATE_LIB_HOST;
    expect(hostedBase({ region: 'mars' })).toBe('https://us.ingest.vibgrate.com');
  });
});

describe('fetchHostedDocs — fails closed to local', () => {
  it('returns the hosted doc on a 200 with content', async () => {
    const r = await fetchHostedDocs({ name: 'acme', query: 'send' }, { fetchImpl: okJson({ content: 'HOSTED DOCS', version: '2.0.0' }) });
    expect(r).toEqual({ content: 'HOSTED DOCS', version: '2.0.0', source: 'hosted', metadata: undefined });
  });

  it('accepts the docs alias and passes metadata through', async () => {
    const r = await fetchHostedDocs({ name: 'acme' }, { fetchImpl: okJson({ docs: 'X', metadata: { tokens: 5 } }) });
    expect(r?.content).toBe('X');
    expect(r?.version).toBeNull();
    expect(r?.metadata).toEqual({ tokens: 5 });
  });

  it('returns null on a non-200', async () => {
    const f = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchHostedDocs({ name: 'acme' }, { fetchImpl: f })).toBeNull();
  });

  it('returns null when the network throws (offline)', async () => {
    const f = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await fetchHostedDocs({ name: 'acme' }, { fetchImpl: f })).toBeNull();
  });

  it('returns null on empty/whitespace content', async () => {
    expect(await fetchHostedDocs({ name: 'acme' }, { fetchImpl: okJson({ content: '   ' }) })).toBeNull();
  });

  it('returns null when no fetch implementation is available (no network)', async () => {
    const saved = globalThis.fetch;
    // @ts-expect-error — simulate a runtime with no global fetch
    delete globalThis.fetch;
    try {
      expect(await fetchHostedDocs({ name: 'acme' })).toBeNull();
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('sends the canonical §4 body (name/targetId/query/verbosity/max_tokens)', async () => {
    let captured: { url?: string; body?: unknown } = {};
    const f = (async (url: string, init: { body: string }) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ content: 'ok' }) };
    }) as unknown as typeof fetch;
    await fetchHostedDocs({ targetId: 'pv1', query: 'send', verbosity: 'concise', maxTokens: 800 }, { base: 'https://h.test', fetchImpl: f });
    expect(captured.url).toBe('https://h.test/v1/lib/docs');
    expect(captured.body).toMatchObject({ targetId: 'pv1', query: 'send', verbosity: 'concise', max_tokens: 800 });
  });
});
