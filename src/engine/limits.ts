import * as v8 from 'node:v8';

/**
 * Resource safeguards for the graph build.
 *
 * Building the map holds every parse table, node, and edge in memory at once,
 * so a pathological corpus (a vendored 200 MB bundle, a million-file tree, a
 * giant TS program) can OOM-kill the process — an uncatchable crash that takes
 * the caller (e.g. a `scan --push`) down with it. These limits convert that
 * crash into either a deterministic skip (per-file size cap, tsc rung cap) or
 * a catchable, actionable error (corpus cap, heap budget).
 *
 * Every limit is overridable via environment variable, and `0` always means
 * "disabled". Skips are pure functions of the input (file size, file count) —
 * never of observed memory — so identical input still yields identical output.
 */

export interface ResourceLimits {
  /** Per-file source cap in bytes. Larger files stay stat-tracked for
   * freshness but are not parsed into the graph. 0 disables. */
  maxFileBytes: number;
  /** Ceiling on discovered corpus files; exceeding aborts with guidance
   * instead of grinding toward an OOM. 0 disables. */
  maxFiles: number;
  /** Ceiling on TS/JS files handed to the in-process TypeScript Compiler API
   * rung (a ts.Program over the whole corpus is the largest single memory
   * consumer). Above it the rung is skipped; the heuristic floor remains.
   * 0 disables. */
  tscMaxFiles: number;
  /** Heap budget in MiB checked at phase boundaries; exceeding aborts with a
   * clear error before V8 hard-crashes. 0 disables. */
  memoryBudgetMb: number;
}

const MIB = 1024 * 1024;

export const DEFAULT_MAX_FILE_BYTES = 2 * MIB;
export const DEFAULT_MAX_FILES = 100_000;
export const DEFAULT_TSC_MAX_FILES = 10_000;

/** Fraction of V8's heap ceiling we allow the build to consume before
 * aborting — past this an OOM crash is imminent anyway. */
const HEAP_GUARD_FRACTION = 0.9;

/** A build stopped by a resource safeguard — catchable, unlike an OOM. The
 * message is user-facing and must carry its own remedy. */
export class ResourceLimitError extends Error {
  readonly isResourceLimitError = true;
  constructor(message: string) {
    super(message);
    this.name = 'ResourceLimitError';
  }
}

/** Non-negative integer from an env var; unset/invalid → fallback. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Like envInt but with no default — undefined when unset/invalid/0. */
function envIntOptional(name: string): number | undefined {
  const n = envInt(name, 0);
  return n > 0 ? n : undefined;
}

/** Default heap budget: 90% of V8's configured heap ceiling (respects
 * NODE_OPTIONS=--max-old-space-size), in MiB. */
export function defaultMemoryBudgetMb(): number {
  return Math.floor((v8.getHeapStatistics().heap_size_limit / MIB) * HEAP_GUARD_FRACTION);
}

/**
 * Resolve effective limits: explicit overrides (tests, programmatic callers)
 * win over environment variables, which win over defaults.
 */
export function resolveLimits(overrides: Partial<ResourceLimits> = {}): ResourceLimits {
  return {
    maxFileBytes: overrides.maxFileBytes ?? envInt('VG_MAX_FILE_BYTES', DEFAULT_MAX_FILE_BYTES),
    maxFiles: overrides.maxFiles ?? envInt('VG_MAX_FILES', DEFAULT_MAX_FILES),
    tscMaxFiles: overrides.tscMaxFiles ?? envInt('VG_TSC_MAX_FILES', DEFAULT_TSC_MAX_FILES),
    memoryBudgetMb: overrides.memoryBudgetMb ?? envInt('VG_MEMORY_BUDGET_MB', defaultMemoryBudgetMb()),
  };
}

/** Default parse worker count override (`VG_JOBS`); undefined when unset. */
export function envJobs(): number | undefined {
  return envIntOptional('VG_JOBS');
}

/** Per-worker old-generation heap cap in MiB (`VG_WORKER_HEAP_MB`);
 * undefined when unset (workers inherit the platform default). */
export function envWorkerHeapMb(): number | undefined {
  return envIntOptional('VG_WORKER_HEAP_MB');
}

/**
 * Abort (catchably) when heap use crosses the budget. Called at phase
 * boundaries — cheap enough to call freely, and an abort here beats a V8
 * hard-crash a few allocations later. Only ever *throws*; it never alters
 * build output, so determinism is unaffected.
 */
export function checkMemoryBudget(phase: string, budgetMb: number): void {
  if (budgetMb <= 0) return;
  const usedMb = process.memoryUsage().heapUsed / MIB;
  if (usedMb <= budgetMb) return;
  throw new ResourceLimitError(
    `graph build stopped during ${phase}: heap use ${Math.round(usedMb)} MiB exceeds the ` +
      `${budgetMb} MiB budget. Narrow the build (scope to sub-paths, add --exclude globs, or ` +
      `--only <langs>), raise the Node heap (NODE_OPTIONS=--max-old-space-size=8192), or set ` +
      `VG_MEMORY_BUDGET_MB (0 disables this safeguard).`,
  );
}

/** Human-readable byte count for warnings ("3.2 MiB"). */
export function formatBytes(n: number): string {
  if (n >= MIB) return `${(n / MIB).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}
