import { describe, expect, it } from 'vitest';
import {
  MERGE_POLICY_PATH,
  evaluateMergePolicy,
  isDocumentationPath,
  isMergePolicyPath,
} from './merge-policy.js';

describe('evaluateMergePolicy', () => {
  it('approves a docs-only change and says it is not a certification', () => {
    const result = evaluateMergePolicy({
      enabled: true,
      requireHuman: [],
      changedFiles: ['docs/guide.md', 'README.md'],
    });
    expect(result.decision).toBe('approve');
    expect(result.reasons.join(' ')).toMatch(/not a certification/);
  });

  it('refuses a change to the merge policy file itself', () => {
    const result = evaluateMergePolicy({
      enabled: true,
      requireHuman: [],
      changedFiles: ['docs/guide.md', MERGE_POLICY_PATH],
    });
    expect(result.decision).toBe('refuse');
    expect(result.reasons.join(' ')).toContain(MERGE_POLICY_PATH);
  });

  it('refuses require-human paths even when the rest is documentation', () => {
    const result = evaluateMergePolicy({
      enabled: true,
      requireHuman: ['docs/secret.md'],
      changedFiles: ['docs/secret.md'],
    });
    expect(result.decision).toBe('refuse');
  });

  it('withholds a code change — absence of findings is not approval', () => {
    const result = evaluateMergePolicy({
      enabled: true,
      requireHuman: [],
      changedFiles: ['src/app.ts'],
    });
    expect(result.decision).toBe('withhold');
    expect(result.reasons.join(' ')).toMatch(/not a certification/);
  });

  it('withholds when disabled', () => {
    expect(
      evaluateMergePolicy({ enabled: false, requireHuman: [], changedFiles: ['README.md'] }).decision,
    ).toBe('withhold');
  });
});

describe('path helpers', () => {
  it('treats merge.md as the merge policy file and not documentation', () => {
    expect(isMergePolicyPath(MERGE_POLICY_PATH)).toBe(true);
    expect(isDocumentationPath(MERGE_POLICY_PATH)).toBe(false);
    expect(isDocumentationPath('docs/a.md')).toBe(true);
  });
});
