/**
 * Execute a {@link ModelInstallPlan}: install npm runtime deps, pull weights
 * via backend channels. Invoked only when the user ran a named install command
 * (install/pull) without `--dry-run` — that intent is the consent boundary.
 */

import { spawnSync } from 'node:child_process';
import { ensurePackage, ensureUnavailableMessage, type EnsureOptions } from '../code/ensure.js';
import type { ModelInstallPlan } from './model-install-plan.js';
import { ensureWeightCached, type DownloadWeightResult } from './weight-store.js';

export interface ExecuteInstallOptions {
  /** When true, refuse network install/download. */
  offline?: boolean;
  /** Quiet JSON mode — no inherited stdio on pulls. */
  quiet?: boolean;
  /** Injectable npm ensure (tests). */
  ensurePackage?: typeof ensurePackage;
  /** Injectable ollama pull (tests). Returns exit status. */
  ollamaPull?: (name: string, quiet: boolean) => number;
  /** Injectable first-party weight download (tests). */
  ensureWeightCached?: typeof ensureWeightCached;
  onProgress?: (line: string) => void;
}

export interface ExecuteInstallResult {
  ok: boolean;
  plan: ModelInstallPlan;
  installedDeps: string[];
  pulledWeights: string[];
  error?: string;
}

/**
 * Run the plan. Install-command invocation implies consent for npm runtime deps
 * and weight downloads listed in the plan. Never installs third-party apps
 * (Ollama/LM Studio) — those stay in `plan.blocked`.
 */
export async function executeModelInstallPlan(
  plan: ModelInstallPlan,
  options: ExecuteInstallOptions = {},
): Promise<ExecuteInstallResult> {
  const installedDeps: string[] = [];
  const pulledWeights: string[] = [];
  const ensure = options.ensurePackage ?? ensurePackage;
  const quiet = !!options.quiet;

  if (options.offline || plan.offlineBlocked) {
    const blocked = plan.blocked[0];
    return {
      ok: false,
      plan,
      installedDeps,
      pulledWeights,
      error: blocked?.reason ?? 'install blocked under --local/offline',
    };
  }

  if (plan.blocked.some((b) => b.id === 'ollama' || plan.runtimeDeps.some((d) => d.id === b.id && d.kind === 'native-binary'))) {
    const b = plan.blocked.find((x) => plan.runtimeDeps.some((d) => d.id === x.id && d.kind === 'native-binary')) ?? plan.blocked[0];
    if (b && plan.runtimeDeps.some((d) => d.id === b.id && d.kind === 'native-binary')) {
      return { ok: false, plan, installedDeps, pulledWeights, error: b.reason };
    }
  }

  // Fail fast on unmanaged native binaries (we never brew-install them).
  for (const b of plan.blocked) {
    const dep = plan.runtimeDeps.find((d) => d.id === b.id);
    if (dep?.kind === 'native-binary') {
      return { ok: false, plan, installedDeps, pulledWeights, error: b.reason };
    }
  }

  for (const spec of plan.willInstall) {
    options.onProgress?.(`installing runtime dep ${spec}`);
    const ensureOpts: EnsureOptions = {
      consent: true, // named install command is the consent
      local: false,
      interactive: false,
    };
    const res = await ensure(spec, ensureOpts);
    if (!res.module) {
      return {
        ok: false,
        plan,
        installedDeps,
        pulledWeights,
        error: ensureUnavailableMessage(res.reason ?? 'install-failed', spec),
      };
    }
    installedDeps.push(spec);
  }

  for (const ref of plan.willDownload) {
    if (plan.weights.channel === 'ollama') {
      options.onProgress?.(`pulling ${ref}`);
      const pull = options.ollamaPull ?? defaultOllamaPull;
      const status = pull(ref, quiet);
      if (status !== 0) {
        return {
          ok: false,
          plan,
          installedDeps,
          pulledWeights,
          error: `\`ollama pull ${ref}\` failed (exit ${status}) — check network and model name`,
        };
      }
      pulledWeights.push(ref);
      continue;
    }
    if (plan.weights.channel === 'vibgrate') {
      options.onProgress?.(`downloading ${ref} (first-party weight store)`);
      const ensureW = options.ensureWeightCached ?? ensureWeightCached;
      const wres: DownloadWeightResult = await ensureW(ref, {
        url: plan.weights.downloadUrl,
        onProgress: options.onProgress,
      });
      if (!wres.ok) {
        return {
          ok: false,
          plan,
          installedDeps,
          pulledWeights,
          error: wres.error ?? `weight download failed for ${ref}`,
        };
      }
      pulledWeights.push(ref);
      continue;
    }
    return {
      ok: false,
      plan,
      installedDeps,
      pulledWeights,
      error: `no automatic download channel for backend ${plan.backend} (weights ref ${ref})`,
    };
  }

  // Manual weight channels: if still not ready after deps, surface blocked reason.
  if (plan.willDownload.length === 0 && plan.weights.status !== 'satisfied') {
    const weightBlock = plan.blocked.find((b) => b.id.startsWith('weights:'));
    if (weightBlock && installedDeps.length === 0 && plan.willInstall.length === 0) {
      // Purely blocked on weights with nothing we can do.
      return { ok: false, plan, installedDeps, pulledWeights, error: weightBlock.reason };
    }
    if (weightBlock && plan.willInstall.length > 0 && installedDeps.length === plan.willInstall.length) {
      // Deps installed but weights still manual — partial success with guidance.
      return {
        ok: false,
        plan,
        installedDeps,
        pulledWeights,
        error: weightBlock.reason,
      };
    }
  }

  return { ok: true, plan, installedDeps, pulledWeights };
}

function defaultOllamaPull(name: string, quiet: boolean): number {
  const res = spawnSync('ollama', ['pull', name], { stdio: quiet ? 'ignore' : 'inherit' });
  return res.status ?? 1;
}
