import { describe, it, expect } from 'vitest';
import { bridgePinnedFacts } from './bridge-facts.js';
import type { BridgeEdge } from './bridge-edges.js';

function edge(over: Partial<BridgeEdge> & Pick<BridgeEdge, 'fromRoot' | 'toRoot' | 'kind' | 'confidence'>): BridgeEdge {
  return {
    schemaVersion: 'bridge-edge/0',
    fromRepositoryId: 'a',
    toRepositoryId: 'b',
    evidence: 'test',
    ...over,
  };
}

describe('bridgePinnedFacts', () => {
  it('keeps only high-confidence bridges by default', () => {
    const facts = bridgePinnedFacts([
      edge({
        fromRoot: '/mono/packages/a',
        toRoot: '/mono/packages/b',
        kind: 'workspace-package',
        confidence: 0.95,
        packageName: '@m/b',
      }),
      edge({
        fromRoot: '/mono/api',
        toRoot: '/mono/shared',
        kind: 'openapi-ref',
        confidence: 0.7,
      }),
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatch(/workspace-package/);
    expect(facts[0]).toMatch(/@m\/b/);
    expect(facts[0]).not.toMatch(/openapi/);
  });

  it('is deterministic and empty-safe', () => {
    expect(bridgePinnedFacts(null)).toEqual([]);
    expect(bridgePinnedFacts([])).toEqual([]);
    const edges = [
      edge({ fromRoot: '/z', toRoot: '/a', kind: 'path-dependency', confidence: 0.9 }),
      edge({ fromRoot: '/a', toRoot: '/b', kind: 'workspace-package', confidence: 0.95 }),
    ];
    expect(bridgePinnedFacts(edges)).toEqual(bridgePinnedFacts(edges));
  });
});
