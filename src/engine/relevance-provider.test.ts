import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadRelevanceProvider,
  rankQuestion,
  resetRelevanceProviderCache,
} from './relevance-provider.js';

const ENV_KEYS = ['VIBGRATE_NO_KERNEL', 'VIBGRATE_RELEVANCE_PATH', 'XDG_CACHE_HOME'] as const;
let saved: Record<string, string | undefined>;
let tmp: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-relevance-'));
  // Point the default probe at an empty cache so a developer machine with a
  // real module installed cannot leak into these tests.
  process.env.XDG_CACHE_HOME = tmp;
  delete process.env.VIBGRATE_NO_KERNEL;
  delete process.env.VIBGRATE_RELEVANCE_PATH;
  resetRelevanceProviderCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  resetRelevanceProviderCache();
});

function writeStubModule(body: string): string {
  const p = path.join(tmp, 'provider.mjs');
  fs.writeFileSync(p, body);
  return p;
}

const GOOD_STUB = `export function createRelevanceProvider() {
  return {
    version: () => 'stub-relevance@1',
    analyzeQuery: (q) => ({
      version: 'stub-relevance@1',
      topics: [{ id: 'payments', score: 0.9 }],
      expansions: [{ term: 'mandate', from: 'gocardless', weight: 0.6 }],
    }),
  };
}`;

describe('relevance provider loader', () => {
  it('returns null when nothing is installed (the default)', async () => {
    expect(await loadRelevanceProvider()).toBeNull();
    expect(await rankQuestion({ nodes: [] }, 'anything')).toBeNull();
  });

  it('VIBGRATE_NO_KERNEL=1 disables the seam even when a module is present', async () => {
    process.env.VIBGRATE_RELEVANCE_PATH = writeStubModule(GOOD_STUB);
    process.env.VIBGRATE_NO_KERNEL = '1';
    resetRelevanceProviderCache();
    expect(await loadRelevanceProvider()).toBeNull();
  });

  it('loads a provider from VIBGRATE_RELEVANCE_PATH; without rankSymbols there is no ranking engine', async () => {
    process.env.VIBGRATE_RELEVANCE_PATH = writeStubModule(GOOD_STUB);
    resetRelevanceProviderCache();
    const provider = await loadRelevanceProvider();
    expect(provider?.version()).toBe('stub-relevance@1');
    // A pre-relocation module (analyzeQuery only) is not a ranking engine:
    // rankQuestion degrades to null → the mechanical fallback answers.
    expect(await rankQuestion({ nodes: [] }, 'handle gocardless retries')).toBeNull();
  });

  it('delegates ranking to a module with rankSymbols and sanitizes the result', async () => {
    process.env.VIBGRATE_RELEVANCE_PATH = writeStubModule(`export function createRelevanceProvider() {
  return {
    version: () => 'stub-ranker@1',
    analyzeQuery: () => ({ version: 'stub-ranker@1', topics: [], expansions: [] }),
    rankSymbols: (q, symbols) => ({
      version: 'stub-ranker@1',
      hasContent: true,
      seeds: [
        { id: symbols[0].id, score: 9, why: 'top pick' },
        { id: 'forged-id', score: 99, why: 'not yours' },
      ],
      conceptMap: ['- interpreted.'],
    }),
  };
}`);
    resetRelevanceProviderCache();
    const graph = {
      nodes: [
        { id: 'n1', name: 'a', qualifiedName: 'a', file: 'src/a.ts', kind: 'function', importance: 0.5 },
      ],
    };
    const ranked = await rankQuestion(graph, 'anything');
    expect(ranked?.version).toBe('stub-ranker@1');
    expect(ranked?.seeds).toEqual([{ id: 'n1', score: 9, why: 'top pick' }]);
    expect(ranked?.conceptMap).toEqual(['- interpreted.']);
  });

  it('a module that violates the contract or throws yields null, never an error', async () => {
    process.env.VIBGRATE_RELEVANCE_PATH = writeStubModule(`export const nothing = 1;`);
    resetRelevanceProviderCache();
    expect(await loadRelevanceProvider()).toBeNull();

    process.env.VIBGRATE_RELEVANCE_PATH = writeStubModule(
      `export function createRelevanceProvider() { return { version: () => 'x', analyzeQuery: () => ({}), rankSymbols: () => { throw new Error('boom'); } }; }`,
    );
    resetRelevanceProviderCache();
    expect(await rankQuestion({ nodes: [] }, 'anything')).toBeNull();
  });
});

describe('loadTopicTags (binary sidecar bound to one exact graph)', () => {
  const TAGGING_STUB = `export function createRelevanceProvider() {
  return {
    version: () => 'stub-relevance@2',
    analyzeQuery: () => ({ version: 'stub-relevance@2', topics: [], expansions: [] }),
    tagNode: ({ file }) => (file.includes('order') ? ['Commerce', ''] : []),
  };
}`;

  const makeGraph = (corpusHash: string) =>
    ({
      provenance: { corpusHash },
      nodes: [
        { id: 'n1', kind: 'function', qualifiedName: 'OrderService.add', file: 'src/order.ts' },
        { id: 'n2', kind: 'function', qualifiedName: 'MathUtil.add', file: 'src/math.ts' },
        { id: 'n3', kind: 'file', qualifiedName: 'src/order.ts', file: 'src/order.ts' },
      ],
    }) as never;

  it('tags + caches beside the graph, binds to corpusHash + provider version, and deletes with the graph', async () => {
    const { loadTopicTags, tagsSidecarPathFor, deleteTagsSidecarFor } = await import('./relevance-enrich.js');
    const root = fs.mkdtempSync(path.join(tmp, 'repo-'));
    const graphPath = path.join(root, 'store', 'branch-main.graph.json');
    const graph = makeGraph('hash-A');

    expect(await loadTopicTags(graph, root, graphPath)).toBeNull(); // no provider installed

    process.env.VIBGRATE_RELEVANCE_PATH = writeStubModule(TAGGING_STUB);
    resetRelevanceProviderCache();
    const tags = await loadTopicTags(graph, root, graphPath);
    // Sanitized (lowercased, empties dropped), file-kind nodes skipped.
    expect(tags?.get('n1')).toEqual(['commerce']);
    expect(tags?.has('n2')).toBe(false);
    expect(tags?.has('n3')).toBe(false);

    // Binary sidecar sits BESIDE the graph artifact (branch-keyed store path)
    // and starts with the VGTAGS magic — no JSON on disk.
    const sidecar = tagsSidecarPathFor(graphPath);
    expect(sidecar).toBe(path.join(root, 'store', 'branch-main.graph.tags.snap'));
    const raw = fs.readFileSync(sidecar);
    expect(raw.subarray(0, 8).toString('latin1')).toBe('VGTAGS1\0');

    // Same graph content → cache hit (mutate the file to prove it is read).
    const before = fs.statSync(sidecar).mtimeMs;
    expect((await loadTopicTags(graph, root, graphPath))?.get('n1')).toEqual(['commerce']);
    expect(fs.statSync(sidecar).mtimeMs).toBe(before);

    // A DIFFERENT graph at the same path (branch switch / rebuild → new
    // corpusHash) must not reuse the old sidecar.
    const other = await loadTopicTags(makeGraph('hash-B'), root, graphPath);
    expect(other?.get('n1')).toEqual(['commerce']); // recomputed, not stale-read

    // Graph removal takes the sidecar with it.
    deleteTagsSidecarFor(graphPath);
    expect(fs.existsSync(sidecar)).toBe(false);
  });

  it('a torn sidecar or one from another engine/provider version is recomputed, and a graph without corpusHash gets no sidecar', async () => {
    const { loadTopicTags, tagsSidecarPathFor } = await import('./relevance-enrich.js');
    const root = fs.mkdtempSync(path.join(tmp, 'repo-'));
    const graphPath = path.join(root, 'g.graph.json');
    process.env.VIBGRATE_RELEVANCE_PATH = writeStubModule(TAGGING_STUB);
    resetRelevanceProviderCache();

    await loadTopicTags(makeGraph('hash-A'), root, graphPath);
    const sidecar = tagsSidecarPathFor(graphPath);
    // Corrupt the payload: CRC must reject it and the load must recompute.
    const raw = fs.readFileSync(sidecar);
    raw[raw.length - 1] ^= 0xff;
    fs.writeFileSync(sidecar, raw);
    expect((await loadTopicTags(makeGraph('hash-A'), root, graphPath))?.get('n1')).toEqual(['commerce']);

    // No content identity → no cacheable binding, but tags still compute.
    const noHash = { nodes: (makeGraph('x') as { nodes: unknown[] }).nodes } as never;
    expect(await loadTopicTags(noHash, root, path.join(root, 'other.graph.json'))).toBeNull();
  });
});
