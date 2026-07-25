/**
 * Local model fleet status for host UIs (`vg models --json`).
 *
 * Pure over an injected fleet + {@link SystemMemory}: attaches per-model size
 * estimates (quant / params / bytes) and a system memory / VRAM snapshot so VS
 * Code and other pure clients can show whether a model will fit without
 * re-implementing capability math.
 */

import { estimateModelBytes, type ModelSizeEstimate, type SystemMemory } from './capability.js';
import type { LocalModel } from '../engine/models.js';

export interface ModelEstimateJson {
  quant: string;
  bytes: number;
  paramsB?: number;
  guessed: boolean;
}

export interface EnrichedLocalModel extends LocalModel {
  estimate: ModelEstimateJson;
}

export interface SystemMemoryJson {
  totalRamBytes: number;
  freeRamBytes: number;
  vramTotalBytes?: number;
  vramFreeBytes?: number;
  loaded: Array<{ name: string; bytes: number }>;
}

export interface ModelsStatusReport {
  models: EnrichedLocalModel[];
  system: SystemMemoryJson;
}

/** Attach a size/quant estimate to each discovered local model. */
export function enrichLocalModels(models: LocalModel[]): EnrichedLocalModel[] {
  return models.map((m) => ({
    ...m,
    estimate: toEstimateJson(estimateModelBytes(m.name)),
  }));
}

/** Build the full JSON payload for `vg models --json` (fleet + memory/VRAM). */
export function buildModelsStatusReport(models: LocalModel[], sys: SystemMemory): ModelsStatusReport {
  return {
    models: enrichLocalModels(models),
    system: {
      totalRamBytes: sys.totalRamBytes,
      freeRamBytes: sys.freeRamBytes,
      ...(typeof sys.vramTotalBytes === 'number' ? { vramTotalBytes: sys.vramTotalBytes } : {}),
      ...(typeof sys.vramFreeBytes === 'number' ? { vramFreeBytes: sys.vramFreeBytes } : {}),
      loaded: sys.loaded.map((l) => ({ name: l.name, bytes: l.bytes })),
    },
  };
}

function toEstimateJson(e: ModelSizeEstimate): ModelEstimateJson {
  return {
    quant: e.quant,
    bytes: e.bytes,
    ...(e.paramsB !== undefined ? { paramsB: e.paramsB } : {}),
    guessed: e.guessed,
  };
}
