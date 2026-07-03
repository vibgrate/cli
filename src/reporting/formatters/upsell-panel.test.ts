// Owned by the public CLI. Exercises the free-plan "Keep tracking your
// DriftScore" upsell panel rendered by the vendored core-open formatText for
// users without a workspace DSN. Lives here (not under src/core-open, which the
// vendor script wipes on every sync) so it survives re-vendoring.
import { describe, it, expect } from 'vitest';
import { formatText } from '../../core-open/formatters/text.js';
import type { ScanArtifact, BillingSummary } from '../../core-open/types.js';

function makeArtifact(overrides: Partial<ScanArtifact> = {}): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-16T00:00:00.000Z',
    vibgrateVersion: '0.1.0',
    rootPath: '/test',
    projects: [],
    drift: {
      score: 42,
      riskLevel: 'moderate',
      components: { runtimeScore: 40, frameworkScore: 40, dependencyScore: 40, eolScore: 40 },
    },
    findings: [],
    ...overrides,
  };
}

/** A billing roll-up with the given per-size counts and canonical ratios. */
function makeBilling(
  counts: { nano?: number; micro?: number; small?: number; standard?: number },
): BillingSummary {
  const nanoCount = counts.nano ?? 0;
  const microCount = counts.micro ?? 0;
  const smallCount = counts.small ?? 0;
  const standardCount = counts.standard ?? 0;
  const raw = standardCount + smallCount / 3 + microCount / 10 + nanoCount / 25;
  return {
    nanoCount,
    microCount,
    smallCount,
    standardCount,
    totalScanned: nanoCount + microCount + smallCount + standardCount,
    nanoBillingRatio: 25,
    microBillingRatio: 10,
    smallBillingRatio: 3,
    billableProjectsRaw: Math.round(raw * 100) / 100,
    billableProjects: Math.floor(raw),
  };
}

describe('free-plan upsell panel', () => {
  it('shows Team/Business monthly costs and the login→push flow when free', () => {
    // 3 standard → 3 billable, first band: Team 3×$6=$18, Business 3×$15=$45.
    const text = formatText(makeArtifact({ billing: makeBilling({ standard: 3 }) }), { free: true });
    expect(text).toContain('KEEP TRACKING YOUR DRIFTSCORE');
    expect(text).toContain('Team');
    expect(text).toContain('$18 / mo');
    expect(text).toContain('Business');
    expect(text).toContain('$45 / mo');
    expect(text).toContain('DriftScore tracked over time');
    expect(text).toContain('Scheduled scans');
    expect(text).toContain('5 pushed scans / month');
    expect(text).toContain('vg login');
    expect(text).toContain('vg push');
  });

  it('prices a fractional single-repo estate to the cent', () => {
    // 2 micro → 0.2 billable: Team 0.2×$6=$1.20, Business 0.2×$15=$3.
    const text = formatText(makeArtifact({ billing: makeBilling({ micro: 2 }) }), { free: true });
    expect(text).toContain('$1.20 / mo');
    expect(text).toContain('$3 / mo');
    expect(text).toContain('0.2 billable projects');
  });

  it('omits the panel when the user is authenticated (has DSN)', () => {
    const text = formatText(makeArtifact({ billing: makeBilling({ standard: 3 }) }), { free: false });
    expect(text).not.toContain('KEEP TRACKING YOUR DRIFTSCORE');
  });

  it('does not surface the panel by default (no options passed)', () => {
    const text = formatText(makeArtifact({ billing: makeBilling({ standard: 3 }) }));
    expect(text).not.toContain('KEEP TRACKING YOUR DRIFTSCORE');
  });

  it('omits the panel when there is no billing roll-up even if free', () => {
    const text = formatText(makeArtifact(), { free: true });
    expect(text).not.toContain('KEEP TRACKING YOUR DRIFTSCORE');
  });
});
