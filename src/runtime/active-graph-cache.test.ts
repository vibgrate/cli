import { describe, it, expect } from 'vitest';
import { ActiveGraphCache } from './active-graph-cache.js';
import { SCHEMA_VERSION, type VgGraph } from '../schema.js';

function tinyGraph(label: string): VgGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '1970-01-01T00:00:00.000Z',
    provenance: { tool: 'vg', version: '0', grammars: {}, resolver: [], deep: false, corpusHash: label },
    meta: {
      root: '.',
      languages: ['ts'],
      counts: { nodes: 1, edges: 0, areas: 0, tests: 0, untested: 0 },
      cluster: 'none',
      edgeKinds: [],
    },
    nodes: [
      {
        id: label,
        name: label,
        qualifiedName: label,
        kind: 'file',
        file: `${label}.ts`,
        span: { start: 1, end: 1 },
        lang: 'ts',
        importance: 0,
        centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
        area: 0,
        isHub: false,
        tested: false,
      },
    ],
    edges: [],
  } as unknown as VgGraph;
}

describe('ActiveGraphCache', () => {
  it('holds multiple branches for one repository and selects current', () => {
    let t = 1000;
    const cache = new ActiveGraphCache({ now: () => t, idleTimeoutMs: 1000, maxPerRepo: 4, maxTotal: 10 });
    cache.put('repo1', 'main', tinyGraph('main'));
    t = 2000;
    cache.put('repo1', 'feature', tinyGraph('feature'));
    cache.select('repo1', 'feature');
    expect(cache.current('repo1')?.gitRef).toBe('feature');
    expect(cache.get('repo1', 'main')?.graph.provenance.corpusHash).toBe('main');
    expect(cache.size()).toBe(2);
  });

  it('evicts idle slots in LILO order (earliest loaded first) after timeout', () => {
    let t = 0;
    const cache = new ActiveGraphCache({ now: () => t, idleTimeoutMs: 100, maxPerRepo: 8, maxTotal: 16 });
    cache.put('r', 'A', tinyGraph('A'));
    t = 10;
    cache.put('r', 'B', tinyGraph('B'));
    t = 20;
    cache.put('r', 'C', tinyGraph('C'));
    cache.select('r', 'C');
    t = 200;
    const removed = cache.evictIdle();
    expect(removed.some((k) => k.includes('::A'))).toBe(true);
    expect(cache.get('r', 'C')).toBeDefined();
    expect(cache.get('r', 'A')).toBeUndefined();
  });

  it('never evicts the currently selected branch on overflow', () => {
    let t = 0;
    const cache = new ActiveGraphCache({ now: () => t, idleTimeoutMs: 1, maxPerRepo: 1, maxTotal: 1 });
    cache.put('r', 'keep', tinyGraph('keep'));
    cache.select('r', 'keep');
    t = 100;
    cache.put('r', 'other', tinyGraph('other'));
    cache.select('r', 'keep');
    cache.evictIfNeeded();
    expect(cache.current('r')?.gitRef).toBe('keep');
    expect(cache.get('r', 'keep')).toBeDefined();
  });

  it('evictRepository drops every slot for that repo and nothing else', () => {
    const cache = new ActiveGraphCache();
    cache.put('keep', 'main', tinyGraph('keep'));
    cache.put('gone', 'main', tinyGraph('gone-main'));
    cache.put('gone', 'feat', tinyGraph('gone-feat'));
    expect(cache.evictRepository('gone')).toHaveLength(2);
    expect(cache.get('gone', 'main')).toBeUndefined();
    expect(cache.get('keep', 'main')).toBeDefined();
    expect(cache.size()).toBe(1);
  });

  it('lists slots with evictable flags', () => {
    let t = 0;
    const cache = new ActiveGraphCache({ now: () => t, idleTimeoutMs: 50 });
    cache.put('r', 'main', tinyGraph('main'));
    cache.select('r', 'main');
    t = 100;
    cache.put('r', 'dev', tinyGraph('dev'));
    cache.select('r', 'dev');
    const list = cache.list('r');
    const main = list.find((s) => s.gitRef === 'main');
    const dev = list.find((s) => s.gitRef === 'dev');
    expect(main?.evictable).toBe(true);
    expect(dev?.current).toBe(true);
    expect(dev?.evictable).toBe(false);
  });

  it('evicts the oldest non-current slot when process RSS exceeds the budget', () => {
    let rss = 100;
    const cache = new ActiveGraphCache({
      idleTimeoutMs: 60_000,
      maxPerRepo: 8,
      maxTotal: 32,
      rssBudgetBytes: 150,
      rssUsedBytes: () => rss,
    });
    cache.put('old', 'main', tinyGraph('old'));
    cache.put('keep', 'main', tinyGraph('keep'));
    cache.select('keep', 'main');
    rss = 200;
    cache.put('keep', 'main', tinyGraph('keep-2'));
    expect(cache.get('old', 'main')).toBeUndefined();
    expect(cache.get('keep', 'main')).toBeDefined();
    expect(cache.size()).toBe(1);
  });
});
