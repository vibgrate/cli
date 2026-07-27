/**
 * Local inference diagnosis for `vg doctor` / operators (Approach B / P4).
 *
 * Read-only snapshot: isolation env, weight catalog integrity, warm host pool,
 * recommended Code Mode from live RAM/VRAM, dynamic-sampler env flags.
 * Never prints secrets or weight paths outside the cache dir basename.
 */

import type { SystemMemory } from '../code/capability.js';
import { resolveInferenceIsolation } from './llm-host/index.js';
import { listHostSessions, hostSessionPoolSize, type HostSessionInfo } from './llm-host/session.js';
import {
  catalogIntegrityReport,
  listCachedWeights,
  weightStoreDir,
  type CatalogIntegrityReport,
} from './weight-store.js';
import type { ModelMode } from './model-execution-profile.js';
import { recommendMode, type RepoSignals } from './model-orchestrator.js';

export const LOCAL_INFERENCE_STATUS_SCHEMA = 'local-inference-status/0' as const;

export interface LocalInferenceStatus {
  schemaVersion: typeof LOCAL_INFERENCE_STATUS_SCHEMA;
  isolation: 'embedded' | 'process';
  isolationSource: 'env' | 'default';
  dynamicOnToken: boolean;
  dynamicCustomSampler: boolean;
  preferOllama: boolean;
  weightCatalog: CatalogIntegrityReport;
  weightStore: { dir: string; cachedGgufs: number; names: string[] };
  hostPool: {
    size: number;
    sessions: HostSessionInfo[];
  };
  recommendedMode: ModelMode;
  memory: {
    freeRamBytes: number;
    totalRamBytes: number;
    vramFreeBytes?: number;
    vramTotalBytes?: number;
    loadedModels: number;
  };
  hints: string[];
}

export function buildLocalInferenceStatus(opts: {
  system: SystemMemory;
  repo?: RepoSignals;
  env?: NodeJS.ProcessEnv;
}): LocalInferenceStatus {
  const env = opts.env ?? process.env;
  const isolationEnv = (env.VIBGRATE_INFERENCE_ISOLATION || env.VG_INFERENCE_ISOLATION || '').trim();
  const isolation = resolveInferenceIsolation(undefined, env);
  const dynamicOnToken = /^(1|true|yes)$/i.test(String(env.VG_LLM_ON_TOKEN ?? env.VIBGRATE_LLM_ON_TOKEN ?? ''));
  const dynamicCustomSampler = /^(1|true|yes)$/i.test(String(env.VG_LLM_CUSTOM_SAMPLER ?? ''));
  const preferOllama = /^(1|true|yes)$/i.test(String(env.VG_PREFER_OLLAMA ?? ''));
  const weightCatalog = catalogIntegrityReport();
  const cached = listCachedWeights(env);
  const sessions = listHostSessions();
  const recommendedMode = recommendMode(opts.system, opts.repo);

  const hints: string[] = [];
  if (!weightCatalog.complete) {
    hints.push(`weight catalog unpinned: ${weightCatalog.unpinned.join(', ')}`);
  }
  if (cached.length === 0) {
    hints.push('no first-party GGUF in weight store — `vg models install` for embedded path');
  }
  if (preferOllama) {
    hints.push('VG_PREFER_OLLAMA=1 — embedded GGUF is deprioritized');
  }
  if (isolation === 'process') {
    hints.push('process isolation — start `vg llm-host serve` when using VIBGRATE_INFERENCE_ISOLATION=process');
  }
  if (!dynamicOnToken && !dynamicCustomSampler) {
    hints.push('dynamic open-ident sampler off — set VG_LLM_ON_TOKEN=1 when the binding supports it');
  }
  if (opts.system.freeRamBytes < 2 * 1024 ** 3) {
    hints.push('low free RAM (<2 GiB) — prefer Spark or free memory before Flow/Forge');
  }

  return {
    schemaVersion: LOCAL_INFERENCE_STATUS_SCHEMA,
    isolation,
    isolationSource: isolationEnv ? 'env' : 'default',
    dynamicOnToken,
    dynamicCustomSampler,
    preferOllama,
    weightCatalog,
    weightStore: {
      dir: weightStoreDir(env),
      cachedGgufs: cached.length,
      names: cached.map((w) => w.name).slice(0, 12),
    },
    hostPool: {
      size: hostSessionPoolSize(),
      sessions,
    },
    recommendedMode,
    memory: {
      freeRamBytes: opts.system.freeRamBytes,
      totalRamBytes: opts.system.totalRamBytes,
      ...(typeof opts.system.vramFreeBytes === 'number' ? { vramFreeBytes: opts.system.vramFreeBytes } : {}),
      ...(typeof opts.system.vramTotalBytes === 'number' ? { vramTotalBytes: opts.system.vramTotalBytes } : {}),
      loadedModels: opts.system.loaded.length,
    },
    hints,
  };
}

/** Apply hardware recommendation as pinned default when unset (opt-in). */
export function applyRecommendedDefaultMode(opts: {
  system: SystemMemory;
  repo?: RepoSignals;
  /** Current pinned default, if any. */
  currentDefault?: ModelMode | null;
  setDefault: (mode: ModelMode) => void;
}): { applied: boolean; mode: ModelMode; reason: string } {
  const recommended = recommendMode(opts.system, opts.repo);
  if (opts.currentDefault) {
    return {
      applied: false,
      mode: opts.currentDefault,
      reason: `default already pinned to ${opts.currentDefault}`,
    };
  }
  opts.setDefault(recommended);
  return {
    applied: true,
    mode: recommended,
    reason: `pinned default to ${recommended} from RAM/VRAM + repo fit`,
  };
}
