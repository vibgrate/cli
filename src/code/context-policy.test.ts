import * as crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  buildContextPolicyPatch,
  signContextPolicyPatch,
  verifyContextPolicyPatch,
  canProposeProductionBump,
  CONTEXT_POLICY_PATCH_SCHEMA_VERSION,
} from './context-policy.js';
import { CONTEXT_POLICY_VERSION } from './run-provenance.js';

function ed25519Pair(): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, publicKey };
}

describe('buildContextPolicyPatch', () => {
  it('requires a meaningful sample size', () => {
    expect(() =>
      buildContextPolicyPatch({
        proposedPolicyVersion: 'context-policy@2026.08.0',
        changeSummary: 'tiny',
        significance: {
          corpusId: 'fusion-lite',
          arms: ['capsule'],
          nTasks: 3,
          summary: 'too small',
        },
      }),
    ).toThrow(/nTasks/);
  });

  it('builds a deterministic unsigned patch', () => {
    const input = {
      proposedPolicyVersion: 'context-policy@2026.08.0',
      changeSummary: 'prefer test-covering slices',
      significance: {
        corpusId: 'fusion-lite',
        arms: ['metadata', 'capsule'],
        fcs: 0.72,
        znsAt1: 0.41,
        nTasks: 24,
        summary: 'paired Wilcoxon p<0.05 on FCS',
      },
    };
    const a = buildContextPolicyPatch(input);
    const b = buildContextPolicyPatch(input);
    expect(a).toEqual(b);
    expect(a.schemaVersion).toBe(CONTEXT_POLICY_PATCH_SCHEMA_VERSION);
    expect(a.basePolicyVersion).toBe(CONTEXT_POLICY_VERSION);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sign + verify + production gate', () => {
  it('signs and verifies, and gates production bumps', () => {
    const { privateKey } = ed25519Pair();
    const unsigned = buildContextPolicyPatch({
      proposedPolicyVersion: 'context-policy@2026.08.0',
      changeSummary: 'ranking tweak after canary',
      significance: {
        corpusId: 'contextbench-canary',
        arms: ['capsule', 'oracle'],
        fcs: 0.7,
        nTasks: 12,
        summary: 'significant FCS lift',
      },
    });
    expect(verifyContextPolicyPatch(unsigned).status).toBe('unsigned');
    expect(canProposeProductionBump(unsigned).ok).toBe(false);

    const signed = signContextPolicyPatch(unsigned, privateKey);
    expect(verifyContextPolicyPatch(signed).status).toBe('valid');
    const gate = canProposeProductionBump(signed);
    expect(gate.ok).toBe(true);
    expect(gate.reason).toMatch(/release PR/);
  });

  it('rejects hash tampering', () => {
    const { privateKey } = ed25519Pair();
    const signed = signContextPolicyPatch(
      buildContextPolicyPatch({
        proposedPolicyVersion: 'context-policy@2026.08.0',
        changeSummary: 'x',
        significance: {
          corpusId: 'c',
          arms: ['a'],
          nTasks: 20,
          summary: 'ok',
        },
      }),
      privateKey,
    );
    const tampered = { ...signed, changeSummary: 'evil' };
    expect(verifyContextPolicyPatch(tampered).status).toBe('hash-mismatch');
  });
});
