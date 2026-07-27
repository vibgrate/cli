/**
 * Binding capability matrix for Approach B (P2).
 *
 * Probes an injected node-llama-cpp module + loaded model without assuming a
 * pinned minor version. Host code branches on these flags so CI can mock a
 * full matrix and production degrades gracefully.
 */

export interface BindingCapabilities {
  /** `TokenBias` class on the module. */
  tokenBias: boolean;
  /** `LlamaGrammar` class on the module. */
  llamaGrammar: boolean;
  /** model.iterateAllTokens + detokenize for vocab suppress. */
  vocabIterate: boolean;
  /** model.tokenize for draft/prefix evaluate. */
  tokenize: boolean;
  /** sequence.evaluateWithoutGeneratingNewTokens. */
  evaluateWithoutGenerate: boolean;
  /** prompt opts may include onToken (declared by env or model feature flag). */
  onTokenCallback: boolean;
  /** prompt opts may include customSampler.accept. */
  customSampler: boolean;
  /** Human summary for doctor / host-status. */
  summary: string[];
}

export interface ProbeBindingOptions {
  /**
   * Force-enable onToken / customSampler when the operator knows the binding
   * version supports them (node-llama-cpp does not always expose flags).
   */
  assumeOnToken?: boolean;
  assumeCustomSampler?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Probe lib + model (+ optional sequence) for Approach B features.
 */
export function probeBindingCapabilities(
  lib: unknown,
  model?: unknown,
  sequence?: unknown,
  options: ProbeBindingOptions = {},
): BindingCapabilities {
  const l: any = lib;
  const m: any = model;
  const seq: any = sequence;
  const env = options.env ?? process.env;

  const tokenBias = !!(l && typeof l.TokenBias === 'function');
  const llamaGrammar = !!(l && typeof l.LlamaGrammar === 'function');
  const vocabIterate = !!(m && typeof m.iterateAllTokens === 'function' && typeof m.detokenize === 'function');
  const tokenize = !!(m && typeof m.tokenize === 'function');
  const evaluateWithoutGenerate = !!(seq && typeof seq.evaluateWithoutGeneratingNewTokens === 'function');

  const envOnToken = /^(1|true|yes)$/i.test(String(env.VG_LLM_ON_TOKEN ?? env.VIBGRATE_LLM_ON_TOKEN ?? ''));
  const envCustom = /^(1|true|yes)$/i.test(String(env.VG_LLM_CUSTOM_SAMPLER ?? ''));
  const onTokenCallback = !!(options.assumeOnToken || envOnToken);
  const customSampler = !!(options.assumeCustomSampler || envCustom);

  const summary: string[] = [];
  if (tokenBias) summary.push('TokenBias');
  if (llamaGrammar) summary.push('LlamaGrammar');
  if (vocabIterate) summary.push('vocabIterate');
  if (tokenize) summary.push('tokenize');
  if (evaluateWithoutGenerate) summary.push('evaluateWithoutGenerate');
  if (onTokenCallback) summary.push('onToken');
  if (customSampler) summary.push('customSampler');
  if (summary.length === 0) summary.push('none');

  return {
    tokenBias,
    llamaGrammar,
    vocabIterate,
    tokenize,
    evaluateWithoutGenerate,
    onTokenCallback,
    customSampler,
    summary,
  };
}

/** True when we can run the P2 dynamic ident filter path. */
export function supportsDynamicIdentSampler(caps: BindingCapabilities): boolean {
  return caps.onTokenCallback || caps.customSampler;
}

/** True when warm prefix evaluate is available. */
export function supportsKvPrefixEvaluate(caps: BindingCapabilities): boolean {
  return caps.tokenize && caps.evaluateWithoutGenerate;
}
