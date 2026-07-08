import { describe, it, expect } from 'vitest';
import { classifyEpistemic, epistemicBreakdown, EPISTEMIC_TIERS } from './epistemic.js';
import type { GraphEdge, ResolverKind } from '../schema.js';

function edge(over: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: 'e',
    kind: 'call',
    src: 'a',
    dst: 'b',
    resolution: 'heuristic',
    confidence: 1,
    ...over,
  };
}

describe('classifyEpistemic', () => {
  it('marks any semantic-resolver edge as observed regardless of kind', () => {
    for (const resolution of ['scip', 'stackgraph', 'tsc'] as ResolverKind[]) {
      expect(classifyEpistemic(edge({ resolution, kind: 'call' }))).toBe('observed');
      // Even a heritage or reference edge is observed once a real resolver saw it.
      expect(classifyEpistemic(edge({ resolution, kind: 'extends' }))).toBe('observed');
    }
  });

  it('treats heuristic call/heritage/reference edges as name-matched (conjecture)', () => {
    expect(classifyEpistemic(edge({ resolution: 'heuristic', kind: 'call' }))).toBe('name-matched');
    expect(classifyEpistemic(edge({ resolution: 'heuristic', kind: 'extends' }))).toBe('name-matched');
    expect(classifyEpistemic(edge({ resolution: 'heuristic', kind: 'implements' }))).toBe('name-matched');
    expect(classifyEpistemic(edge({ resolution: 'heuristic', kind: 'references' }))).toBe('name-matched');
  });

  it('confidence does not upgrade the tier — a high-confidence heuristic call is still name-matched', () => {
    expect(classifyEpistemic(edge({ resolution: 'heuristic', kind: 'call', confidence: 0.85 }))).toBe(
      'name-matched',
    );
  });

  it('reads containment straight off the parse tree as observed', () => {
    expect(classifyEpistemic(edge({ resolution: 'heuristic', kind: 'contains' }))).toBe('observed');
  });

  it('classifies imports by whether the destination is in the corpus', () => {
    // Resolved to a real file node → observed.
    expect(classifyEpistemic(edge({ kind: 'import' }), 'file')).toBe('observed');
    expect(classifyEpistemic(edge({ kind: 'import' }), 'module')).toBe('observed');
    // External package (or unknown destination) → only declared.
    expect(classifyEpistemic(edge({ kind: 'import' }), 'external')).toBe('declared');
    expect(classifyEpistemic(edge({ kind: 'import' }))).toBe('declared');
  });

  it('marks test/coverage linkage as declared', () => {
    expect(classifyEpistemic(edge({ kind: 'test' }))).toBe('declared');
    expect(classifyEpistemic(edge({ kind: 'coverage' }))).toBe('declared');
  });

  it('only ever returns a known tier', () => {
    const tiers = new Set(EPISTEMIC_TIERS);
    for (const kind of ['call', 'import', 'contains', 'extends', 'test', 'coverage'] as const) {
      expect(tiers.has(classifyEpistemic(edge({ kind })))).toBe(true);
    }
  });
});

describe('epistemicBreakdown', () => {
  it('counts edges by tier deterministically', () => {
    const edges: GraphEdge[] = [
      edge({ id: '1', epistemic: 'observed' }),
      edge({ id: '2', epistemic: 'observed' }),
      edge({ id: '3', epistemic: 'name-matched' }),
      edge({ id: '4', epistemic: 'declared' }),
      edge({ id: '5' }), // no tier set → ignored
    ];
    expect(epistemicBreakdown(edges)).toEqual({ observed: 2, 'name-matched': 1, declared: 1 });
    // Stable key order for deterministic serialization.
    expect(Object.keys(epistemicBreakdown(edges))).toEqual(['observed', 'name-matched', 'declared']);
  });
});
