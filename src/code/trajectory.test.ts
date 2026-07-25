import { describe, it, expect } from 'vitest';
import {
  computeFcsReport,
  computeZnsAt1,
  createTrajectoryCollector,
  renderFcsReportMarkdown,
  TRAJECTORY_SCHEMA_VERSION,
  type TrajectoryRecord,
} from './trajectory.js';
import { defaultFusionTaskPack, runFusionTaskPack } from './trajectory-harness.js';

function rec(partial: Partial<TrajectoryRecord> & Pick<TrajectoryRecord, 'taskId' | 'arm' | 'solved'>): TrajectoryRecord {
  return {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    verified: partial.solved,
    znsAt1: false,
    steps: 2,
    stopped: partial.solved ? 'finished' : 'error',
    inferenceTurns: 2,
    toolCalls: [],
    discoveryToolCalls: 0,
    mutationToolCalls: 1,
    shellCommands: 0,
    promptTokens: 100,
    completionTokens: 20,
    elapsedMs: 10,
    filesChanged: 1,
    usedCapsule: partial.arm === 'capsule' || partial.arm === 'oracle',
    failureCapsuleBuilt: false,
    ...partial,
  };
}

describe('trajectory metrics', () => {
  it('computeZnsAt1 requires capsule + solve + no discovery tools', () => {
    expect(
      computeZnsAt1({
        solved: true,
        usedCapsule: true,
        toolCalls: [{ name: 'edit_file' }, { name: 'finish' }],
      }),
    ).toBe(true);
    expect(
      computeZnsAt1({
        solved: true,
        usedCapsule: true,
        toolCalls: [{ name: 'search_code' }, { name: 'edit_file' }],
      }),
    ).toBe(false);
    expect(
      computeZnsAt1({
        solved: true,
        usedCapsule: false,
        toolCalls: [{ name: 'edit_file' }],
      }),
    ).toBe(false);
  });

  it('collector finalizes discovery counts and zns', () => {
    const c = createTrajectoryCollector();
    c.recordTool('edit_file', 1, true);
    c.recordTool('finish', 1, false);
    c.recordUsage(50, 10);
    const t = c.finalize({
      taskId: 't1',
      arm: 'capsule',
      solved: true,
      verified: true,
      steps: 1,
      stopped: 'finished',
      inferenceTurns: 1,
      filesChanged: 1,
      usedCapsule: true,
    });
    expect(t.znsAt1).toBe(true);
    expect(t.discoveryToolCalls).toBe(0);
    expect(t.mutationToolCalls).toBe(1);
    expect(t.promptTokens).toBe(50);
  });

  it('computeFcsReport pairs capsule vs oracle task ids', () => {
    const report = computeFcsReport([
      rec({ taskId: 'a', arm: 'oracle', solved: true }),
      rec({ taskId: 'b', arm: 'oracle', solved: true }),
      rec({ taskId: 'a', arm: 'capsule', solved: true, znsAt1: true, usedCapsule: true }),
      rec({ taskId: 'b', arm: 'capsule', solved: false, usedCapsule: true }),
      rec({ taskId: 'c', arm: 'metadata', solved: true, usedCapsule: false }),
    ]);
    // Oracle solves a,b; capsule solves only a among those → FCS = 0.5
    expect(report.fcs).toBe(0.5);
    expect(report.oracleSolved).toBe(2);
    expect(report.capsuleSolved).toBe(1);
    expect(report.znsAt1Rate).toBe(1);
    expect(renderFcsReportMarkdown(report)).toContain('FCS');
  });
});

describe('fusion trajectory harness', () => {
  it('runs the default pack and produces FCS / ZNS metrics', async () => {
    const { report, results, markdown } = await runFusionTaskPack(defaultFusionTaskPack());
    expect(results.length).toBeGreaterThanOrEqual(6);
    expect(report.capsuleRuns).toBeGreaterThan(0);
    expect(report.oracleRuns).toBeGreaterThan(0);
    // At least one capsule ZNS path in the pack.
    expect(results.some((r) => r.arm === 'capsule' && r.trajectory.znsAt1)).toBe(true);
    // Failure→repair path builds a failure capsule when verify fails first.
    expect(results.some((r) => r.trajectory.failureCapsuleBuilt)).toBe(true);
    expect(markdown).toMatch(/ZNS@1|FCS/);
    // FCS defined when oracle arm present.
    expect(report.fcs).not.toBeNull();
    expect(report.fcs!).toBeGreaterThan(0);
  }, 30_000);
});
