/**
 * Vibgrate Model Orchestrator — Code Modes (Spark / Flow / Forge).
 *
 * Product stance (PRD): users and agents select outcome-oriented **Code Modes**,
 * never GGUF names by default. This module:
 *  1. Declares versioned **qualified packs** (contract + primary/fallback weights)
 *  2. Runs a **fit** algorithm (available memory now × reserves × repo signals)
 *  3. Resolves mode → pack → concrete model / backend
 *  4. Supports pin/unpin for reproducibility
 *
 * Pure resolve + fit helpers have no I/O. Registry pin state uses the global
 * Vibgrate data dir (never in-repo). Pull/ensure is a separate CLI concern that
 * calls into `vg models pull` after resolve.
 *
 * schemaVersion: model-orchestrator/0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { estimateModelBytes, type SystemMemory } from '../code/capability.js';
import {
  MODEL_EXECUTION_PROFILE_SCHEMA_VERSION,
  type ModelExecutionProfile,
  type ModelMode,
  type ToolCallingMode,
  type EditFormatPreference,
} from './model-execution-profile.js';
import { vibgrateDataDir } from './paths.js';

export const MODEL_ORCHESTRATOR_SCHEMA_VERSION = 'model-orchestrator/0' as const;

/** UX fit vocabulary (stricter than “weights fit”). */
export type FitLabel = 'flies' | 'comfortable' | 'tight' | 'will_not_fit';

export type TaskClass = 'spark_task' | 'flow_task' | 'forge_task' | 'explicit_mode';

export interface PackWeightsRef {
  /** Backend that can load these weights. */
  backend: 'ollama' | 'llama.cpp' | 'lm-studio' | 'foundry-local' | 'other';
  /** Concrete model id / slug (e.g. qwen2.5-coder:3b). */
  weightsRef: string;
  quant?: string;
  /** SPDX / short license note for first-download surface. */
  license?: string;
  /** Approx weights size in bytes (for fit when not discoverable). */
  weightsBytes?: number;
  /**
   * Optional HTTPS GGUF URL for the first-party weight store (must pass host
   * allowlist). When set, `vg models install` can download without Ollama.
   */
  downloadUrl?: string;
  /** Optional content hash for downloaded GGUF. */
  sha256?: string;
}

export interface PackContract {
  toolCalling: ToolCallingMode;
  editFormat: EditFormatPreference;
  capsuleBudgetTokens: number;
  maxRepairRounds: number;
  maxParallelEdits: number;
  /** Minimum qualification score (0–1) this pack was gated on. */
  minEffectiveScore?: number;
  constrainedDecoding?: boolean;
  kvCacheStrategy?: ModelExecutionProfile['kvCacheStrategy'];
  securityTier?: ModelExecutionProfile['securityTier'];
  /**
   * Preferred inference path when available (ADR-005). Weights may still be
   * pulled via Ollama; embedded llama.cpp is preferred for sampler/grammar.
   */
  preferredInference?: 'ollama' | 'llama.cpp';
  /** Process isolation for preferredInference llama.cpp (default embedded). */
  inferenceIsolation?: ModelExecutionProfile['inferenceIsolation'];
}

export interface QualifiedPack {
  /** e.g. flow@2026.07.1 */
  packId: string;
  mode: ModelMode;
  displayName: string;
  /** User-facing promise (one line). */
  promise: string;
  primary: PackWeightsRef;
  fallback?: PackWeightsRef[];
  contract: PackContract;
  resources: {
    minRamGb: number;
    minVramGb?: number;
    /** Estimated KV cache bytes per 1k context tokens. */
    estimatedKvPer1kContext?: number;
  };
  provenance?: {
    evalRunIds?: string[];
    notes?: string;
  };
}

export interface RepoSignals {
  /** Approximate source file count (0 = unknown). */
  fileCount?: number;
  /** Graph node count when a map is warm (0 = unknown). */
  graphNodeCount?: number;
  /** Dominant languages (optional). */
  languages?: string[];
}

export interface FitInput {
  system: SystemMemory;
  pack: QualifiedPack;
  repo?: RepoSignals;
  taskClass?: TaskClass;
  /**
   * Static reserves (bytes) for IDE / OS / graph / tests.
   * Defaults applied when omitted.
   */
  reserves?: {
    ideBytes?: number;
    osBytes?: number;
    graphBytes?: number;
    testsBytes?: number;
    safetyMarginBytes?: number;
  };
  /** Context budget used to estimate KV (tokens). Defaults from pack contract. */
  contextBudgetTokens?: number;
}

export interface FitResult {
  label: FitLabel;
  /** 0–100; higher is more headroom. */
  score: number;
  needBytes: number;
  availableBytes: number;
  /** Breakdown for “memory pie” UX. */
  breakdown: {
    modelBytes: number;
    kvBytes: number;
    ideBytes: number;
    osBytes: number;
    graphBytes: number;
    testsBytes: number;
    freeAfterReservesBytes: number;
  };
  /** When tight: suggested reduced capsule budget. */
  reducedCapsuleBudgetTokens?: number;
  reasons: string[];
}

export interface ResolvedMode {
  schemaVersion: typeof MODEL_ORCHESTRATOR_SCHEMA_VERSION;
  mode: ModelMode;
  pack: QualifiedPack;
  /** Concrete weights chosen (primary or fallback after fit). */
  underlying: PackWeightsRef;
  fit: FitResult;
  profile: ModelExecutionProfile;
  /** True when pack id was pinned by the user. */
  pinned: boolean;
  /** How the mode was chosen. */
  selection: 'explicit' | 'default' | 'auto_fit' | 'pinned';
}

export interface OrchestratorStatus {
  schemaVersion: typeof MODEL_ORCHESTRATOR_SCHEMA_VERSION;
  defaultMode: ModelMode;
  pin?: { mode: ModelMode; packId: string } | null;
  modes: Array<{
    mode: ModelMode;
    packId: string;
    displayName: string;
    promise: string;
    underlyingModelId: string;
    backend: string;
    fit: FitLabel;
    fitScore: number;
    needBytes: number;
    availableBytes: number;
    installed: boolean;
    pinned: boolean;
  }>;
  recommended: ModelMode;
  system: {
    totalRamBytes: number;
    freeRamBytes: number;
    vramTotalBytes?: number;
    vramFreeBytes?: number;
    loaded: Array<{ name: string; bytes: number }>;
  };
  memoryBreakdown?: FitResult['breakdown'];
}

// ── Curated packs (versioned; weights may change under the same mode contract) ─

/** Pack channel — bump when contracts or weight refs change under stable mode names. */
const PACK_CHANNEL = '2026.07.4';

/**
 * Current qualified packs — one primary per mode.
 *
 * Approach B default: Spark/Flow **primary** is first-party GGUF (llama.cpp)
 * for install + inference when fit allows. Ollama remains an explicit fallback
 * adapter, not the default path.
 */
export const QUALIFIED_PACKS: QualifiedPack[] = [
  {
    packId: `spark@${PACK_CHANNEL}`,
    mode: 'spark',
    displayName: 'Spark',
    promise: 'Fastest capable local coding — simple edits, minimal memory.',
    primary: {
      backend: 'llama.cpp',
      weightsRef: 'qwen2.5-coder-3b-q4_k_m.gguf',
      quant: 'q4_k_m',
      license: 'Apache-2.0',
      weightsBytes: estimateModelBytes('qwen2.5-coder:3b').bytes,
    },
    fallback: [
      {
        backend: 'ollama',
        weightsRef: 'qwen2.5-coder:3b',
        quant: 'q4_k_m',
        license: 'Apache-2.0',
        weightsBytes: estimateModelBytes('qwen2.5-coder:3b').bytes,
      },
      {
        backend: 'ollama',
        weightsRef: 'qwen2.5-coder:1.5b',
        quant: 'q4_k_m',
        license: 'Apache-2.0',
        weightsBytes: estimateModelBytes('qwen2.5-coder:1.5b').bytes,
      },
    ],
    contract: {
      toolCalling: 'grammar',
      editFormat: 'patch_ir_json',
      capsuleBudgetTokens: 2000,
      maxRepairRounds: 2,
      maxParallelEdits: 2,
      minEffectiveScore: 0.55,
      constrainedDecoding: true,
      preferredInference: 'llama.cpp',
      inferenceIsolation: 'embedded',
      kvCacheStrategy: 'stable_prefix',
      securityTier: 'L1',
    },
    resources: { minRamGb: 4, estimatedKvPer1kContext: 2 * 1024 * 1024 },
    provenance: {
      notes: 'Spark@2026.07.4 — Approach B: first-party GGUF + embedded vibgrate manager; Ollama pack fallback only',
    },
  },
  {
    packId: `flow@${PACK_CHANNEL}`,
    mode: 'flow',
    displayName: 'Flow',
    promise: 'Best everyday graph-guided coding for this machine.',
    primary: {
      backend: 'llama.cpp',
      weightsRef: 'qwen2.5-coder-7b-q4_k_m.gguf',
      quant: 'q4_k_m',
      license: 'Apache-2.0',
      weightsBytes: estimateModelBytes('qwen2.5-coder:7b').bytes,
    },
    fallback: [
      {
        backend: 'ollama',
        weightsRef: 'qwen2.5-coder:7b',
        quant: 'q4_k_m',
        license: 'Apache-2.0',
        weightsBytes: estimateModelBytes('qwen2.5-coder:7b').bytes,
      },
      {
        backend: 'ollama',
        weightsRef: 'qwen2.5-coder:3b',
        quant: 'q4_k_m',
        license: 'Apache-2.0',
        weightsBytes: estimateModelBytes('qwen2.5-coder:3b').bytes,
      },
    ],
    contract: {
      toolCalling: 'native',
      editFormat: 'auto',
      capsuleBudgetTokens: 3500,
      maxRepairRounds: 2,
      maxParallelEdits: 4,
      minEffectiveScore: 0.65,
      constrainedDecoding: false,
      preferredInference: 'llama.cpp',
      inferenceIsolation: 'embedded',
      kvCacheStrategy: 'stable_prefix',
      securityTier: 'L1',
    },
    resources: { minRamGb: 8, minVramGb: 6, estimatedKvPer1kContext: 4 * 1024 * 1024 },
    provenance: {
      notes: 'Flow@2026.07.4 — first-party GGUF primary; Ollama pack fallback only',
    },
  },
  {
    packId: `forge@${PACK_CHANNEL}`,
    mode: 'forge',
    displayName: 'Forge',
    promise: 'Strongest deep work that safely fits (migrations, multi-file).',
    primary: {
      backend: 'llama.cpp',
      weightsRef: 'qwen2.5-coder-14b-q4_k_m.gguf',
      quant: 'q4_k_m',
      license: 'Apache-2.0',
      weightsBytes: estimateModelBytes('qwen2.5-coder:14b').bytes,
    },
    fallback: [
      {
        backend: 'ollama',
        weightsRef: 'qwen2.5-coder:14b',
        quant: 'q4_k_m',
        license: 'Apache-2.0',
        weightsBytes: estimateModelBytes('qwen2.5-coder:14b').bytes,
      },
      {
        backend: 'ollama',
        weightsRef: 'qwen2.5-coder:7b',
        quant: 'q4_k_m',
        license: 'Apache-2.0',
        weightsBytes: estimateModelBytes('qwen2.5-coder:7b').bytes,
      },
    ],
    contract: {
      toolCalling: 'native',
      editFormat: 'patch_ir_json',
      capsuleBudgetTokens: 6000,
      maxRepairRounds: 3,
      maxParallelEdits: 6,
      minEffectiveScore: 0.7,
      constrainedDecoding: false,
      preferredInference: 'llama.cpp',
      inferenceIsolation: 'embedded',
      kvCacheStrategy: 'stable_prefix',
      securityTier: 'L1',
    },
    resources: { minRamGb: 16, minVramGb: 12, estimatedKvPer1kContext: 8 * 1024 * 1024 },
    provenance: {
      notes:
        'Forge@2026.07.4 — first-party 14B GGUF + embedded vibgrate manager (same path as Spark/Flow); Ollama pack fallback only',
    },
  },
];

const GiB = 1024 ** 3;

/**
 * Static reserves applied on top of *available* RAM.
 *
 * Important: `freeRamBytes` is already residual after currently-running
 * processes (IDE, OS, browsers, …). Subtracting a full IDE/OS footprint again
 * double-counts and falsely zeros fit on healthy machines. Keep growth
 * headroom for graph/tests (often not yet resident) + safety, and a modest
 * fraction of IDE/OS for workspace growth under load.
 */
const DEFAULT_RESERVES = {
  ideBytes: 1.5 * GiB,
  osBytes: 2 * GiB,
  graphBytes: 0.5 * GiB,
  testsBytes: 0.25 * GiB,
  safetyMarginBytes: 1 * GiB,
};

/** Fraction of IDE+OS reserves kept as growth headroom on the free-RAM path. */
const IDE_OS_GROWTH_FRACTION = 0.25;

// ── Pack lookup ───────────────────────────────────────────────────────────────

export function packForMode(mode: ModelMode, packs: QualifiedPack[] = QUALIFIED_PACKS): QualifiedPack | null {
  return packs.find((p) => p.mode === mode) ?? null;
}

export function packById(packId: string, packs: QualifiedPack[] = QUALIFIED_PACKS): QualifiedPack | null {
  return packs.find((p) => p.packId === packId) ?? null;
}

export function listModes(): ModelMode[] {
  return ['spark', 'flow', 'forge'];
}

// ── Fit algorithm ─────────────────────────────────────────────────────────────

/**
 * Fit decision: available memory *now* after IDE/OS/graph/tests reserves and
 * safety margin — not only “weights fit in total RAM”.
 *
 * Target: < 100 ms once system snapshot is warm (pure arithmetic).
 */
export function fitPack(input: FitInput): FitResult {
  const r = { ...DEFAULT_RESERVES, ...input.reserves };
  const pack = input.pack;
  const weightsBytes =
    pack.primary.weightsBytes ??
    estimateModelBytes(pack.primary.weightsRef).bytes;
  const ctxTokens = input.contextBudgetTokens ?? pack.contract.capsuleBudgetTokens * 2;
  const kvPer1k = pack.resources.estimatedKvPer1kContext ?? 2 * 1024 * 1024;
  const kvBytes = Math.round((ctxTokens / 1000) * kvPer1k);
  const modelBytes = weightsBytes;
  const needBytes = modelBytes + kvBytes;

  const useVram =
    typeof input.system.vramTotalBytes === 'number' && input.system.vramTotalBytes > 0;
  const freeNow = useVram
    ? (input.system.vramFreeBytes ?? 0)
    : input.system.freeRamBytes;
  const loadedBytes = input.system.loaded.reduce((n, m) => n + m.bytes, 0);
  // Prefer free-after-unload for fit of *next* load when something is resident.
  const freePool = freeNow + loadedBytes;

  const graphBump =
    (input.repo?.graphNodeCount ?? 0) > 50_000
      ? 0.5 * GiB
      : (input.repo?.fileCount ?? 0) > 5_000
        ? 0.25 * GiB
        : 0;
  const graphBytes = r.graphBytes + graphBump;

  // On discrete VRAM, only model+KV compete for VRAM — host reserves stay on RAM.
  // On unified / CPU path: free/available RAM already excludes current IDE/OS
  // usage, so only charge growth (graph/tests/safety + modest IDE/OS headroom).
  const reserved = useVram
    ? r.safetyMarginBytes
    : graphBytes +
      r.testsBytes +
      r.safetyMarginBytes +
      IDE_OS_GROWTH_FRACTION * (r.ideBytes + r.osBytes);
  const freeAfterReserves = Math.max(0, freePool - reserved);

  const availableBytes = freeAfterReserves;
  const reasons: string[] = [];
  const headroom = availableBytes - needBytes;
  const ratio = needBytes > 0 ? availableBytes / needBytes : 0;

  let label: FitLabel;
  let reducedCapsuleBudgetTokens: number | undefined;

  if (availableBytes < needBytes * 0.85) {
    label = 'will_not_fit';
    reasons.push(
      `needs ~${fmtGb(needBytes)} but only ~${fmtGb(availableBytes)} is free after reserves`,
    );
  } else if (ratio < 1.1 || headroom < 0.5 * GiB) {
    label = 'tight';
    reducedCapsuleBudgetTokens = Math.max(
      1200,
      Math.floor(pack.contract.capsuleBudgetTokens * 0.65),
    );
    reasons.push('tight fit — capsule budget will be reduced automatically');
  } else if (ratio >= 1.6 && headroom >= 2 * GiB) {
    label = 'flies';
    reasons.push('comfortable headroom for this mode');
  } else {
    label = 'comfortable';
    reasons.push('within policy for this machine');
  }

  // Large monorepo + forge → soft-downgrade score (does not force will_not_fit).
  if (
    pack.mode === 'forge' &&
    ((input.repo?.fileCount ?? 0) > 10_000 || (input.repo?.graphNodeCount ?? 0) > 100_000) &&
    label === 'comfortable'
  ) {
    reasons.push('large repository — prefer moderated capsule + graph paging');
  }

  // Score: map ratio into 0–100 with floors for labels.
  let score = Math.max(0, Math.min(100, Math.round(ratio * 50)));
  if (label === 'will_not_fit') score = Math.min(score, 20);
  if (label === 'tight') score = Math.min(Math.max(score, 25), 45);
  if (label === 'comfortable') score = Math.min(Math.max(score, 50), 75);
  if (label === 'flies') score = Math.max(score, 80);

  return {
    label,
    score,
    needBytes,
    availableBytes,
    breakdown: {
      modelBytes,
      kvBytes,
      // Report the charged growth headroom (not the full static IDE/OS footprint).
      ideBytes: useVram ? 0 : IDE_OS_GROWTH_FRACTION * r.ideBytes,
      osBytes: useVram ? 0 : IDE_OS_GROWTH_FRACTION * r.osBytes,
      graphBytes: useVram ? 0 : graphBytes,
      testsBytes: useVram ? 0 : r.testsBytes,
      freeAfterReservesBytes: freeAfterReserves,
    },
    reducedCapsuleBudgetTokens,
    reasons,
  };
}

function fmtGb(bytes: number): string {
  return `${(bytes / GiB).toFixed(1)} GiB`;
}

// ── Resolve mode → pack → underlying ──────────────────────────────────────────

export interface ResolveModeOptions {
  mode?: ModelMode;
  /** Prefer auto-fit when no mode set (default true for first-run wizard). */
  autoFit?: boolean;
  system: SystemMemory;
  repo?: RepoSignals;
  taskClass?: TaskClass;
  /** Installed model names (ollama/lmstudio) for installed: true. */
  installedNames?: string[];
  /** Pin map mode → packId. */
  pin?: { mode: ModelMode; packId: string } | null;
  packs?: QualifiedPack[];
  defaultMode?: ModelMode;
}

function packToProfile(pack: QualifiedPack, underlying: PackWeightsRef, fit: FitResult): ModelExecutionProfile {
  const budget =
    fit.label === 'tight' && fit.reducedCapsuleBudgetTokens
      ? fit.reducedCapsuleBudgetTokens
      : pack.contract.capsuleBudgetTokens;
  return {
    schemaVersion: MODEL_EXECUTION_PROFILE_SCHEMA_VERSION,
    id: underlying.weightsRef,
    displayName: `${pack.displayName} · ${underlying.weightsRef}`,
    mode: pack.mode,
    backend:
      underlying.backend === 'ollama'
        ? 'ollama'
        : underlying.backend === 'llama.cpp'
          ? 'llama.cpp'
          : underlying.backend === 'lm-studio'
            ? 'openai-compatible'
            : 'other',
    toolCalling: pack.contract.toolCalling,
    editFormat: pack.contract.editFormat,
    capsuleBudgetTokens: budget,
    maxParallelEdits: pack.contract.maxParallelEdits,
    maxRepairRounds: pack.contract.maxRepairRounds,
    temperature: 0,
    constrainedDecoding: pack.contract.constrainedDecoding ?? false,
    kvCacheStrategy: pack.contract.kvCacheStrategy,
    resources: {
      minRamGb: pack.resources.minRamGb,
      minVramGb: pack.resources.minVramGb,
      quant: underlying.quant,
    },
    securityTier: pack.contract.securityTier,
    inferenceIsolation: pack.contract.inferenceIsolation ?? 'embedded',
  };
}

function tryWeights(
  pack: QualifiedPack,
  weights: PackWeightsRef,
  system: SystemMemory,
  repo?: RepoSignals,
  taskClass?: TaskClass,
): { fit: FitResult; underlying: PackWeightsRef } {
  const trial: QualifiedPack = { ...pack, primary: weights };
  return { fit: fitPack({ system, pack: trial, repo, taskClass }), underlying: weights };
}

/**
 * Resolve a Code Mode to a pack, concrete weights, fit label, and MEP.
 * Refuses primary load when fit is will_not_fit and tries fallbacks; if all
 * fail, returns the best effort with label will_not_fit (caller must not load).
 */
export function resolveMode(opts: ResolveModeOptions): ResolvedMode {
  const packs = opts.packs ?? QUALIFIED_PACKS;
  const defaultMode = opts.defaultMode ?? 'flow';
  let mode: ModelMode = opts.mode ?? defaultMode;
  let selection: ResolvedMode['selection'] = opts.mode ? 'explicit' : 'default';

  if (!opts.mode && opts.autoFit !== false) {
    mode = recommendMode(opts.system, opts.repo, packs);
    selection = 'auto_fit';
  }

  let pack = packForMode(mode, packs);
  if (!pack) {
    pack = packForMode('flow', packs)!;
    mode = 'flow';
    selection = 'default';
  }

  if (opts.pin && opts.pin.mode === mode) {
    const pinned = packById(opts.pin.packId, packs);
    if (pinned && pinned.mode === mode) {
      pack = pinned;
      selection = 'pinned';
    }
  }

  const candidates = [pack.primary, ...(pack.fallback ?? [])];
  let best: { fit: FitResult; underlying: PackWeightsRef } | null = null;

  for (const w of candidates) {
    const trial = tryWeights(pack, w, opts.system, opts.repo, opts.taskClass);
    if (!best || fitRank(trial.fit) > fitRank(best.fit)) best = trial;
    if (trial.fit.label === 'flies' || trial.fit.label === 'comfortable') {
      best = trial;
      break;
    }
  }

  const chosen = best ?? tryWeights(pack, pack.primary, opts.system, opts.repo, opts.taskClass);
  const profile = packToProfile(pack, chosen.underlying, chosen.fit);

  return {
    schemaVersion: MODEL_ORCHESTRATOR_SCHEMA_VERSION,
    mode,
    pack,
    underlying: chosen.underlying,
    fit: chosen.fit,
    profile,
    pinned: selection === 'pinned',
    selection,
  };
}

function fitRank(f: FitResult): number {
  const order: Record<FitLabel, number> = {
    flies: 4,
    comfortable: 3,
    tight: 2,
    will_not_fit: 1,
  };
  return order[f.label] * 1000 + f.score;
}

/**
 * Pick the strongest mode that still fits at least “comfortable” (or tight
 * for spark). Prefer Flow when both Flow and Forge are comfortable.
 */
export function recommendMode(
  system: SystemMemory,
  repo?: RepoSignals,
  packs: QualifiedPack[] = QUALIFIED_PACKS,
): ModelMode {
  const order: ModelMode[] = ['forge', 'flow', 'spark'];
  let bestTight: ModelMode | null = null;
  for (const mode of order) {
    const pack = packForMode(mode, packs);
    if (!pack) continue;
    const resolved = resolveMode({
      mode,
      autoFit: false,
      system,
      repo,
      packs,
    });
    if (resolved.fit.label === 'flies' || resolved.fit.label === 'comfortable') {
      // Prefer Flow as daily default when Forge also fits, unless repo is tiny.
      if (mode === 'forge') {
        const flow = resolveMode({ mode: 'flow', autoFit: false, system, repo, packs });
        if (flow.fit.label === 'flies' || flow.fit.label === 'comfortable') {
          const files = repo?.fileCount ?? 0;
          if (files < 2000) return 'flow';
        }
        return 'forge';
      }
      return mode;
    }
    if (resolved.fit.label === 'tight' && !bestTight) bestTight = mode;
  }
  return bestTight ?? 'spark';
}

/** Build orchestrator status for `vg models status` / host UIs. */
export function buildOrchestratorStatus(opts: {
  system: SystemMemory;
  repo?: RepoSignals;
  installedNames?: string[];
  /** Single pin (legacy) or full pin map. */
  pin?: { mode: ModelMode; packId: string } | null;
  pins?: Partial<Record<ModelMode, string>>;
  defaultMode?: ModelMode;
  packs?: QualifiedPack[];
}): OrchestratorStatus {
  const packs = opts.packs ?? QUALIFIED_PACKS;
  const installed = new Set((opts.installedNames ?? []).map((n) => n.toLowerCase()));
  const recommended = recommendMode(opts.system, opts.repo, packs);
  const pinFor = (mode: ModelMode): { mode: ModelMode; packId: string } | null => {
    const fromMap = opts.pins?.[mode];
    if (fromMap) return { mode, packId: fromMap };
    if (opts.pin?.mode === mode) return opts.pin;
    return null;
  };
  const modes = listModes().map((mode) => {
    const resolved = resolveMode({
      mode,
      autoFit: false,
      system: opts.system,
      repo: opts.repo,
      pin: pinFor(mode),
      packs,
    });
    const id = resolved.underlying.weightsRef.toLowerCase();
    const installedHit =
      installed.has(id) ||
      [...installed].some((n) => n.includes(id) || id.includes(n));
    return {
      mode,
      packId: resolved.pack.packId,
      displayName: resolved.pack.displayName,
      promise: resolved.pack.promise,
      underlyingModelId: resolved.underlying.weightsRef,
      backend: resolved.underlying.backend,
      fit: resolved.fit.label,
      fitScore: resolved.fit.score,
      needBytes: resolved.fit.needBytes,
      availableBytes: resolved.fit.availableBytes,
      installed: installedHit,
      pinned: resolved.pinned,
    };
  });

  const recResolved = resolveMode({
    mode: recommended,
    autoFit: false,
    system: opts.system,
    repo: opts.repo,
    pin: pinFor(recommended),
    packs,
  });

  return {
    schemaVersion: MODEL_ORCHESTRATOR_SCHEMA_VERSION,
    defaultMode: opts.defaultMode ?? 'flow',
    pin: pinFor(recommended),
    modes,
    recommended,
    system: {
      totalRamBytes: opts.system.totalRamBytes,
      freeRamBytes: opts.system.freeRamBytes,
      ...(typeof opts.system.vramTotalBytes === 'number'
        ? { vramTotalBytes: opts.system.vramTotalBytes }
        : {}),
      ...(typeof opts.system.vramFreeBytes === 'number'
        ? { vramFreeBytes: opts.system.vramFreeBytes }
        : {}),
      loaded: opts.system.loaded.map((l) => ({ name: l.name, bytes: l.bytes })),
    },
    memoryBreakdown: recResolved.fit.breakdown,
  };
}

// ── Pin registry (global storage, not in-repo) ────────────────────────────────

export interface OrchestratorPinState {
  schemaVersion: 'model-orchestrator-pin/0';
  /** mode → packId */
  pins: Partial<Record<ModelMode, string>>;
  /** Workspace / global default mode preference. */
  defaultMode?: ModelMode;
  updatedAt: string;
}

export function orchestratorStatePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home?: string,
): string {
  return path.join(vibgrateDataDir(env, platform, home), 'model-orchestrator', 'state.json');
}

export function readOrchestratorState(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home?: string,
): OrchestratorPinState {
  const p = orchestratorStatePath(env, platform, home);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<OrchestratorPinState>;
    return {
      schemaVersion: 'model-orchestrator-pin/0',
      pins: raw.pins && typeof raw.pins === 'object' ? raw.pins : {},
      defaultMode:
        raw.defaultMode === 'spark' || raw.defaultMode === 'flow' || raw.defaultMode === 'forge'
          ? raw.defaultMode
          : undefined,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return {
      schemaVersion: 'model-orchestrator-pin/0',
      pins: {},
      updatedAt: new Date(0).toISOString(),
    };
  }
}

export function writeOrchestratorState(
  state: OrchestratorPinState,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home?: string,
): string {
  const p = orchestratorStatePath(env, platform, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const next: OrchestratorPinState = {
    ...state,
    schemaVersion: 'model-orchestrator-pin/0',
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return p;
}

export function pinPack(
  mode: ModelMode,
  packId: string,
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
  home?: string,
): OrchestratorPinState {
  const state = readOrchestratorState(env, platform, home);
  if (!packById(packId)) {
    throw new Error(`unknown pack id: ${packId}`);
  }
  state.pins[mode] = packId;
  writeOrchestratorState(state, env, platform, home);
  return state;
}

export function unpinPack(
  mode: ModelMode,
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
  home?: string,
): OrchestratorPinState {
  const state = readOrchestratorState(env, platform, home);
  delete state.pins[mode];
  writeOrchestratorState(state, env, platform, home);
  return state;
}

export function setDefaultMode(
  mode: ModelMode,
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
  home?: string,
): OrchestratorPinState {
  const state = readOrchestratorState(env, platform, home);
  state.defaultMode = mode;
  writeOrchestratorState(state, env, platform, home);
  return state;
}

/** Active pin for a mode, if any. */
export function activePin(
  mode: ModelMode,
  state: OrchestratorPinState = readOrchestratorState(),
): { mode: ModelMode; packId: string } | null {
  const packId = state.pins[mode];
  return packId ? { mode, packId } : null;
}

/** Map backend hint to vg code --provider id. */
export function providerForBackend(backend: PackWeightsRef['backend']): string {
  switch (backend) {
    case 'ollama':
      return 'ollama';
    case 'llama.cpp':
      return 'llama-cpp';
    case 'lm-studio':
      return 'lmstudio';
    default:
      return 'ollama';
  }
}

/** Parse mode from user string; null if invalid. */
export function parseMode(raw: string | undefined | null): ModelMode | null {
  if (!raw) return null;
  const m = raw.trim().toLowerCase();
  if (m === 'spark' || m === 'flow' || m === 'forge') return m;
  return null;
}
