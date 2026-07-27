/**
 * Model install plan — pure dependency closure for a provider + pack/weights.
 *
 * Used by `vg models install` / `pull` (and hosts that mirror them). Planning is
 * side-effect free; execution lives in `model-install.ts`.
 *
 * schemaVersion: model-install-plan/0
 */

import { isPackageInstalled } from '../code/ensure.js';
import type { PackWeightsRef } from './model-orchestrator.js';
import { isWeightCached, lookupCatalog } from './weight-store.js';

export const MODEL_INSTALL_PLAN_SCHEMA_VERSION = 'model-install-plan/0' as const;

export type RuntimeDepKind = 'npm-runtime' | 'native-binary' | 'weights';

/** Dep/weight readiness: `manual` = user must supply path/app (we do not auto-fetch). */
export type DepStatus = 'satisfied' | 'missing' | 'unmanaged' | 'manual';

export interface ProviderRuntimeDep {
  id: string;
  kind: RuntimeDepKind;
  /** npm install spec, e.g. `node-llama-cpp@^3`. */
  spec?: string;
  /** PATH binary name for native-binary deps. */
  binary?: string;
  /** One-line human reason. */
  reason: string;
  /** When true, npm install may need scripts (surfaced in plan only). */
  requiresInstallScripts?: boolean;
}

export interface PlannedDep extends ProviderRuntimeDep {
  status: DepStatus;
}

export interface ModelInstallPlan {
  schemaVersion: typeof MODEL_INSTALL_PLAN_SCHEMA_VERSION;
  provider: string;
  backend: string;
  model: string;
  mode?: string;
  packId?: string;
  license?: string;
  promise?: string;
  fit?: string;
  runtimeDeps: PlannedDep[];
  weights: {
    channel: 'ollama' | 'local-path' | 'manual' | 'vibgrate';
    ref: string;
    status: DepStatus;
    /** First-party or pack download URL when channel is vibgrate. */
    downloadUrl?: string;
  };
  /** Ids already present (runtime + weights). */
  alreadySatisfied: string[];
  /** npm specs / binary ids we will install (never third-party apps). */
  willInstall: string[];
  /** Weight refs we will download via the backend channel. */
  willDownload: string[];
  /** Things the user must fix outside vg (e.g. install Ollama.app). */
  blocked: Array<{ id: string; reason: string }>;
  offlineBlocked: boolean;
  /** True when nothing remains to install/download and nothing is blocked. */
  ready: boolean;
}

export interface BuildInstallPlanInput {
  backend: PackWeightsRef['backend'] | string;
  weightsRef: string;
  license?: string;
  mode?: string;
  packId?: string;
  promise?: string;
  fit?: string;
  /** Discovered local model names (Ollama / LM Studio / gguf). */
  installedNames?: string[];
  /** When true, network install/download is forbidden. */
  offline?: boolean;
  /** Injectable binary probe (defaults: which/where style via injected map). */
  hasBinary?: (name: string) => boolean;
  /** Injectable npm package probe. */
  isPackageInstalled?: (spec: string) => boolean;
  /** Optional local GGUF path (llama.cpp) — when set, weights are satisfied. */
  modelPath?: string;
  /** Pack/catalog HTTPS URL for first-party GGUF download. */
  downloadUrl?: string;
  /** Optional sha256 for first-party download. */
  sha256?: string;
  /** Injectable weight-cache probe (tests). */
  isWeightCached?: (ref: string) => boolean;
}

/** Runtime deps declared per backend (not third-party app installers). */
export function runtimeDepsForBackend(backend: string): ProviderRuntimeDep[] {
  const b = backend.toLowerCase();
  if (b === 'llama.cpp' || b === 'llama-cpp' || b === 'vibgrate') {
    return [
      {
        id: 'node-llama-cpp',
        kind: 'npm-runtime',
        spec: 'node-llama-cpp@^3',
        reason: 'in-process llama.cpp binding for the first-party / llama-cpp provider',
      },
    ];
  }
  if (b === 'ollama') {
    return [
      {
        id: 'ollama',
        kind: 'native-binary',
        binary: 'ollama',
        reason: 'Ollama on PATH (install from https://ollama.com — third-party apps are not auto-installed)',
      },
    ];
  }
  // LM Studio / Foundry / other: weights managed externally; no auto deps.
  return [];
}

export function weightsChannelForBackend(
  backend: string,
  opts?: { downloadUrl?: string; weightsRef?: string },
): ModelInstallPlan['weights']['channel'] {
  const b = backend.toLowerCase();
  if (b === 'ollama') return 'ollama';
  if (b === 'llama.cpp' || b === 'llama-cpp' || b === 'vibgrate') {
    // Prefer first-party store when we have a catalog/pack URL for this ref.
    if (opts?.downloadUrl || (opts?.weightsRef && lookupCatalog(opts.weightsRef))) return 'vibgrate';
    return 'local-path';
  }
  if (b === 'lm-studio' || b === 'lmstudio' || b === 'foundry-local') return 'manual';
  return 'manual';
}

function weightsInstalled(ref: string, installedNames: string[]): boolean {
  const want = ref.toLowerCase();
  return installedNames.some((n) => {
    const have = n.toLowerCase();
    return have === want || have.includes(want) || want.includes(have);
  });
}

/**
 * Build a side-effect-free install plan for a backend + weight ref.
 */
export function buildModelInstallPlan(input: BuildInstallPlanInput): ModelInstallPlan {
  const hasBinary = input.hasBinary ?? (() => false);
  const pkgInstalled = input.isPackageInstalled ?? isPackageInstalled;
  const installedNames = input.installedNames ?? [];
  const offline = !!input.offline;
  const backend = input.backend;
  const provider = providerLabel(backend);

  const runtimeDeps: PlannedDep[] = runtimeDepsForBackend(backend).map((dep) => {
    if (dep.kind === 'npm-runtime' && dep.spec) {
      return { ...dep, status: pkgInstalled(dep.spec) ? 'satisfied' : 'missing' };
    }
    if (dep.kind === 'native-binary' && dep.binary) {
      // Present → satisfied; absent → unmanaged (we never install third-party apps).
      return { ...dep, status: hasBinary(dep.binary) ? 'satisfied' : 'unmanaged' };
    }
    return { ...dep, status: 'unmanaged' as const };
  });

  const channel = weightsChannelForBackend(backend, {
    downloadUrl: input.downloadUrl,
    weightsRef: input.weightsRef,
  });
  const weightCached = (input.isWeightCached ?? isWeightCached)(input.weightsRef);
  const catalog = lookupCatalog(input.weightsRef);
  const downloadUrl = input.downloadUrl ?? catalog?.url;

  let weightsStatus: DepStatus = 'missing';
  if (channel === 'ollama') {
    weightsStatus = weightsInstalled(input.weightsRef, installedNames) ? 'satisfied' : 'missing';
  } else if (channel === 'vibgrate') {
    weightsStatus =
      weightCached || weightsInstalled(input.weightsRef, installedNames) || !!input.modelPath ? 'satisfied' : 'missing';
  } else if (channel === 'local-path') {
    // Satisfied only when caller reports the model (path) already discoverable.
    weightsStatus = weightsInstalled(input.weightsRef, installedNames) || !!input.modelPath || weightCached ? 'satisfied' : 'manual';
  } else {
    weightsStatus = weightsInstalled(input.weightsRef, installedNames) ? 'satisfied' : 'manual';
  }

  const alreadySatisfied: string[] = [];
  const willInstall: string[] = [];
  const willDownload: string[] = [];
  const blocked: Array<{ id: string; reason: string }> = [];

  for (const dep of runtimeDeps) {
    if (dep.status === 'satisfied') {
      alreadySatisfied.push(dep.id);
      continue;
    }
    if (dep.kind === 'npm-runtime' && dep.spec && dep.status === 'missing') {
      if (offline) {
        blocked.push({ id: dep.id, reason: `${dep.spec} needed but --local/offline forbids install` });
      } else {
        willInstall.push(dep.spec);
      }
      continue;
    }
    if (dep.kind === 'native-binary' && dep.status === 'unmanaged') {
      blocked.push({
        id: dep.id,
        reason: dep.reason,
      });
    }
  }

  if (weightsStatus === 'satisfied') {
    alreadySatisfied.push(`weights:${input.weightsRef}`);
  } else if (weightsStatus === 'missing' && (channel === 'ollama' || channel === 'vibgrate')) {
    if (offline) {
      blocked.push({ id: `weights:${input.weightsRef}`, reason: 'weights missing and --local/offline forbids download' });
    } else if (channel === 'ollama' && runtimeDeps.some((d) => d.id === 'ollama' && d.status === 'unmanaged')) {
      willDownload.push(input.weightsRef);
    } else if (channel === 'vibgrate' && !downloadUrl) {
      blocked.push({
        id: `weights:${input.weightsRef}`,
        reason: `no first-party download URL for ${input.weightsRef} — place a gguf in the weight store or pass --model-path`,
      });
    } else {
      willDownload.push(input.weightsRef);
    }
  } else if (weightsStatus === 'manual' || weightsStatus === 'missing') {
    blocked.push({
      id: `weights:${input.weightsRef}`,
      reason:
        channel === 'local-path'
          ? `point --model-path at a local gguf for ${input.weightsRef}, or run install when a first-party URL is catalogued`
          : `install or link weights for ${input.weightsRef} via the backend app`,
    });
  }

  // Under offline, do not claim we will download/install — those land in blocked.
  const effectiveWillInstall = offline ? [] : willInstall;
  const effectiveWillDownload = offline ? [] : willDownload;
  const offlineBlocked = offline && blocked.some((b) => /offline|forbids/i.test(b.reason));

  const allRuntimeOk = runtimeDeps.every((d) => d.status === 'satisfied');
  const fullyReady = allRuntimeOk && weightsStatus === 'satisfied' && blocked.length === 0;

  return {
    schemaVersion: MODEL_INSTALL_PLAN_SCHEMA_VERSION,
    provider,
    backend,
    model: input.weightsRef,
    mode: input.mode,
    packId: input.packId,
    license: input.license,
    promise: input.promise,
    fit: input.fit,
    runtimeDeps,
    weights: {
      channel,
      ref: input.weightsRef,
      status: weightsStatus,
      downloadUrl: channel === 'vibgrate' ? downloadUrl : undefined,
    },
    alreadySatisfied,
    willInstall: effectiveWillInstall,
    willDownload: effectiveWillDownload,
    blocked,
    offlineBlocked,
    ready: fullyReady,
  };
}

function providerLabel(backend: string): string {
  const b = backend.toLowerCase();
  if (b === 'llama.cpp' || b === 'llama-cpp') return 'llama-cpp';
  if (b === 'vibgrate') return 'vibgrate';
  if (b === 'lm-studio' || b === 'lmstudio') return 'lmstudio';
  if (b === 'foundry-local') return 'foundry-local';
  return b === 'ollama' ? 'ollama' : backend;
}
