import { describe, it, expect } from 'vitest';
import { dedupePlans } from './dedupe.js';
import type { PlannedUpgrade, UpgradePlan, VulnDelta } from './types.js';

function emptyDelta(): VulnDelta {
  return { total: 0, bySeverity: { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 } };
}

function upgrade(pkg: string, from: string, to: string): PlannedUpgrade {
  return { package: pkg, ecosystem: 'npm', from, to, kind: 'minor', blastRadius: 'low', fixes: emptyDelta(), reason: 'minor update' };
}

function plan(tier: UpgradePlan['tier'], upgrades: PlannedUpgrade[]): UpgradePlan {
  return { tier, label: tier, description: '', upgrades, excluded: [], riskScore: 3, confidence: 'high', fixes: emptyDelta(), introduces: emptyDelta() };
}

describe('dedupePlans', () => {
  it('keeps only the lowest-risk tier when all plans carry the identical upgrade set', () => {
    const same = [upgrade('wrangler', '4.111.0', '4.112.0')];
    const { plans, canonicalTier } = dedupePlans([plan('safe', same), plan('balanced', same), plan('aggressive', same)]);
    expect(plans.map((p) => p.tier)).toEqual(['safe']);
    expect(canonicalTier.get('balanced')).toBe('safe');
    expect(canonicalTier.get('aggressive')).toBe('safe');
    expect(canonicalTier.get('safe')).toBe('safe');
  });

  it('collapses onto the lowest duplicated tier, not always safe', () => {
    const majors = [upgrade('react', '17.0.2', '18.3.1')];
    const { plans, canonicalTier } = dedupePlans([plan('safe', []), plan('balanced', majors), plan('aggressive', majors)]);
    expect(plans.map((p) => p.tier)).toEqual(['safe', 'balanced']);
    expect(canonicalTier.get('aggressive')).toBe('balanced');
  });

  it('keeps all plans when the upgrade sets differ', () => {
    const input = [
      plan('safe', [upgrade('lodash', '4.17.20', '4.17.21')]),
      plan('balanced', [upgrade('lodash', '4.17.20', '4.17.21'), upgrade('react', '17.0.2', '18.3.1')]),
      plan('aggressive', [upgrade('react', '17.0.2', '19.0.0')]),
    ];
    const { plans } = dedupePlans(input);
    expect(plans.map((p) => p.tier)).toEqual(['safe', 'balanced', 'aggressive']);
  });

  it('treats upgrade sets as equal regardless of ordering', () => {
    const a = [upgrade('a', '1.0.0', '1.1.0'), upgrade('b', '2.0.0', '2.1.0')];
    const b = [upgrade('b', '2.0.0', '2.1.0'), upgrade('a', '1.0.0', '1.1.0')];
    const { plans } = dedupePlans([plan('safe', a), plan('balanced', b)]);
    expect(plans.map((p) => p.tier)).toEqual(['safe']);
  });

  it('distinguishes sets that differ only in target version', () => {
    const { plans } = dedupePlans([
      plan('safe', [upgrade('react', '17.0.2', '17.0.3')]),
      plan('balanced', [upgrade('react', '17.0.2', '18.3.1')]),
    ]);
    expect(plans.map((p) => p.tier)).toEqual(['safe', 'balanced']);
  });
});
