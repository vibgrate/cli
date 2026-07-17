import { describe, expect, it } from 'vitest';
import { toCycloneDx, toSpdx, formatDeltaText } from './sbom.js';
import type { ScanArtifact } from '../types.js';

function makeArtifact(version: string, driftScore: number): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'repo',
    drift: {
      score: driftScore,
      riskLevel: 'moderate',
      components: { runtimeScore: 70, frameworkScore: 70, dependencyScore: 70, eolScore: 70 },
    },
    findings: [],
    projects: [
      {
        type: 'node',
        path: '.',
        name: 'app',
        frameworks: [],
        dependencies: [
          {
            package: 'chalk',
            section: 'dependencies',
            currentSpec: version,
            resolvedVersion: version,
            latestStable: '5.3.0',
            majorsBehind: 0,
            drift: 'current',
          },
        ],
        dependencyAgeBuckets: { current: 1, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
      },
    ],
  };
}

describe('sbom helpers', () => {
  it('exports CycloneDX with components', () => {
    const sbom = toCycloneDx(makeArtifact('5.3.0', 90)) as { bomFormat: string; components: Array<{ name: string }> };
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(sbom.components[0].name).toBe('chalk');
  });

  it('exports SPDX with package entries', () => {
    const sbom = toSpdx(makeArtifact('5.3.0', 90)) as { spdxVersion: string; packages: Array<{ name: string }> };
    expect(sbom.spdxVersion).toBe('SPDX-2.3');
    expect(sbom.packages[0].name).toBe('chalk');
  });

  it('produces a deterministic serialNumber for identical content', () => {
    const a = toCycloneDx(makeArtifact('5.3.0', 90)) as { serialNumber: string };
    const b = toCycloneDx(makeArtifact('5.3.0', 90)) as { serialNumber: string };
    expect(a.serialNumber).toBe(b.serialNumber);
    expect(a.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Different dependency version ⇒ different id.
    const c = toCycloneDx(makeArtifact('5.2.0', 90)) as { serialNumber: string };
    expect(c.serialNumber).not.toBe(a.serialNumber);
  });

  it('formats dependency deltas', () => {
    const base = makeArtifact('5.2.0', 80);
    const current = makeArtifact('5.3.0', 76);
    const text = formatDeltaText(base, current);
    expect(text).toContain('DriftScore delta: -4.00 points');
    expect(text).toContain('Changed dependencies (1)');
  });
});
