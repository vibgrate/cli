/**
 * Agent trajectory metrics (Fusion Runtime Phase 0 / plan §0.2).
 *
 * Pure helpers that turn a finished agent run into a TrajectoryRecord so we can
 * compute ZNS@1 (zero-navigation solve) and FCS (first-capsule sufficiency)
 * offline without a live model. Discovery tools force another navigation hop;
 * a ZNS@1 solve uses only edit/verify/finish after the initial capsule.
 */

export const TRAJECTORY_SCHEMA_VERSION = 'trajectory/0' as const;

/** Tools that count as model-driven navigation / discovery (not ZNS). */
export const DISCOVERY_TOOLS = new Set([
  'search_code',
  'read_file',
  'list_files',
  'graph_impact',
  'library_docs',
]);

/** Tools that mutate workspace state. */
export const MUTATION_TOOLS = new Set([
  'edit_file',
  'create_file',
  'delete_file',
  'apply_patch',
  'run_command',
]);

export type TrajectoryArm = 'metadata' | 'capsule' | 'oracle' | 'other';

export interface ToolCallRecord {
  name: string;
  /** Wall-clock step index (1-based agent step). */
  step: number;
  mutated: boolean;
}

export interface TrajectoryRecord {
  schemaVersion: typeof TRAJECTORY_SCHEMA_VERSION;
  /** Stable task id (fixture / SWE-bench instance id). */
  taskId: string;
  arm: TrajectoryArm;
  /** True when the run stopped finished and verification (if any) passed. */
  solved: boolean;
  /** True when verification was run and passed (or no verify configured). */
  verified: boolean;
  znsAt1: boolean;
  steps: number;
  stopped: string;
  inferenceTurns: number;
  toolCalls: ToolCallRecord[];
  discoveryToolCalls: number;
  mutationToolCalls: number;
  shellCommands: number;
  promptTokens: number;
  completionTokens: number;
  elapsedMs: number | null;
  filesChanged: number;
  usedCapsule: boolean;
  failureCapsuleBuilt: boolean;
  provider?: { id: string; model: string };
}

export interface TrajectoryCollector {
  recordTool(name: string, step: number, mutated: boolean): void;
  recordUsage(promptTokens: number, completionTokens: number): void;
  markFailureCapsule(): void;
  finalize(input: {
    taskId: string;
    arm: TrajectoryArm;
    solved: boolean;
    verified: boolean;
    steps: number;
    stopped: string;
    inferenceTurns: number;
    filesChanged: number;
    usedCapsule: boolean;
    elapsedMs?: number | null;
    provider?: { id: string; model: string };
  }): TrajectoryRecord;
}

/** Create a mutable collector for one agent run. */
export function createTrajectoryCollector(): TrajectoryCollector {
  const toolCalls: ToolCallRecord[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let failureCapsuleBuilt = false;

  return {
    recordTool(name, step, mutated) {
      toolCalls.push({ name, step, mutated });
    },
    recordUsage(p, c) {
      promptTokens += p;
      completionTokens += c;
    },
    markFailureCapsule() {
      failureCapsuleBuilt = true;
    },
    finalize(input) {
      const discoveryToolCalls = toolCalls.filter((t) => DISCOVERY_TOOLS.has(t.name)).length;
      const mutationToolCalls = toolCalls.filter((t) => MUTATION_TOOLS.has(t.name)).length;
      const shellCommands = toolCalls.filter((t) => t.name === 'run_command').length;
      const znsAt1 = computeZnsAt1({
        solved: input.solved && input.verified,
        usedCapsule: input.usedCapsule,
        toolCalls,
      });
      return {
        schemaVersion: TRAJECTORY_SCHEMA_VERSION,
        taskId: input.taskId,
        arm: input.arm,
        solved: input.solved,
        verified: input.verified,
        znsAt1,
        steps: input.steps,
        stopped: input.stopped,
        inferenceTurns: input.inferenceTurns,
        toolCalls,
        discoveryToolCalls,
        mutationToolCalls,
        shellCommands,
        promptTokens,
        completionTokens,
        elapsedMs: input.elapsedMs ?? null,
        filesChanged: input.filesChanged,
        usedCapsule: input.usedCapsule,
        failureCapsuleBuilt,
        provider: input.provider,
      };
    },
  };
}

/**
 * ZNS@1: task solved + verified from the initial capsule with zero discovery
 * tool calls (model never navigated). Requires capsule arm.
 */
export function computeZnsAt1(input: {
  solved: boolean;
  usedCapsule: boolean;
  toolCalls: Array<{ name: string }>;
}): boolean {
  if (!input.solved || !input.usedCapsule) return false;
  return !input.toolCalls.some((t) => DISCOVERY_TOOLS.has(t.name));
}

export interface FcsReport {
  schemaVersion: 'fcs-report/0';
  /** Solved under capsule arm ÷ solved under oracle arm (same task ids). */
  fcs: number | null;
  /** Tasks in both arms used for FCS. */
  pairedTasks: number;
  capsuleSolved: number;
  oracleSolved: number;
  /** Zero-navigation solve rate among capsule solves. */
  znsAt1Rate: number | null;
  capsuleRuns: number;
  oracleRuns: number;
  metadataRuns: number;
  byArm: Record<
    string,
    {
      runs: number;
      solved: number;
      passRate: number;
      znsAt1: number;
      medianDiscovery: number | null;
      medianSteps: number | null;
      medianPromptTokens: number | null;
    }
  >;
  records: TrajectoryRecord[];
}

/**
 * Aggregate trajectory records into FCS / ZNS@1 report.
 * FCS = |tasks solved under capsule| / |tasks solved under oracle| for the
 * intersection of task ids present in both arms. When no oracle arm exists,
 * fcs is null and pass rates are still reported per arm.
 */
export function computeFcsReport(records: TrajectoryRecord[]): FcsReport {
  const byArm: FcsReport['byArm'] = {};
  for (const arm of ['capsule', 'oracle', 'metadata', 'other'] as TrajectoryArm[]) {
    const armRecs = records.filter((r) => r.arm === arm);
    if (!armRecs.length && arm === 'other') continue;
    byArm[arm] = summarizeArm(armRecs);
  }

  const capsule = records.filter((r) => r.arm === 'capsule');
  const oracle = records.filter((r) => r.arm === 'oracle');
  const oracleSolvedIds = new Set(oracle.filter((r) => r.solved).map((r) => r.taskId));
  const capsuleByTask = new Map<string, TrajectoryRecord>();
  for (const r of capsule) {
    // Prefer solved record if duplicates.
    const prev = capsuleByTask.get(r.taskId);
    if (!prev || (r.solved && !prev.solved)) capsuleByTask.set(r.taskId, r);
  }
  const pairedIds = [...capsuleByTask.keys()].filter((id) => oracle.some((o) => o.taskId === id));
  const oracleSolvedPaired = pairedIds.filter((id) => oracleSolvedIds.has(id));
  const capsuleSolvedAmongOracle = oracleSolvedPaired.filter((id) => capsuleByTask.get(id)?.solved).length;

  const fcs =
    oracleSolvedPaired.length > 0 ? round(capsuleSolvedAmongOracle / oracleSolvedPaired.length) : null;

  const capsuleSolved = capsule.filter((r) => r.solved);
  const znsAt1Rate =
    capsuleSolved.length > 0 ? round(capsuleSolved.filter((r) => r.znsAt1).length / capsuleSolved.length) : null;

  return {
    schemaVersion: 'fcs-report/0',
    fcs,
    pairedTasks: pairedIds.length,
    capsuleSolved: capsuleSolvedAmongOracle,
    oracleSolved: oracleSolvedPaired.length,
    znsAt1Rate,
    capsuleRuns: capsule.length,
    oracleRuns: oracle.length,
    metadataRuns: records.filter((r) => r.arm === 'metadata').length,
    byArm,
    records,
  };
}

/** Markdown summary suitable for CI artifacts / docs. */
export function renderFcsReportMarkdown(report: FcsReport): string {
  const lines: string[] = [
    '# Fusion trajectory / FCS report',
    '',
    `| Metric | Value |`,
    `|---|---:|`,
    `| FCS (capsule ÷ oracle solves) | ${report.fcs == null ? 'n/a (no oracle arm)' : report.fcs.toFixed(3)} |`,
    `| ZNS@1 rate (capsule solves) | ${report.znsAt1Rate == null ? 'n/a' : (report.znsAt1Rate * 100).toFixed(1) + '%'} |`,
    `| Paired tasks | ${report.pairedTasks} |`,
    `| Capsule runs | ${report.capsuleRuns} |`,
    `| Oracle runs | ${report.oracleRuns} |`,
    `| Metadata runs | ${report.metadataRuns} |`,
    '',
    '## Per arm',
    '',
    '| Arm | Runs | Solved | Pass rate | ZNS@1 | Discovery p50 | Steps p50 | Prompt tokens p50 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [arm, s] of Object.entries(report.byArm)) {
    if (!s.runs) continue;
    lines.push(
      `| ${arm} | ${s.runs} | ${s.solved} | ${(s.passRate * 100).toFixed(1)}% | ${s.znsAt1} | ${fmt(s.medianDiscovery)} | ${fmt(s.medianSteps)} | ${fmt(s.medianPromptTokens)} |`,
    );
  }
  lines.push(
    '',
    '## Definitions',
    '',
    '- **ZNS@1**: solved + verified from a Task Capsule with zero discovery tool calls (`search_code`, `read_file`, `list_files`, `graph_impact`, `library_docs`).',
    '- **FCS**: among tasks the oracle arm solves, the fraction also solved under the capsule arm (same task ids).',
  );
  return lines.join('\n') + '\n';
}

function summarizeArm(recs: TrajectoryRecord[]): FcsReport['byArm'][string] {
  const solved = recs.filter((r) => r.solved).length;
  return {
    runs: recs.length,
    solved,
    passRate: recs.length ? round(solved / recs.length) : 0,
    znsAt1: recs.filter((r) => r.znsAt1).length,
    medianDiscovery: median(recs.map((r) => r.discoveryToolCalls)),
    medianSteps: median(recs.map((r) => r.steps)),
    medianPromptTokens: median(recs.map((r) => r.promptTokens)),
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function fmt(n: number | null): string {
  return n == null ? 'n/a' : String(n);
}
