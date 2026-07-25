/**
 * Model Execution Profile (Fusion Runtime Phase 4 / ADR-style contract).
 *
 * Per-model knobs for capsule budget, repair rounds, tool-calling mode, and
 * resource hints. Pure resolve helpers — no I/O. Schema:
 * docs/fusion/model-execution-profile-v0.schema.json
 *
 * {@link resolveModelExecutionProfile} prefers the first-party catalogue
 * ({@link matchCatalogueProfile}) before size/provider heuristics.
 */

import { matchCatalogueProfile } from './model-execution-catalogue.js';

export const MODEL_EXECUTION_PROFILE_SCHEMA_VERSION = 'model-execution-profile/0' as const;

export type ModelMode = 'spark' | 'flow' | 'forge';
export type ToolCallingMode = 'native' | 'grammar' | 'disabled';
export type EditFormatPreference = 'search_replace' | 'patch_ir_json' | 'whole_file' | 'auto';

export interface ModelExecutionProfile {
  schemaVersion: typeof MODEL_EXECUTION_PROFILE_SCHEMA_VERSION;
  /** Stable id, e.g. "qwen2.5-coder-7b-q4_k_m". */
  id: string;
  displayName?: string;
  mode: ModelMode;
  backend?: 'ollama' | 'llama.cpp' | 'mlx' | 'openai-compatible' | 'other';
  toolCalling: ToolCallingMode;
  editFormat: EditFormatPreference;
  /** Soft token budget for the capsule body (excluding system/tools). */
  capsuleBudgetTokens: number;
  maxParallelEdits: number;
  maxRepairRounds: number;
  temperature?: number;
  constrainedDecoding: boolean;
  kvCacheStrategy?: 'stable_prefix' | 'full_reprefill' | 'auto';
  resources?: {
    minRamGb?: number;
    minVramGb?: number;
    quant?: string;
  };
  /** Preferred security tier for agent shell under this profile. */
  securityTier?: 'L0' | 'L1' | 'L2' | 'L3';
}

export interface ResolveMepOptions {
  id?: string;
  displayName?: string;
  backend?: ModelExecutionProfile['backend'];
  mode?: ModelMode;
  /** Override capsule budget (from --budget / code.json). */
  capsuleBudgetTokens?: number;
  maxRepairRounds?: number;
  securityTier?: ModelExecutionProfile['securityTier'];
  quant?: string;
}

/** Default Flow-tier profile for a general coding model. */
export function defaultModelExecutionProfile(partial: ResolveMepOptions = {}): ModelExecutionProfile {
  const id = partial.id?.trim() || 'default';
  return {
    schemaVersion: MODEL_EXECUTION_PROFILE_SCHEMA_VERSION,
    id,
    displayName: partial.displayName ?? id,
    mode: partial.mode ?? 'flow',
    backend: partial.backend ?? 'other',
    toolCalling: 'native',
    editFormat: 'auto',
    capsuleBudgetTokens: partial.capsuleBudgetTokens ?? 3000,
    maxParallelEdits: 4,
    maxRepairRounds: partial.maxRepairRounds ?? 2,
    temperature: 0,
    constrainedDecoding: false,
    kvCacheStrategy: 'stable_prefix',
    resources: partial.quant ? { quant: partial.quant } : undefined,
    securityTier: partial.securityTier,
  };
}

/**
 * Resolve a profile from loose provider/model metadata.
 * Heuristics only — never invents capabilities not implied by the id.
 */
export function resolveModelExecutionProfile(input: {
  providerId?: string;
  model?: string;
  budget?: number;
  maxRepairRounds?: number;
  securityTier?: ModelExecutionProfile['securityTier'];
}): ModelExecutionProfile {
  const model = (input.model ?? '').trim();
  const provider = (input.providerId ?? '').toLowerCase();

  // Catalogue first (curated local + common hosted coding models).
  const catalogued = matchCatalogueProfile(model);
  if (catalogued) {
    return {
      ...catalogued,
      id: model || catalogued.id,
      displayName: model || catalogued.displayName,
      capsuleBudgetTokens: input.budget ?? catalogued.capsuleBudgetTokens,
      maxRepairRounds: input.maxRepairRounds ?? catalogued.maxRepairRounds,
      securityTier: input.securityTier ?? catalogued.securityTier,
      backend:
        provider === 'ollama'
          ? 'ollama'
          : provider === 'llama-cpp' || provider === 'llamacpp'
            ? 'llama.cpp'
            : provider === 'lmstudio' || provider === 'openrouter' || provider === 'openai' || provider === 'together'
              ? 'openai-compatible'
              : catalogued.backend,
    };
  }

  const backend: ModelExecutionProfile['backend'] =
    provider === 'ollama'
      ? 'ollama'
      : provider === 'llama-cpp' || provider === 'llamacpp'
        ? 'llama.cpp'
        : provider === 'lmstudio' || provider === 'openrouter' || provider === 'openai' || provider === 'together'
          ? 'openai-compatible'
          : 'other';

  let mode: ModelMode = 'flow';
  const m = model.toLowerCase();
  if (/\b(1\.5b|1b|3b|0\.5b|tiny|mini)\b/.test(m)) mode = 'spark';
  if (/\b(32b|70b|72b|405b|large|opus|sonnet)\b/.test(m)) mode = 'forge';

  const quant = /\bq[2-8](_[a-z0-9]+)?\b/i.exec(model)?.[0];

  return defaultModelExecutionProfile({
    id: model || provider || 'default',
    displayName: model || provider || 'default',
    backend,
    mode,
    capsuleBudgetTokens: input.budget,
    maxRepairRounds: input.maxRepairRounds,
    securityTier: input.securityTier,
    quant: quant ?? undefined,
  });
}

/** Sanitize untrusted JSON into a partial profile (config file). */
export function parseModelExecutionProfile(raw: unknown): Partial<ModelExecutionProfile> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: Partial<ModelExecutionProfile> = {};
  if (typeof o.id === 'string' && o.id.trim()) out.id = o.id.trim();
  if (typeof o.displayName === 'string') out.displayName = o.displayName;
  if (o.mode === 'spark' || o.mode === 'flow' || o.mode === 'forge') out.mode = o.mode;
  if (
    o.backend === 'ollama' ||
    o.backend === 'llama.cpp' ||
    o.backend === 'mlx' ||
    o.backend === 'openai-compatible' ||
    o.backend === 'other'
  ) {
    out.backend = o.backend;
  }
  if (o.toolCalling === 'native' || o.toolCalling === 'grammar' || o.toolCalling === 'disabled') {
    out.toolCalling = o.toolCalling;
  }
  if (
    o.editFormat === 'search_replace' ||
    o.editFormat === 'patch_ir_json' ||
    o.editFormat === 'whole_file' ||
    o.editFormat === 'auto'
  ) {
    out.editFormat = o.editFormat;
  }
  if (typeof o.capsuleBudgetTokens === 'number' && o.capsuleBudgetTokens > 0) {
    out.capsuleBudgetTokens = Math.floor(o.capsuleBudgetTokens);
  }
  if (typeof o.maxParallelEdits === 'number' && o.maxParallelEdits > 0) {
    out.maxParallelEdits = Math.floor(o.maxParallelEdits);
  }
  if (typeof o.maxRepairRounds === 'number' && o.maxRepairRounds >= 0) {
    out.maxRepairRounds = Math.floor(o.maxRepairRounds);
  }
  if (typeof o.temperature === 'number') out.temperature = o.temperature;
  if (typeof o.constrainedDecoding === 'boolean') out.constrainedDecoding = o.constrainedDecoding;
  if (o.securityTier === 'L0' || o.securityTier === 'L1' || o.securityTier === 'L2' || o.securityTier === 'L3') {
    out.securityTier = o.securityTier;
  }
  return out;
}

/** Merge a partial override onto a base profile (config wins on set fields). */
export function mergeModelExecutionProfile(
  base: ModelExecutionProfile,
  override: Partial<ModelExecutionProfile> | null | undefined,
): ModelExecutionProfile {
  if (!override) return base;
  return {
    ...base,
    ...override,
    schemaVersion: MODEL_EXECUTION_PROFILE_SCHEMA_VERSION,
    id: override.id ?? base.id,
    resources: override.resources ?? base.resources,
  };
}
