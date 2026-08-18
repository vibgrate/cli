import { describe, it, expect } from 'vitest';
import { queryGraphSemantic } from './query.js';
import type { VgGraph } from '../schema.js';

/**
 * `semanticRanked` is how a caller hands the semantic half to vgd. It must
 * behave like the in-process pass it replaces — same fusion, same tolerance
 * for a graph that has moved on since the daemon indexed it.
 */

function graph(): VgGraph {
  return {
    nodes: [
      { id: 'n1', name: 'chargeCard', qualifiedName: 'billing.chargeCard', kind: 'function', file: 'src/billing.ts', span: { start: 1, end: 3 }, importance: 0.5, area: 'a1' },
      { id: 'n2', name: 'refund', qualifiedName: 'billing.refund', kind: 'function', file: 'src/billing.ts', span: { start: 5, end: 7 }, importance: 0.4, area: 'a1' },
      { id: 'n3', name: 'renderChart', qualifiedName: 'ui.renderChart', kind: 'function', file: 'src/ui.ts', span: { start: 1, end: 4 }, importance: 0.3, area: 'a2' },
    ],
    edges: [],
    areas: [
      { id: 'a1', label: 'billing' },
      { id: 'a2', label: 'ui' },
    ],
    meta: { root: '.', counts: { nodes: 3, edges: 0, areas: 2 }, languages: ['ts'] },
  } as unknown as VgGraph;
}

describe('queryGraphSemantic with a pre-computed ranking', () => {
  it('never loads an embedder when the ranking is supplied', async () => {
    let embedded = 0;
    const result = await queryGraphSemantic(graph(), 'money movement', {
      budget: 500,
      semanticRanked: [{ id: 'n2', score: 0.9 }],
      embedder: {
        id: 'must-not-be-used',
        embed: () => Promise.reject(new Error('should not embed')),
        embedQuery: () => {
          embedded++;
          return Promise.reject(new Error('should not embed'));
        },
      },
    });

    expect(embedded).toBe(0);
    expect(result.matches.some((m) => m.node.id === 'n2')).toBe(true);
  });

  it('lets the supplied ranking surface a node with no shared identifier', async () => {
    const result = await queryGraphSemantic(graph(), 'money movement', {
      budget: 500,
      semanticRanked: [{ id: 'n2', score: 0.95 }],
    });

    // "money movement" shares no token with `refund`; only the ranking puts it in.
    expect(result.matches[0]?.node.id).toBe('n2');
  });

  it('ignores ids the local map no longer has, so a stale daemon index is harmless', async () => {
    const result = await queryGraphSemantic(graph(), 'money movement', {
      budget: 500,
      semanticRanked: [
        { id: 'deleted-node', score: 0.99 },
        { id: 'n2', score: 0.8 },
      ],
    });

    expect(result.matches.map((m) => m.node.id)).not.toContain('deleted-node');
    expect(result.matches[0]?.node.id).toBe('n2');
  });

  it('drops non-positive scores rather than ranking them', async () => {
    const result = await queryGraphSemantic(graph(), 'money movement', {
      budget: 500,
      semanticRanked: [
        { id: 'n3', score: 0 },
        { id: 'n2', score: 0.7 },
      ],
    });

    expect(result.matches[0]?.node.id).toBe('n2');
    expect(result.matches.some((m) => m.node.id === 'n3')).toBe(false);
  });

  it('still fuses lexical evidence — an exact name beats a weak semantic hit', async () => {
    const result = await queryGraphSemantic(graph(), 'chargeCard', {
      budget: 500,
      semanticRanked: [{ id: 'n3', score: 0.2 }],
    });

    expect(result.matches[0]?.node.id).toBe('n1');
  });
});
