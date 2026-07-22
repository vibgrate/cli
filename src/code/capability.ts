/**
 * Local capability + memory pre-flight for `vg code` (VG-CLI-CODE §10).
 *
 * Before we ever pull or run a local model we check the machine can actually
 * hold it: estimate the model's memory footprint from its parameter count and
 * quantization, read available system memory (and GPU VRAM where we can see
 * it), account for models already loaded, and produce a clear go / no-go with
 * actionable suggestions — free memory by unloading a model, pick a smaller
 * quant, or don't install. We never download a model the machine can't run.
 *
 * The estimators and parsers here are pure and unit-tested; the command layer
 * feeds them real `os` memory, `ollama ps`, and (best-effort) `nvidia-smi`
 * output.
 */

const GiB = 1024 ** 3;

/** Approximate bytes-per-weight for common gguf quantizations. */
const QUANT_BYTES_PER_PARAM: Record<string, number> = {
  f16: 2.0, fp16: 2.0, f32: 4.0,
  q8: 1.06, q8_0: 1.06,
  q6: 0.82, q6_k: 0.82,
  q5: 0.7, q5_k_m: 0.72, q5_k_s: 0.68, q5_0: 0.71, q5_1: 0.77,
  q4: 0.58, q4_k_m: 0.6, q4_k_s: 0.56, q4_0: 0.56, q4_1: 0.63,
  q3: 0.46, q3_k_m: 0.48, q3_k_s: 0.44,
  q2: 0.36, q2_k: 0.4,
};
const DEFAULT_QUANT = 'q4_k_m';
/** Runtime overhead over raw weights: KV cache, context, activations. */
const RUNTIME_OVERHEAD = 1.2;

export interface ModelSizeEstimate {
  /** Parsed parameter count in billions (e.g. 7, 13, 70), or undefined if unknown. */
  paramsB?: number;
  quant: string;
  /** Estimated resident bytes to run the model (weights × quant × overhead). */
  bytes: number;
  /** True when we had to guess the size because the slug didn't state params. */
  guessed: boolean;
}

/**
 * Estimate a model's memory footprint from its slug/name/tag, e.g.
 * `qwen2.5-coder:7b-instruct-q4_K_M` → ~5 GiB. Falls back to a conservative
 * default size when the parameter count isn't stated.
 */
export function estimateModelBytes(slug: string, defaultParamsB = 7): ModelSizeEstimate {
  const lower = slug.toLowerCase();
  const paramMatch = lower.match(/(\d+(?:\.\d+)?)\s*b\b/);
  const paramsB = paramMatch ? Number(paramMatch[1]) : undefined;
  const quant = detectQuant(lower);
  const bytesPerParam = QUANT_BYTES_PER_PARAM[quant] ?? QUANT_BYTES_PER_PARAM[DEFAULT_QUANT];
  const effectiveParams = (paramsB ?? defaultParamsB) * 1e9;
  const bytes = Math.round(effectiveParams * bytesPerParam * RUNTIME_OVERHEAD);
  return { paramsB, quant, bytes, guessed: paramsB === undefined };
}

function detectQuant(lower: string): string {
  // Longest key match first so `q4_k_m` beats `q4`.
  const keys = Object.keys(QUANT_BYTES_PER_PARAM).sort((a, b) => b.length - a.length);
  for (const k of keys) if (lower.includes(k)) return k;
  return DEFAULT_QUANT;
}

export interface LoadedModel {
  name: string;
  bytes: number;
}

/**
 * Parse `ollama ps` output into currently-loaded models and their sizes. The
 * table looks like: `NAME  ID  SIZE  PROCESSOR  UNTIL` with SIZE like `5.5 GB`.
 */
export function parseOllamaPs(stdout: string): LoadedModel[] {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const out: LoadedModel[] = [];
  for (const line of lines) {
    if (/^NAME\b/i.test(line)) continue; // header
    const sizeMatch = line.match(/(\d+(?:\.\d+)?)\s*(GB|GiB|MB|MiB|TB)/i);
    const name = line.split(/\s+/)[0];
    if (!name || !sizeMatch) continue;
    out.push({ name, bytes: toBytes(Number(sizeMatch[1]), sizeMatch[2]) });
  }
  return out;
}

/** Parse `nvidia-smi --query-gpu=memory.total,memory.used --format=csv,noheader,nounits` (MiB). */
export function parseNvidiaSmi(stdout: string): { totalBytes: number; usedBytes: number } | null {
  const line = stdout.split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const parts = line.split(',').map((p) => Number(p.trim()));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return { totalBytes: parts[0] * 1024 * 1024, usedBytes: parts[1] * 1024 * 1024 };
}

export interface SystemMemory {
  totalRamBytes: number;
  freeRamBytes: number;
  /** GPU total/free if a discrete GPU was detected (else undefined → CPU/unified). */
  vramTotalBytes?: number;
  vramFreeBytes?: number;
  loaded: LoadedModel[];
}

export interface CapabilityReport {
  model: ModelSizeEstimate;
  /** Bytes available to a new model right now (the larger of free VRAM or free RAM). */
  availableBytes: number;
  /** Bytes available if every currently-loaded model were unloaded. */
  availableIfUnloadedBytes: number;
  canRun: boolean;
  /** True only after unloading currently-loaded models. */
  needsUnload: boolean;
  suggestions: string[];
  loaded: LoadedModel[];
}

/**
 * Decide whether `model` can run on `sys`, and if not, what to do about it.
 * Prefers GPU memory when a discrete GPU is present, else system RAM (covers
 * Apple-silicon unified memory too). Leaves a safety margin so we don't wedge
 * the machine at 100% memory.
 */
export function assessCapability(model: ModelSizeEstimate, sys: SystemMemory): CapabilityReport {
  const useVram = typeof sys.vramTotalBytes === 'number' && sys.vramTotalBytes > 0;
  const free = useVram ? (sys.vramFreeBytes ?? 0) : sys.freeRamBytes;
  const loadedBytes = sys.loaded.reduce((n, m) => n + m.bytes, 0);
  // A margin so we never fill memory completely.
  const margin = Math.min(2 * GiB, (useVram ? sys.vramTotalBytes! : sys.totalRamBytes) * 0.1);
  const available = Math.max(0, free - margin);
  const availableIfUnloaded = Math.max(0, free + loadedBytes - margin);

  const need = model.bytes;
  const canRunNow = available >= need;
  const canRunUnloaded = availableIfUnloaded >= need;

  const suggestions: string[] = [];
  if (!canRunNow && canRunUnloaded && sys.loaded.length) {
    const biggest = [...sys.loaded].sort((a, b) => b.bytes - a.bytes);
    suggestions.push(`unload a loaded model to free memory (e.g. \`ollama stop ${biggest[0].name}\` frees ~${fmt(biggest[0].bytes)})`);
  }
  if (!canRunUnloaded) {
    suggestions.push(`this model needs ~${fmt(need)} but only ~${fmt(availableIfUnloaded)} is available — choose a smaller model or a lower quant (e.g. q4_K_M)`);
  }
  if (model.guessed) {
    suggestions.push(`couldn't read the parameter count from the name — this estimate assumes a ~${(model.bytes / GiB).toFixed(1)} GiB model; verify before pulling`);
  }

  return {
    model,
    availableBytes: available,
    availableIfUnloadedBytes: availableIfUnloaded,
    canRun: canRunNow || canRunUnloaded,
    needsUnload: !canRunNow && canRunUnloaded,
    suggestions,
    loaded: sys.loaded,
  };
}

/** Human-readable byte size. */
export function fmt(bytes: number): string {
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(1)} GiB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
}

function toBytes(n: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith('t')) return n * 1000 ** 4;
  if (u.startsWith('g')) return n * (u.includes('i') ? GiB : 1e9);
  if (u.startsWith('m')) return n * (u.includes('i') ? 1024 * 1024 : 1e6);
  return n;
}
