import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fetchHostedDocsCached, hostedDocsCacheKey, HOSTED_DOCS_TTL_MS } from '../src/engine/hosted-cache.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-hosted-cache-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function countingFetch(body: unknown): { fetchImpl: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => n };
}

describe('hostedDocsCacheKey', () => {
  it('keys on request identity, host and caller identity — never cross-identity', () => {
    const a = hostedDocsCacheKey({ name: 'stripe', query: 'charges' });
    expect(a).toBe(hostedDocsCacheKey({ name: 'stripe', query: 'charges' }));
    expect(a).not.toBe(hostedDocsCacheKey({ name: 'stripe', query: 'refunds' }));
    expect(a).not.toBe(hostedDocsCacheKey({ name: 'stripe', query: 'charges' }, { auth: { keyId: 'k1', secret: 's' } }));
    expect(a).not.toBe(hostedDocsCacheKey({ name: 'stripe', query: 'charges' }, { base: 'https://eu.example' }));
  });
});

describe('fetchHostedDocsCached', () => {
  it('serves a fresh repeat lookup from disk (one network call), flagged cached', async () => {
    const { fetchImpl, calls } = countingFetch({ content: 'DOCS', version: '19.0.0' });
    const first = await fetchHostedDocsCached(root, { name: 'stripe' }, { fetchImpl });
    expect(first?.content).toBe('DOCS');
    expect(first?.metadata?.cached).toBeUndefined();
    const second = await fetchHostedDocsCached(root, { name: 'stripe' }, { fetchImpl });
    expect(second?.content).toBe('DOCS');
    expect(second?.metadata?.cached).toBe(true);
    expect(calls()).toBe(1);
  });

  it('expires entries after the TTL and re-fetches', async () => {
    const { fetchImpl, calls } = countingFetch({ content: 'DOCS' });
    let t = 1_000_000;
    const now = (): number => t;
    await fetchHostedDocsCached(root, { name: 'stripe' }, { fetchImpl, now });
    t += HOSTED_DOCS_TTL_MS + 1;
    const later = await fetchHostedDocsCached(root, { name: 'stripe' }, { fetchImpl, now });
    expect(later?.metadata?.cached).toBeUndefined(); // refreshed, not served stale
    expect(calls()).toBe(2);
  });

  it('never caches a null (offline / rate-capped) answer — the next call retries', async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      if (n === 1) throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({ content: 'LATE' }) } as unknown as Response;
    }) as unknown as typeof fetch;
    expect(await fetchHostedDocsCached(root, { name: 'x' }, { fetchImpl: flaky })).toBeNull();
    expect((await fetchHostedDocsCached(root, { name: 'x' }, { fetchImpl: flaky }))?.content).toBe('LATE');
  });

  it('survives a corrupt cache file (degrades to a plain fetch)', async () => {
    const dir = path.join(root, '.vibgrate', 'cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hosted-docs.json'), '{not json');
    const { fetchImpl } = countingFetch({ content: 'OK' });
    expect((await fetchHostedDocsCached(root, { name: 'x' }, { fetchImpl }))?.content).toBe('OK');
  });

  it('does not serve a cached answer to a different identity', async () => {
    const { fetchImpl, calls } = countingFetch({ content: 'WORKSPACE DOCS' });
    await fetchHostedDocsCached(root, { name: 'x' }, { fetchImpl, auth: { keyId: 'k1', secret: 's1' } });
    await fetchHostedDocsCached(root, { name: 'x' }, { fetchImpl }); // anonymous — must NOT hit k1's entry
    expect(calls()).toBe(2);
  });
});
