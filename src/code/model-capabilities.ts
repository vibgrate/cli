/**
 * Per-model capability registry (VG Code model-agnostic robustness, phase 2).
 *
 * The provider layer knows whether a *backend* has a native tool API
 * (`Provider.supportsTools`), but robustness also depends on the *model*: many
 * models served over a native-capable backend (Ollama, LM Studio) ignore the
 * `tools` field or cannot see images. Aider's model database and OpenHands'
 * supported-model list solve this with a per-model registry; this is ours —
 * conservative pattern rules over the model id, with three-valued answers:
 * `true` (known capable), `false` (known incapable), `null` (unknown — keep
 * today's behavior and rely on the runtime rescue paths).
 *
 * The registry is advisory routing metadata, not a hard gate: an unknown model
 * still gets native tool calling plus the text-markup rescue parser, and
 * images are only dropped when a model is *known* to be blind.
 */

export interface ModelCapabilities {
  /** Does the model reliably emit native (OpenAI-shaped) tool calls? */
  nativeTools: boolean | null;
  /** Can the model see image input? */
  vision: boolean | null;
}

/** Case-insensitive substring/regex tests over the model id (family markers). */
const VISION_YES = [
  /gpt-4o/, /gpt-4\.1/, /gpt-5/, /^o[34]/, // OpenAI multimodal families
  /claude/, // Claude 3+ are all vision-capable
  /gemini/, /gemma-?3/, // Google
  /llava/, /vision/, /-vl\b/, /-vl-/, /qwen.*vl/, // open vision families / naming markers
  /pixtral/, /moondream/, /minicpm-v/, /bakllava/, /cogvlm/, /internvl/, /phi-?4-multimodal/,
];
const VISION_NO = [
  /deepseek/, // DeepSeek chat/coder/r1 lines are text-only
  /codestral/, /starcoder/, /codegemma/, /codellama/, /code-?llama/, /qwen.*coder/, /devstral/,
  /^(mistral|mixtral)(?!.*(pixtral|medium-3|small-3\.1))/, // classic Mistral text models
  /phi-?[123]\b/, /granite(?!.*vision)/, /command-r(?!.*vision)/, /stablelm/, /tinyllama/, /smollm(?!.*v)/,
  /^llama-?[12]/, /llama-?3(\.[01])?(?!.*vision)/, // Llama ≤3.1 text-only; 3.2-vision matches VISION_YES first
];

const TOOLS_YES = [
  /gpt-4/, /gpt-5/, /^o[134]/, /claude/, /gemini/, /grok/, /deepseek-(chat|v3)/, /kimi/,
  /qwen-?[23]/, /qwen.*(coder|instruct)/, /llama-?3\.[13]/, /llama-?4/, /mistral-(small|medium|large)/,
  /devstral/, /command-r/, /glm-?4/, /minimax/, /hermes/, // Hermes models are tool-call trained
];
const TOOLS_NO = [
  /phi-?[12]\b/, /tinyllama/, /stablelm/, /smollm/, /starcoder/, /codellama/, /codegemma/,
  /gemma\b/, /gemma-?[12]\b/, // Gemma 1/2 have no tool support; Gemma 3 is unreliable but attempts it
  /moondream/, /llava/, // pure-vision chat models
  /-base\b/, /-base-/, // base (non-instruct) checkpoints never tool-call
];

function match(rules: RegExp[], id: string): boolean {
  return rules.some((r) => r.test(id));
}

/**
 * Look up capabilities for a model id. `overrides` (from project config) wins
 * over the built-in rules — exact id match first, then substring match.
 */
export function lookupModelCapabilities(
  model: string | undefined,
  overrides?: Record<string, Partial<ModelCapabilities>>,
): ModelCapabilities {
  const id = (model ?? '').trim().toLowerCase();
  const result: ModelCapabilities = { nativeTools: null, vision: null };
  if (!id) return result;

  if (match(VISION_YES, id)) result.vision = true;
  else if (match(VISION_NO, id)) result.vision = false;

  if (match(TOOLS_NO, id)) result.nativeTools = false;
  else if (match(TOOLS_YES, id)) result.nativeTools = true;

  if (overrides) {
    for (const [key, caps] of Object.entries(overrides)) {
      const k = key.trim().toLowerCase();
      if (!k) continue;
      if (id === k || id.includes(k)) {
        if (caps.nativeTools !== undefined) result.nativeTools = caps.nativeTools;
        if (caps.vision !== undefined) result.vision = caps.vision;
      }
    }
  }
  return result;
}
