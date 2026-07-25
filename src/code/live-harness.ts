/**
 * Live-model Fusion harness arm (optional, opt-in).
 *
 * Offline FCS uses {@link runFusionTaskPack} with ScriptedProvider. This module
 * runs the same {@link FusionTask} corpus against a real {@link Provider} when
 * the caller supplies one — for local SWE-bench Lite measurement with a matched
 * model. Never runs automatically in CI (no network / no keys by default).
 *
 * Enable explicitly:
 *   import { runLiveFusionArm } from './live-harness.js';
 *   await runLiveFusionArm(tasks, { provider, arm: 'capsule' });
 */

import { runAgent, type AgentResult } from './agent.js';
import {
  computeFcsReport,
  createTrajectoryCollector,
  renderFcsReportMarkdown,
  type FcsReport,
  type TrajectoryArm,
  type TrajectoryRecord,
} from './trajectory.js';
import type { FusionTask } from './trajectory-harness.js';
import { fixtureGraph } from './graph-fixture.js';
import type { CodeFs } from './session.js';
import type { Provider } from './types.js';

export interface LiveHarnessOptions {
  /** Real model provider (Ollama, OpenRouter, …). */
  provider: Provider;
  /** Which arm label to record (default capsule). */
  arm?: TrajectoryArm;
  /** Max agent steps per task (default 16). */
  maxSteps?: number;
  /** Auto-approve mutations (default true for unattended bench). */
  auto?: boolean;
  /** Wall-clock budget per task ms (default 10 min). */
  timeoutMs?: number;
  /** Optional filter: only these task ids. */
  taskIds?: string[];
}

export interface LiveTaskResult {
  taskId: string;
  arm: TrajectoryArm;
  trajectory: TrajectoryRecord;
  agent: AgentResult | null;
  error?: string;
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
 * Run tasks against a live provider. Does not call the network unless
 * `provider.chat` does — callers construct the provider explicitly.
 */
export async function runLiveFusionArm(
  tasks: FusionTask[],
  options: LiveHarnessOptions,
): Promise<{ report: FcsReport; results: LiveTaskResult[]; markdown: string }> {
  const arm = options.arm ?? 'capsule';
  const selected = options.taskIds?.length
    ? tasks.filter((t) => options.taskIds!.includes(t.id))
    : tasks;
  const results: LiveTaskResult[] = [];

  for (const task of selected) {
    const collector = createTrajectoryCollector();
    let inferenceTurns = 0;
    const t0 = Date.now();
    let shellIdx = 0;
    const exits = task.shellExits ?? [0];
    const run = (command: string): { stdout: string; exitCode: number } => {
      const exitCode = exits[Math.min(shellIdx, exits.length - 1)] ?? 0;
      shellIdx++;
      return {
        stdout: exitCode === 0 ? `ok: ${command}` : `FAIL: ${command}`,
        exitCode,
      };
    };

    try {
      const agent = await withTimeout(
        runAgent({
          graph: task.graph ?? fixtureGraph(),
          root: '/repo',
          instruction: task.instruction,
          providers: [options.provider],
          fsImpl: memFs(task.files),
          run,
          approve: async () => options.auto !== false,
          auto: options.auto !== false,
          maxSteps: options.maxSteps ?? 16,
          capsule: arm === 'capsule' || arm === 'oracle',
          verify: task.verifyCommand ? { command: task.verifyCommand, maxRounds: 2 } : undefined,
          noAudit: true,
          onEvent: (e) => {
            if (e.type === 'step') inferenceTurns = e.n;
            if (e.type === 'tool-result') collector.recordTool(e.name, inferenceTurns || 1, e.mutated);
            if (e.type === 'usage') collector.recordUsage(e.promptTokens, e.completionTokens);
            if (e.type === 'failure-capsule') collector.markFailureCapsule();
          },
        }),
        options.timeoutMs ?? 600_000,
      );

      const solved = agent.stopped === 'finished';
      const trajectory = collector.finalize({
        taskId: task.id,
        arm,
        solved,
        verified: solved,
        steps: agent.steps,
        stopped: agent.stopped,
        inferenceTurns: inferenceTurns || agent.steps,
        filesChanged: agent.changes.length,
        usedCapsule: arm === 'capsule' || arm === 'oracle',
        elapsedMs: Date.now() - t0,
        provider: { id: agent.provider.id, model: agent.provider.model },
      });
      results.push({ taskId: task.id, arm, trajectory, agent });
    } catch (e) {
      const trajectory = collector.finalize({
        taskId: task.id,
        arm,
        solved: false,
        verified: false,
        steps: 0,
        stopped: 'error',
        inferenceTurns: 0,
        filesChanged: 0,
        usedCapsule: arm === 'capsule' || arm === 'oracle',
        elapsedMs: Date.now() - t0,
      });
      results.push({
        taskId: task.id,
        arm,
        trajectory,
        agent: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const report = computeFcsReport(results.map((r) => r.trajectory));
  return { report, results, markdown: renderFcsReportMarkdown(report) };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`live harness task timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
