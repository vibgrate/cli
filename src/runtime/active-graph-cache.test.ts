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
    // Load A then B then C; select C as current.
    cache.put('r', 'A', tinyGraph('A')); // loadedAt 0
    t = 10;
    cache.put('r', 'B', tinyGraph('B')); // loadedAt 10
    t = 20;
    cache.put('r', 'C', tinyGraph('C')); // loadedAt 20
    cache.select('r', 'C');
    // Advance past idle timeout without touching A/B.
    t = 200;
    const removed = cache.evictIdle();
    // A was loaded first among idle → LILO reclaims A then B; C stays (current).
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
    // maxPerRepo=1: other may stay if selected switches, but keep should survive if still selected
    cache.select('r', 'keep');
    cache.evictIfNeeded();
    expect(cache.current('r')?.gitRef).toBe('keep');
    expect(cache.get('r', 'keep')).toBeDefined();
  });

  it('lists slots with evictable flags', () => {
    let t = 0;
    const cache = new ActiveGraphCache({ now: () => t, idleTimeoutMs: 50 });
    cache.put('r', 'main', tinyGraph('main'));
    cache.select('r', 'main');
    t = 100;
    cache.put('r', 'dev', tinyGraph('dev'));
    cache.select('r', 'dev');
    // main last access at t=0 → idle 100 >= 50 and not current → evictable
    const list = cache.list('r');
    const main = list.find((s) => s.gitRef === 'main');
    const dev = list.find((s) => s.gitRef === 'dev');
    expect(main?.evictable).toBe(true);
    expect(dev?.current).toBe(true);
    expect(dev?.evictable).toBe(false);
  });
});
