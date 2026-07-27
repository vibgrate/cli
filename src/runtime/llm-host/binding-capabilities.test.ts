import { describe, it, expect } from 'vitest';
import {
  probeBindingCapabilities,
  supportsDynamicIdentSampler,
  supportsKvPrefixEvaluate,
} from './binding-capabilities.js';

describe('binding-capabilities', () => {
  it('probes empty lib as none', () => {
    const c = probeBindingCapabilities({});
    expect(c.tokenBias).toBe(false);
    expect(c.summary).toContain('none');
  });

  it('detects TokenBias, grammar, tokenize, evaluate', () => {
    class TokenBias {}
    class LlamaGrammar {}
    const lib = { TokenBias, LlamaGrammar };
    const model = {
      tokenize: (s: string) => [s],
      iterateAllTokens: function* () {
        yield 1;
      },
      detokenize: () => 'x',
    };
    const seq = { evaluateWithoutGeneratingNewTokens: async () => {} };
    const c = probeBindingCapabilities(lib, model, seq);
    expect(c.tokenBias).toBe(true);
    expect(c.llamaGrammar).toBe(true);
    expect(c.tokenize).toBe(true);
    expect(c.vocabIterate).toBe(true);
    expect(c.evaluateWithoutGenerate).toBe(true);
    expect(supportsKvPrefixEvaluate(c)).toBe(true);
    expect(supportsDynamicIdentSampler(c)).toBe(false);
  });

  it('env can enable onToken / customSampler', () => {
    const c = probeBindingCapabilities({}, undefined, undefined, {
      env: { VG_LLM_ON_TOKEN: '1', VG_LLM_CUSTOM_SAMPLER: 'true' },
    });
    expect(c.onTokenCallback).toBe(true);
    expect(c.customSampler).toBe(true);
    expect(supportsDynamicIdentSampler(c)).toBe(true);
  });
});
