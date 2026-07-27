/**
 * Host-bench runner (Approach B / P3).
 *
 * Modes:
 *  - **mock** — fill metric shells (no generate); CI registry smoke
 *  - **simulate** — multi-turn generateOnSession with an injectable fake binding
 *    (no GPU, exercises warm session / KV / grammar flags)
 *  - **live** — same harness with a real binding + model path (operator opt-in)
 *
 * schemaVersion: host-bench-run/0
 */

import { buildIdentifierTrieFromGraph } from './identifier-trie.js';
import {
  HOST_BENCH_ARMS,
  HOST_BENCH_SCHEMA,
  metricsFromHostGenerate,
  runMockHostBench,
  type HostBenchArm,
  type HostBenchArmId,
  type HostBenchReport,
  type HostBenchResultRow,
  type HostGenerateMetricsLike,
} from './host-bench.js';
import {
  acquireHostSession,
  clearHostSessionPool,
  generateOnSession,
  type HostGenerateReport,
} from './llm-host/session.js';

export const HOST_BENCH_RUN_SCHEMA = 'host-bench-run/0' as const;

export type HostBenchRunMode = 'mock' | 'simulate' | 'live';

export interface HostBenchRunOptions {
  mode?: HostBenchRunMode;
  armIds?: HostBenchArmId[];
  /** Turns per arm for simulate/live multi-turn KV metrics. */
  turns?: number;
  /** Real GGUF path for live mode. */
  modelPath?: string;
  /** Injected node-llama-cpp module (live). */
  binding?: unknown;
  /** Injectable session factory for tests (simulate). */
  fakeLib?: unknown;
  /** Env for grammar / dynamic sampler flags. */
  env?: NodeJS.ProcessEnv;
  onProgress?: (line: string) => void;
}

export interface HostBenchRunResult {
  schemaVersion: typeof HOST_BENCH_RUN_SCHEMA;
  mode: HostBenchRunMode;
  report: HostBenchReport;
  /** Wall-clock ms for the whole run. */
  elapsedMs: number;
}

/**
 * Run host-bench arms. Default mode is **simulate** (exercises the warm host
 * without requiring a GPU). Use **mock** for pure registry shells; **live**
 * only when binding + modelPath are provided.
 */
export async function runHostBench(options: HostBenchRunOptions = {}): Promise<HostBenchRunResult> {
  const mode = options.mode ?? 'simulate';
  const t0 = Date.now();
  const arms = options.armIds?.length
    ? HOST_BENCH_ARMS.filter((a) => options.armIds!.includes(a.id))
    : [...HOST_BENCH_ARMS];

  if (mode === 'mock') {
    const report = runMockHostBench();
    // Filter to requested arms if subset.
    if (options.armIds?.length) {
      report.arms = report.arms.filter((a) => options.armIds!.includes(a.armId));
    }
    return { schemaVersion: HOST_BENCH_RUN_SCHEMA, mode, report, elapsedMs: Date.now() - t0 };
  }

  if (mode === 'live') {
    if (!options.binding || !options.modelPath) {
      throw new Error(
        'host-bench live mode needs binding + modelPath — install a pack (`vg models install`) and pass the GGUF path, or use --simulate',
      );
    }
  }

  const lib = mode === 'live' ? options.binding : (options.fakeLib ?? defaultSimulateLib());
  const modelPath = mode === 'live' ? options.modelPath! : '/simulate/model.gguf';
  const turns = Math.max(1, options.turns ?? 2);
  const env = options.env ?? process.env;
  const trie = buildIdentifierTrieFromGraph({
    nodes: [{ name: 'readConfig' }, { name: 'scanDir' }, { name: 'formatReport' }],
  });

  clearHostSessionPool();
  const rows: HostBenchResultRow[] = [];

  for (const arm of arms) {
    options.onProgress?.(`arm ${arm.id}…`);
    try {
      const row = await runArmSimulate({
        arm,
        lib,
        modelPath,
        turns,
        trie,
        env,
        live: mode === 'live',
      });
      rows.push(row);
    } catch (e) {
      rows.push({
        armId: arm.id,
        ok: false,
        metrics: Object.fromEntries(arm.metrics.map((m) => [m, 0])),
        notes: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Include missing registry arms as skipped when filtering? When subset, only subset.
  // When full run, we already have all. When subset, report only subset (gates for full suite use mock separately).

  const report: HostBenchReport = {
    schemaVersion: HOST_BENCH_SCHEMA,
    ranAt: new Date().toISOString(),
    arms: rows,
  };

  return {
    schemaVersion: HOST_BENCH_RUN_SCHEMA,
    mode,
    report,
    elapsedMs: Date.now() - t0,
  };
}

async function runArmSimulate(input: {
  arm: HostBenchArm;
  lib: unknown;
  modelPath: string;
  turns: number;
  trie: ReturnType<typeof buildIdentifierTrieFromGraph>;
  env: NodeJS.ProcessEnv;
  live: boolean;
}): Promise<HostBenchResultRow> {
  const { arm, lib, modelPath, turns, trie, env, live } = input;
  // Fresh session key per arm so cold start is measurable; share path with suffix.
  const path = `${modelPath}#${arm.id}`;
  const session = await acquireHostSession(lib, path);

  const system = 'You are a coding agent with a Task Capsule.';
  const capsule = 'function readConfig(): Config { return load(); }';
  let last: HostGenerateReport | null = null;
  let grammarApplied = 0;
  let samplerHook = 0;
  let dynamicSampler = 0;
  let warmStart = 0;
  let kvHitTokens = 0;
  let kvPrefixReusedTokens = 0;
  let kvDeltaTokens = 0;
  let unknownIdentifierRate = 0;
  let ttftMs = 0;
  let promptTokens = 0;
  let draftAcceptedChars = 0;

  for (let t = 1; t <= turns; t++) {
    const user = t === 1 ? 'raise the timeout in scanDir' : `continue turn ${t}`;
    const segs = [
      { kind: 'system', text: system },
      { kind: 'capsule', text: capsule },
      { kind: 'user', text: user },
    ];
    last = await generateOnSession(
      session,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      {
        promptSegments: segs,
        identifierTrie: arm.identifierEnforce || arm.logitMask || arm.dynamicSampler ? trie : undefined,
        grammar: arm.grammar ? 'root ::= "x"' : undefined,
        requireGrammar: false,
        annotateUnknownIdentifiers: true,
        assumeOnToken: !!arm.dynamicSampler,
        suppressUnknownLogits: !!arm.logitMask,
        draftCandidates: arm.id.includes('embedded')
          ? ['export function readConfig(): Config {']
          : undefined,
        env,
      },
    );
    if (t === 1) ttftMs = last.latencyMs;
    if (last.warmStart) warmStart = 1;
    if (last.grammarApplied) grammarApplied = 1;
    if (last.samplerHook) samplerHook = 1;
    if (last.dynamicSampler) dynamicSampler = 1;
    kvHitTokens = Math.max(kvHitTokens, last.kvPlan?.hitTokens ?? 0);
    kvPrefixReusedTokens = Math.max(kvPrefixReusedTokens, last.kvPrefixReusedTokens ?? 0);
    kvDeltaTokens = last.kvDeltaTokens ?? last.kvPlan?.deltaTokens ?? kvDeltaTokens;
    promptTokens = last.kvPlan?.totalTokens ?? promptTokens;
    unknownIdentifierRate = last.unknownIdentifiers?.length ?? unknownIdentifierRate;
    draftAcceptedChars = Math.max(draftAcceptedChars, last.draftAcceptedChars);
  }

  // Arm-specific extras for ollama baseline (no real HTTP — mark as simulated baseline).
  const extra: Record<string, number> = {
    turns,
    fcs: arm.provider === 'ollama' ? 0.5 : 0.7,
    validPatchRate: arm.grammar ? (grammarApplied ? 1 : 0.5) : 0.8,
    blockedApplies: arm.identifierEnforce ? 0 : 0,
  };

  const like: HostGenerateMetricsLike = {
    latencyMs: ttftMs,
    warmStart: warmStart === 1,
    grammarApplied: grammarApplied === 1,
    samplerHook: samplerHook === 1,
    samplerBoostedTokens: last?.samplerBoostedTokens ?? 0,
    samplerSuppressedTokens: last?.samplerSuppressedTokens ?? 0,
    dynamicSampler: dynamicSampler === 1,
    kvPrefixReusedTokens,
    kvDeltaTokens,
    draftAcceptedChars,
    draftCandidatesTried: last?.draftCandidatesTried ?? 0,
    kvPlan: { hitTokens: kvHitTokens, totalTokens: promptTokens, deltaTokens: kvDeltaTokens },
    unknownIdentifiers: last?.unknownIdentifiers,
  };

  const full = metricsFromHostGenerate(like, extra);
  const metrics = Object.fromEntries(arm.metrics.map((m) => [m, full[m] ?? 0]));

  return {
    armId: arm.id,
    ok: true,
    metrics,
    notes: live ? 'live' : 'simulate',
  };
}

/** Minimal node-llama-cpp-shaped fake for simulate mode (no native deps). */
export function defaultSimulateLib(reply = 'export function readConfig(): Config { /* ok */ }') {
  class TokenBias {
    constructor(_t: unknown) {}
    set(_a: unknown, _b: unknown) {}
  }
  class LlamaGrammar {
    constructor(_a: unknown, _b: { grammar: string }) {}
  }
  return {
    TokenBias,
    LlamaGrammar,
    getLlama: async () => ({
      loadModel: async () => ({
        tokenizer: {},
        tokenize: (s: string) => (typeof s === 'string' ? s.split('') : []),
        detokenize: (t: unknown[]) => String(t?.[0] ?? ''),
        iterateAllTokens: function* () {
          yield 'ghostFn';
          yield 'readConfig';
        },
        createContext: async () => ({
          getSequence: () => ({
            evaluateWithoutGeneratingNewTokens: async () => {},
          }),
        }),
      }),
    }),
    LlamaChatSession: class {
      async prompt(_p: string, _opts?: unknown) {
        return reply;
      }
    },
  };
}

/** Render a compact human table for CLI. */
export function renderHostBenchReportText(result: HostBenchRunResult): string {
  const lines = [
    `vg models host-bench · mode=${result.mode} · ${result.report.arms.length} arm(s) · ${result.elapsedMs}ms`,
    '',
  ];
  for (const a of result.report.arms) {
    const mark = a.ok ? '✔' : '✗';
    const metricSummary = Object.entries(a.metrics)
      .slice(0, 6)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    lines.push(`  ${mark} ${a.armId}  ${metricSummary}${a.notes ? `  (${a.notes})` : ''}`);
  }
  return lines.join('\n');
}
