/**
 * Model routing for `vg code` (VG-CLI-CODE §5.2).
 *
 * The "best in breed" story is an ordered set of backends with automatic
 * fallback — the OpenRouter/LiteLLM model — expressed as a *scheduling* decision
 * the session can execute: try the preferred provider, and on a transport
 * failure fall through to the next available one. This resolver is pure over its
 * injected inputs (flags, environment, the discovered local fleet), so it is
 * fully testable, and it holds two hard rules from the guardrails:
 *
 *   - **No surprise egress or install.** With no explicit selection it picks a
 *     backend only from signals already present (a configured hosted key, or a
 *     model already pulled locally). It never dials a default cloud endpoint you
 *     didn't configure, and never triggers an install to pick a default.
 *   - **`--local` stays local.** Under `--local` only on-device backends are
 *     eligible; if none are available it fails with an actionable message rather
 *     than silently reaching the network.
 */

import { CliError, ExitCode } from '../util/exit.js';
import { discoverModels, type LocalModel } from '../engine/models.js';
import {
  LocalLlamaProvider,
  MockProvider,
  OllamaProvider,
  OpenAiCompatibleProvider,
  OPENAI_COMPATIBLE,
  type OpenAiCompatibleConfig,
} from './providers.js';
import type { Provider } from './types.js';

export interface RouteOptions {
  /** Explicit `--provider` (ollama, lmstudio, openrouter, litellm, openai, together, llama-cpp). */
  provider?: string;
  /** Explicit `--model`. */
  model?: string;
  /** `--local`: on-device backends only. */
  local?: boolean;
  /** `--yes`: consent to a first-use install (only relevant to llama-cpp). */
  consent?: boolean;
  /** Path to a gguf for the llama-cpp backend. */
  modelPath?: string;
  /** A scripted reply → force the deterministic MockProvider (tests/`--mock`). */
  mockReply?: string;
}

export interface RouteDeps {
  env?: NodeJS.ProcessEnv;
  discover?: () => LocalModel[];
}

export interface RouteResult {
  /** Providers to try in order; the session falls through on transport failure. */
  providers: Provider[];
  /** A short, human explanation of the choice (for the run header / --json). */
  reason: string;
}

const HOSTED_IDS = new Set(['openrouter', 'litellm', 'openai', 'together']);

/** Resolve the ordered provider list for a run. Throws an actionable CliError when nothing is eligible. */
export function resolveProviders(opts: RouteOptions, deps: RouteDeps = {}): RouteResult {
  const env = deps.env ?? process.env;
  const discover = deps.discover ?? discoverModels;

  // Deterministic offline floor — used by tests, the benchmark, and `--mock`.
  if (opts.mockReply !== undefined) {
    return { providers: [new MockProvider(opts.model ?? 'mock-1', opts.mockReply)], reason: 'mock provider (scripted, offline)' };
  }

  // Explicit provider wins.
  if (opts.provider) {
    const provider = buildExplicit(opts.provider, opts, env, discover);
    const fallbacks = opts.local || provider.local ? localFallbacks(opts, env, discover, provider.id) : [];
    return { providers: [provider, ...fallbacks], reason: `explicit --provider ${opts.provider}` };
  }

  // --local: on-device only, in preference order.
  if (opts.local) {
    const locals = localFallbacks(opts, env, discover, '');
    if (locals.length === 0) {
      throw new CliError(
        'no local model backend available for --local. Start Ollama (`ollama serve` + `ollama pull <model>`), run LM Studio, or point --provider llama-cpp at a gguf. See `vg models`.',
        ExitCode.NOT_FOUND,
      );
    }
    return { providers: locals, reason: '--local (on-device backends only)' };
  }

  // No explicit selection: choose from signals already present, best first.
  // 1) A configured hosted router key (OpenRouter is the reference best-in-breed router).
  if (env.OPENROUTER_API_KEY) {
    const model = resolveHostedModel(opts, env, 'openrouter');
    const primary = buildHosted('openrouter', model);
    return { providers: [primary, ...localFallbacks(opts, env, discover, 'openrouter')], reason: 'OPENROUTER_API_KEY is set → OpenRouter (with local fallback)' };
  }
  // 2) A locally-pulled model.
  const locals = localFallbacks(opts, env, discover, '');
  if (locals.length) return { providers: locals, reason: 'a local model is available → on-device (no key needed)' };
  // 3) Any other configured hosted key.
  for (const id of ['litellm', 'openai', 'together'] as const) {
    const keyEnv = OPENAI_COMPATIBLE[id].apiKeyEnv;
    if (keyEnv && env[keyEnv]) {
      const model = resolveHostedModel(opts, env, id);
      return { providers: [buildHosted(id, model)], reason: `${keyEnv} is set → ${OPENAI_COMPATIBLE[id].label}` };
    }
  }

  throw new CliError(
    'no model backend configured. Do one of: set OPENROUTER_API_KEY for the hosted router, run Ollama locally (`ollama serve`), or use --local with a local model. Set the model with --model or VG_CODE_MODEL. (No models are installed by default.)',
    ExitCode.NOT_FOUND,
  );
}

function buildExplicit(id: string, opts: RouteOptions, env: NodeJS.ProcessEnv, discover: () => LocalModel[]): Provider {
  if (id === 'ollama') return new OllamaProvider(resolveLocalModel(opts, discover, 'ollama'), env.OLLAMA_HOST);
  if (id === 'llama-cpp') {
    const modelPath = opts.modelPath || env.VG_CODE_MODEL_PATH;
    if (!modelPath) throw new CliError('--provider llama-cpp needs a gguf path via --model-path or VG_CODE_MODEL_PATH (no weights are downloaded automatically; see `vg models`).', ExitCode.USAGE_ERROR);
    return new LocalLlamaProvider(opts.model ?? basename(modelPath), modelPath, undefined, !!opts.consent);
  }
  if (id === 'lmstudio') return buildHosted('lmstudio', resolveHostedModel(opts, env, 'lmstudio'));
  if (HOSTED_IDS.has(id)) return buildHosted(id, resolveHostedModel(opts, env, id));
  throw new CliError(`unknown --provider "${id}". Known: ollama, lmstudio, openrouter, litellm, openai, together, llama-cpp.`, ExitCode.USAGE_ERROR);
}

function buildHosted(id: string, model: string): OpenAiCompatibleProvider {
  const base = OPENAI_COMPATIBLE[id];
  const config: OpenAiCompatibleConfig = { ...base, id };
  return new OpenAiCompatibleProvider(model, config);
}

/** On-device backends in preference order, skipping the one already chosen as primary. */
function localFallbacks(opts: RouteOptions, env: NodeJS.ProcessEnv, discover: () => LocalModel[], exclude: string): Provider[] {
  const out: Provider[] = [];
  const models = safeDiscover(discover);
  const ollamaModel = opts.model ?? firstOfRuntime(models, 'ollama');
  if (exclude !== 'ollama' && ollamaModel) out.push(new OllamaProvider(ollamaModel, env.OLLAMA_HOST));
  // LM Studio serves an OpenAI-compatible endpoint locally; include if a model id is known.
  const lmModel = opts.model ?? firstOfRuntime(models, 'lm-studio');
  if (exclude !== 'lmstudio' && lmModel) out.push(buildHosted('lmstudio', lmModel));
  return out;
}

function resolveLocalModel(opts: RouteOptions, discover: () => LocalModel[], runtime: LocalModel['runtime']): string {
  if (opts.model) return opts.model;
  const found = firstOfRuntime(safeDiscover(discover), runtime);
  if (found) return found;
  throw new CliError(`--provider ${runtime} needs a model. Pull one (\`ollama pull <model>\`) then re-run, or pass --model. See \`vg models\`.`, ExitCode.NOT_FOUND);
}

function resolveHostedModel(opts: RouteOptions, env: NodeJS.ProcessEnv, id: string): string {
  const model = opts.model || env.VG_CODE_MODEL;
  if (model) return model;
  throw new CliError(
    `${OPENAI_COMPATIBLE[id].label} needs a model id — pass --model (e.g. a current best-in-breed coding model) or set VG_CODE_MODEL. We don't hard-code a model so you always pick the current best one.`,
    ExitCode.USAGE_ERROR,
  );
}

function firstOfRuntime(models: LocalModel[], runtime: LocalModel['runtime']): string | undefined {
  // Deterministic: discoverModels() already returns a sorted list.
  const m = models.find((x) => x.runtime === runtime);
  return m?.name;
}

function safeDiscover(discover: () => LocalModel[]): LocalModel[] {
  try {
    return discover();
  } catch {
    return [];
  }
}

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}
