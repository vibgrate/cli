/**
 * Compose grammar + TokenBias + dynamic sampler onto one prompt() options bag (P2).
 *
 * Order of application (documented for operators / binding authors):
 *  1. Grammar (GBNF) — hard structure (PatchIR)
 *  2. Static TokenBias — graph id boost / unknown suppress
 *  3. Dynamic onToken/customSampler — open-identifier stream filter
 *
 * Bindings that reject unknown keys are protected: we only set keys we intend.
 */

export interface ComposeConstraintsInput {
  grammar?: unknown | null;
  tokenBias?: unknown | null;
  /** Already-mutated base opts (temperature, maxTokens, …). */
  base?: Record<string, unknown>;
  /** Extra keys from dynamic sampler attach (onToken / customSampler). */
  dynamic?: Record<string, unknown> | null;
}

export interface ComposeConstraintsResult {
  promptOpts: Record<string, unknown>;
  /** Which layers are present. */
  layers: {
    grammar: boolean;
    tokenBias: boolean;
    dynamic: boolean;
  };
}

export function composePromptConstraints(input: ComposeConstraintsInput): ComposeConstraintsResult {
  const promptOpts: Record<string, unknown> = { ...(input.base ?? {}) };
  if (input.grammar != null) promptOpts.grammar = input.grammar;
  if (input.tokenBias != null) promptOpts.tokenBias = input.tokenBias;
  if (input.dynamic) {
    for (const [k, v] of Object.entries(input.dynamic)) {
      if (v !== undefined) promptOpts[k] = v;
    }
  }
  return {
    promptOpts,
    layers: {
      grammar: input.grammar != null,
      tokenBias: input.tokenBias != null,
      dynamic: !!(input.dynamic && Object.keys(input.dynamic).length > 0),
    },
  };
}
