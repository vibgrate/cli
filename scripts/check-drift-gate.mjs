#!/usr/bin/env node
/**
 * Pre-publish dependency-drift gate.
 *
 * Vibgrate's whole pitch is reducing dependency drift, so the CLI we ship must
 * be an exemplar of it. This gate runs the *just-built* `vg` binary against the
 * public CLI package itself — dogfooding the exact artifact about to be
 * published — and blocks the release if our own dependency hygiene regresses.
 *
 * It leans on the CLI's own machine-readable output and exit-code gates rather
 * than re-deriving thresholds, so the gate can never disagree with the tool it
 * publishes:
 *
 *   1. standards — `vg drift --fail-on standards` (offline, deterministic): no
 *                  banned/abandoned dependency from vibgrate.standards.json is
 *                  in use. Runs on every PR and at publish.
 *   2. currency  — `vg drift --online --json`: no direct dependency drifts past
 *                  the allowed level (default: no whole major behind latest),
 *                  honouring reviewed per-package allowances. Needs the registry,
 *                  so it is an online-only (publish) gate.
 *   3. budget    — `vg scan --online --drift-budget <N>`: the blended DriftScore
 *                  (0 = clean … 100 = worst) stays at or below the budget. Also
 *                  online-only — offline the score sees no dependency currency.
 *
 * Every step yields pass/fail/error; the wrapper prints GitHub annotations + a
 * summary and exits 2 if any step failed (fail-closed: an unexpected/tooling
 * exit is a failure, never a silent pass).
 *
 * Usage:
 *   node scripts/check-drift-gate.mjs [--online] [--cli <path>] [--target <dir>] [--budget <n>]
 *
 * `--online` enables the currency + budget gates (used at publish). Without it
 * only the deterministic standards gate runs (used on PRs). The pure helpers
 * (loadPolicy, planSteps, the evaluators, runGate, overallExit) are exported for
 * tests; `main()` runs only when the file is executed directly.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Drift severity ranks — mirrors src/commands/drift.ts so the gate agrees with the CLI. */
const DRIFT_RANK = { major: 3, minor: 2, patch: 1, current: 0, unknown: 0 };
const LEVEL_RANK = { major: 3, minor: 2 };

/** Default policy — overridable per-key by drift-gate.config.json at the package root. */
export const DEFAULT_POLICY = {
  /** Blended DriftScore ceiling (0-100, lower is better), enforced online. */
  driftBudget: 30,
  /** Currency gate level: 'major' | 'minor' | null (disabled). Enforced online. */
  currency: 'major',
  /** Per-package lag allowances: { name: 'major' | 'minor' }. A reviewed escape hatch. */
  allow: {},
  /** Globs excluded from the budget scan so vendored sample repos / fixtures don't pollute the score. */
  scanExclude: [],
  /** Max % the DriftScore may worsen vs a committed baseline (only if the baseline exists). */
  worseningPercent: 0,
  /** Path (relative to target) of the committed baseline for the regression gate. */
  baseline: 'gate/drift-baseline.json',
  /** Whether to enforce the banned-dependency standards policy. */
  standards: true,
};

/** Merge drift-gate.config.json (if present) over the defaults. `readFile` is injectable for tests. */
export function loadPolicy(root = PKG_ROOT, readFile = readFileSync) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFile(path.join(root, 'drift-gate.config.json'), 'utf8'));
  } catch {
    // No config or unreadable → strict defaults. A malformed config must never
    // silently weaken the gate, so we only ever copy keys we recognise.
  }
  const merged = { ...DEFAULT_POLICY };
  for (const key of Object.keys(DEFAULT_POLICY)) {
    if (cfg[key] !== undefined) merged[key] = cfg[key];
  }
  return merged;
}

/** exit 0 → pass · exit 2 → fail (GATE_FAILED) · anything else → error (fail-closed). */
export function evaluateExit(result) {
  const detail = (result.stderr || result.stdout || '').trim();
  if (result.code === 0) return { status: 'pass' };
  if (result.code === 2) return { status: 'fail', detail };
  return { status: 'error', detail: `unexpected exit ${result.code}${detail ? `: ${detail}` : ''}` };
}

/**
 * Evaluate `vg drift --online --json` against the currency policy + allowances.
 * Only installed dependencies are classified (fixtures resolve to `unknown`), so
 * vendored sample repos never trip this. Pure — takes the parsed result.
 */
export function evaluateCurrency(result, policy) {
  if (result.code !== 0 && result.code !== 2) {
    return { status: 'error', detail: `drift command exited ${result.code}: ${(result.stderr || '').trim()}` };
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return { status: 'error', detail: 'could not parse `vg drift --json` output' };
  }
  const threshold = LEVEL_RANK[policy.currency] ?? 3;
  const allow = policy.allow ?? {};
  const offenders = (data.records ?? []).filter((r) => {
    const rank = DRIFT_RANK[r.drift] ?? 0;
    if (rank < threshold) return false;
    const allowed = LEVEL_RANK[allow[r.name]] ?? 0;
    return rank > allowed; // allowed at/above the observed drift → not an offender
  });
  if (offenders.length === 0) return { status: 'pass' };
  const detail = offenders
    .map((r) => `${r.drift} ${r.name} ${r.installed ?? r.declared} → ${r.latest}`)
    .join('; ');
  return { status: 'fail', detail: `${offenders.length} dependency(ies) at/above ${policy.currency}: ${detail}` };
}

/**
 * Build the ordered list of gate steps for the mode. Each step is
 * `{ id, label, args, online, evaluate }`. Pure — spawns nothing.
 */
export function planSteps({ policy, online, baselineExists }) {
  const steps = [];

  if (policy.standards) {
    steps.push({
      id: 'standards',
      label: 'No banned/abandoned dependency in use (standards policy)',
      args: ['drift', '--fail-on', 'standards'],
      online: false,
      evaluate: evaluateExit,
    });
  }

  // Currency + budget need a live "latest" from the registry — offline they are
  // meaningless, so they only run when --online is set (the publish gate).
  if (online && policy.currency) {
    steps.push({
      id: 'currency',
      label: `No direct dependency a whole ${policy.currency} behind latest (reviewed allowances aside)`,
      args: ['drift', '--online', '--json'],
      online: true,
      evaluate: (result) => evaluateCurrency(result, policy),
    });
  }

  if (online) {
    const scanArgs = ['scan', '.', '--no-graph', '--no-local-artifacts', '--quiet', '--drift-budget', String(policy.driftBudget)];
    for (const glob of policy.scanExclude ?? []) scanArgs.push('--exclude', glob);
    if (baselineExists) scanArgs.push('--baseline', policy.baseline, '--drift-worsening', String(policy.worseningPercent));
    steps.push({
      id: 'budget',
      label: baselineExists
        ? `DriftScore ≤ ${policy.driftBudget} and not worsening > ${policy.worseningPercent}% vs baseline`
        : `DriftScore ≤ ${policy.driftBudget}`,
      args: scanArgs,
      online: true,
      evaluate: evaluateExit,
    });
  }

  return steps;
}

/** Spawn the built CLI for one step. Deterministic env: no colour, no markers. */
export function defaultRunStep(cli, target, step) {
  const res = spawnSync(process.execPath, [cli, ...step.args], {
    cwd: target,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', VIBGRATE_EMIT_MARKERS: '0' },
  });
  if (res.error) return { code: 127, stdout: '', stderr: String(res.error.message ?? res.error) };
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Run every planned step. `runStep(step) → { code, stdout, stderr }` is injectable for tests. */
export function runGate({ policy, online, cli, target, baselineExists, runStep }) {
  const run = runStep ?? ((step) => defaultRunStep(cli, target, step));
  return planSteps({ policy, online, baselineExists }).map((step) => {
    const verdict = step.evaluate(run(step));
    return { id: step.id, label: step.label, ...verdict };
  });
}

/** 2 if any step failed or errored (fail-closed), else 0. */
export function overallExit(results) {
  return results.some((r) => r.status === 'fail' || r.status === 'error') ? 2 : 0;
}

/** Render a plain summary for a set of results. */
export function renderReport(results) {
  const icon = { pass: '✓', fail: '✗', error: '!' };
  const lines = [];
  for (const r of results) {
    lines.push(`${icon[r.status] ?? '?'} [${r.status.toUpperCase()}] ${r.label}`);
    if (r.status !== 'pass' && r.detail) lines.push(`    → ${r.detail}`);
  }
  return lines.join('\n');
}

function annotate(results) {
  for (const r of results) {
    if (r.status === 'pass') continue;
    console.log(`::error::Drift gate — ${r.label}${r.detail ? `: ${r.detail.replace(/\s+/g, ' ')}` : ''}`);
  }
}

function parseArgs(argv) {
  const out = { online: false, cli: path.join(PKG_ROOT, 'dist', 'cli.js'), target: PKG_ROOT, budget: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--online') out.online = true;
    else if (a === '--cli') out.cli = path.resolve(argv[++i]);
    else if (a === '--target') out.target = path.resolve(argv[++i]);
    else if (a === '--budget') out.budget = Number(argv[++i]);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadPolicy();
  if (Number.isFinite(args.budget)) policy.driftBudget = args.budget;

  if (!existsSync(args.cli)) {
    console.log(`::error::Drift gate: built CLI not found at ${args.cli}. Build the package before running the gate.`);
    process.exit(2);
  }
  const baselineExists = existsSync(path.join(args.target, policy.baseline));

  const results = runGate({ policy, online: args.online, cli: args.cli, target: args.target, baselineExists });
  const report = renderReport(results);
  console.log(`\nDependency drift gate (${args.online ? 'online' : 'offline'}) — ${path.relative(process.cwd(), args.target) || '.'}\n${report}\n`);
  annotate(results);

  const exit = overallExit(results);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const heading = exit === 0 ? '### ✓ Dependency drift gate passed' : '### ✗ Dependency drift gate FAILED';
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${heading}\n\n\`\`\`\n${report}\n\`\`\`\n`);
    } catch {
      // Best-effort summary; never let it change the outcome.
    }
  }
  if (exit !== 0) {
    console.log('\nThe published CLI must lead by example on dependency drift. Fix the breaches above, or');
    console.log('adjust the reviewed policy in packages/vibgrate-cli-public/{drift-gate.config.json,vibgrate.standards.json}.');
  } else {
    console.log('✓ Dependency drift gate passed — the CLI package is within its own drift policy.');
  }
  process.exit(exit);
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
