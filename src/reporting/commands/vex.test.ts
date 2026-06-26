import { describe, it, expect } from 'vitest';
import { buildVexDocument, VexValidationError, OPENVEX_PREDICATE_TYPE } from './vex.js';

const FIXED = { timestamp: '2026-06-19T00:00:00.000Z', id: 'https://vibgrate.com/vex/test', author: 'Vibgrate' };

describe('buildVexDocument', () => {
  it('emits a spec-valid OpenVEX document envelope', () => {
    const doc = buildVexDocument({ ...FIXED, statements: [] });
    expect(doc['@context']).toBe('https://openvex.dev/ns/v0.2.0');
    expect(doc['@id']).toBe('https://vibgrate.com/vex/test');
    expect(doc.author).toBe('Vibgrate');
    expect(doc.timestamp).toBe('2026-06-19T00:00:00.000Z');
    expect(doc.version).toBe(1);
  });

  it('a zero-statement document is valid (asserts no known affected components)', () => {
    expect(buildVexDocument({ ...FIXED, statements: [] }).statements).toEqual([]);
  });

  it('is reproducible when timestamp and id are pinned', () => {
    const a = buildVexDocument({ ...FIXED, defaultProduct: 'img@sha256:abc', statements: [
      { vulnerability: 'CVE-2024-1', status: 'not_affected', justification: 'vulnerable_code_not_present' },
    ] });
    const b = buildVexDocument({ ...FIXED, defaultProduct: 'img@sha256:abc', statements: [
      { vulnerability: 'CVE-2024-1', status: 'not_affected', justification: 'vulnerable_code_not_present' },
    ] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('applies the default product to statements without their own', () => {
    const doc = buildVexDocument({ ...FIXED, defaultProduct: 'img@sha256:abc', statements: [
      { vulnerability: 'CVE-2024-1', status: 'under_investigation' },
      { vulnerability: 'CVE-2024-2', status: 'fixed', products: ['pkg:npm/left-pad@1.3.0'] },
    ] });
    expect(doc.statements[0].products).toEqual([{ '@id': 'img@sha256:abc' }]);
    expect(doc.statements[1].products).toEqual([{ '@id': 'pkg:npm/left-pad@1.3.0' }]);
  });

  it('rejects an unknown status', () => {
    expect(() => buildVexDocument({ ...FIXED, defaultProduct: 'p', statements: [
      { vulnerability: 'CVE-x', status: 'bogus' as never },
    ] })).toThrow(VexValidationError);
  });

  it('requires a product (statement-level or default)', () => {
    expect(() => buildVexDocument({ ...FIXED, statements: [
      { vulnerability: 'CVE-x', status: 'fixed' },
    ] })).toThrow(/no product/);
  });

  it('requires a justification or impact_statement for not_affected', () => {
    expect(() => buildVexDocument({ ...FIXED, defaultProduct: 'p', statements: [
      { vulnerability: 'CVE-x', status: 'not_affected' },
    ] })).toThrow(/not_affected/);
  });

  it('requires an action_statement for affected', () => {
    expect(() => buildVexDocument({ ...FIXED, defaultProduct: 'p', statements: [
      { vulnerability: 'CVE-x', status: 'affected' },
    ] })).toThrow(/action_statement/);
  });

  it('exposes the openvex predicate type for the attestation', () => {
    expect(OPENVEX_PREDICATE_TYPE).toBe('openvex');
  });
});
