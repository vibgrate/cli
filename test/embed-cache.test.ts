import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGraph } from '../src/engine/build.js';
import {
  modelCacheDir,
  isModelReady,
  countPending,
  getNodeEmbeddings,
  resolveEmbedModel,
  unavailableMessage,
  modelCacheInfo,
  clearModelCache,
  loadEmbedder,
  type Embedder,
} from '../src/engine/embeddings.js';
import { makeProject, cleanup, SAMPLE_FILES } from './helpers.js';

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v?: string): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

function counting(): Embedder & { calls: number } {
  return {
    id: 'stub-emb',
    calls: 0,
    async embed(texts) {
      this.calls += texts.length;
      return texts.map(() => [1, 0]);
    },
    async embedQuery() {
      return [1, 0];
    },
  };
}

describe('central, per-user model cache', () => {
  it('defaults to a shared vibgrate/models dir; XDG_CACHE_HOME relocates it', () => {
    setEnv('XDG_CACHE_HOME', undefined);
    const d = modelCacheDir();
    expect(d).toContain('vibgrate');
    expect(d).toContain('models');
    const tmp = path.join(os.tmpdir(), 'vg-model-cache-xyz');
    setEnv('XDG_CACHE_HOME', tmp);
    expect(modelCacheDir()).toBe(path.join(tmp, 'vibgrate', 'models'));
  });

  it('isModelReady reflects the marker in the central cache', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-mc-'));
    dirs.push(tmp);
    setEnv('XDG_CACHE_HOME', tmp);
    const cache = modelCacheDir();
    fs.mkdirSync(cache, { recursive: true });
    const model = resolveEmbedModel();
    expect(isModelReady(model)).toBe(false);
    fs.writeFileSync(path.join(cache, `.ready-${model}`), '1');
    expect(isModelReady(model)).toBe(true);
  });
});

describe('embed pending count + single-writer lock', () => {
  it('countPending drops to 0 after embedding', async () => {
    const dir = makeProject(SAMPLE_FILES);
    dirs.push(dir);
    const g = (await buildGraph({ root: dir, inline: true, generatedAt: '2020-01-01T00:00:00.000Z' })).graph;
    expect(countPending(g, dir, 'stub-emb')).toBeGreaterThan(0);
    await getNodeEmbeddings(g, counting(), dir);
    expect(countPending(g, dir, 'stub-emb')).toBe(0);
  });

  it('skips embedding when another live process holds the lock', async () => {
    const dir = makeProject(SAMPLE_FILES);
    dirs.push(dir);
    const g = (await buildGraph({ root: dir, inline: true, generatedAt: '2020-01-01T00:00:00.000Z' })).graph;
    const cdir = path.join(dir, '.vibgrate', 'cache');
    fs.mkdirSync(cdir, { recursive: true });
    const lock = path.join(cdir, 'embeddings-stub-emb.json.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() })); // live → not stale

    const held = counting();
    const vecs = await getNodeEmbeddings(g, held, dir);
    expect(held.calls).toBe(0); // lock held → did not embed (no double-work / race)
    expect(vecs.size).toBe(0); // nothing cached yet → empty (lexical floor still applies)

    fs.rmSync(lock, { force: true });
    const free = counting();
    await getNodeEmbeddings(g, free, dir);
    expect(free.calls).toBeGreaterThan(0); // lock released → embeds normally
  });

  it('reclaims a stale lock (dead pid)', async () => {
    const dir = makeProject(SAMPLE_FILES);
    dirs.push(dir);
    const g = (await buildGraph({ root: dir, inline: true, generatedAt: '2020-01-01T00:00:00.000Z' })).graph;
    const cdir = path.join(dir, '.vibgrate', 'cache');
    fs.mkdirSync(cdir, { recursive: true });
    const lock = path.join(cdir, 'embeddings-stub-emb.json.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483646, at: Date.now() })); // implausible pid → dead

    const emb = counting();
    await getNodeEmbeddings(g, emb, dir);
    expect(emb.calls).toBeGreaterThan(0); // stale lock reclaimed → embeds
  });
});

describe('graceful fallback messaging (low-temperature, trust-building)', () => {
  it('every reason reassures with lexical and never alarms', () => {
    for (const r of ['not-installed', 'no-permission', 'download-failed', 'init-failed'] as const) {
      const m = unavailableMessage(r);
      expect(m.toLowerCase()).toContain('lexical'); // reassures it still works
      expect(m).not.toMatch(/error|fatal|traceback|crash|fail(ed|ure)/i); // calm, no alarm
    }
    // actionable: the permission case names the off switch + relocation + "no sudo"
    const perm = unavailableMessage('no-permission');
    expect(perm).toContain('--local');
    expect(perm).toContain('XDG_CACHE_HOME');
    expect(perm.toLowerCase()).toContain('sudo');
  });

  it('loadEmbedder reports a reason (never throws) when the cache cannot be created', async () => {
    const f = path.join(os.tmpdir(), `vg-notdir-${process.pid}`);
    fs.writeFileSync(f, 'x'); // a file…
    dirs.push(f);
    setEnv('XDG_CACHE_HOME', path.join(f, 'sub')); // …so mkdir under it fails
    let reason: string | undefined;
    const embedder = await loadEmbedder({ onUnavailable: (r) => (reason = r) });
    expect(embedder).toBeNull();
    expect(reason).toBeTruthy(); // a calm reason was surfaced, not an exception
  });
});

describe('model cache inspect + clear', () => {
  it('modelCacheInfo reports size/presence; clearModelCache frees it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-clear-'));
    dirs.push(tmp);
    setEnv('XDG_CACHE_HOME', tmp);
    const cache = modelCacheDir();
    fs.mkdirSync(cache, { recursive: true });
    const model = resolveEmbedModel();
    fs.writeFileSync(path.join(cache, `.ready-${model}`), '1');
    fs.mkdirSync(path.join(cache, 'fast-model'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'fast-model', 'weights.onnx'), 'x'.repeat(2048));

    const info = modelCacheInfo(model);
    expect(info.present).toBe(true);
    expect(info.bytes).toBeGreaterThan(2000);

    const freed = clearModelCache();
    expect(freed).toBeGreaterThan(2000);
    expect(fs.existsSync(cache)).toBe(false);
    expect(modelCacheInfo(model).present).toBe(false);
  });
});
