import { describe, it, expect } from 'vitest';
import {
  createVgBuiltinMcpTools,
  mergeExternalToolsets,
  vgMcpToolNames,
  VG_MCP_SERVER_ID,
} from './vg-mcp-bridge.js';
import { fixtureGraph } from './graph-fixture.js';

describe('createVgBuiltinMcpTools', () => {
  it('exposes namespaced vg serve tools', () => {
    const set = createVgBuiltinMcpTools({ getGraph: () => fixtureGraph(), root: '/repo' });
    const names = set.specs.map((s) => s.name);
    expect(names).toContain(`mcp__${VG_MCP_SERVER_ID}__search_symbols`);
    expect(names).toContain(`mcp__${VG_MCP_SERVER_ID}__query_graph`);
    expect(names).toContain(`mcp__${VG_MCP_SERVER_ID}__orient`);
    expect(vgMcpToolNames().every((n) => set.owns(n))).toBe(true);
  });

  it('runs search_symbols in-process over the graph + root', async () => {
    const set = createVgBuiltinMcpTools({ getGraph: () => fixtureGraph(), root: '/repo' });
    const r = await set.execute({
      id: '1',
      name: `mcp__${VG_MCP_SERVER_ID}__search_symbols`,
      arguments: { query: 'scanDir', limit: 5 },
    });
    expect(r.mutated).toBe(false);
    expect(r.content).toMatch(/scanDir/);
  });

  it('uses live graph from execute() when provided', async () => {
    const g = fixtureGraph();
    const set = createVgBuiltinMcpTools({ getGraph: () => g, root: '/repo' });
    const r = await set.execute(
      {
        id: '1',
        name: `mcp__${VG_MCP_SERVER_ID}__get_node`,
        arguments: { name: 'scanDir' },
      },
      { graph: g },
    );
    expect(r.content).toMatch(/scanDir|function|file/i);
  });
});

describe('mergeExternalToolsets', () => {
  it('always keeps vibgrate tools when merged with an empty project set', () => {
    const vg = createVgBuiltinMcpTools({ getGraph: () => fixtureGraph(), root: '/repo' });
    const merged = mergeExternalToolsets(vg, undefined);
    expect(merged?.specs.some((s) => s.name.startsWith('mcp__vibgrate__'))).toBe(true);
  });

  it('prefers later sets on name clash', async () => {
    const a = {
      specs: [{ name: 'mcp__x__t', description: 'a', parameters: {} }],
      owns: (n: string) => n === 'mcp__x__t',
      execute: async () => ({ content: 'from-a', mutated: false }),
    };
    const b = {
      specs: [{ name: 'mcp__x__t', description: 'b', parameters: {} }],
      owns: (n: string) => n === 'mcp__x__t',
      execute: async () => ({ content: 'from-b', mutated: false }),
    };
    const m = mergeExternalToolsets(a, b)!;
    expect((await m.execute({ id: '1', name: 'mcp__x__t', arguments: {} })).content).toBe('from-b');
  });
});
