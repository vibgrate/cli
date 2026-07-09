import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { TOOLS } from '../src/mcp/tools.js';
import { recordUsage } from '../src/mcp/server.js';
import { readSavings, readUsage } from '../src/engine/savings.js';
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

describe('savings recording (vg serve --savings)', () => {
  let root: string;
  beforeAll(() => {
    root = makeProject(SAMPLE_FILES);
  });
  afterAll(() => cleanup(root));

  it('records a concise query_graph call — the default mode, which used to record nothing', async () => {
    // Regression: recording keyed off `tokensEstimate`, which concise mode never
    // set, so the ledger stayed empty and `vg savings` always read "off".
    const result = await tool('query_graph').handler(graph, { question: 'order' }, { root, local: true });
    expect((result as { tokensEstimate?: number }).tokensEstimate).toBeUndefined(); // concise: no estimate field
    recordUsage(root, 'query_graph', result);

    const report = readSavings(root, 30, Date.now());
    expect(report.enabled).toBe(true);
    expect(report.queries).toBe(1);
    expect(report.vgTokens).toBeGreaterThan(0);
    expect(report.baselineTokens).toBeGreaterThan(0);
  });

  it('records a get_node call, which never carried a tokensEstimate at all', () => {
    const before = readSavings(root, 30, Date.now()).queries;
    const result = tool('get_node').handler(graph, { name: 'OrderService.addItem' });
    recordUsage(root, 'get_node', result);

    const report = readSavings(root, 30, Date.now());
    expect(report.queries).toBe(before + 1);
    expect(report.vgTokens).toBeGreaterThan(0);
    // Baseline counts the node's own file plus the files of the edges it returned.
    expect(report.baselineTokens).toBeGreaterThan(0);
  });
});

describe('usage breakdown (vg savings per-command)', () => {
  let root: string;
  beforeAll(() => {
    root = makeProject(SAMPLE_FILES);
  });
  afterAll(() => cleanup(root));

  it('records every tool with its outcome, and non-savings tools stay out of the token figures', async () => {
    // A hit, a miss, and a non-savings tool — the breakdown covers all three.
    recordUsage(root, 'query_graph', await tool('query_graph').handler(graph, { question: 'order' }, { root, local: true }));
    recordUsage(root, 'query_graph', await tool('query_graph').handler(graph, { question: 'zzzz qqqq xyzzy' }, { root, local: true }));
    recordUsage(root, 'get_node', tool('get_node').handler(graph, { name: 'zzznope' })); // not_found → miss
    recordUsage(root, 'list_hubs', tool('list_hubs').handler(graph, {}));

    const usage = readUsage(root, 30, Date.now());
    expect(usage.totals.calls).toBe(4);
    const byTool = Object.fromEntries(usage.commands.map((cmd) => [cmd.tool, cmd]));

    expect(byTool.query_graph.calls).toBe(2);
    expect(byTool.query_graph.miss).toBe(1); // the no-match pivot
    expect(byTool.get_node.miss).toBe(1); // not_found
    expect(byTool.list_hubs.calls).toBe(1);
    expect(byTool.list_hubs.miss).toBe(0); // SAMPLE_FILES has hubs

    // Success% is (complete+partial)/calls; avg weights each command equally.
    for (const cmd of usage.commands) {
      expect(cmd.successPct).toBe(Math.round(((cmd.complete + cmd.partial) / cmd.calls) * 100));
    }
    expect(usage.avgSuccessPct).toBe(
      Math.round(usage.commands.reduce((s, cmd) => s + cmd.successPct, 0) / usage.commands.length),
    );

    // list_hubs is not a grep-baseline tool, so it never inflates the token savings.
    const report = readSavings(root, 30, Date.now());
    expect(report.queries).toBe(3); // 2 query_graph + 1 get_node, not list_hubs
  });

  it('attributes MCP calls to source "mcp" and the detected client', async () => {
    const r2 = makeProject(SAMPLE_FILES);
    try {
      recordUsage(r2, 'query_graph', await tool('query_graph').handler(graph, { question: 'order' }, { root: r2, local: true }), 'Claude Code');
      const usage = readUsage(r2, 30, Date.now());
      expect(usage.sources.find((s) => s.key === 'mcp')?.calls).toBe(1);
      expect(usage.sources.find((s) => s.key === 'cli')).toBeUndefined();
      expect(usage.clients.find((c) => c.key === 'claude-code')?.calls).toBe(1); // sanitized
    } finally {
      cleanup(r2);
    }
  });
});
