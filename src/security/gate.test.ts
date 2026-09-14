import { describe, it, expect } from 'vitest';
import { evaluateSecurityGate, lowestThreshold, parseFailOn, severityRank } from './gate.js';
import type { SecurityFinding, SecuritySection } from './types.js';

describe('parseFailOn', () => {
  it.each([
    [undefined, { security: [] }],
    ['warn', { legacy: 'warn', security: [] }],
    ['error', { legacy: 'error', security: [] }],
    ['architecture-finding', { legacy: 'architecture-finding', security: [] }],
    ['architecture-warning', { legacy: 'architecture-warning', security: [] }],
    ['iac-finding', { security: [{ cls: 'iac', minSeverity: 'high' }] }],
    ['iac-finding=medium', { security: [{ cls: 'iac', minSeverity: 'medium' }] }],
    ['iac-finding=critical', { security: [{ cls: 'iac', minSeverity: 'critical' }] }],
    ['security-finding', { security: [{ cls: 'security', minSeverity: 'high' }] }],
    ['security-finding=info', { security: [{ cls: 'security', minSeverity: 'info' }] }],
    ['error,iac-finding', { legacy: 'error', security: [{ cls: 'iac', minSeverity: 'high' }] }],
    [' iac-finding , warn ', { legacy: 'warn', security: [{ cls: 'iac', minSeverity: 'high' }] }],
    [
      'iac-finding=low,security-finding',
      { security: [{ cls: 'iac', minSeverity: 'low' }, { cls: 'security', minSeverity: 'high' }] },
    ],
  ])('%s', (raw, expected) => {
    expect(parseFailOn(raw)).toEqual(expected);
  });

  it.each([
    ['warn,error', /only one of/],
    ['error,error', /only one of/],
    ['bogus', /unknown --fail-on value "bogus"/],
    ['iac-finding=bogus', /severity must be one of critical, high, medium, low, info/],
    ['iac-finding=', /severity must be one of/],
    ['', /needs a value/],
    [',', /needs a value/],
    ['iac-findings', /unknown --fail-on value "iac-findings"/],
  ])('rejects %s', (raw, message) => {
    const parsed = parseFailOn(raw);
    expect(parsed.invalid).toMatch(message);
    expect(parsed.security).toEqual([]);
    expect(parsed.legacy).toBeUndefined();
  });
});

describe('severityRank', () => {
  it('orders critical > high > medium > low > info', () => {
    expect(severityRank('critical')).toBeGreaterThan(severityRank('high'));
    expect(severityRank('high')).toBeGreaterThan(severityRank('medium'));
    expect(severityRank('medium')).toBeGreaterThan(severityRank('low'));
    expect(severityRank('low')).toBeGreaterThan(severityRank('info'));
  });
});

function finding(overrides: Partial<SecurityFinding>): SecurityFinding {
  return {
    id: '0123456789abcdef0123456789abcdef',
    pack: 'iac-cis-v1',
    packVersion: '1',
    rule: 'aws-s3-public',
    severity: 'high',
    message: 'm',
    path: 'infra/s3.tf',
    ...overrides,
  };
}

function section(findings: SecurityFinding[], packs: Record<string, string> = { 'iac-cis-v1': '1' }): SecuritySection {
  return {
    schema: 'vg.security.v1',
    engine: 'haile-fast/test',
    packs,
    facts: { received: findings.length, evaluated: findings.length, rejected: 0 },
    findings,
  };
}

describe('evaluateSecurityGate', () => {
  const critical = finding({ id: '1'.repeat(32), severity: 'critical', rule: 'sg-open-ingress' });
  const high = finding({ id: '2'.repeat(32), severity: 'high' });
  const medium = finding({ id: '3'.repeat(32), severity: 'medium', rule: 'disk-unencrypted' });
  const low = finding({ id: '4'.repeat(32), severity: 'low', rule: 'k8s-no-resource-limits' });
  const all = section([critical, high, medium, low]);

  it('passes with no rules', () => {
    expect(evaluateSecurityGate(all, [])).toEqual({ failed: false, matched: [], unavailable: [] });
  });

  it('matches findings at or above the threshold, in section order', () => {
    const outcome = evaluateSecurityGate(all, [{ cls: 'iac', minSeverity: 'high' }]);
    expect(outcome.failed).toBe(true);
    expect(outcome.matched.map((f) => f.severity)).toEqual(['critical', 'high']);
    expect(outcome.unavailable).toEqual([]);
    expect(evaluateSecurityGate(all, [{ cls: 'iac', minSeverity: 'low' }]).matched).toHaveLength(4);
    expect(evaluateSecurityGate(all, [{ cls: 'iac', minSeverity: 'critical' }]).matched).toEqual([critical]);
  });

  it('passes when nothing reaches the threshold', () => {
    const outcome = evaluateSecurityGate(section([medium, low]), [{ cls: 'iac', minSeverity: 'high' }]);
    expect(outcome).toEqual({ failed: false, matched: [], unavailable: [] });
  });

  it('counts each finding once across overlapping rules', () => {
    const outcome = evaluateSecurityGate(all, [
      { cls: 'iac', minSeverity: 'high' },
      { cls: 'security', minSeverity: 'medium' },
    ]);
    expect(outcome.matched.map((f) => f.severity)).toEqual(['critical', 'high', 'medium']);
  });

  it('scopes the iac class to the infrastructure pack and the umbrella to every pack', () => {
    const other = finding({
      id: '5'.repeat(32),
      pack: 'secrets-v1',
      severity: 'critical',
    });
    const mixed = section([high, other], { 'iac-cis-v1': '1', 'secrets-v1': '1' });
    expect(evaluateSecurityGate(mixed, [{ cls: 'iac', minSeverity: 'high' }]).matched).toEqual([high]);
    expect(evaluateSecurityGate(mixed, [{ cls: 'security', minSeverity: 'high' }]).matched).toEqual([high, other]);
  });

  it('fails when a covered pack is unavailable, even with zero findings', () => {
    const outcome = evaluateSecurityGate(section([], { 'iac-cis-v1': 'unavailable' }), [{ cls: 'iac', minSeverity: 'high' }]);
    expect(outcome).toEqual({ failed: true, matched: [], unavailable: ['iac-cis-v1'] });
    const missing = evaluateSecurityGate(section([], {}), [{ cls: 'iac', minSeverity: 'high' }]);
    expect(missing.unavailable).toEqual(['iac-cis-v1']);
  });
});

describe('lowestThreshold', () => {
  it('reports the most permissive threshold among the rules, defaulting to high', () => {
    expect(lowestThreshold([])).toBe('high');
    expect(lowestThreshold([{ cls: 'iac', minSeverity: 'critical' }])).toBe('critical');
    expect(lowestThreshold([{ cls: 'iac', minSeverity: 'critical' }, { cls: 'security', minSeverity: 'low' }])).toBe('low');
  });
});
