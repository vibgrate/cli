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
 *   - **Code Modes stay on the Vibgrate manager.** When {@link RouteOptions.codeMode}
 *     is set, routing is fail-closed to embedded llama.cpp (first-party GGUF).
 *     Ollama / LM Studio are never auto-selected for Code Modes.
 */

import { CliError, ExitCode } from '../util/exit.js';
import { discoverModels, type LocalModel } from '../engine/models.js';
import { resolveGgufPath } from '../runtime/resolve-gguf.js';
import {
  formatManagerBadgeLine,
  managerFromProviderId,
  type ModelManagerId,
} from '../runtime/model-manager.js';
import {
  LocalLlamaProvider,
  MockProvider,
  OllamaProvider,
  OpenAiCompatibleProvider,
  OPENAI_COMPATIBLE,
  type OpenAiCompatibleConfig,
} from './providers.js';
import { withToolCallFallback } from './text-tool-protocol.js';
import { lookupModelCapabilities } from './model-capabilities.js';
import type { Provider } from './types.js';

export interface RouteOptions {
  /** Explicit `--provider` (vibgrate-relay, ollama, lmstudio, foundry-local, openrouter, litellm, openai, together, llama-cpp). */
  provider?: string;
  /** Explicit `--model`. */
  model?: string;
  /** `--local`: on-device backends only. */
  local?: boolean;
  /** `--yes`: consent to a first-use install (only relevant to llama-cpp). */
  consent?: boolean;
  /** Path to a gguf for the llama-cpp backend. */
  modelPath?: string;
  /**
   * Prefer embedded llama.cpp when a GGUF is resolvable (Code Mode preferredInference).
   * When false, Ollama may be tried first (VG_PREFER_OLLAMA).
   */
  preferEmbedded?: boolean;
  /**
   * Code Mode path (spark|flow|forge): fail-closed to the Vibgrate model manager.
   * Never auto-routes to Ollama / LM Studio / hosted.
   */
  codeMode?: boolean;
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
  /** Manager identity for the primary provider (badge / UX). */
  manager: ModelManagerId;
  /** e.g. "[Vibgrate] Code Mode · first-party model manager …" */
  managerLine: string;
}

const HOSTED_IDS = new Set(['vibgrate-relay', 'openrouter', 'litellm', 'openai', 'together']);

/** Resolve the ordered provider list for a run. Throws an actionable CliError when nothing is eligible. */
export function resolveProviders(opts: RouteOptions, deps: RouteDeps = {}): RouteResult {
  const env = deps.env ?? process.env;
  const discover = deps.discover ?? discoverModels;

  // Deterministic offline floor — used by tests, the benchmark, and `--mock`.
  if (opts.mockReply !== undefined) {
    const providers = [new MockProvider(opts.model ?? 'mock-1', opts.mockReply)];
    return finish(providers, 'mock provider (scripted, offline)');
  }

  // Code Modes: Vibgrate manager only (embedded GGUF). No third-party auto-route.
  // Even when code.ts pins provider=llama-cpp, never chain Ollama/LM Studio — a
  // grammar or load failure must surface the real error, not "couldn't reach Ollama".
  if (opts.codeMode && (!opts.provider || opts.provider === 'llama-cpp' || opts.provider === 'vibgrate')) {
    const gguf = resolveGgufPath({
      modelPath: opts.modelPath || env.VG_CODE_MODEL_PATH,
      modelRef: opts.model,
      env,
      discover,
    });
    if (!gguf) {
      throw new CliError(
        'Code Mode needs the Vibgrate model manager weights on disk. Run `vg models install spark|flow|forge` (or pass --model-path to a GGUF). Custom Ollama/LM Studio backends are only used when you set --provider explicitly.',
        ExitCode.NOT_FOUND,
      );
    }
    const providers = [
      new LocalLlamaProvider(opts.model ?? basename(gguf.path), gguf.path, undefined, !!opts.consent),
    ];
    return finish(providers, `Code Mode → Vibgrate model manager (embedded llama.cpp · ${gguf.path})`);
  }

  // Explicit provider wins.
  if (opts.provider) {
    const provider = buildExplicit(opts.provider, opts, env, discover);
    // Code Mode + explicit custom backend (ollama, lmstudio, …): still no surprise chain.
    if (opts.codeMode) {
      return finish([provider], `Code Mode → explicit --provider ${opts.provider} (no auto-fallback)`);
    }
    // Custom path: only fall through to other *local* adapters when --local, never LM Studio unless chosen.
    const fallbacks =
      opts.local || provider.local
        ? localFallbacks(opts, env, discover, provider.id, { allowLmStudio: opts.provider === 'lmstudio' })
        : [];
    return finish([provider, ...fallbacks], `explicit --provider ${opts.provider}`);
  }

  // --local: on-device only, in preference order (embedded → ollama; no surprise LM Studio).
  if (opts.local) {
    const locals = localFallbacks(opts, env, discover, '', { allowLmStudio: false });
    if (locals.length === 0) {
      throw new CliError(
        'no local model backend available for --local. Install a Code Mode (`vg models install spark`), start Ollama (`ollama serve` + pull), or point --provider llama-cpp at a gguf. See `vg models`.',
        ExitCode.NOT_FOUND,
      );
    }
    return finish(locals, '--local (on-device backends only)');
  }

  // No explicit selection: choose from signals already present, best first.
  // 1) Vibgrate Relay — the first-party hosted router, preferred when the user
  // has signed in. Nothing is dialled without their token, so this stays inside
  // the no-surprise-egress rule above.
  if (env.VIBGRATE_RELAY_TOKEN) {
    const model = resolveHostedModel(opts, env, 'vibgrate-relay');
    const primary = buildHosted('vibgrate-relay', model);
    return finish(
      [primary, ...localFallbacks(opts, env, discover, 'vibgrate-relay', { allowLmStudio: false })],
      'VIBGRATE_RELAY_TOKEN is set → Vibgrate Relay (with local fallback)',
    );
  }
  // 2) Another configured hosted router key.
  if (env.OPENROUTER_API_KEY) {
    const model = resolveHostedModel(opts, env, 'openrouter');
    const primary = buildHosted('openrouter', model);
    return finish(
      [primary, ...localFallbacks(opts, env, discover, 'openrouter', { allowLmStudio: false })],
      'OPENROUTER_API_KEY is set → OpenRouter (with local fallback)',
    );
  }
  // 3) A locally-pulled model (embedded first; never auto LM Studio).
  const locals = localFallbacks(opts, env, discover, '', { allowLmStudio: false });
  if (locals.length) return finish(locals, 'a local model is available → on-device (no key needed)');
  // 4) Any other configured hosted key.
  for (const id of ['litellm', 'openai', 'together'] as const) {
    const keyEnv = OPENAI_COMPATIBLE[id].apiKeyEnv;
    if (keyEnv && env[keyEnv]) {
      const model = resolveHostedModel(opts, env, id);
      return finish([buildHosted(id, model)], `${keyEnv} is set → ${OPENAI_COMPATIBLE[id].label}`);
    }
  }

  throw new CliError(
    'no model backend configured. Do one of: sign in to Vibgrate Relay (VIBGRATE_RELAY_TOKEN), set OPENROUTER_API_KEY for the hosted router, run `vg models install spark` for the Vibgrate manager, run Ollama locally, or use --local with a local model. Set the model with --model or VG_CODE_MODEL.',
    ExitCode.NOT_FOUND,
  );
}

function finish(rawProviders: Provider[], reason: string): RouteResult {
  // Every backend gets the tool-call fallback: native providers are passed
  // through (with a text-markup rescue), backends without native function
  // calling (embedded llama.cpp) — and models the capability registry knows
  // cannot tool-call natively — get the prompt-described text protocol. This
  // is what makes the agent work with whatever model is picked underneath.
  const providers = rawProviders.map((p) => withToolCallFallback(p, lookupModelCapabilities(p.model)));
  const primary = providers[0];
  const manager = managerFromProviderId(primary?.id);
  return {
    providers,
    reason,
    manager,
    managerLine: formatManagerBadgeLine(manager, primary?.model),
  };
}

function buildExplicit(id: string, opts: RouteOptions, env: NodeJS.ProcessEnv, discover: () => LocalModel[]): Provider {
  if (id === 'ollama') return new OllamaProvider(resolveLocalModel(opts, discover, 'ollama'), env.OLLAMA_HOST);
  if (id === 'llama-cpp' || id === 'vibgrate') {
    const resolved = resolveGgufPath({
      modelPath: opts.modelPath || env.VG_CODE_MODEL_PATH,
      modelRef: opts.model,
      env,
      discover,
    });
    if (!resolved) {
      throw new CliError(
        '--provider llama-cpp needs a GGUF: pass --model-path, set VG_CODE_MODEL_PATH, or run `vg models install` so the weight store has a catalogued gguf. See `vg models`.',
        ExitCode.USAGE_ERROR,
      );
    }
    return new LocalLlamaProvider(opts.model ?? basename(resolved.path), resolved.path, undefined, !!opts.consent);
  }
  if (id === 'lmstudio') return buildHosted('lmstudio', resolveHostedModel(opts, env, 'lmstudio'));
  if (id === 'foundry-local' || id === 'foundry') {
    return buildHosted('foundry-local', resolveHostedModel(opts, env, 'foundry-local'));
  }
  if (HOSTED_IDS.has(id)) return buildHosted(id, resolveHostedModel(opts, env, id));
  throw new CliError(
    `unknown --provider "${id}". Known: vibgrate-relay, ollama, lmstudio, foundry-local, openrouter, litellm, openai, together, llama-cpp.`,
    ExitCode.USAGE_ERROR,
  );
}

function buildHosted(id: string, model: string): OpenAiCompatibleProvider {
  const base = OPENAI_COMPATIBLE[id];
  const config: OpenAiCompatibleConfig = { ...base, id };
  return new OpenAiCompatibleProvider(model, config);
}

interface LocalFallbackOpts {
  /** Only include LM Studio when the user explicitly asked for it. */
  allowLmStudio: boolean;
}

/** On-device backends in preference order, skipping the one already chosen as primary. */
function localFallbacks(
  opts: RouteOptions,
  env: NodeJS.ProcessEnv,
  discover: () => LocalModel[],
  exclude: string,
  fb: LocalFallbackOpts,
): Provider[] {
  const out: Provider[] = [];
  const models = safeDiscover(discover);

  // Approach B default: when a GGUF is already on disk, embedded is primary local.
  // Opt out with VG_PREFER_OLLAMA=1 if the user wants Ollama first.
  const preferOllama =
    env.VG_PREFER_OLLAMA === '1' ||
    env.VIBGRATE_PREFER_OLLAMA === '1' ||
    opts.preferEmbedded === false;
  const gguf =
    exclude === 'llama-cpp' || exclude === 'vibgrate'
      ? null
      : resolveGgufPath({
          modelPath: opts.modelPath || env.VG_CODE_MODEL_PATH,
          modelRef: opts.model,
          env,
          discover: () => models,
        });

  if (gguf && !preferOllama) {
    out.push(new LocalLlamaProvider(opts.model ?? basename(gguf.path), gguf.path, undefined, !!opts.consent));
  }

  const ollamaModel = opts.model ?? firstOfRuntime(models, 'ollama');
  if (exclude !== 'ollama' && ollamaModel) out.push(new OllamaProvider(ollamaModel, env.OLLAMA_HOST));

  // LM Studio only when explicitly allowed (user chose --provider lmstudio).
  if (fb.allowLmStudio && exclude !== 'lmstudio') {
    const lmModel = opts.model ?? firstOfRuntime(models, 'lm-studio');
    if (lmModel) out.push(buildHosted('lmstudio', lmModel));
  }

  // Foundry Local when server/env is configured.
  if (exclude !== 'foundry-local' && exclude !== 'foundry' && (env.FOUNDRY_LOCAL_BASE_URL || env.VG_CODE_PROVIDER === 'foundry-local')) {
    try {
      const m = opts.model || env.VG_CODE_MODEL;
      if (m) out.push(buildHosted('foundry-local', m));
    } catch {
      /* skip if no model */
    }
  }

  // Embedded last if user forced Ollama-first but GGUF still available.
  if (gguf && !out.some((p) => p.id === 'llama-cpp')) {
    out.push(new LocalLlamaProvider(opts.model ?? basename(gguf.path), gguf.path, undefined, !!opts.consent));
  }
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
