/**
 * Side-by-side parity harness for `vg code` backends (parity spec §5.2).
 *
 * Runs a fixed prompt set against two or more *arms* — each arm is a set of
 * `vg code` flags, e.g. `--provider grok-build`, `--acp-command "<reference agent> acp"`,
 * or `--provider openrouter --model …` for the native loop. Every run goes
 * through the same host path the VS Code panel uses (`--stream-json --session`,
 * one `submit`, wait for `idle`, `end`), in a throwaway git worktree so edits
 * never touch the source checkout.
 *
 * Per run it records: steps, turn wall time (submit → idle), startup time,
 * time to first token, stop reason, visible activity lines and Changes cards
 * (HOST_UI.md defaults, via host-transcript.ts), whether the run concluded
 * cleanly, which files changed, and whether a plan-only prompt wrote anything.
 * Each run also keeps the engine's own `--profile-out` record and a full
 * `--trace-out` frame trace for auditing.
 *
 * The verdict compares every arm to the baseline arm:
 *  - latency: median turn time ≤ baseline × (1 + maxSlowdown)   (default 20%)
 *  - conclusion: clean-conclusion rate ≥ baseline − 20 percentage points
 *  - quietness: median activity lines ≤ baseline's
 * plus the absolute shape: every edit prompt ≤ 2 activity lines + 1 Changes card,
 * and no plan prompt writes a file.
 *
 * Runner I/O (spawn, git) is injected-free but isolated in {@link runParityOnce};
 * the aggregation and report are pure and unit-tested.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { visibleTranscript } from './host-transcript.js';
import { redactSecrets } from './providers.js';

export interface ParityPrompt {
  id: string;
  text: string;
  /** `plan` runs the turn in plan mode (must not write). */
  mode: 'agent' | 'plan';
  expectsEdit: boolean;
}

/** The parity set from the spec (§5.2). */
export const PARITY_PROMPTS: readonly ParityPrompt[] = [
  { id: 'timeout-flag', text: 'Add a --timeout flag to the scan command and document it.', mode: 'agent', expectsEdit: true },
  { id: 'extract-gate', text: 'Extract the approval gate into its own module.', mode: 'agent', expectsEdit: true },
  {
    id: 'no-progress-retry',
    text: 'Fix the no-progress guard so legitimate retries are allowed, and add a unit test.',
    mode: 'agent',
    expectsEdit: true,
  },
  { id: 'plan-worktree', text: 'Plan a safe worktree support for non-git folders. Do not edit yet.', mode: 'plan', expectsEdit: false },
];

export interface ParityArm {
  name: string;
  /** Extra `vg code` flags for this arm. */
  args: string[];
  /** True when the arm is a simulation (the fake ACP agent); reports say so. */
  simulated?: boolean;
  /** Extra environment for this arm's `vg` process (e.g. a local endpoint URL). Never a secret in a report. */
  env?: Record<string, string>;
}

export interface ParityRun {
  arm: string;
  promptId: string;
  run: number;
  /** Process exited and the turn reached `idle`. */
  ok: boolean;
  /** submit → idle. The primary latency number. */
  turnMs: number | null;
  /** spawn → session-start (map load, agent spawn + handshake). */
  startupMs: number | null;
  timeToFirstTokenMs: number | null;
  steps: number | null;
  toolCalls: number | null;
  stopReason: string | null;
  activityLines: number;
  changesCards: number;
  permissionCards: number;
  concludedCleanly: boolean;
  /** Files changed in the worktree (git status), excluding .vibgrate/. */
  filesChanged: string[];
  /** A plan-mode prompt changed a file. */
  planViolation: boolean;
  error: string | null;
  exitCode: number | null;
}

export interface ArmSummary {
  arm: string;
  simulated: boolean;
  runs: number;
  medianTurnMs: number | null;
  medianStartupMs: number | null;
  medianSteps: number | null;
  medianActivityLines: number | null;
  cleanRate: number;
  changesCardRate: number;
  planViolations: number;
  /** Edit prompts whose transcript exceeded 2 activity lines or lacked exactly 1 Changes card. */
  shapeViolations: string[];
}

export interface ArmComparison {
  arm: string;
  baseline: string;
  /** arm median turn time / baseline median turn time. */
  turnRatio: number | null;
  cleanRateDelta: number;
  activityDelta: number | null;
  latencyPass: boolean;
  conclusionPass: boolean;
  quietPass: boolean;
  shapePass: boolean;
  pass: boolean;
}

export interface ParitySummary {
  schema: 'vg-code-parity/1';
  baseline: string;
  maxSlowdown: number;
  simulated: boolean;
  arms: ArmSummary[];
  comparisons: ArmComparison[];
  pass: boolean;
}

export function median(xs: Array<number | null>): number | null {
  const v = xs.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Aggregate runs per arm and compare every arm to the baseline. Pure. */
export function summarizeParity(
  runs: readonly ParityRun[],
  arms: readonly ParityArm[],
  baseline: string,
  prompts: readonly ParityPrompt[] = PARITY_PROMPTS,
  maxSlowdown = 0.2,
): ParitySummary {
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const summaries: ArmSummary[] = arms.map((arm) => {
    const mine = runs.filter((r) => r.arm === arm.name);
    const shapeViolations: string[] = [];
    for (const r of mine) {
      const prompt = byId.get(r.promptId);
      if (!prompt?.expectsEdit) continue;
      if (r.activityLines > 2) shapeViolations.push(`${r.promptId}#${r.run}: ${r.activityLines} activity lines`);
      if (r.filesChanged.length && r.changesCards !== 1) shapeViolations.push(`${r.promptId}#${r.run}: ${r.changesCards} Changes cards`);
    }
    const editRuns = mine.filter((r) => byId.get(r.promptId)?.expectsEdit && r.filesChanged.length);
    return {
      arm: arm.name,
      simulated: !!arm.simulated,
      runs: mine.length,
      medianTurnMs: median(mine.map((r) => r.turnMs)),
      medianStartupMs: median(mine.map((r) => r.startupMs)),
      medianSteps: median(mine.map((r) => r.steps)),
      medianActivityLines: median(mine.map((r) => r.activityLines)),
      cleanRate: mine.length ? mine.filter((r) => r.concludedCleanly).length / mine.length : 0,
      changesCardRate: editRuns.length ? editRuns.filter((r) => r.changesCards === 1).length / editRuns.length : 0,
      planViolations: mine.filter((r) => r.planViolation).length,
      shapeViolations,
    };
  });
  const base = summaries.find((s) => s.arm === baseline);
  const comparisons: ArmComparison[] = summaries
    .filter((s) => s.arm !== baseline && base)
    .map((s) => {
      const turnRatio = s.medianTurnMs !== null && base!.medianTurnMs ? s.medianTurnMs / base!.medianTurnMs : null;
      const activityDelta =
        s.medianActivityLines !== null && base!.medianActivityLines !== null ? s.medianActivityLines - base!.medianActivityLines : null;
      const latencyPass = turnRatio !== null && turnRatio <= 1 + maxSlowdown;
      const conclusionPass = s.cleanRate >= base!.cleanRate - 0.2;
      const quietPass = activityDelta !== null && activityDelta <= 0;
      const shapePass = s.shapeViolations.length === 0 && s.planViolations === 0;
      return {
        arm: s.arm,
        baseline,
        turnRatio,
        cleanRateDelta: s.cleanRate - base!.cleanRate,
        activityDelta,
        latencyPass,
        conclusionPass,
        quietPass,
        shapePass,
        pass: latencyPass && conclusionPass && quietPass && shapePass,
      };
    });
  return {
    schema: 'vg-code-parity/1',
    baseline,
    maxSlowdown,
    simulated: arms.some((a) => a.simulated),
    arms: summaries,
    comparisons,
    pass: !!base && comparisons.length > 0 && comparisons.every((c) => c.pass),
  };
}

const fmtMs = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`);
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const mark = (ok: boolean): string => (ok ? 'pass' : 'FAIL');

/** Markdown report for `summary.md`. Pure. */
export function renderParityMarkdown(summary: ParitySummary, runs: readonly ParityRun[]): string {
  const lines: string[] = ['# VG Code parity report', ''];
  if (summary.simulated) {
    lines.push(
      '> **Simulated arms present.** Arms marked *simulated* drive scripted fakes (a fake ACP agent or a fake model server), not a real model. Their numbers validate the harness only; they say nothing about Grok Build or any real agent.',
      '',
    );
  }
  lines.push(`Baseline: **${summary.baseline}** · latency budget: ≤ ${pct(1 + summary.maxSlowdown)} of baseline · overall: **${summary.pass ? 'PASS' : 'FAIL'}**`, '');
  lines.push('| Arm | Runs | Median turn | Median startup | Median steps | Median activity lines | Clean conclusion | Changes card (edits) | Plan violations |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const a of summary.arms) {
    lines.push(
      `| ${a.arm}${a.simulated ? ' *(simulated)*' : ''} | ${a.runs} | ${fmtMs(a.medianTurnMs)} | ${fmtMs(a.medianStartupMs)} | ${a.medianSteps ?? '—'} | ${a.medianActivityLines ?? '—'} | ${pct(a.cleanRate)} | ${pct(a.changesCardRate)} | ${a.planViolations} |`,
    );
  }
  lines.push('', '## Comparison with the baseline', '');
  lines.push('| Arm | Turn time ratio | Latency | Clean-rate Δ | Conclusion | Activity Δ | Quietness | Shape | Verdict |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const c of summary.comparisons) {
    lines.push(
      `| ${c.arm} | ${c.turnRatio === null ? '—' : c.turnRatio.toFixed(2)} | ${mark(c.latencyPass)} | ${(c.cleanRateDelta * 100).toFixed(0)} pts | ${mark(c.conclusionPass)} | ${c.activityDelta ?? '—'} | ${mark(c.quietPass)} | ${mark(c.shapePass)} | **${c.pass ? 'PASS' : 'FAIL'}** |`,
    );
  }
  const shape = summary.arms.flatMap((a) => a.shapeViolations.map((v) => `- ${a.arm}: ${v}`));
  if (shape.length) lines.push('', '## Shape violations', '', ...shape);
  lines.push('', '## Runs', '');
  lines.push('| Arm | Prompt | # | Stop | Steps | Tools | Turn | TTFT | Activity | Cards | Clean | Files | Error |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of runs) {
    lines.push(
      `| ${r.arm} | ${r.promptId} | ${r.run} | ${r.stopReason ?? '—'} | ${r.steps ?? '—'} | ${r.toolCalls ?? '—'} | ${fmtMs(r.turnMs)} | ${fmtMs(r.timeToFirstTokenMs)} | ${r.activityLines} | ${r.changesCards} | ${r.concludedCleanly ? 'yes' : 'no'} | ${r.filesChanged.length} | ${r.error ? r.error.replace(/\|/g, '/').slice(0, 80) : ''} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

// ── runner ────────────────────────────────────────────────────────────────────

export interface RunOnceOptions {
  /** argv prefix that runs `vg`, e.g. [process.execPath, 'dist/cli.js']. */
  vg: string[];
  arm: ParityArm;
  prompt: ParityPrompt;
  run: number;
  /** Source repository (a git repo; a detached worktree is created per run). */
  repo: string;
  /** Per-run artifacts (profile, trace, ACP wire log, stderr) land here. */
  outDir: string;
  timeoutMs: number;
  keepWorkspace?: boolean;
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Create an isolated copy of `repo` at HEAD: a detached git worktree. */
export function createWorkspace(repo: string): { dir: string; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-parity-'));
  const added = git(repo, ['worktree', 'add', '--detach', dir, 'HEAD']);
  if (!added.ok) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`could not create a worktree of ${repo} (is it a git repository with a commit?): ${added.out.trim().split('\n').pop()}`);
  }
  return {
    dir,
    dispose: () => {
      git(repo, ['worktree', 'remove', '--force', dir]);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Files changed in a workspace, excluding VG's own state. */
export function changedFiles(dir: string): string[] {
  const st = git(dir, ['status', '--porcelain', '--untracked-files=all']);
  return st.out
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter((f) => f && !f.startsWith('.vibgrate/') && !f.startsWith('.vibgrate'))
    .sort();
}

/** One prompt on one arm, through the host protocol. Never throws: failures are recorded. */
export async function runParityOnce(o: RunOnceOptions): Promise<ParityRun> {
  const clock = o.clock ?? Date.now;
  const tag = `${o.arm.name}.${o.prompt.id}.${o.run}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  fs.mkdirSync(o.outDir, { recursive: true });
  const profileOut = path.join(o.outDir, `${tag}.profile.jsonl`);
  const traceOut = path.join(o.outDir, `${tag}.trace.ndjson`);
  const acpLog = path.join(o.outDir, `${tag}.acp.ndjson`);
  const stderrFile = path.join(o.outDir, `${tag}.stderr.txt`);
  const base: ParityRun = {
    arm: o.arm.name,
    promptId: o.prompt.id,
    run: o.run,
    ok: false,
    turnMs: null,
    startupMs: null,
    timeToFirstTokenMs: null,
    steps: null,
    toolCalls: null,
    stopReason: null,
    activityLines: 0,
    changesCards: 0,
    permissionCards: 0,
    concludedCleanly: false,
    filesChanged: [],
    planViolation: false,
    error: null,
    exitCode: null,
  };
  let ws: { dir: string; dispose: () => void };
  try {
    ws = createWorkspace(o.repo);
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
  try {
    const argv = [
      ...o.vg.slice(1),
      'code',
      '--cwd',
      ws.dir,
      '--stream-json',
      '--session',
      '--auto',
      '--profile-out',
      profileOut,
      '--trace-out',
      traceOut,
      '--acp-log',
      acpLog,
      ...o.arm.args,
    ];
    const t0 = clock();
    const child = spawn(o.vg[0], argv, {
      cwd: ws.dir,
      env: { ...process.env, ...(o.env ?? {}), ...(o.arm.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stderr: string[] = [];
    child.stderr.on('data', (d) => stderr.push(String(d)));
    child.stdin.on('error', () => {});
    const turnLines: Record<string, unknown>[] = [];
    let tStart: number | null = null;
    let tSubmit: number | null = null;
    let tIdle: number | null = null;
    let tFirstToken: number | null = null;
    let fatal: string | null = null;
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (raw) => {
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      const now = clock();
      if (line.event === 'session-start' && tStart === null) {
        tStart = now;
        tSubmit = now;
        child.stdin.write(JSON.stringify({ submit: o.prompt.text, agentMode: o.prompt.mode === 'plan' ? 'plan' : 'auto' }) + '\n');
        return;
      }
      if (tSubmit === null) {
        if (line.event === 'error') fatal = String(line.message ?? 'error');
        return;
      }
      turnLines.push(line);
      if (tFirstToken === null && line.event === 'event' && (line.type === 'token' || line.type === 'assistant')) tFirstToken = now;
      if (line.event === 'idle' && tIdle === null) {
        tIdle = now;
        child.stdin.write(JSON.stringify({ end: true }) + '\n');
        child.stdin.end();
      }
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        fatal = fatal ?? `timed out after ${Math.round(o.timeoutMs / 1000)}s`;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3_000).unref();
      }, o.timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        fatal = `could not run vg: ${e.message}`;
        resolve(null);
      });
    });
    fs.writeFileSync(stderrFile, redactSecrets(stderr.join('')));
    const view = visibleTranscript(turnLines);
    const done = [...turnLines].reverse().find((l) => l.event === 'done') as { result?: { steps?: number; stopped?: string } } | undefined;
    const errLine = [...turnLines].reverse().find((l) => l.event === 'error') as { message?: unknown } | undefined;
    const metrics = [...turnLines].reverse().find((l) => l.event === 'event' && l.type === 'metrics') as
      | { metrics?: { toolCalls?: number; steps?: number } }
      | undefined;
    const files = changedFiles(ws.dir);
    const stopReason = done?.result?.stopped ?? (errLine ? 'error' : null);
    return {
      ...base,
      ok: tIdle !== null,
      turnMs: tIdle !== null && tSubmit !== null ? tIdle - tSubmit : null,
      startupMs: tStart !== null ? tStart - t0 : null,
      timeToFirstTokenMs: tFirstToken !== null && tSubmit !== null ? tFirstToken - tSubmit : null,
      steps: done?.result?.steps ?? metrics?.metrics?.steps ?? null,
      toolCalls: metrics?.metrics?.toolCalls ?? null,
      stopReason,
      activityLines: view.activityLines,
      changesCards: view.changesCards,
      permissionCards: view.permissionCards,
      concludedCleanly: stopReason === 'finished' && !!view.answer && !errLine && !(o.prompt.mode === 'plan' && files.length > 0),
      filesChanged: files,
      planViolation: o.prompt.mode === 'plan' && files.length > 0,
      error: fatal ?? (errLine ? redactSecrets(String(errLine.message ?? '')).slice(0, 300) : null),
      exitCode,
    };
  } finally {
    if (o.keepWorkspace) {
      fs.writeFileSync(path.join(o.outDir, `${tag}.workspace.txt`), ws.dir + '\n');
    } else {
      ws.dispose();
    }
  }
}
