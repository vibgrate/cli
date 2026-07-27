/**
 * Approach B host measurement arms (B5 + P1 live metrics).
 *
 * Offline-safe definitions for ContextBench / release gates. Real model runs
 * are opt-in; the harness records structured arm metadata, maps
 * {@link HostGenerateReport}-shaped results into metric rows, and can execute
 * mock arms without a GPU.
 *
 * schemaVersion: host-bench/0
 */

export const HOST_BENCH_SCHEMA = 'host-bench/0' as const;

export type HostBenchArmId =
  | 'capsule-ollama'
  | 'capsule-embedded'
  | 'capsule-embedded-grammar'
  | 'capsule-embedded-trie-enforce'
  | 'capsule-embedded-logit-mask'
  | 'capsule-embedded-dynamic-sampler'
  | 'capsule-embedded-kv-delta';

export interface HostBenchArm {
  id: HostBenchArmId;
  label: string;
  /** What this arm proves. */
  hypothesis: string;
  provider: 'ollama' | 'llama-cpp' | 'mock';
  capsule: boolean;
  grammar: boolean;
  identifierEnforce: boolean;
  /** TokenBias / native logit mask expected. */
  logitMask?: boolean;
  /** P2 dynamic open-identifier sampler. */
  dynamicSampler?: boolean;
  /** Metrics the arm must record. */
  metrics: string[];
}

export const HOST_BENCH_ARMS: HostBenchArm[] = [
  {
    id: 'capsule-ollama',
    label: 'Capsule + Ollama (Approach A baseline)',
    hypothesis: 'HTTP local baseline for TTFT/turns/FCS',
    provider: 'ollama',
    capsule: true,
    grammar: false,
    identifierEnforce: false,
    metrics: ['ttftMs', 'turns', 'fcs', 'validPatchRate', 'promptTokens'],
  },
  {
    id: 'capsule-embedded',
    label: 'Capsule + embedded warm host',
    hypothesis: 'Warm session lowers multi-turn TTFT vs cold Ollama',
    provider: 'llama-cpp',
    capsule: true,
    grammar: false,
    identifierEnforce: false,
    metrics: ['ttftMs', 'warmStart', 'turns', 'fcs', 'promptTokens', 'kvHitTokens', 'kvPrefixReusedTokens'],
  },
  {
    id: 'capsule-embedded-grammar',
    label: 'Capsule + embedded + PatchIR grammar',
    hypothesis: 'Fail-closed grammar raises validPatchRate to ~1.0 on Spark tasks',
    provider: 'llama-cpp',
    capsule: true,
    grammar: true,
    identifierEnforce: false,
    metrics: ['ttftMs', 'validPatchRate', 'grammarApplied', 'fcs'],
  },
  {
    id: 'capsule-embedded-trie-enforce',
    label: 'Capsule + embedded + identifier enforce',
    hypothesis: 'Unknown-symbol patches never apply; repair loop recovers',
    provider: 'llama-cpp',
    capsule: true,
    grammar: true,
    identifierEnforce: true,
    metrics: ['blockedApplies', 'unknownIdentifierRate', 'fcs', 'turns'],
  },
  {
    id: 'capsule-embedded-logit-mask',
    label: 'Capsule + embedded + TokenBias logit mask',
    hypothesis: 'TokenBias boost/suppress reduces unknown-identifier rate vs post-scan only',
    provider: 'llama-cpp',
    capsule: true,
    grammar: true,
    identifierEnforce: true,
    logitMask: true,
    metrics: ['ttftMs', 'samplerHook', 'samplerBoostedTokens', 'samplerSuppressedTokens', 'unknownIdentifierRate', 'kvPrefixReusedTokens'],
  },
  {
    id: 'capsule-embedded-dynamic-sampler',
    label: 'Capsule + embedded + dynamic open-ident sampler',
    hypothesis: 'Per-token onToken/customSampler rejects inventing identifiers mid-decode',
    provider: 'llama-cpp',
    capsule: true,
    grammar: true,
    identifierEnforce: true,
    logitMask: true,
    dynamicSampler: true,
    metrics: ['ttftMs', 'dynamicSampler', 'samplerHook', 'unknownIdentifierRate', 'grammarApplied', 'validPatchRate'],
  },
  {
    id: 'capsule-embedded-kv-delta',
    label: 'Capsule + embedded multi-turn KV delta',
    hypothesis: 'Cursor skip + delta evaluate lowers multi-turn TTFT vs full re-prefill',
    provider: 'llama-cpp',
    capsule: true,
    grammar: false,
    identifierEnforce: false,
    metrics: ['ttftMs', 'warmStart', 'kvHitTokens', 'kvPrefixReusedTokens', 'kvDeltaTokens', 'turns'],
  },
];

export interface HostBenchResultRow {
  armId: HostBenchArmId;
  ok: boolean;
  /** Metric name → number (or 0/1 for booleans). */
  metrics: Record<string, number>;
  notes?: string;
}

export interface HostBenchReport {
  schemaVersion: typeof HOST_BENCH_SCHEMA;
  ranAt: string;
  arms: HostBenchResultRow[];
}

/** Shape of generate metrics we can fold into a bench row (from HostGenerateReport). */
export interface HostGenerateMetricsLike {
  latencyMs?: number;
  warmStart?: boolean;
  grammarApplied?: boolean;
  samplerHook?: boolean;
  samplerBoostedTokens?: number;
  samplerSuppressedTokens?: number;
  kvPrefixReusedTokens?: number;
  kvDeltaTokens?: number;
  dynamicSampler?: boolean;
  draftAcceptedChars?: number;
  draftCandidatesTried?: number;
  kvPlan?: { hitTokens?: number; totalTokens?: number; deltaTokens?: number };
  unknownIdentifiers?: string[];
}

/**
 * Map a host generate report into numeric metrics for an arm.
 * Missing fields become 0 so offline/mock rows stay schema-complete.
 */
export function metricsFromHostGenerate(
  report: HostGenerateMetricsLike | null | undefined,
  extra: Record<string, number> = {},
): Record<string, number> {
  const r = report ?? {};
  return {
    ttftMs: r.latencyMs ?? 0,
    warmStart: r.warmStart ? 1 : 0,
    grammarApplied: r.grammarApplied ? 1 : 0,
    samplerHook: r.samplerHook ? 1 : 0,
    samplerBoostedTokens: r.samplerBoostedTokens ?? 0,
    samplerSuppressedTokens: r.samplerSuppressedTokens ?? 0,
    dynamicSampler: r.dynamicSampler ? 1 : 0,
    kvHitTokens: r.kvPlan?.hitTokens ?? 0,
    kvPrefixReusedTokens: r.kvPrefixReusedTokens ?? 0,
    kvDeltaTokens: r.kvDeltaTokens ?? r.kvPlan?.deltaTokens ?? 0,
    promptTokens: r.kvPlan?.totalTokens ?? 0,
    draftAcceptedChars: r.draftAcceptedChars ?? 0,
    draftCandidatesTried: r.draftCandidatesTried ?? 0,
    unknownIdentifierRate: r.unknownIdentifiers?.length ? r.unknownIdentifiers.length : 0,
    turns: extra.turns ?? 1,
    fcs: extra.fcs ?? 0,
    validPatchRate: extra.validPatchRate ?? 0,
    blockedApplies: extra.blockedApplies ?? 0,
    ...extra,
  };
}

/**
 * Offline dry-run: validate arm definitions and emit empty metric shells.
 * Real runners fill metrics via ContextBench / live harness.
 */
export function planHostBench(armIds?: HostBenchArmId[]): HostBenchArm[] {
  if (!armIds?.length) return [...HOST_BENCH_ARMS];
  const set = new Set(armIds);
  return HOST_BENCH_ARMS.filter((a) => set.has(a.id));
}

/** Build a stub report for CI that asserts arm registry integrity. */
export function stubHostBenchReport(): HostBenchReport {
  return {
    schemaVersion: HOST_BENCH_SCHEMA,
    ranAt: new Date(0).toISOString(),
    arms: HOST_BENCH_ARMS.map((a) => ({
      ok: true,
      armId: a.id,
      metrics: Object.fromEntries(a.metrics.map((m) => [m, 0])),
      notes: 'stub — run live harness to populate',
    })),
  };
}

/**
 * Offline mock live run: fill arm metrics from injectable generate reports
 * (no GPU). Used by CI and by operators to validate wiring before hardware runs.
 */
export function runMockHostBench(
  reportsByArm: Partial<Record<HostBenchArmId, HostGenerateMetricsLike>> = {},
  extrasByArm: Partial<Record<HostBenchArmId, Record<string, number>>> = {},
): HostBenchReport {
  return {
    schemaVersion: HOST_BENCH_SCHEMA,
    ranAt: new Date().toISOString(),
    arms: HOST_BENCH_ARMS.map((a) => {
      const full = metricsFromHostGenerate(reportsByArm[a.id], extrasByArm[a.id]);
      const metrics = Object.fromEntries(a.metrics.map((m) => [m, full[m] ?? 0]));
      return {
        armId: a.id,
        ok: true,
        metrics,
        notes: reportsByArm[a.id] ? 'mock-from-generate' : 'mock-empty',
      };
    }),
  };
}

export function assertHostBenchRegistry(): void {
  const ids = new Set<string>();
  for (const a of HOST_BENCH_ARMS) {
    if (ids.has(a.id)) throw new Error(`duplicate host bench arm: ${a.id}`);
    ids.add(a.id);
    if (!a.metrics.length) throw new Error(`arm ${a.id} has no metrics`);
  }
}
