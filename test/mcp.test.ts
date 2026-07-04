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

  it('query_graph is concise by default: ranked matches + summary, no context block', async () => {
    // `local: true` keeps the server air-gapped (no model download) → the
    // deterministic lexical floor, independent of any machine-cached model.
    const r = (await tool('query_graph').handler(graph, { question: 'order' }, { root: dir, local: true })) as {
      context?: string;
      summary: string;
      matches: unknown[];
      mode: string;
    };
    expect(r.context).toBeUndefined();
    expect(r.summary).toContain('match');
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches.length).toBeLessThanOrEqual(5);
    expect(r.mode).toBe('lexical');
  });

  it('query_graph detailed mode adds the fact-annotated context block', async () => {
    const r = (await tool('query_graph').handler(
      graph,
      { question: 'order', response_format: 'detailed' },
      { root: dir, local: true },
    )) as { context: string; mode: string };
    expect(r.context).toContain('Context for');
    expect(r.mode).toBe('lexical');
  });

  it('query_graph returns a structured pivot instead of an empty result', async () => {
    const r = (await tool('query_graph').handler(graph, { question: 'zzzz qqqq xyzzy' }, { root: dir, local: true })) as {
      matches: unknown[];
      hint?: string;
    };
    if (r.matches.length === 0) expect(r.hint).toContain('search_symbols');
  });

  it('search_symbols finds symbols first and falls through to literal text', async () => {
    const bySymbol = tool('search_symbols').handler(graph, { query: 'double' }, { root: dir, local: true }) as {
      matches: { kind: string; name?: string; file: string; line: number }[];
    };
    expect(bySymbol.matches.length).toBeGreaterThan(0);
    expect(bySymbol.matches[0].kind).not.toBe('text');

    const byText = tool('search_symbols').handler(graph, { query: 'zz-no-symbol-has-this' }, { root: dir, local: true }) as {
      matches: unknown[];
      hint?: string;
    };
    expect(byText.matches.length).toBe(0);
    expect(byText.hint).toContain('query_graph');
  });

  it('get_node resolves and reports relations', () => {
    const r = tool('get_node').handler(graph, { name: 'OrderService.addItem' }) as { calls: string[] };
    expect(r.calls).toContain('double');
  });

  it('impact_of is decision-shaped by default and lists rows only in detailed mode', () => {
    const concise = tool('impact_of').handler(graph, { name: 'double' }) as {
      directCallers: number;
      riskLevel: string;
      summary: string;
      affected?: unknown[];
    };
    expect(concise.directCallers).toBeGreaterThan(0);
    expect(['low', 'medium', 'high']).toContain(concise.riskLevel);
    expect(concise.summary).toContain('direct dependent');
    expect(concise.affected).toBeUndefined();

    const detailed = tool('impact_of').handler(graph, { name: 'double', response_format: 'detailed' }) as {
      affected: unknown[];
    };
    expect(detailed.affected.length).toBeGreaterThan(0);
  });

  it('get_node reports not_found for nonsense', () => {
    const r = tool('get_node').handler(graph, { name: 'zzznope' }) as { error?: string };
    expect(r.error).toBe('not_found');
  });
});
