import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { resolveGgufPath, embeddedLlamaReady } from './resolve-gguf.js';

describe('resolveGgufPath', () => {
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

  it('prefers explicit existing path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gguf-'));
    dirs.push(dir);
    const file = path.join(dir, 'm.gguf');
    fs.writeFileSync(file, 'x');
    const r = resolveGgufPath({ modelPath: file, discover: () => [] });
    expect(r?.source).toBe('explicit');
    expect(r?.path).toBe(path.resolve(file));
  });

  it('resolves from weight store via VIBGRATE_CACHE_DIR', () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cache-'));
    dirs.push(cache);
    const weights = path.join(cache, 'weights');
    fs.mkdirSync(weights, { recursive: true });
    const name = 'qwen2.5-coder-3b-q4_k_m.gguf';
    fs.writeFileSync(path.join(weights, name), 'gguf');
    const r = resolveGgufPath({
      modelRef: name,
      env: { VIBGRATE_CACHE_DIR: cache },
      discover: () => [],
    });
    expect(r?.source).toBe('weight-store');
    expect(r?.path).toContain(name);
    expect(embeddedLlamaReady({ modelRef: name, env: { VIBGRATE_CACHE_DIR: cache }, discover: () => [] })).toBe(true);
  });

  it('resolves from fleet discovery', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-fleet-'));
    dirs.push(dir);
    const file = path.join(dir, 'coder.gguf');
    fs.writeFileSync(file, 'x');
    const r = resolveGgufPath({
      modelRef: 'coder',
      discover: () => [{ runtime: 'gguf', name: 'coder.gguf', path: file }],
      env: {},
    });
    expect(r?.source).toBe('fleet');
    expect(r?.path).toBe(file);
  });

  it('returns null when nothing available', () => {
    expect(resolveGgufPath({ modelRef: 'nope.gguf', discover: () => [], env: {} })).toBeNull();
    expect(embeddedLlamaReady({ modelRef: 'nope.gguf', discover: () => [], env: {} })).toBe(false);
  });
});
