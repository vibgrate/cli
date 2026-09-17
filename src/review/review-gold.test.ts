/**
 * Review proposeFindingFix gold — in-process, scripted providers, no live model.
 *
 * Feeds the shared cli-benchmark review-gold fixtures (Context Capsule +
 * finding + policy + model id) through {@link proposeFindingFix} / `runAgent`.
 * Extends `propose.test.ts` / `loop-gate.test.ts`; does not fork a second loop.
 *
 * Priority 2 for #2662. Coding-session gold is PR #2699.
 */

import { describe, it, expect } from 'vitest';
import { PATCH_IR_SCHEMA_VERSION, validatePatchIR } from '../code/patch-ir.js';
import { withToolCallFallback } from '../code/text-tool-protocol.js';
import type { Provider } from '../code/types.js';
import {
  loadReviewGoldFixtureFile,
  reviewGoldResolvedModelId,
  runReviewGoldFixture,
} from './gold-run.js';

const fixtures = loadReviewGoldFixtureFile();

describe('review-gold fixtures (shared with cli-benchmark)', () => {
  it('loads the Priority 2 families from the shared JSON', () => {
    expect(fixtures.map((f) => f.id)).toEqual([
      'happy-path-loop',
      'happy-path-oneshot',
      'plan-mode-no-patch',
      'refuse-fallback-backend',
      'invalid-model',
      'default-branch-refuse',
    ]);
    expect(new Set(fixtures.map((f) => f.family))).toEqual(
      new Set(['happy-path', 'plan-mode', 'refuse-backend', 'invalid-model', 'default-branch']),
    );
  });
});

describe('review-gold — proposeFindingFix (offline, no live model)', () => {
  it.each(fixtures)('$id ($family) meets the PatchIR / stop-reason contract', async (fixture) => {
    const { result, filesAfter } = await runReviewGoldFixture(fixture);
    expect(result.ok, result.error ?? fixture.id).toBe(fixture.expected.ok);
    expect(result.stopReason).toBe(fixture.expected.stopReason);
    expect(result.applied).toBe(fixture.expected.applied);
    expect(result.patch !== null).toBe(fixture.expected.hasPatch);
    if (fixture.expected.hasPatch) {
      expect(result.patch?.schemaVersion).toBe(PATCH_IR_SCHEMA_VERSION);
      expect(validatePatchIR(result.patch!).ok).toBe(true);
    } else {
      expect(result.patch).toBeNull();
    }
    if (fixture.expected.proposedDiffIncludes) {
      expect(result.proposedDiff).toContain(fixture.expected.proposedDiffIncludes);
    }
    if (fixture.expected.errorMatches) {
      expect(result.error).toMatch(new RegExp(fixture.expected.errorMatches, 'i'));
      expect(result.correlationId).toBeTruthy();
    }
    if (fixture.expected.fileUnchanged) {
      expect(filesAfter[fixture.expected.fileUnchanged]).toBe(fixture.files[fixture.expected.fileUnchanged]);
    }
    expect(result.applied).toBe(false);
  });

  it('happy-path-loop reports steps from runAgent and usage as a pair (zeros allowed)', async () => {
    const fixture = fixtures.find((f) => f.id === 'happy-path-loop')!;
    const { result } = await runReviewGoldFixture(fixture);
    expect(result.steps).toBeGreaterThanOrEqual(2);
    // Scripted providers may report 0+0 — that is a measured zero, not absent.
    expect(result.usage).toEqual({ promptTokens: expect.any(Number), completionTokens: expect.any(Number) });
  });

  it('happy-path-loop cannot regress to no-tools when a Code Mode emits residual SEARCH/REPLACE', async () => {
    // Deterministic llama-cpp-shaped mock (supportsTools: false, no <tool_call>
    // tags). The live Code Mode miss was stopReason no-tools after 3 steps.
    const fixture = fixtures.find((f) => f.id === 'happy-path-loop')!;
    const residual = [
      'src/scan.ts',
      '<<<<<<< SEARCH',
      'const timeout = 0;',
      '=======',
      'const timeout = 5000;',
      '>>>>>>> REPLACE',
    ].join('\n');
    const backend: Provider = {
      id: 'llama-cpp',
      label: 'Vibgrate (local)',
      local: true,
      model: 'forge-pack',
      supportsTools: false,
      async chat() {
        return { text: residual, model: 'forge-pack', provider: 'llama-cpp' };
      },
    };
    const { result, filesAfter } = await runReviewGoldFixture(fixture, {
      providers: [withToolCallFallback(backend)],
    });
    expect(result.ok, result.error ?? fixture.id).toBe(true);
    expect(result.stopReason).toBe('finished');
    expect(result.stopReason).not.toBe('no-tools');
    expect(result.patch).toBeTruthy();
    expect(validatePatchIR(result.patch!).ok).toBe(true);
    expect(result.toolTrace.map((t) => t.name)).toContain('edit_file');
    expect(result.applied).toBe(false);
    expect(filesAfter['src/scan.ts']).toBe(fixture.files['src/scan.ts']);
  });

  it('invalid-model never calls a backend (usage absent, not zero)', async () => {
    const fixture = fixtures.find((f) => f.id === 'invalid-model')!;
    const { result } = await runReviewGoldFixture(fixture);
    expect(result.usage).toBeNull();
    expect(result.steps).toBe(0);
  });

  it('CLI --model / live model does not override non-happy-path fixtures', async () => {
    const liveModel = 'relay:hosted-coder';
    const nonHappy = fixtures.filter((f) => f.family !== 'happy-path');
    expect(nonHappy.map((f) => f.id)).toEqual([
      'plan-mode-no-patch',
      'refuse-fallback-backend',
      'invalid-model',
      'default-branch-refuse',
    ]);
    for (const fixture of nonHappy) {
      expect(reviewGoldResolvedModelId(fixture, { live: true, modelId: liveModel })).toBe(fixture.modelId);
      expect(reviewGoldResolvedModelId(fixture, { live: false, modelId: liveModel })).toBe(fixture.modelId);
      const { result } = await runReviewGoldFixture(fixture, { live: true, modelId: liveModel });
      expect(result.ok, result.error ?? fixture.id).toBe(fixture.expected.ok);
      expect(result.stopReason).toBe(fixture.expected.stopReason);
      expect(result.provider.id).not.toBe('vibgrate-relay');
    }
    const invalid = fixtures.find((f) => f.id === 'invalid-model')!;
    const { result } = await runReviewGoldFixture(invalid, { live: true, modelId: liveModel });
    expect(result.stopReason).toBe('invalid-model');
    expect(result.usage).toBeNull();
    expect(result.steps).toBe(0);
    expect(result.provider.model).toBe('');
  });

  it('offline --model does not override happy-path either', async () => {
    const happy = fixtures.find((f) => f.id === 'happy-path-loop')!;
    expect(reviewGoldResolvedModelId(happy, { live: false, modelId: 'relay:hosted-coder' })).toBe(happy.modelId);
    expect(reviewGoldResolvedModelId(happy, { live: true, modelId: 'relay:hosted-coder' })).toBe('relay:hosted-coder');
    const { result } = await runReviewGoldFixture(happy, { live: false, modelId: 'relay:hosted-coder' });
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe('finished');
    expect(result.provider.id).toBe('scripted');
  });

  it('one-shot path leaves usage absent (the session does not report tokens)', async () => {
    const fixture = fixtures.find((f) => f.id === 'happy-path-oneshot')!;
    const { result } = await runReviewGoldFixture(fixture);
    expect(result.usage).toBeNull();
    expect(result.steps).toBe(1);
    expect(result.toolTrace.some((t) => t.name === 'one-shot-assess')).toBe(true);
  });

  it('refuse-fallback-backend is fail-closed (fellBack, no patch)', async () => {
    const fixture = fixtures.find((f) => f.id === 'refuse-fallback-backend')!;
    const { result } = await runReviewGoldFixture(fixture);
    expect(result.provider.fellBack).toBe(true);
    expect(result.patch).toBeNull();
    expect(result.ok).toBe(false);
  });
});
