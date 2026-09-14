import { describe, it, expect } from 'vitest';
import { compareFindings, sanitizeSecurityFinding, sanitizeSecurityResult } from './sanitize.js';

const ID_A = '0123456789abcdef0123456789abcdef';
const ID_B = 'fedcba9876543210fedcba9876543210';
const NODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PACKS = ['iac-cis-v1'];

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID_A,
    pack: 'iac-cis-v1',
    packVersion: '1',
    rule: 'aws-s3-public',
    severity: 'high',
    message: 'aws_s3_bucket.logs grants public access (acl public-read)',
    path: 'infra/s3.tf',
    line: 12,
    address: 'aws_s3_bucket.logs',
    node: NODE,
    owasp: ['A02:2025'],
    cwe: ['CWE-284'],
    cis: ['CIS-AWS-2.1.4'],
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'vg.security.v1',
    engine: 'haile-fast/2026.903.5',
    packs: { 'iac-cis-v1': '1' },
    facts: { received: 3, evaluated: 2, rejected: 1 },
    rejected: [{ index: 2, reason: 'unknown kind: foo' }],
    findings: [finding()],
    ...overrides,
  };
}

describe('sanitizeSecurityResult', () => {
  it('passes a contract-shaped result through with every field intact', () => {
    const section = sanitizeSecurityResult(result(), PACKS);
    expect(section).toEqual({
      schema: 'vg.security.v1',
      engine: 'haile-fast/2026.903.5',
      packs: { 'iac-cis-v1': '1' },
      facts: { received: 3, evaluated: 2, rejected: 1 },
      rejected: [{ index: 2, reason: 'unknown kind: foo' }],
      findings: [finding()],
    });
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['wrong schema', result({ schema: 'vg.security.v2' })],
    ['missing engine', result({ engine: undefined })],
    ['engine too long', result({ engine: 'x'.repeat(129) })],
    ['packs not an object', result({ packs: ['iac-cis-v1'] })],
    ['facts missing', result({ facts: undefined })],
    ['facts counts not integers', result({ facts: { received: 1.5, evaluated: 1, rejected: 0 } })],
    ['facts counts negative', result({ facts: { received: -1, evaluated: 1, rejected: 0 } })],
    ['findings not an array', result({ findings: {} })],
    ['rejected not an array', result({ rejected: 'x' })],
  ])('abstains (null) on a top level that is off-contract: %s', (_label, raw) => {
    expect(sanitizeSecurityResult(raw, PACKS)).toBeNull();
  });

  it('drops unknown top-level keys and reports a requested pack the module omitted as unavailable', () => {
    const section = sanitizeSecurityResult(result({ ranker: 'relevance/1', packs: {} }), ['iac-cis-v1', 'secrets-v1']);
    expect(section).not.toBeNull();
    expect('ranker' in section!).toBe(false);
    expect(section!.packs).toEqual({ 'iac-cis-v1': 'unavailable', 'secrets-v1': 'unavailable' });
  });

  it('drops malformed rejected rows and sorts the rest by index', () => {
    const section = sanitizeSecurityResult(
      result({ rejected: [{ index: 5, reason: 'missing path' }, { index: -1, reason: 'x' }, 'junk', { index: 1, reason: 'missing kind' }] }),
      PACKS,
    );
    expect(section!.rejected).toEqual([
      { index: 1, reason: 'missing kind' },
      { index: 5, reason: 'missing path' },
    ]);
  });

  it('re-sorts findings by (path, line, address, rule, id) and drops duplicate ids', () => {
    const b = finding({ id: ID_B, path: 'a/first.tf', line: 3, address: 'x' });
    const section = sanitizeSecurityResult(result({ findings: [finding(), b, finding()] }), PACKS);
    expect(section!.findings.map((f) => f.id)).toEqual([ID_B, ID_A]);
  });
});

describe('sanitizeSecurityFinding', () => {
  const allowed = new Set(PACKS);

  it('drops unknown keys and keeps the contract fields', () => {
    const out = sanitizeSecurityFinding(finding({ reach: 'reachable', rank: 90, extra: { nested: true } }), allowed);
    expect(out).toEqual(finding());
    expect(Object.keys(out!)).not.toContain('reach');
  });

  it('accepts a finding without the optional fields', () => {
    const minimal = {
      id: ID_A,
      pack: 'iac-cis-v1',
      packVersion: '1',
      rule: 'r',
      severity: 'low',
      message: 'm',
      path: 'p',
    };
    const out = sanitizeSecurityFinding(minimal, allowed);
    expect(out).toEqual(minimal);
  });

  it.each([
    ['bad id (uppercase)', { id: ID_A.toUpperCase() }],
    ['bad id (short)', { id: 'abc' }],
    ['unknown severity', { severity: 'fatal' }],
    ['missing severity', { severity: undefined }],
    ['huge message', { message: 'm'.repeat(513) }],
    ['empty message', { message: '' }],
    ['huge path', { path: 'p'.repeat(1025) }],
    ['huge address', { address: 'a'.repeat(513) }],
    ['line zero', { line: 0 }],
    ['line fractional', { line: 1.5 }],
    ['line as string', { line: '12' }],
    ['bad node', { node: 'zz' }],
    ['owasp not an array', { owasp: 'A02:2025' }],
    ['cwe too many', { cwe: Array.from({ length: 17 }, (_, i) => `CWE-${i}`) }],
    ['cis item not a string', { cis: [1] }],
    ['pack not requested', { pack: 'secrets-v1' }],
    ['missing rule', { rule: undefined }],
    ['missing packVersion', { packVersion: undefined }],
    ['not an object', null],
  ])('drops a finding that fails a check: %s', (_label, overrides) => {
    const raw = overrides === null ? null : finding(overrides as Record<string, unknown>);
    expect(sanitizeSecurityFinding(raw, allowed)).toBeNull();
  });

  it('scrubs a credential-shaped substring out of a message (GUARDRAILS §1.1)', () => {
    const fakeToken = ['ghp', '0123456789abcdefghijklmnopqrstuvwxyzA'].join('_');
    const out = sanitizeSecurityFinding(finding({ message: `token ${fakeToken} in env` }), allowed);
    expect(out!.message).not.toContain(fakeToken);
    expect(out!.message).toContain('token');
  });
});

describe('compareFindings', () => {
  it('orders by path, then line (absent first), address, rule, id', () => {
    const base = finding() as never;
    const mk = (o: Record<string, unknown>) => ({ ...(base as object), ...o }) as never;
    const rows = [
      mk({ path: 'b', line: 1, id: ID_A }),
      mk({ path: 'a', line: 2, id: ID_A }),
      mk({ path: 'a', line: undefined, id: ID_A }),
      mk({ path: 'a', line: 2, address: 'a', id: ID_B }),
      mk({ path: 'a', line: 2, address: 'a', rule: 'a-rule', id: ID_B }),
      mk({ path: 'a', line: 2, address: 'a', rule: 'a-rule', id: ID_A }),
    ];
    const sorted = [...rows].sort(compareFindings);
    expect(sorted.map((r: { path: string; line?: number; address?: string; rule: string; id: string }) => [r.path, r.line ?? 0, r.address, r.rule, r.id])).toEqual([
      ['a', 0, 'aws_s3_bucket.logs', 'aws-s3-public', ID_A],
      ['a', 2, 'a', 'a-rule', ID_A],
      ['a', 2, 'a', 'a-rule', ID_B],
      ['a', 2, 'a', 'aws-s3-public', ID_B],
      ['a', 2, 'aws_s3_bucket.logs', 'aws-s3-public', ID_A],
      ['b', 1, 'aws_s3_bucket.logs', 'aws-s3-public', ID_A],
    ]);
  });
});
