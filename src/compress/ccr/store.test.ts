import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CcrEntryTooLargeError, CompressionStore, defaultStore, hashOriginal, jsonPathPick, resetDefaultStores, shortHash } from './store.js';
import { makeMarker } from './markers.js';

const ORIGINAL = ['line 1 alpha', 'line 2 beta', 'line 3 gamma', 'line 4 delta', 'line 5 epsilon'].join('\n');

function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe('hashOriginal', () => {
  it('is sha256[:24], lowercase, content-derived', () => {
    const h = hashOriginal('hello');
    expect(h).toBe('2cf24dba5fb0a30e26e83b2a');
    expect(shortHash(h)).toBe('2cf24dba5fb0');
  });
});

describe('CompressionStore (memory)', () => {
  it('stores, dedups identical originals and retrieves', () => {
    const c = clock();
    const s = new CompressionStore({ now: c.now });
    const h1 = s.store(ORIGINAL, { compressed: 'x', strategy: 'log', toolName: 'Bash' });
    const h2 = s.store(ORIGINAL, { compressed: 'y', strategy: 'log' });
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(24);
    expect(s.exists(h1)).toBe(true);
    expect(s.exists(h1.toUpperCase())).toBe(true);
    expect(s.exists(shortHash(h1))).toBe(true); // 12-char marker form resolves by prefix
    expect(s.resolveKey('000000000000')).toBe('000000000000');
    expect(s.stats().entries).toBe(1);
    const r = s.retrieve(h1);
    expect(r.found).toBe(true);
    expect(r.content).toBe(ORIGINAL);
    expect(r.entry?.retrievalCount).toBe(1);
    expect(s.stats().totalRetrievals).toBe(1);
    expect(s.retrieve(shortHash(h1)).hash).toBe(h1);
    expect(s.stats().totalRetrievals).toBe(2);
  });

  it('honours explicit 12-char hashes and rejects invalid ones', () => {
    const s = new CompressionStore({ now: clock().now });
    expect(s.store('abc', { compressed: '', strategy: 'x', explicitHash: 'ABCDEF012345' })).toBe('abcdef012345');
    expect(s.exists('abcdef012345')).toBe(true);
    expect(() => s.store('abc', { compressed: '', strategy: 'x', explicitHash: 'nothex' })).toThrow();
  });

  it('never persists a bare marker as an original', () => {
    const s = new CompressionStore({ now: clock().now });
    const h = s.store(makeMarker('rows', 'abcdef012345abcdef012345', 3), { compressed: '', strategy: 'x' });
    expect(s.exists(h)).toBe(false);
    const nested = s.store(`data\n${makeMarker('rows', 'abcdef012345abcdef012345', 3)}`, { compressed: '', strategy: 'x' });
    expect(s.exists(nested)).toBe(true);
  });

  it('expires by TTL and reports why an entry is gone', () => {
    const c = clock();
    const s = new CompressionStore({ now: c.now, ttlSeconds: 60 });
    const h = s.store(ORIGINAL, { compressed: '', strategy: 'x' });
    c.advance(59_000);
    expect(s.get(h)).not.toBeNull();
    c.advance(2_000);
    expect(s.get(h)).toBeNull();
    expect(s.statusOf(h).status).toBe('expired');
    expect(s.retrieve(h).detail).toMatch(/Entry expired \(retrieval TTL: 60 seconds/);
    expect(s.statusOf('0000000000000000000000ff').status).toBe('missing');
    expect(s.missDetail('0000000000000000000000ff')).toBe('Entry not found (retrieval TTL: 60 seconds)');
  });

  it('per-entry ttl override and purgeExpired', () => {
    const c = clock();
    const s = new CompressionStore({ now: c.now, ttlSeconds: 1000 });
    s.store('short', { compressed: '', strategy: 'x', ttlSeconds: 5 });
    s.store('long', { compressed: '', strategy: 'x' });
    c.advance(6_000);
    expect(s.purgeExpired()).toBe(1);
    expect(s.stats().entries).toBe(1);
  });

  it('LRU-evicts at maxEntries (least recently accessed first) and never evicts on a re-store', () => {
    const c = clock();
    const s = new CompressionStore({ now: c.now, maxEntries: 3 });
    const a = s.store('a-original', { compressed: '', strategy: 'x' });
    c.advance(1);
    const b = s.store('b-original', { compressed: '', strategy: 'x' });
    c.advance(1);
    const d = s.store('c-original', { compressed: '', strategy: 'x' });
    c.advance(1);
    s.retrieve(a); // a becomes most recent
    c.advance(1);
    s.store('b-original', { compressed: '', strategy: 'x' }); // re-store: no eviction
    expect(s.stats().entries).toBe(3);
    const e = s.store('d-original', { compressed: '', strategy: 'x' });
    expect(s.exists(a)).toBe(true);
    expect(s.exists(b)).toBe(true);
    expect(s.exists(d)).toBe(false);
    expect(s.exists(e)).toBe(true);
    expect(s.statusOf(d).status).toBe('evicted');
    expect(s.missDetail(d)).toMatch(/evicted/);
  });

  it('refuses originals above maxEntryBytes with a typed error', () => {
    const s = new CompressionStore({ now: clock().now, maxEntryBytes: 10 });
    expect(() => s.store('x'.repeat(11), { compressed: '', strategy: 'x' })).toThrow(CcrEntryTooLargeError);
  });

  it('redacts credential shapes at ingest and marks the entry', () => {
    const s = new CompressionStore({ now: clock().now });
    const secret = 'AWS_ACCESS_KEY_ID=AKIA_aaaaaaaaaaaa\nAuthorization: bbbbbbbbbbbbbbbbbbbb\nplain line';
    const h = s.store(secret, { compressed: '', strategy: 'x' });
    const e = s.get(h)!;
    expect(e.status).toBe('redacted');
    expect(e.original).not.toContain('AKIA_aaaaaaaaaaaa');
    expect(e.original).not.toContain('bbbbbbbbbbbbbbbbbbbb');
    expect(e.original).toContain('plain line');
    expect(s.stats().redacted).toBe(1);
    expect(s.retrieve(h).status).toBe('redacted');
  });

  it('serves targeted views: grep, lines, head, tail, jsonPath, maxTokens', () => {
    const s = new CompressionStore({ now: clock().now });
    const h = s.store(ORIGINAL, { compressed: '', strategy: 'x' });
    expect(s.retrieve(h, { grep: 'BETA' })).toMatchObject({ view: 'grep', content: '2:line 2 beta', matchedLines: 1, totalLines: 5 });
    expect(s.retrieve(h, { lines: [2, 3] }).content).toBe('line 2 beta\nline 3 gamma');
    expect(s.retrieve(h, { head: 1 }).content).toBe('line 1 alpha');
    expect(s.retrieve(h, { tail: 2 }).content).toBe('line 4 delta\nline 5 epsilon');
    const big = s.store(Array.from({ length: 400 }, (_, i) => `row ${i} value ${i * 7}`).join('\n'), { compressed: '', strategy: 'x' });
    const t = s.retrieve(big, { maxTokens: 50 });
    expect(t.truncated).toBe(true);
    expect(t.content).toContain('truncated');
    const j = s.store(JSON.stringify({ items: [{ name: 'first' }, { name: 'second', tags: ['a', 'b'] }] }), { compressed: '', strategy: 'x' });
    expect(s.retrieve(j, { jsonPath: 'items[1].name' }).content).toBe('second');
    expect(s.retrieve(j, { jsonPath: 'items[1].tags' }).content).toBe(JSON.stringify(['a', 'b'], null, 2));
    expect(jsonPathPick('not json', 'a')).toBeUndefined();
    expect(jsonPathPick('{"a":1}', 'a.b')).toBeUndefined();
  });

  it('lists entries sorted by createdAt then hash, and clears', () => {
    const c = clock();
    const s = new CompressionStore({ now: c.now });
    const h1 = s.store('zzz', { compressed: '', strategy: 'x' });
    c.advance(10);
    const h2 = s.store('aaa', { compressed: '', strategy: 'x' });
    expect(s.list().map((e) => e.hash)).toEqual([h1, h2]);
    s.clear();
    expect(s.list()).toEqual([]);
    expect(s.delete(h1)).toBe(false);
  });

  it('is deterministic: two stores over the same input agree', () => {
    const a = new CompressionStore({ now: () => 5 });
    const b = new CompressionStore({ now: () => 5 });
    const ha = a.store(ORIGINAL, { compressed: 'c', strategy: 'log', originalTokens: 9, compressedTokens: 1 });
    const hb = b.store(ORIGINAL, { compressed: 'c', strategy: 'log', originalTokens: 9, compressedTokens: 1 });
    expect(a.get(ha)).toEqual(b.get(hb));
  });
});

describe('CompressionStore (disk)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ccr-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resetDefaultStores();
  });

  it('writes <hash>.json + index.json with 0600 and shares entries across instances', () => {
    const c = clock();
    const s = new CompressionStore({ backend: 'disk', dir, now: c.now });
    const h = s.store(ORIGINAL, { compressed: 'c', strategy: 'log', toolName: 'Bash', toolCallId: 't1' });
    const file = path.join(dir, `${h}.json`);
    expect(fs.existsSync(file)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(dir, 'index.json')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const other = new CompressionStore({ backend: 'disk', dir, now: c.now });
    expect(other.exists(h)).toBe(true);
    expect(other.retrieve(h).content).toBe(ORIGINAL);
    expect(other.stats()).toMatchObject({ backend: 'disk', entries: 1, dir });
  });

  it('picks up entries another process wrote after the index was saved', () => {
    const c = clock();
    const s = new CompressionStore({ backend: 'disk', dir, now: c.now });
    s.store('first', { compressed: '', strategy: 'x' });
    const foreign = hashOriginal('foreign');
    fs.writeFileSync(path.join(dir, `${foreign}.json`), JSON.stringify({ hash: foreign, original: 'foreign', compressed: '', strategy: 'x', originalTokens: 1, compressedTokens: 0, createdAt: c.now(), expiresAt: c.now() + 60_000, status: 'active' }));
    expect(s.exists(foreign)).toBe(true);
    expect(s.get(foreign)?.original).toBe('foreign');
    const fresh = new CompressionStore({ backend: 'disk', dir, now: c.now });
    expect(fresh.list().map((e) => e.original).sort()).toEqual(['first', 'foreign']);
  });

  it('redacts before anything touches disk', () => {
    const s = new CompressionStore({ backend: 'disk', dir, now: clock().now });
    const h = s.store('token = ghp_aaaaaaaaaaaaaaaaaaaa', { compressed: '', strategy: 'x' });
    const raw = fs.readFileSync(path.join(dir, `${h}.json`), 'utf8');
    expect(raw).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaa');
    expect(raw).toContain('redacted');
  });

  it('purges expired files from disk', () => {
    const c = clock();
    const s = new CompressionStore({ backend: 'disk', dir, now: c.now, ttlSeconds: 10 });
    const h = s.store(ORIGINAL, { compressed: '', strategy: 'x' });
    c.advance(11_000);
    expect(s.purgeExpired()).toBe(1);
    expect(fs.existsSync(path.join(dir, `${h}.json`))).toBe(false);
  });

  it('tolerates a corrupt entry file', () => {
    const s = new CompressionStore({ backend: 'disk', dir, now: clock().now });
    fs.writeFileSync(path.join(dir, `${hashOriginal('bad')}.json`), '{not json');
    expect(s.get(hashOriginal('bad'))).toBeNull();
    expect(s.list()).toEqual([]);
  });

  it('defaultStore honours VG_CCR_BACKEND and VG_CONTEXT_DIR', () => {
    const env = { VG_CONTEXT_DIR: dir, VG_CCR_BACKEND: 'disk' } as NodeJS.ProcessEnv;
    const s = defaultStore(env);
    expect(s.backendKind).toBe('disk');
    expect(s.dir).toBe(path.join(dir, 'ccr'));
    expect(defaultStore(env)).toBe(s);
    const mem = defaultStore({ VG_CONTEXT_DIR: dir, VG_CCR_BACKEND: 'memory' } as NodeJS.ProcessEnv);
    expect(mem.backendKind).toBe('memory');
    expect(mem).not.toBe(s);
  });
});
