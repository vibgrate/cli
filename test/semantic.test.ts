import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildGraph } from '../src/engine/build.js';
import { queryGraph, queryGraphSemantic, identifierParts } from '../src/engine/query.js';
import {
  loadEmbedder,
  cosine,
  nodeEmbedText,
  resolveEmbedModel,
  embeddingsCached,
  getNodeEmbeddings,
  type Embedder,
} from '../src/engine/embeddings.js';
import type { GraphNode } from '../src/schema.js';
import { makeProject, cleanup } from './helpers.js';
import type { VgGraph } from '../src/schema.js';

const FILES = {
  'src/security.ts': [
    'export function authenticate(token: string) { return verifyToken(token); }',
    'export function verifyToken(t: string) { return t.length > 0; }',
    'export function catchException(e: Error) { return e.message; }',
    'export function listProducts() { return []; }',
  ].join('\n'),
};

let graph: VgGraph;
let dir: string;
beforeAll(async () => {
  dir = makeProject(FILES);
  graph = (await buildGraph({ root: dir, generatedAt: '2020-01-01T00:00:00.000Z', inline: true })).graph;
});
afterAll(() => cleanup(dir));

describe('lexical morphology (zero-dep, always on)', () => {
  it('matches "authentication" against authenticate via shared-prefix fuzzing', () => {
    const r = queryGraph(graph, 'authentication');
    expect(r.matches.map((m) => m.node.name)).toContain('authenticate');
  });

  it('does not fuzzy-match unrelated short overlaps', () => {
    // "user" should not pull in "verifyToken"/"authenticate" via prefix.
    const names = queryGraph(graph, 'product').matches.map((m) => m.node.name);
    expect(names).toContain('listProducts');
    expect(names).not.toContain('authenticate');
  });

  it('identifierParts splits camelCase and snake_case', () => {
    expect([...identifierParts('verifyToken')]).toEqual(['verify', 'token']);
    expect([...identifierParts('get_password_hash')]).toEqual(['get', 'password', 'hash']);
  });
});

// A deterministic concept-based stub embedder (no model, no network): vectors
// over a few concept dimensions keyed by keywords, so semantically-related text
// with no shared identifier still scores a high cosine.
function stubEmbedder(): Embedder {
  const CONCEPTS: Record<string, string[]> = {
    error: ['error', 'errors', 'exception', 'catch', 'fail', 'handle'],
    auth: ['auth', 'authenticate', 'authentication', 'token', 'verify', 'security'],
    product: ['product', 'products', 'list', 'catalog'],
  };
  const dims = Object.keys(CONCEPTS);
  const vec = (text: string): number[] => {
    const t = text.toLowerCase();
    return dims.map((d) => (CONCEPTS[d].some((w) => t.includes(w)) ? 1 : 0));
  };
  return {
    id: 'stub',
    async embed(texts) {
      return texts.map(vec);
    },
    async embedQuery(text) {
      return vec(text);
    },
  };
}

describe('semantic hybrid (stub embedder)', () => {
  it('surfaces a conceptually-related node with no shared identifier', async () => {
    const embedder = stubEmbedder();
    const targets = graph.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'external');
    const vecs = await embedder.embed(targets.map(nodeEmbedText));
    const nodeVectors = new Map(targets.map((n, i) => [n.id, vecs[i]]));

    // "where do we handle errors?" shares no identifier with catchException,
    // but the concept matches → it should appear.
    const r = await queryGraphSemantic(graph, 'where do we handle errors', { embedder, nodeVectors });
    expect(r.matches.map((m) => m.node.name)).toContain('catchException');
  });

  it('cosine is 1 for identical vectors, 0 for orthogonal', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosine([1, 0, 0], [0, 1, 0])).toBe(0);
  });
});

describe('embedder loading', () => {
  it('returns null under --local (the only air-gapped switch — no download)', async () => {
    expect(await loadEmbedder({ local: true })).toBeNull();
  });

  it('loads the backend from VIBGRATE_EMBEDDER_PATH (host-supplied, wins over own deps)', async () => {
    // A fake `fastembed` in a host-owned dir — how the VS Code extension
    // supplies the native backend its bundled engine deliberately omits.
    const host = makeProject({
      'node_modules/fastembed/package.json': JSON.stringify({
        name: 'fastembed',
        version: '0.0.0-test',
        main: 'index.cjs',
      }),
      'node_modules/fastembed/index.cjs': [
        'module.exports = {',
        '  EmbeddingModel: {},',
        '  FlagEmbedding: {',
        '    init: async () => ({',
        '      embed: async function* () {},',
        '      queryEmbed: async () => [0.25, 0.75],',
        '    }),',
        '  },',
        '};',
      ].join('\n'),
    });
    const cacheHome = path.join(host, 'xdg-cache');
    const savedPath = process.env.VIBGRATE_EMBEDDER_PATH;
    const savedCache = process.env.XDG_CACHE_HOME;
    process.env.VIBGRATE_EMBEDDER_PATH = host;
    process.env.XDG_CACHE_HOME = cacheHome; // keep the ready-marker out of the real user cache
    try {
      const embedder = await loadEmbedder();
      expect(embedder).not.toBeNull();
      expect(embedder!.id).toBe(resolveEmbedModel());
      expect(await embedder!.embedQuery('q')).toEqual([0.25, 0.75]);
    } finally {
      if (savedPath === undefined) delete process.env.VIBGRATE_EMBEDDER_PATH;
      else process.env.VIBGRATE_EMBEDDER_PATH = savedPath;
      if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = savedCache;
      cleanup(host);
    }
  });
});

describe('embed model id + cache detection (drives the ask setup note)', () => {
  it('resolveEmbedModel defaults, and honors an explicit id', () => {
    expect(resolveEmbedModel()).toBe('bge-small-en-v1.5');
    expect(resolveEmbedModel('custom-model')).toBe('custom-model');
  });

  it('embeddingsCached is false until this repo has a vector cache, true after', () => {
    const dir = makeProject({});
    try {
      const model = resolveEmbedModel();
      expect(embeddingsCached(dir, model)).toBe(false);
      const cdir = path.join(dir, '.vibgrate', 'cache');
      fs.mkdirSync(cdir, { recursive: true });
      fs.writeFileSync(path.join(cdir, `embeddings-${model}.json`), '{}');
      expect(embeddingsCached(dir, model)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('nodeEmbedText adds doc summary + file-path + area context, dropping noise dirs', () => {
    const node = {
      qualifiedName: 'Table',
      kind: 'function',
      signature: 'function Table(',
      doc: 'Renders a sortable data table of rows',
      file: 'apps/web/src/components/Table.tsx',
    } as unknown as GraphNode;
    const t = nodeEmbedText(node, 'react');
    expect(t).toContain('Table');
    expect(t).toContain('Renders a sortable data table of rows'); // doc summary included
    expect(t).toContain('components'); // meaningful dir kept
    expect(t).toContain('react'); // area label included
    expect(t.split(/\s+/)).not.toContain('src'); // noise dir dropped
  });
});

// A counting stub embedder (no model, no network) to exercise the cache path.
function countingEmbedder(): Embedder & { calls: number } {
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

describe('getNodeEmbeddings — cached, resumable, progress', () => {
  it('embeds each target once, reports progress to 100%, and caches', async () => {
    const dir = makeProject(FILES);
    try {
      const g = (await buildGraph({ root: dir, generatedAt: '2020-01-01T00:00:00.000Z', inline: true })).graph;
      const targets = g.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'external').length;
      const emb = countingEmbedder();
      const seen: Array<[number, number]> = [];
      const vecs = await getNodeEmbeddings(g, emb, dir, (d, t) => seen.push([d, t]));
      expect(vecs.size).toBe(targets);
      expect(emb.calls).toBe(targets);
      expect(seen.at(-1)).toEqual([targets, targets]); // progress reached the total

      // Second run: cache hit → nothing re-embedded, no progress emitted.
      const emb2 = countingEmbedder();
      const seen2: Array<[number, number]> = [];
      await getNodeEmbeddings(g, emb2, dir, (d, t) => seen2.push([d, t]));
      expect(emb2.calls).toBe(0);
      expect(seen2).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it('resumes from a partial cache (only the missing entries are embedded)', async () => {
    const dir = makeProject(FILES);
    try {
      const g = (await buildGraph({ root: dir, generatedAt: '2020-01-01T00:00:00.000Z', inline: true })).graph;
      const targets = g.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'external').length;
      await getNodeEmbeddings(g, countingEmbedder(), dir); // full embed → cache written

      // Simulate an interrupted run: drop two cached entries.
      const file = path.join(dir, '.vibgrate', 'cache', `embeddings-${resolveEmbedModel('stub-emb')}.json`);
      const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
      const drop = Object.keys(cache.entries).slice(0, 2);
      for (const id of drop) delete cache.entries[id];
      fs.writeFileSync(file, JSON.stringify(cache));

      const emb = countingEmbedder();
      const vecs = await getNodeEmbeddings(g, emb, dir);
      expect(emb.calls).toBe(drop.length); // only the dropped ones re-embedded
      expect(vecs.size).toBe(targets); // full set still returned
    } finally {
      cleanup(dir);
    }
  });
});

describe('withTimeout (embedder init ceiling)', () => {
  it('resolves when the promise settles in time', async () => {
    const { withTimeout } = await import('../src/engine/embeddings.js');
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'late')).resolves.toBe('ok');
  });

  it('rejects with the given message when the promise hangs', async () => {
    const { withTimeout } = await import('../src/engine/embeddings.js');
    const never = new Promise(() => undefined);
    await expect(withTimeout(never, 10, 'embedding model init timed out')).rejects.toThrow(
      'embedding model init timed out',
    );
  });
});
