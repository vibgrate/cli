/**
 * Model manager identity + runtime ensure.
 *
 * **Code Modes** always use the first-party **Vibgrate** manager (embedded
 * llama.cpp / vgd host-broker + weight store). Custom local/hosted backends
 * (Ollama, LM Studio, OpenRouter, …) are explicit user choices; when chosen we
 * silently install *our* installable runtime packages for that path (npm
 * bindings), never third-party desktop apps. The user sees a short badge for
 * which manager ran.
 */

import { spawnSync } from 'node:child_process';
import { ensurePackage, isPackageInstalled, type EnsureOptions } from '../code/ensure.js';
import { runtimeDepsForBackend } from './model-install-plan.js';

/** Durable manager ids surfaced in badges and JSON. */
export type ModelManagerId =
  | 'vibgrate'
  | 'ollama'
  | 'lmstudio'
  | 'foundry-local'
  | 'openrouter'
  | 'litellm'
  | 'openai'
  | 'together'
  | 'mock'
  | 'other';

export interface ManagerBadge {
  id: ModelManagerId;
  /** Short product label, e.g. "Vibgrate". */
  label: string;
  /** Compact badge for CLI/UI, e.g. "[Vibgrate]". */
  badge: string;
  /** One-line after-run note. */
  note: string;
}

const LABELS: Record<ModelManagerId, { label: string; note: string }> = {
  vibgrate: {
    label: 'Vibgrate',
    note: 'Code Mode · first-party model manager (embedded inference)',
  },
  ollama: {
    label: 'Ollama',
    note: 'Custom local · Ollama',
  },
  lmstudio: {
    label: 'LM Studio',
    note: 'Custom local · LM Studio',
  },
  'foundry-local': {
    label: 'Foundry Local',
    note: 'Custom local · Foundry Local',
  },
  openrouter: {
    label: 'OpenRouter',
    note: 'Custom hosted · OpenRouter',
  },
  litellm: {
    label: 'LiteLLM',
    note: 'Custom hosted · LiteLLM',
  },
  openai: {
    label: 'OpenAI',
    note: 'Custom hosted · OpenAI',
  },
  together: {
    label: 'Together',
    note: 'Custom hosted · Together',
  },
  mock: {
    label: 'Mock',
    note: 'Scripted offline provider',
  },
  other: {
    label: 'Custom',
    note: 'Custom model backend',
  },
};

/** Map a provider id (`llama-cpp`, `ollama`, …) to a manager badge. */
export function managerFromProviderId(providerId: string | undefined | null): ModelManagerId {
  const id = (providerId ?? '').toLowerCase().trim();
  if (id === 'llama-cpp' || id === 'llama.cpp' || id === 'vibgrate' || id === 'vibgrate-store') return 'vibgrate';
  if (id === 'ollama') return 'ollama';
  if (id === 'lmstudio' || id === 'lm-studio') return 'lmstudio';
  if (id === 'foundry-local' || id === 'foundry') return 'foundry-local';
  if (id === 'openrouter') return 'openrouter';
  if (id === 'litellm') return 'litellm';
  if (id === 'openai') return 'openai';
  if (id === 'together') return 'together';
  if (id === 'mock' || id === 'scripted') return 'mock';
  return 'other';
}

export function managerBadge(id: ModelManagerId): ManagerBadge {
  const meta = LABELS[id] ?? LABELS.other;
  return {
    id,
    label: meta.label,
    badge: `[${meta.label}]`,
    note: meta.note,
  };
}

export function formatManagerBadgeLine(id: ModelManagerId, model?: string): string {
  const b = managerBadge(id);
  const modelPart = model ? ` · ${model}` : '';
  return `${b.badge} ${b.note}${modelPart}`;
}

export interface EnsureManagerRuntimeOptions {
  /** Provider id that will run (llama-cpp, ollama, …). */
  providerId: string;
  /** Model id for weight pull when the backend supports it. */
  model?: string;
  /** `--local` / offline — no network install. */
  offline?: boolean;
  /**
   * Consent to install npm runtime packages (and ollama pull when binary is
   * present). True when the user chose a custom provider/model or passed --yes.
   */
  consent?: boolean;
  /** Injectable ensure (tests). */
  ensurePackage?: typeof ensurePackage;
  /** Injectable PATH binary probe. */
  hasBinary?: (name: string) => boolean;
  /** Injectable ollama pull. */
  ollamaPull?: (name: string) => number;
  onProgress?: (line: string) => void;
}

export interface EnsureManagerRuntimeResult {
  ok: boolean;
  manager: ModelManagerId;
  badge: ManagerBadge;
  /** npm specs installed this call. */
  installed: string[];
  /** Weight refs pulled (e.g. ollama pull). */
  pulled: string[];
  /** Non-fatal notes (e.g. app already present). */
  messages: string[];
  error?: string;
}

function defaultHasBinary(name: string): boolean {
  const res = spawnSync(name, ['--version'], { stdio: 'ignore', encoding: 'utf8' });
  // Some CLIs use subcommands; try bare which-style.
  if (res.status === 0) return true;
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    stdio: 'ignore',
    encoding: 'utf8',
  });
  return which.status === 0;
}

/**
 * Silently install *installable* runtime deps for the chosen manager.
 * Never installs third-party desktop apps (Ollama.app, LM Studio) — those
 * remain user-managed; we only install npm packages into the Vibgrate runtime
 * cache and pull weights when the backend binary is already on PATH.
 */
export async function ensureManagerRuntime(
  opts: EnsureManagerRuntimeOptions,
): Promise<EnsureManagerRuntimeResult> {
  const manager = managerFromProviderId(opts.providerId);
  const badge = managerBadge(manager);
  const installed: string[] = [];
  const pulled: string[] = [];
  const messages: string[] = [];
  const ensure = opts.ensurePackage ?? ensurePackage;
  const hasBinary = opts.hasBinary ?? defaultHasBinary;

  // Hosted OpenAI-compatible backends: no local packages.
  if (
    manager === 'openrouter' ||
    manager === 'litellm' ||
    manager === 'openai' ||
    manager === 'together' ||
    manager === 'mock'
  ) {
    return { ok: true, manager, badge, installed, pulled, messages };
  }

  // LM Studio / Foundry: HTTP clients only — no auto app install (ADR-005).
  if (manager === 'lmstudio' || manager === 'foundry-local') {
    messages.push(
      manager === 'lmstudio'
        ? 'LM Studio must already be running with a model loaded (we never install the app)'
        : 'Foundry Local must already be running (we never install the app)',
    );
    return { ok: true, manager, badge, installed, pulled, messages };
  }

  const backend =
    manager === 'vibgrate' ? 'llama.cpp' : manager === 'ollama' ? 'ollama' : opts.providerId;
  const deps = runtimeDepsForBackend(backend);

  for (const dep of deps) {
    if (dep.kind === 'npm-runtime' && dep.spec) {
      if (isPackageInstalled(dep.spec)) {
        messages.push(`${dep.id} already installed`);
        continue;
      }
      if (opts.offline) {
        return {
          ok: false,
          manager,
          badge,
          installed,
          pulled,
          messages,
          error: `${dep.spec} needed but offline/--local forbids install`,
        };
      }
      if (!opts.consent) {
        return {
          ok: false,
          manager,
          badge,
          installed,
          pulled,
          messages,
          error: `${dep.spec} needed — pass --yes or run \`vg models install\` once`,
        };
      }
      opts.onProgress?.(`installing ${dep.spec}`);
      const ensureOpts: EnsureOptions = {
        consent: true,
        local: false,
        interactive: false,
      };
      const res = await ensure(dep.spec, ensureOpts);
      if (!res.module) {
        return {
          ok: false,
          manager,
          badge,
          installed,
          pulled,
          messages,
          error: `couldn't install ${dep.spec}`,
        };
      }
      installed.push(dep.spec);
      continue;
    }
    if (dep.kind === 'native-binary' && dep.binary) {
      if (!hasBinary(dep.binary)) {
        return {
          ok: false,
          manager,
          badge,
          installed,
          pulled,
          messages,
          error:
            dep.reason ||
            `${dep.binary} is not on PATH — install it once, then re-run (vg never auto-installs third-party apps)`,
        };
      }
      messages.push(`${dep.binary} on PATH`);
    }
  }

  // Optional: when user chose a custom Ollama model, pull weights if missing.
  if (manager === 'ollama' && opts.model && opts.consent && !opts.offline) {
    const list = spawnSync('ollama', ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const have =
      list.status === 0 &&
      (list.stdout ?? '')
        .split('\n')
        .slice(1)
        .some((line) => {
          const name = line.trim().split(/\s+/)[0]?.toLowerCase();
          return name === opts.model!.toLowerCase() || name?.startsWith(`${opts.model!.toLowerCase()}:`);
        });
    if (!have) {
      opts.onProgress?.(`pulling ${opts.model}`);
      const pull = opts.ollamaPull ?? ((name: string) => spawnSync('ollama', ['pull', name], { stdio: 'ignore' }).status ?? 1);
      const status = pull(opts.model);
      if (status !== 0) {
        return {
          ok: false,
          manager,
          badge,
          installed,
          pulled,
          messages,
          error: `ollama pull ${opts.model} failed (exit ${status})`,
        };
      }
      pulled.push(opts.model);
    }
  }

  return { ok: true, manager, badge, installed, pulled, messages };
}
