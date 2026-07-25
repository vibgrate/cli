/**
 * Offline trajectory harness for FCS / ZNS@1 measurement (Fusion Phase 0).
 *
 * Runs scripted providers against the real agent loop on in-memory fixtures —
 * no network, no model. Scales to SWE-bench-shaped task packs by adding more
 * {@link FusionTask} records.
 */

import { runAgent, type AgentResult } from './agent.js';
import { ScriptedProvider } from './providers.js';
import { fixtureGraph } from './graph-fixture.js';
import {
  computeFcsReport,
  createTrajectoryCollector,
  renderFcsReportMarkdown,
  type FcsReport,
  type TrajectoryArm,
  type TrajectoryRecord,
} from './trajectory.js';
import { fullOfflineFusionCorpus, loadFusionTasksFromDir } from './fusion-task-pack.js';
import type { CodeFs } from './session.js';
import type { Provider, ToolCall } from './types.js';
import type { VgGraph } from '../schema.js';

export interface FusionTaskScriptStep {
  text?: string;
  toolCalls?: ToolCall[];
}

export interface FusionTask {
  /** Stable id (SWE-bench instance_id or fixture slug). */
  id: string;
  instruction: string;
  /** Seed files for the in-memory fs. */
  files: Record<string, string>;
  /**
   * Scripted model turns per arm. Missing arm → task skipped for that arm.
   * Use empty toolCalls array + finish for oracle / capsule ZNS paths.
   */
  scripts: Partial<Record<TrajectoryArm, FusionTaskScriptStep[]>>;
  /**
   * When set, agent runs with verify.command after finish. Scripted run()
   * can return non-zero once then zero to exercise Failure Capsule + repair.
   */
  verifyCommand?: string;
  /** Shell runner responses in order (exitCode). Default always 0. */
  shellExits?: number[];
  /** Optional graph (default fixtureGraph). */
  graph?: VgGraph;
}

export interface RunFusionTaskOptions {
  arms?: TrajectoryArm[];
  autoApprove?: boolean;
}

export interface FusionTaskResult {
  taskId: string;
  arm: TrajectoryArm;
  trajectory: TrajectoryRecord;
  agent: AgentResult;
}

function memFs(seed: Record<string, string>): CodeFs {
  const files: Record<string, string | null> = { ...seed };
  return {
    read: (f) => (f in files ? files[f] : null),
    write: (f, c) => {
      files[f] = c;
    },
    remove: (f) => {
      files[f] = null;
    },
    appendAudit: () => {},
  };
}

/**
 * Built-in pack for FCS / ZNS@1 (includes SWE-bench Lite–shaped offline corpus).
 * Prefer {@link fullOfflineFusionCorpus} for the full scale set; this alias keeps
 * existing call sites stable.
 */
export function defaultFusionTaskPack(): FusionTask[] {
  return fullOfflineFusionCorpus();
}

/** Load JSON packs from disk and merge with the built-in offline corpus. */
export function loadScaledFusionCorpus(extraDirs: string[] = []): FusionTask[] {
  const seen = new Set<string>();
  const out: FusionTask[] = [];
  for (const t of fullOfflineFusionCorpus()) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  for (const dir of extraDirs) {
    for (const t of loadFusionTasksFromDir(dir)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/** Run one task under one arm with a scripted provider. */
export async function runFusionTask(
  task: FusionTask,
  arm: TrajectoryArm,
  options: RunFusionTaskOptions = {},
): Promise<FusionTaskResult | null> {
  const script = task.scripts[arm];
  if (!script?.length) return null;

  const collector = createTrajectoryCollector();
  const provider: Provider = new ScriptedProvider(`scripted-${arm}`, script);
  let shellIdx = 0;
  const exits = task.shellExits ?? [0];
  const run = (command: string): { stdout: string; exitCode: number } => {
    const exitCode = exits[Math.min(shellIdx, exits.length - 1)] ?? 0;
    shellIdx++;
    return {
      stdout: exitCode === 0 ? `ok: ${command}` : `FAIL: ${command}\nAssertionError: expected 5000`,
      exitCode,
    };
  };

  const usedCapsule = arm === 'capsule' || arm === 'oracle';
  const t0 = Date.now();
  let inferenceTurns = 0;
  const agent = await runAgent({
    graph: task.graph ?? fixtureGraph(),
    root: '/repo',
    instruction: task.instruction,
    providers: [provider],
    fsImpl: memFs(task.files),
    run,
    approve: async () => options.autoApprove !== false,
    auto: true,
    capsule: usedCapsule,
    verify: task.verifyCommand ? { command: task.verifyCommand, maxRounds: 2 } : undefined,
    verifyLadder: usedCapsule,
    overlay: usedCapsule,
    noAudit: true,
    onEvent: (e) => {
      if (e.type === 'step') inferenceTurns = e.n;
      if (e.type === 'tool-call') {
        /* recorded after result for mutated flag */
      }
      if (e.type === 'tool-result') {
        collector.recordTool(e.name, inferenceTurns || 1, e.mutated);
      }
      if (e.type === 'usage') {
        collector.recordUsage(e.promptTokens, e.completionTokens);
      }
      if (e.type === 'failure-capsule') {
        collector.markFailureCapsule();
      }
    },
  });

  const verified =
    agent.stopped === 'finished' &&
    (task.verifyCommand
      ? // Last shell exit should be 0 if verify eventually passed.
        shellIdx > 0
          ? (exits[Math.min(shellIdx - 1, exits.length - 1)] ?? 0) === 0
          : true
      : true);

  // Stronger verified: agent finished and for fail-repair tasks, final file ok.
  const solved = agent.stopped === 'finished' && verified;

  const trajectory = collector.finalize({
    taskId: task.id,
    arm,
    solved,
    verified,
    steps: agent.steps,
    stopped: agent.stopped,
    inferenceTurns: inferenceTurns || agent.steps,
    filesChanged: agent.changes.length,
    usedCapsule,
    elapsedMs: Date.now() - t0,
    provider: { id: agent.provider.id, model: agent.provider.model },
  });

  // Attach agent metrics if present.
  if (agent.metrics) {
    Object.assign(trajectory, {
      discoveryToolCalls: agent.metrics.discoveryToolCalls,
      mutationToolCalls: agent.metrics.mutationToolCalls,
      shellCommands: agent.metrics.shellCommands,
      znsAt1: agent.metrics.znsAt1,
      promptTokens: agent.usage.promptTokens,
      completionTokens: agent.usage.completionTokens,
    });
  }

  return { taskId: task.id, arm, trajectory, agent };
}

/** Run a full pack across arms and return FCS report. */
export async function runFusionTaskPack(
  tasks: FusionTask[] = defaultFusionTaskPack(),
  options: RunFusionTaskOptions = {},
): Promise<{ report: FcsReport; results: FusionTaskResult[]; markdown: string }> {
  const arms = options.arms ?? (['capsule', 'metadata', 'oracle'] as TrajectoryArm[]);
  const results: FusionTaskResult[] = [];
  for (const task of tasks) {
    for (const arm of arms) {
      const r = await runFusionTask(task, arm, options);
      if (r) results.push(r);
    }
  }
  const report = computeFcsReport(results.map((r) => r.trajectory));
  return { report, results, markdown: renderFcsReportMarkdown(report) };
}
