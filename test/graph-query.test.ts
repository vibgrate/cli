import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { runGraphQuery } from '../src/lsp/graph-query.js';
import { makeProject, cleanup, SAMPLE_FILES } from './helpers.js';
import type { VgGraph } from '../src/schema.js';

/**
 * `vibgrate/graph/query` must return the same facts the CLI commands do —
 * it calls the exact same engine functions, just wrapped in a typed result
 * instead of throwing on a lookup miss (this is a long-lived server, not a
 * one-shot process).
 */

let graph: VgGraph;
let dir: string;
const ctx = { root: '', offline: true };

beforeAll(async () => {
  dir = makeProject(SAMPLE_FILES);
  ctx.root = dir;
  graph = (await buildGraph({ root: dir, generatedAt: '2020-01-01T00:00:00.000Z', inline: true })).graph;
});
afterAll(() => cleanup(dir));

describe('runGraphQuery — ask', () => {
  it('returns lexical matches by default', async () => {
    const result = await runGraphQuery(graph, { mode: 'ask', question: 'double' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { matches: { name: string }[]; mode: string };
    expect(data.mode).toBe('lexical');
    expect(data.matches.some((m) => m.name.toLowerCase().includes('double'))).toBe(true);
  });

  it('rejects an empty question', async () => {
    const result = await runGraphQuery(graph, { mode: 'ask', question: '  ' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('bad-request');
  });
});

describe('runGraphQuery — areas / hubs', () => {
  it('areas returns an array', async () => {
    const result = await runGraphQuery(graph, { mode: 'areas' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('hubs returns node summaries sorted by importance', async () => {
    const result = await runGraphQuery(graph, { mode: 'hubs' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const list = result.data as { importance: number }[];
    expect(Array.isArray(list)).toBe(true);
    for (let i = 1; i < list.length; i++) expect(list[i - 1].importance).toBeGreaterThanOrEqual(list[i].importance);
  });
});

describe('runGraphQuery — impact', () => {
  it('finds what depends on a symbol', async () => {
    const result = await runGraphQuery(graph, { mode: 'impact', name: 'add' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { affected: { name: string }[] };
    expect(data.affected.some((a) => a.name.toLowerCase().includes('double'))).toBe(true);
  });

  it('returns not-found for an unknown symbol', async () => {
    const result = await runGraphQuery(graph, { mode: 'impact', name: 'zzzznotathing' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('not-found');
  });
});

describe('runGraphQuery — path / show / tree', () => {
  it('path finds a connection between two symbols', async () => {
    const result = await runGraphQuery(graph, { mode: 'path', a: 'add', b: 'double' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { path: string[] };
    expect(data.path.length).toBeGreaterThan(1);
  });

  it('show describes a node and its neighbours', async () => {
    const result = await runGraphQuery(graph, { mode: 'show', name: 'double' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { calls: string[] };
    expect(data.calls.some((c) => c.toLowerCase().includes('add'))).toBe(true);
  });

  it('tree walks the call tree rooted at a node', async () => {
    const result = await runGraphQuery(graph, { mode: 'tree', name: 'add', callers: true }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { name: string; children?: unknown[] };
    expect(data.name.toLowerCase()).toContain('add');
  });
});
