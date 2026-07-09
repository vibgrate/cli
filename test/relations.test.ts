import { describe, it, expect } from 'vitest';
import { GraphIndex, indexFor } from '../src/engine/relations.js';
import type { GraphEdge, GraphNode, VgGraph } from '../src/schema.js';

/** Minimal graph: a → b, a → c (call edges). GraphIndex only reads nodes+edges. */
function tinyGraph(): VgGraph {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as unknown as GraphNode[];
  const edges = [
    { id: 'e1', kind: 'call', src: 'a', dst: 'b' },
    { id: 'e2', kind: 'call', src: 'a', dst: 'c' },
  ] as unknown as GraphEdge[];
  return { nodes, edges } as unknown as VgGraph;
}

describe('indexFor (GraphIndex memoization)', () => {
  it('returns the same instance for the same graph object', () => {
    const g = tinyGraph();
    expect(indexFor(g)).toBe(indexFor(g));
  });

  it('returns a distinct instance for a different graph object', () => {
    // A rebuild hands back a NEW object (even if content-equal), so the cache
    // misses and the stale index is dropped — the invalidation contract.
    expect(indexFor(tinyGraph())).not.toBe(indexFor(tinyGraph()));
  });

  it('is behaviourally identical to a freshly-built GraphIndex', () => {
    const g = tinyGraph();
    const cached = indexFor(g);
    const fresh = new GraphIndex(g);
    const ids = (idx: GraphIndex) => idx.callees('a').map((x) => x.node.id).sort();
    expect(ids(cached)).toEqual(['b', 'c']);
    expect(ids(cached)).toEqual(ids(fresh));
  });
});
