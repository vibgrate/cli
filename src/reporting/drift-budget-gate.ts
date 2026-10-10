/**
 * `driftBudget` from the project config, applied to a finished `vg scan`.
 *
 * The `--drift-budget` / `--drift-worsening` flags keep their historic
 * behaviour and take precedence: when either flag is passed, the config budget
 * is not consulted. Otherwise the config budget is evaluated with the same
 * evaluator the GitHub App check uses (`core-open/drift-budget.ts`).
 *
 * `vg scan` cannot tell who authored a change, so `agents.maxWorseningPercent`
 * is enforced by the GitHub App check only.
 */
import { evaluateDriftBudget, LOCAL_SCAN_RISK_NOTE, parseDriftBudget, type DriftBudgetVerdict } from '../core-open/index.js';

export interface DriftBudgetGateInput {
  /** The `driftBudget` value from the loaded config (unvalidated). */
  raw: unknown;
  /** Where the config came from, for messages. */
  configFile: string | null;
  headScore: number;
  /** Score before this change: `headScore - delta` when `--baseline` was used. */
  baseScore: number | null;
}

export type GateLineLevel = 'info' | 'warn' | 'error';

export interface DriftBudgetGateResult {
  /** 2 when an enforced limit was breached; otherwise 0. */
  exitCode: 0 | 2;
  lines: { level: GateLineLevel; text: string }[];
  verdict: DriftBudgetVerdict | null;
}

/**
 * Compare a DriftScore to `--drift-budget`.
 *
 * A null score is unmeasured. It does not fail the budget, and it is not
 * treated as 0. A measured 0 is a real score and is compared as usual.
 */
export function compareDriftBudget(
  score: number | null,
  budget: number,
): { exitCode: 0 | 2; message: string | null } {
  if (score === null) {
    return {
      exitCode: 0,
      message: `DriftScore is absent; --drift-budget ${budget} was not compared.`,
    };
  }
  if (score > budget) {
    return {
      exitCode: 2,
      message: `Failing fitness function: DriftScore ${score}/100 exceeds budget ${budget}.`,
    };
  }
  return { exitCode: 0, message: null };
}

export function evaluateConfigDriftBudget(input: DriftBudgetGateInput): DriftBudgetGateResult {
  const source = input.configFile ?? 'the project config';
  const parsed = parseDriftBudget(input.raw);
  if (!parsed) return { exitCode: 0, lines: [], verdict: null };
  if (!parsed.ok) {
    return {
      exitCode: 0,
      verdict: null,
      lines: [
        { level: 'warn', text: `driftBudget in ${source} was not applied:` },
        ...parsed.errors.map((e) => ({ level: 'warn' as const, text: `  ${e}` })),
      ],
    };
  }

  const verdict = evaluateDriftBudget({
    headScore: input.headScore,
    baseScore: input.baseScore,
    budget: parsed.budget,
    riskUnavailableReason: LOCAL_SCAN_RISK_NOTE,
  });
  const lines: DriftBudgetGateResult['lines'] = [];
  const breachLevel: GateLineLevel = verdict.mode === 'enforce' ? 'error' : 'warn';
  for (const rule of verdict.rules) {
    // An agent limit can't be judged locally; the App check owns it.
    if (rule.id === 'agents.maxWorseningPercent') continue;
    if (rule.status === 'breach') lines.push({ level: breachLevel, text: `drift budget (${verdict.mode}): ${rule.message}` });
    else if (rule.status === 'not_evaluated') {
      const hint = rule.id === 'maxWorseningPercent' ? ' Run with --baseline to compare.' : '';
      lines.push({ level: 'info', text: `drift budget: ${rule.message}${hint}` });
    }
    else lines.push({ level: 'info', text: `drift budget: ${rule.message}` });
  }
  if (!verdict.withinBudget && verdict.mode === 'warn') {
    lines.push({ level: 'info', text: `drift budget: warn mode — set driftBudget.mode: enforce in ${source} to fail the scan.` });
  }
  return { exitCode: verdict.blocking ? 2 : 0, lines, verdict };
}
