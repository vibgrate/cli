import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { serializeGraph } from '../src/engine/serialize.js';
import { probeFreshness, writeSnapshot, hasDrift } from '../src/engine/freshness.js';
import {
  resolveLimits,
  checkMemoryBudget,
  envJobs,
  envWorkerHeapMb,
  formatBytes,
  ResourceLimitError,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_TSC_MAX_FILES,
} from '../src/engine/limits.js';
import { makeProject, cleanup } from './helpers.js';

const PIN = '2020-01-01T00:00:00.000Z';
const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}

const ENV_KEYS = [
  'VG_MAX_FILE_BYTES',
  'VG_MAX_FILES',
  'VG_TSC_MAX_FILES',
  'VG_MEMORY_BUDGET_MB',
  'VG_JOBS',
  'VG_WORKER_HEAP_MB',
];
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('resolveLimits', () => {
  it('uses defaults when env is unset', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const limits = resolveLimits();
    expect(limits.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(limits.maxFiles).toBe(DEFAULT_MAX_FILES);
    expect(limits.tscMaxFiles).toBe(DEFAULT_TSC_MAX_FILES);
    expect(limits.memoryBudgetMb).toBeGreaterThan(0); // derived from the V8 heap ceiling
  });

  it('reads env vars, with 0 meaning disabled', () => {
    process.env.VG_MAX_FILE_BYTES = '1024';
    process.env.VG_MAX_FILES = '0';
    process.env.VG_TSC_MAX_FILES = '7';
    process.env.VG_MEMORY_BUDGET_MB = '512';
    const limits = resolveLimits();
    expect(limits.maxFileBytes).toBe(1024);
    expect(limits.maxFiles).toBe(0);
    expect(limits.tscMaxFiles).toBe(7);
    expect(limits.memoryBudgetMb).toBe(512);
  });

  it('falls back to defaults on invalid env values', () => {
    process.env.VG_MAX_FILE_BYTES = 'lots';
    process.env.VG_MAX_FILES = '-3';
    const limits = resolveLimits();
    expect(limits.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(limits.maxFiles).toBe(DEFAULT_MAX_FILES);
  });

  it('explicit overrides beat env vars', () => {
    process.env.VG_MAX_FILE_BYTES = '1024';
    expect(resolveLimits({ maxFileBytes: 99 }).maxFileBytes).toBe(99);
  });

  it('parses VG_JOBS and VG_WORKER_HEAP_MB (unset/0/garbage → undefined)', () => {
    delete process.env.VG_JOBS;
    delete process.env.VG_WORKER_HEAP_MB;
    expect(envJobs()).toBeUndefined();
    expect(envWorkerHeapMb()).toBeUndefined();
    process.env.VG_JOBS = '2';
    process.env.VG_WORKER_HEAP_MB = '256';
    expect(envJobs()).toBe(2);
    expect(envWorkerHeapMb()).toBe(256);
    process.env.VG_JOBS = '0';
    process.env.VG_WORKER_HEAP_MB = 'big';
    expect(envJobs()).toBeUndefined();
    expect(envWorkerHeapMb()).toBeUndefined();
  });
});

describe('checkMemoryBudget', () => {
  it('is a no-op when disabled or under budget', () => {
    expect(() => checkMemoryBudget('parse', 0)).not.toThrow();
    expect(() => checkMemoryBudget('parse', 1_000_000)).not.toThrow();
  });

  it('throws an actionable ResourceLimitError when over budget', () => {
    // Any live Node process uses well over 1 MiB of heap.
    expect(() => checkMemoryBudget('parse', 1)).toThrow(ResourceLimitError);
    expect(() => checkMemoryBudget('parse', 1)).toThrow(/VG_MEMORY_BUDGET_MB/);
  });
});

describe('formatBytes', () => {
  it('renders B / KiB / MiB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(3 * 1024 * 1024 + 200 * 1024)).toBe('3.2 MiB');
  });
});

describe('buildGraph resource safeguards', () => {
  const big = `// ${'x'.repeat(400)}\nexport function huge(){ return 1; }\n`;

  it('skips files over the per-file size cap, with a warning', async () => {
    const root = project({
      'small.ts': 'export function tiny(){ return 1; }',
      'generated.ts': big,
    });
    const result = await buildGraph({
      root,
      generatedAt: PIN,
      inline: true,
      limits: { maxFileBytes: 256 },
    });
    const files = result.graph.nodes.filter((n) => n.kind === 'file').map((n) => n.file);
    expect(files).toContain('small.ts');
    expect(files).not.toContain('generated.ts');
    expect(result.warnings.some((w) => w.includes('generated.ts') && w.includes('VG_MAX_FILE_BYTES'))).toBe(true);
    // Still stat-tracked so the freshness probe never sees phantom drift.
    expect(result.fileStats.map((f) => f.rel)).toContain('generated.ts');
  });

  it('size-cap skipping is deterministic (byte-identical output)', async () => {
    const root = project({ 'a.ts': 'export const a = 1;', 'b.ts': big });
    const opts = { root, generatedAt: PIN, inline: true, noCache: true, limits: { maxFileBytes: 256 } };
    const one = serializeGraph((await buildGraph(opts)).graph);
    const two = serializeGraph((await buildGraph(opts)).graph);
    expect(one).toBe(two);
  });

  it('oversized files cause no phantom freshness drift', async () => {
    const root = project({ 'a.ts': 'export const a = 1;', 'b.ts': big });
    const result = await buildGraph({
      root,
      generatedAt: PIN,
      inline: true,
      limits: { maxFileBytes: 256 },
    });
    writeSnapshot(root, result.graph.provenance.corpusHash, result.fileStats, {});
    const probe = probeFreshness(root);
    expect(probe).not.toBeNull();
    expect(hasDrift(probe!.drift)).toBe(false);
  });

  it('aborts with guidance when the corpus exceeds the file-count cap', async () => {
    const root = project({ 'a.ts': 'export const a = 1;', 'b.ts': 'export const b = 2;' });
    await expect(
      buildGraph({ root, generatedAt: PIN, inline: true, limits: { maxFiles: 1 } }),
    ).rejects.toThrow(/VG_MAX_FILES/);
  });

  it('skips the TypeScript resolver rung above its file cap, with a warning', async () => {
    const root = project({
      'a.ts': 'import { b } from "./b"; export function a(){ return b(); }',
      'b.ts': 'export function b(){ return 1; }',
    });
    const result = await buildGraph({
      root,
      generatedAt: PIN,
      inline: true,
      limits: { tscMaxFiles: 1 },
    });
    expect(result.tsc).toBeUndefined();
    expect(result.graph.provenance.resolver).not.toContain('tsc');
    expect(result.warnings.some((w) => w.includes('VG_TSC_MAX_FILES'))).toBe(true);
  });

  it('aborts catchably when the memory budget is exceeded', async () => {
    const root = project({ 'a.ts': 'export const a = 1;' });
    await expect(
      buildGraph({ root, generatedAt: PIN, inline: true, limits: { memoryBudgetMb: 1 } }),
    ).rejects.toThrow(ResourceLimitError);
  });

  it('a build under default limits is unaffected by the safeguards', async () => {
    const root = project({
      'a.ts': 'import { b } from "./b"; export function a(){ return b(); }',
      'b.ts': 'export function b(){ return 1; }',
    });
    const capped = serializeGraph(
      (await buildGraph({ root, generatedAt: PIN, inline: true, noCache: true })).graph,
    );
    const uncapped = serializeGraph(
      (
        await buildGraph({
          root,
          generatedAt: PIN,
          inline: true,
          noCache: true,
          limits: { maxFileBytes: 0, maxFiles: 0, tscMaxFiles: 0, memoryBudgetMb: 0 },
        })
      ).graph,
    );
    expect(capped).toBe(uncapped);
  });
});
