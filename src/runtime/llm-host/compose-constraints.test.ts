import { describe, it, expect } from 'vitest';
import { composePromptConstraints } from './compose-constraints.js';

describe('composePromptConstraints', () => {
  it('layers grammar, bias, and dynamic hooks', () => {
    const r = composePromptConstraints({
      base: { temperature: 0 },
      grammar: { g: true },
      tokenBias: { b: true },
      dynamic: { onToken: () => true },
    });
    expect(r.layers).toEqual({ grammar: true, tokenBias: true, dynamic: true });
    expect(r.promptOpts.grammar).toEqual({ g: true });
    expect(r.promptOpts.tokenBias).toEqual({ b: true });
    expect(typeof r.promptOpts.onToken).toBe('function');
    expect(r.promptOpts.temperature).toBe(0);
  });

  it('omits null layers', () => {
    const r = composePromptConstraints({ base: { maxTokens: 8 } });
    expect(r.layers.grammar).toBe(false);
    expect(r.promptOpts.maxTokens).toBe(8);
    expect(r.promptOpts.grammar).toBeUndefined();
  });
});
