import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { TOOLS } from '../src/mcp/tools.js';
import { makeProject, cleanup, SAMPLE_FILES } from './helpers.js';
import type { VgGraph } from '../src/schema.js';

let graph: VgGraph;
let dir: string;
beforeAll(async () => {
  dir = makeProject(SAMPLE_FILES);
  graph = (await buildGraph({ root: dir, generatedAt: '2020-01-01T00:00:00.000Z', inline: true })).graph;
});
afterAll(() => cleanup(dir));

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

describe('MCP tools', () => {
  it('exposes the read-only tool set', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'get_graph_summary',
        'query_graph',
        'get_node',
        'find_path',
        'impact_of',
        'list_areas',
        'list_hubs',
      ]),
    );
  });

  it('get_graph_summary returns counts', () => {
    const r = tool('get_graph_summary').handler(graph, {}) as { counts: { nodes: number } };
    expect(r.counts.nodes).toBeGreaterThan(0);
  });

  it('query_graph returns a context block', async () => {
    // `local: true` keeps the server air-gapped (no model download) → the
    // deterministic lexical floor, independent of any machine-cached model.
    const r = (await tool('query_graph').handler(graph, { question: 'order' }, { root: dir, local: true })) as {
      context: string;
      mode: string;
    };
    expect(r.context).toContain('Context for');
    expect(r.mode).toBe('lexical');
  });

  it('get_node resolves and reports relations', () => {
    const r = tool('get_node').handler(graph, { name: 'OrderService.addItem' }) as { calls: string[] };
    expect(r.calls).toContain('double');
  });

  it('impact_of returns affected nodes', () => {
    const r = tool('impact_of').handler(graph, { name: 'double' }) as { affected: unknown[] };
    expect(r.affected.length).toBeGreaterThan(0);
  });

  it('get_node reports not_found for nonsense', () => {
    const r = tool('get_node').handler(graph, { name: 'zzznope' }) as { error?: string };
    expect(r.error).toBe('not_found');
  });
});
