/**
 * First-party Model Execution Profile catalogue (Fusion Phase 4/7).
 *
 * Named profiles for common local coding models. resolveModelExecutionProfile
 * matches the model slug against this list before falling back to heuristics.
 * Pure data + pure match — no I/O.
 */

import {
  MODEL_EXECUTION_PROFILE_SCHEMA_VERSION,
  type ModelExecutionProfile,
  type ModelMode,
} from './model-execution-profile.js';

export interface CatalogueEntry {
  /** Substrings matched against the model id (case-insensitive). Longest match wins. */
  match: string[];
  profile: Omit<ModelExecutionProfile, 'schemaVersion' | 'id' | 'displayName'> & {
    id?: string;
    displayName?: string;
  };
}

/**
 * Curated local coding models. Spark = small/fast; Flow = default coding;
 * Forge = large reasoning. Capsule budgets and repair rounds are conservative.
 */
export const MODEL_EXECUTION_CATALOGUE: CatalogueEntry[] = [
  {
    match: ['qwen2.5-coder:1.5b', 'qwen2.5-coder:3b', 'qwen2.5:1.5b', 'qwen2.5:3b'],
    profile: {
      mode: 'spark',
      backend: 'ollama',
      toolCalling: 'native',
      editFormat: 'search_replace',
      capsuleBudgetTokens: 2000,
      maxParallelEdits: 2,
      maxRepairRounds: 2,
      temperature: 0,
      constrainedDecoding: true,
      kvCacheStrategy: 'stable_prefix',
      resources: { minRamGb: 4, quant: 'q4_k_m' },
      securityTier: 'L1',
    },
  },
  {
    match: ['qwen2.5-coder:7b', 'qwen2.5-coder:14b', 'qwen2.5:7b', 'qwen2.5:14b'],
    profile: {
      mode: 'flow',
      backend: 'ollama',
      toolCalling: 'native',
      editFormat: 'auto',
      capsuleBudgetTokens: 3500,
      maxParallelEdits: 4,
      maxRepairRounds: 2,
      temperature: 0,
      constrainedDecoding: false,
      kvCacheStrategy: 'stable_prefix',
      resources: { minRamGb: 8, minVramGb: 6, quant: 'q4_k_m' },
      securityTier: 'L1',
    },
  },
  {
    match: ['qwen2.5-coder:32b', 'qwen2.5:32b', 'qwen2.5:72b'],
    profile: {
      mode: 'forge',
      backend: 'ollama',
      toolCalling: 'native',
      editFormat: 'patch_ir_json',
      capsuleBudgetTokens: 6000,
      maxParallelEdits: 6,
      maxRepairRounds: 3,
      temperature: 0,
      constrainedDecoding: false,
      kvCacheStrategy: 'stable_prefix',
      resources: { minRamGb: 24, minVramGb: 20, quant: 'q4_k_m' },
      securityTier: 'L1',
    },
  },
  {
    match: ['deepseek-coder', 'deepseek-coder-v2'],
    profile: {
      mode: 'flow',
      backend: 'ollama',
      toolCalling: 'native',
      editFormat: 'auto',
      capsuleBudgetTokens: 4000,
      maxParallelEdits: 4,
      maxRepairRounds: 2,
      temperature: 0,
      constrainedDecoding: false,
      kvCacheStrategy: 'stable_prefix',
      resources: { minRamGb: 12, quant: 'q4_k_m' },
      securityTier: 'L1',
    },
  },
  {
    match: ['codellama:7b', 'codellama:13b', 'codegemma'],
    profile: {
      mode: 'flow',
      backend: 'ollama',
      toolCalling: 'native',
      editFormat: 'search_replace',
      capsuleBudgetTokens: 3000,
      maxParallelEdits: 3,
      maxRepairRounds: 2,
      temperature: 0,
      constrainedDecoding: true,
      kvCacheStrategy: 'stable_prefix',
      resources: { minRamGb: 8, quant: 'q4_k_m' },
      securityTier: 'L1',
    },
  },
  {
    match: ['llama3.1:8b', 'llama3.2:3b', 'llama3.2:1b'],
    profile: {
      mode: 'spark',
      backend: 'ollama',
      toolCalling: 'native',
      editFormat: 'search_replace',
      capsuleBudgetTokens: 2500,
      maxParallelEdits: 2,
      maxRepairRounds: 2,
      temperature: 0,
      constrainedDecoding: true,
      kvCacheStrategy: 'stable_prefix',
      resources: { minRamGb: 6, quant: 'q4_k_m' },
      securityTier: 'L1',
    },
  },
  {
    match: ['granite-code:3b', 'granite-code:8b'],
    profile: {
      mode: 'spark',
      backend: 'ollama',
      toolCalling: 'native',
      editFormat: 'search_replace',
      capsuleBudgetTokens: 2500,
      maxParallelEdits: 2,
      maxRepairRounds: 2,
      temperature: 0,
      constrainedDecoding: true,
      kvCacheStrategy: 'stable_prefix',
      resources: { minRamGb: 4, quant: 'q4_k_m' },
      securityTier: 'L1',
    },
  },
  {
    match: ['granite-code:20b', 'granite-code:34b'],
    profile: {
      mode: 'flow',
      backend: 'ollama',
      toolCalling: 'native',
      editFormat: 'auto',
      capsuleBudgetTokens: 3500,
      maxParallelEdits: 4,
      maxRepairRounds: 2,
      temperature: 0,
      constrainedDecoding: false,
      kvCacheStrategy: 'stable_prefix',
      resources: { minRamGb: 16, minVramGb: 12, quant: 'q4_k_m' },
      securityTier: 'L1',
    },
  },
  {
    match: ['claude-3.5-sonnet', 'claude-sonnet', 'claude-3-opus', 'gpt-4o', 'o1', 'o3'],
    profile: {
      mode: 'forge',
      backend: 'openai-compatible',
      toolCalling: 'native',
      editFormat: 'auto',
      capsuleBudgetTokens: 5000,
      maxParallelEdits: 6,
      maxRepairRounds: 3,
      temperature: 0,
      constrainedDecoding: false,
      kvCacheStrategy: 'stable_prefix',
      securityTier: 'L1',
    },
  },
];

/**
 * Find the best catalogue entry for a model slug (longest match substring wins).
 */
export function matchCatalogueProfile(model: string): ModelExecutionProfile | null {
  const m = model.trim().toLowerCase();
  if (!m) return null;
  let best: { len: number; entry: CatalogueEntry; needle: string } | null = null;
  for (const entry of MODEL_EXECUTION_CATALOGUE) {
    for (const needle of entry.match) {
      const n = needle.toLowerCase();
      if (m.includes(n) && (!best || n.length > best.len)) {
        best = { len: n.length, entry, needle: n };
      }
    }
  }
  if (!best) return null;
  const p = best.entry.profile;
  return {
    schemaVersion: MODEL_EXECUTION_PROFILE_SCHEMA_VERSION,
    id: p.id ?? model.trim(),
    displayName: p.displayName ?? model.trim(),
    mode: p.mode as ModelMode,
    backend: p.backend,
    toolCalling: p.toolCalling,
    editFormat: p.editFormat,
    capsuleBudgetTokens: p.capsuleBudgetTokens,
    maxParallelEdits: p.maxParallelEdits,
    maxRepairRounds: p.maxRepairRounds,
    temperature: p.temperature,
    constrainedDecoding: p.constrainedDecoding,
    kvCacheStrategy: p.kvCacheStrategy,
    resources: p.resources,
    securityTier: p.securityTier,
  };
}

/** All catalogue ids/needles for `vg models` / docs listing. */
export function listCatalogueNeedles(): string[] {
  return MODEL_EXECUTION_CATALOGUE.flatMap((e) => e.match).sort((a, b) => a.localeCompare(b));
}
