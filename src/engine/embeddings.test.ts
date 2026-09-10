import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BGE_QUERY_PREFIX,
  countPending,
  embedModelSpec,
  embedTargets,
  getNodeEmbeddings,
  nodeEmbedText,
  nodeEmbedTextV1,
  queryEmbedText,
  readCachedVectors,
  type Embedder,
} from './embeddings.js';
import { clearCasRepositoryIdCache, openVectorCas } from './cas.js';
import type { GraphNode, VgGraph } from '../schema.js';

/**
 * Two things the branch-switch work changed about vectors:
 *   1. a *query* is embedded with the model's own instruction prefix (BGE v1.5
 *      is asymmetric; MiniLM is not) — the backend's generic `query: ` marker
 *      was the wrong instruction for both;
 *   2. the embed text of a node no longer carries its path or area, so the
 *      vector of a symbol is the same on every branch, at every path, in every
 *      worktree — and the content-addressed store can serve it without ONNX.
 */

describe('query prefix per model', () => {
  it('BGE v1.5 queries carry the FlagEmbedding retrieval instruction; documents never do', () => {
    expect(queryEmbedText('bge-small-en-v1.5', 'where is auth')).toBe(`${BGE_QUERY_PREFIX}where is auth`);
    expect(queryEmbedText('bge-base-en-v1.5', 'x')).toBe(`${BGE_QUERY_PREFIX}x`);
    expect(queryEmbedText('bge-small', 'x')).toBe(`${BGE_QUERY_PREFIX}x`); // alias
    expect(queryEmbedText('BAAI/bge-small-en-v1.5', 'x')).toBe(`${BGE_QUERY_PREFIX}x`);
  });

  it('symmetric and unknown models embed the bare query', () => {
    expect(queryEmbedText('all-MiniLM-L6-v2', 'where is auth')).toBe('where is auth');
    expect(queryEmbedText('all-minilm', 'x')).toBe('x');
    expect(queryEmbedText('some-future-model', 'x')).toBe('x');
  });

  it('the registry resolves ids and aliases case-insensitively', () => {
    expect(embedModelSpec('BGE-SMALL-EN-V1.5')?.id).toBe('bge-small-en-v1.5');
    expect(embedModelSpec('minilm')?.dims).toBe(384);
    expect(embedModelSpec('nope')).toBeUndefined();
  });
});

describe('embed text v2 is path-agnostic', () => {
  const node = {
    id: 'n1',
    name: 'Table',
    qualifiedName: 'Table',
    kind: 'function',
    signature: 'function Table(',
    doc: 'Renders a sortable data table of rows',
    file: 'apps/web/src/components/Table.tsx',
    area: 'a1',
  } as unknown as GraphNode;

  it('drops path words and the area label that v1 carried', () => {
    const v1 = nodeEmbedTextV1(node, 'react');
    const v2 = nodeEmbedText(node);
    expect(v1).toContain('components');
    expect(v1).toContain('react');
    expect(v2).not.toContain('components');
    expect(v2).not.toContain('react');
    expect(v2).toContain('Renders a sortable data table of rows');
  });

  it('the same symbol at another path has the same embed hash (and so the same vector key)', () => {
    const moved = { ...node, id: 'n2', file: 'lib/ui/Table.tsx' } as unknown as GraphNode;
    const graph = { nodes: [node, moved], edges: [], areas: [] } as unknown as VgGraph;
    const [a, b] = embedTargets(graph);
    expect(a!.id).not.toBe(b!.id);
    expect(a!.hash).toBe(b!.hash);
  });
});

describe('getNodeEmbeddings binds from the content-addressed store', () => {
  const MODEL = 'bge-small-en-v1.5';
  let cacheDir: string;
  let root: string;
  let prevCache: string | undefined;
  let prevCas: string | undefined;

  function counting(): Embedder & { calls: number; texts: string[] } {
    const e = {
      id: MODEL,
      calls: 0,
      texts: [] as string[],
      embed(texts: string[]) {
        e.calls++;
        e.texts.push(...texts);
        return Promise.resolve(texts.map((t, i) => [t.length, i + 1, 0.5]));
      },
      embedQuery: () => Promise.resolve([1, 0, 0]),
    };
    return e;
  }

  function graph(files: string[], ids?: string[]): VgGraph {
    return {
      nodes: files.map((file, i) => ({
        id: ids?.[i] ?? `n${i}`,
        name: `sym${i}`,
        qualifiedName: `pkg.sym${i}`,
        kind: 'function',
        file,
        line: 1,
      })),
      edges: [],
      areas: [],
    } as unknown as VgGraph;
  }

  const sidecar = (): string => path.join(root, '.vibgrate', 'embeddings');

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-emb-cache-'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-emb-root-'));
    fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
    prevCache = process.env.VIBGRATE_CACHE_DIR;
    prevCas = process.env.VIBGRATE_CAS;
    process.env.VIBGRATE_CACHE_DIR = cacheDir;
    delete process.env.VIBGRATE_CAS;
    // vitest.config pins VIBGRATE_GRAPH_IN_REPO=1: the sidecar is `.vibgrate/embeddings`.
    clearCasRepositoryIdCache();
  });

  afterEach(() => {
    if (prevCache === undefined) delete process.env.VIBGRATE_CACHE_DIR;
    else process.env.VIBGRATE_CACHE_DIR = prevCache;
    if (prevCas === undefined) delete process.env.VIBGRATE_CAS;
    else process.env.VIBGRATE_CAS = prevCas;
    clearCasRepositoryIdCache();
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a map with an empty sidecar (first visit to a ref) binds every known symbol without the model', async () => {
    const g = graph(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const first = counting();
    const v1 = await getNodeEmbeddings(g, first, root);
    expect(first.calls).toBe(1);
    expect(v1.size).toBe(3);
    expect(openVectorCas(root)!.stats).toMatchObject({ vectorWrites: 0 }); // fresh handle: counts are per handle
    expect(fs.existsSync(sidecar())).toBe(true);

    // The next ref's sidecar does not exist yet — that is the branch switch.
    fs.rmSync(sidecar());
    const second = counting();
    const v2 = await getNodeEmbeddings(g, second, root);
    expect(second.calls).toBe(0); // nothing embedded
    expect(v2.size).toBe(3);
    expect([...v2.entries()]).toEqual([...v1.entries()]);
    expect(fs.existsSync(sidecar())).toBe(true); // re-packed from the store, no ONNX
  });

  it('a renamed file keeps its vectors: new node ids, same embed hashes', async () => {
    await getNodeEmbeddings(graph(['src/a.ts', 'src/b.ts']), counting(), root);
    fs.rmSync(sidecar());
    const renamed = graph(['lib/a.ts', 'lib/b.ts'], ['r0', 'r1']);
    const e = counting();
    const vecs = await getNodeEmbeddings(renamed, e, root);
    expect(e.calls).toBe(0);
    expect([...vecs.keys()].sort()).toEqual(['r0', 'r1']);
  });

  it('only the symbols the store has never seen are embedded', async () => {
    await getNodeEmbeddings(graph(['src/a.ts', 'src/b.ts']), counting(), root);
    fs.rmSync(sidecar());
    const e = counting();
    const vecs = await getNodeEmbeddings(graph(['src/a.ts', 'src/b.ts', 'src/new.ts']), e, root);
    expect(e.calls).toBe(1);
    expect(e.texts).toHaveLength(1); // just the new symbol
    expect(vecs.size).toBe(3);
  });

  it('countPending and readCachedVectors (vgd seeding) see store hits too', async () => {
    const g = graph(['src/a.ts', 'src/b.ts']);
    await getNodeEmbeddings(g, counting(), root);
    fs.rmSync(sidecar());
    expect(countPending(g, root, MODEL)).toBe(0);
    const read = readCachedVectors(g, root, MODEL);
    expect(read.vectors.size).toBe(2);
    expect(read.pending).toEqual([]);
  });

  it('vectors are per model: another model id embeds afresh', async () => {
    const g = graph(['src/a.ts']);
    await getNodeEmbeddings(g, counting(), root);
    fs.rmSync(sidecar());
    const other = { ...counting(), id: 'all-MiniLM-L6-v2' };
    let calls = 0;
    other.embed = (texts) => {
      calls++;
      return Promise.resolve(texts.map(() => [1, 1, 1]));
    };
    await getNodeEmbeddings(g, other, root);
    expect(calls).toBe(1);
  });

  it('VIBGRATE_CAS=0 falls back to the sidecar-only behaviour', async () => {
    process.env.VIBGRATE_CAS = '0';
    const g = graph(['src/a.ts']);
    await getNodeEmbeddings(g, counting(), root);
    fs.rmSync(sidecar());
    const e = counting();
    await getNodeEmbeddings(g, e, root);
    expect(e.calls).toBe(1);
    expect(fs.existsSync(path.join(cacheDir, 'cas'))).toBe(false);
  });
});
