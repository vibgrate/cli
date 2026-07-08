import { describe, it, expect } from 'vitest';
import { estimateDriftScore } from './expected-drift.js';
import type { ScanArtifact } from '../../core-open/index.js';

/** Build a minimal artifact with one node project's dependency age buckets. */
function artifact(buckets: { current: number; oneBehind: number; twoPlusBehind: number; unknown: number }, deps: Array<{ package: string; majorsBehind: number }>): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2024-01-01T00:00:00.000Z',
    vibgrateVersion: 'test',
    rootPath: '.',
    projects: [
      {
        type: 'node',
        path: '.',
        name: 'p',
        frameworks: [],
        dependencies: deps.map((d) => ({
          package: d.package,
          section: 'dependencies',
          currentSpec: '^1',
          resolvedVersion: '1.0.0',
          latestStable: '3.0.0',
          majorsBehind: d.majorsBehind,
          drift: 'major-behind',
        })),
        dependencyAgeBuckets: buckets,
      },
    ],
    drift: { score: 0, riskLevel: 'low', components: {} },
    findings: [],
  } as unknown as ScanArtifact;
}

describe('estimateDriftScore', () => {
  it('lowers the score as major-behind deps move to current', () => {
    const a = artifact(
      { current: 40, oneBehind: 8, twoPlusBehind: 12, unknown: 0 },
      [
        { package: 'a', majorsBehind: 2 },
        { package: 'b', majorsBehind: 1 },
      ],
    );
    const before = estimateDriftScore(a, new Set());
    const afterOne = estimateDriftScore(a, new Set(['b'])); // moves 1 out of oneBehind
    const afterAll = estimateDriftScore(a, new Set(['a', 'b']));
    expect(afterOne).toBeLessThanOrEqual(before);
    expect(afterAll).toBeLessThanOrEqual(afterOne);
  });

  it('does not mutate the input artifact', () => {
    const a = artifact({ current: 10, oneBehind: 5, twoPlusBehind: 5, unknown: 0 }, [{ package: 'a', majorsBehind: 2 }]);
    estimateDriftScore(a, new Set(['a']));
    expect(a.projects[0].dependencyAgeBuckets).toEqual({ current: 10, oneBehind: 5, twoPlusBehind: 5, unknown: 0 });
  });

  it('is deterministic', () => {
    const a = artifact({ current: 10, oneBehind: 5, twoPlusBehind: 5, unknown: 0 }, [{ package: 'a', majorsBehind: 2 }]);
    expect(estimateDriftScore(a, new Set(['a']))).toBe(estimateDriftScore(a, new Set(['a'])));
  });
});
