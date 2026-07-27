import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import {
  ensureWeightCached,
  isAllowedWeightUrl,
  isAllowedWeightHost,
  isWeightCached,
  lookupCatalog,
  weightPathForRef,
  listCachedWeights,
  FIRST_PARTY_WEIGHT_CATALOG,
  catalogIntegrityReport,
  assertCatalogPinned,
} from './weight-store.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('weight-store', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('allowlists https huggingface hosts and CDN suffixes', () => {
    expect(isAllowedWeightUrl('https://huggingface.co/org/model/resolve/main/a.gguf')).toBe(true);
    expect(isAllowedWeightUrl('https://cdn-lfs.huggingface.co/repos/ab/cd/ef')).toBe(true);
    expect(isAllowedWeightUrl('https://us.aws.cdn.hf.co/x/y')).toBe(true);
    expect(isAllowedWeightUrl('https://cas-server.xethub.hf.co/x')).toBe(true);
    expect(isAllowedWeightHost('cdn-lfs-eu-1.huggingface.co')).toBe(true);
    expect(isAllowedWeightUrl('http://huggingface.co/x')).toBe(false);
    expect(isAllowedWeightUrl('https://evil.example/a.gguf')).toBe(false);
    expect(isAllowedWeightHost('evil.example')).toBe(false);
  });

  it('looks up catalog entries by ref', () => {
    const e = lookupCatalog('qwen2.5-coder-3b-q4_k_m.gguf');
    expect(e?.url).toMatch(/huggingface\.co/);
    expect(e?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(e?.bytes).toBeGreaterThan(0);
    expect(FIRST_PARTY_WEIGHT_CATALOG.length).toBeGreaterThan(0);
  });

  it('ensureWeightCached uses injectable fetch and caches', async () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-weights-'));
    dirs.push(cache);
    const env = { VIBGRATE_CACHE_DIR: cache };
    const ref = 'qwen2.5-coder-3b-q4_k_m.gguf';
    const body = 'gguf-bytes';
    expect(isWeightCached(ref, env)).toBe(false);

    const res = await ensureWeightCached(ref, {
      env,
      // Override catalog pin so the fixture body verifies cleanly.
      expectedSha256: sha256(body),
      fetchToFile: async (_url, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, body);
      },
    });
    expect(res.ok).toBe(true);
    expect(res.fromCache).toBe(false);
    expect(isWeightCached(ref, env)).toBe(true);
    expect(fs.readFileSync(weightPathForRef(ref, env), 'utf8')).toBe(body);

    const again = await ensureWeightCached(ref, {
      env,
      fetchToFile: async () => {
        throw new Error('should not download');
      },
    });
    expect(again.fromCache).toBe(true);
    expect(listCachedWeights(env).map((w) => w.name)).toContain(ref);
  });

  it('rejects missing catalog without url', async () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-weights-'));
    dirs.push(cache);
    const res = await ensureWeightCached('no-such-model.gguf', { env: { VIBGRATE_CACHE_DIR: cache } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no first-party download URL/);
  });

  it('enforces sha256 when provided', async () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-weights-'));
    dirs.push(cache);
    const res = await ensureWeightCached('qwen2.5-coder-3b-q4_k_m.gguf', {
      env: { VIBGRATE_CACHE_DIR: cache },
      expectedSha256: 'deadbeef',
      fetchToFile: async (_u, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'not-matching');
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/sha256 mismatch/);
  });

  it('enforces catalog sha256 pin when expectedSha256 omitted', async () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-weights-'));
    dirs.push(cache);
    const res = await ensureWeightCached('qwen2.5-coder-3b-q4_k_m.gguf', {
      env: { VIBGRATE_CACHE_DIR: cache },
      fetchToFile: async (_u, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'not-the-real-gguf');
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/sha256 mismatch/);
  });

  it('first-party catalog is fully pinned (B6 CI gate)', () => {
    const report = catalogIntegrityReport(FIRST_PARTY_WEIGHT_CATALOG);
    expect(report.total).toBeGreaterThan(0);
    expect(report.complete).toBe(true);
    expect(report.unpinned).toEqual([]);
    expect(() => assertCatalogPinned()).not.toThrow();
    expect(() => assertCatalogPinned([{ ref: 'y', url: 'https://huggingface.co/y' }])).toThrow(/missing sha256/);
  });
});
