import { describe, it, expect } from 'vitest';
import {
  defaultModelExecutionProfile,
  mergeModelExecutionProfile,
  MODEL_EXECUTION_PROFILE_SCHEMA_VERSION,
  parseModelExecutionProfile,
  resolveModelExecutionProfile,
} from './model-execution-profile.js';

describe('ModelExecutionProfile', () => {
  it('defaults to flow tier with stable schema', () => {
    const p = defaultModelExecutionProfile({ id: 'qwen2.5-coder:7b' });
    expect(p.schemaVersion).toBe(MODEL_EXECUTION_PROFILE_SCHEMA_VERSION);
    expect(p.mode).toBe('flow');
    expect(p.toolCalling).toBe('native');
    expect(p.capsuleBudgetTokens).toBe(3000);
  });

  it('resolveModelExecutionProfile classifies provider and size heuristics', () => {
    const spark = resolveModelExecutionProfile({ providerId: 'ollama', model: 'qwen2.5:1.5b' });
    expect(spark.backend).toBe('ollama');
    expect(spark.mode).toBe('spark');

    const forge = resolveModelExecutionProfile({ providerId: 'openrouter', model: 'anthropic/claude-sonnet' });
    expect(forge.backend).toBe('openai-compatible');
    expect(forge.mode).toBe('forge');
  });

  it('prefers the curated catalogue for known coding models', () => {
    const p = resolveModelExecutionProfile({ providerId: 'ollama', model: 'qwen2.5-coder:7b' });
    expect(p.mode).toBe('flow');
    expect(p.capsuleBudgetTokens).toBe(3500);
    expect(p.securityTier).toBe('L1');
  });

  it('parse + merge sanitize config overrides', () => {
    const partial = parseModelExecutionProfile({
      capsuleBudgetTokens: 5000,
      maxRepairRounds: 3,
      securityTier: 'L1',
      junk: true,
    });
    expect(partial?.capsuleBudgetTokens).toBe(5000);
    expect((partial as { junk?: unknown })?.junk).toBeUndefined();
    const base = defaultModelExecutionProfile({ id: 'm' });
    const merged = mergeModelExecutionProfile(base, partial);
    expect(merged.capsuleBudgetTokens).toBe(5000);
    expect(merged.maxRepairRounds).toBe(3);
    expect(merged.securityTier).toBe('L1');
    expect(merged.id).toBe('m');
  });
});
