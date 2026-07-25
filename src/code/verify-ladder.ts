/**
 * Graph-derived verification ladder (Fusion Runtime Phase 5).
 *
 * Compiles a deterministic ordered checklist from a Task Capsule verification
 * plan (and optional project test command), then runs the steps that can be
 * checked without a model. Shell steps use an injected runner — never spawn
 * implicitly.
 */

import type { VerificationPlan } from './capsule.js';
import type { VerificationTarget } from './patch-ir.js';

export type LadderStep =
  | { kind: 'syntax'; files: string[]; detail: string }
  | { kind: 'command'; command: string; detail: string }
  | { kind: 'note'; detail: string };

export interface LadderStepResult {
  step: LadderStep;
  ok: boolean;
  /** Actionable detail for the model / user (no secrets). */
  message: string;
}

export interface LadderResult {
  ok: boolean;
  steps: LadderStepResult[];
  /** True if any command step was run. */
  ranCommands: boolean;
}

export interface CompileLadderOptions {
  /** Project test / verify command (e.g. from code.json). */
  testCommand?: string;
  /** Extra targets from PatchIR.requestedVerification. */
  patchTargets?: VerificationTarget[];
  /** Cap how many syntax files to check (default 20). */
  maxSyntaxFiles?: number;
}

/**
 * Compile an ordered verification ladder. Deterministic given the same plan + options.
 *
 * Order: notes → syntax (touched files exist & non-empty) → patch commands →
 * project testCommand → suggested test symbols as notes (hints only).
 */
export function compileVerificationLadder(plan: VerificationPlan, options: CompileLadderOptions = {}): LadderStep[] {
  const steps: LadderStep[] = [];
  const maxSyntax = options.maxSyntaxFiles ?? 20;

  for (const note of plan.notes) {
    steps.push({ kind: 'note', detail: note });
  }

  const syntaxFiles = [...new Set(plan.syntaxFiles.map(normalize))].filter(Boolean).sort().slice(0, maxSyntax);
  if (syntaxFiles.length) {
    steps.push({
      kind: 'syntax',
      files: syntaxFiles,
      detail: `check ${syntaxFiles.length} target file(s) exist after edit`,
    });
  }

  const commands = new Set<string>();
  for (const t of options.patchTargets ?? []) {
    if (t.kind === 'command' || t.kind === 'test' || t.kind === 'build' || t.kind === 'typecheck') {
      if (t.target.trim()) commands.add(t.target.trim());
    }
  }
  if (options.testCommand?.trim()) commands.add(options.testCommand.trim());

  for (const command of [...commands].sort()) {
    steps.push({ kind: 'command', command, detail: `run \`${command}\`` });
  }

  if (plan.suggestedTests.length) {
    steps.push({
      kind: 'note',
      detail: `graph-linked tests to prefer: ${plan.suggestedTests.slice(0, 8).join(', ')}`,
    });
  }

  return steps;
}

export interface RunLadderOptions {
  readFile: (relativePath: string) => string | null;
  run?: (command: string) => { stdout: string; exitCode: number };
  /** When false, command steps are skipped (reported as ok notes). Default true. */
  runCommands?: boolean;
}

/** Execute a compiled ladder. Stops early on the first failing non-note step when `failFast` is true (default). */
export function runVerificationLadder(
  steps: LadderStep[],
  options: RunLadderOptions,
  failFast = true,
): LadderResult {
  const results: LadderStepResult[] = [];
  let ranCommands = false;
  let ok = true;

  for (const step of steps) {
    const result = runStep(step, options);
    if (result.step.kind === 'command' && options.runCommands !== false) ranCommands = true;
    results.push(result);
    if (!result.ok) {
      ok = false;
      if (failFast && step.kind !== 'note') break;
    }
  }

  return { ok, steps: results, ranCommands };
}

function runStep(step: LadderStep, options: RunLadderOptions): LadderStepResult {
  if (step.kind === 'note') {
    return { step, ok: true, message: step.detail };
  }

  if (step.kind === 'syntax') {
    const missing: string[] = [];
    const empty: string[] = [];
    for (const file of step.files) {
      const content = options.readFile(file);
      if (content === null) missing.push(file);
      else if (content.length === 0) empty.push(file);
    }
    if (missing.length || empty.length) {
      const parts: string[] = [];
      if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
      if (empty.length) parts.push(`empty: ${empty.join(', ')}`);
      return { step, ok: false, message: `syntax check failed — ${parts.join('; ')}` };
    }
    return { step, ok: true, message: `syntax ok — ${step.files.length} file(s) present` };
  }

  // command
  if (options.runCommands === false || !options.run) {
    return { step, ok: true, message: `skipped command (not configured): ${step.command}` };
  }
  const res = options.run(step.command);
  if (res.exitCode === 0) {
    return { step, ok: true, message: `\`${step.command}\` exit 0` };
  }
  const tail = (res.stdout ?? '').slice(0, 2000);
  return {
    step,
    ok: false,
    message: `\`${step.command}\` exit ${res.exitCode}${tail ? `:\n${tail}` : ''}`,
  };
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}
