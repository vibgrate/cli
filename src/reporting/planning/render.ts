import chalk from 'chalk';
import type { VulnSeverity } from '../../core-open/index.js';
import type { FixPlanResponse, UpgradePlan, VulnDelta } from './types.js';

/**
 * Human-facing renderers for the planner's response. `--json` bypasses these
 * entirely (the {@link FixPlanResponse} is emitted verbatim); these are for
 * `text` and `md`.
 */

const SEVERITY_ORDER: VulnSeverity[] = ['critical', 'high', 'moderate', 'low', 'unknown'];

function deltaSummary(delta: VulnDelta): string {
  if (delta.total === 0) return 'none';
  const parts = SEVERITY_ORDER.filter((s) => delta.bySeverity[s]).map((s) => `${delta.bySeverity[s]} ${s}`);
  return parts.length ? parts.join(', ') : `${delta.total}`;
}

function riskLabel(score: number): string {
  if (score <= 15) return chalk.green(`${score}/100 low`);
  if (score <= 40) return chalk.yellow(`${score}/100 moderate`);
  return chalk.red(`${score}/100 high`);
}

function planBlock(plan: UpgradePlan, recommended: boolean): string {
  const lines: string[] = [];
  const marker = recommended ? chalk.green('● recommended') : chalk.dim('○');
  lines.push(`${marker} ${chalk.bold(plan.label)} — ${chalk.dim(plan.description)}`);
  const drift =
    typeof plan.expectedDriftScore === 'number' && typeof plan.driftDelta === 'number'
      ? `  ·  DriftScore →${plan.expectedDriftScore} (${plan.driftDelta <= 0 ? '' : '+'}${plan.driftDelta})`
      : '';
  lines.push(
    `    risk ${riskLabel(plan.riskScore)}  ·  ${plan.upgrades.length} upgrade(s)  ·  ` +
      `fixes ${deltaSummary(plan.fixes)}${drift}`,
  );
  if (plan.introduces.total) {
    lines.push(chalk.red(`    ⚠ introduces ${deltaSummary(plan.introduces)} advisory(ies) in target versions`));
  }
  const shown = plan.upgrades.slice(0, 12);
  for (const u of shown) {
    const codemod = u.playbook?.codemod ? chalk.magenta(`  [codemod: ${u.playbook.codemod}]`) : '';
    lines.push(`      ${chalk.cyan(u.package)} ${chalk.dim(`${u.from ?? '?'} → ${u.to ?? '?'}`)}  ${chalk.dim(u.reason)}${codemod}`);
  }
  if (plan.upgrades.length > shown.length) {
    lines.push(chalk.dim(`      … and ${plan.upgrades.length - shown.length} more`));
  }
  return lines.join('\n');
}

function dataNote(report: FixPlanResponse): string | null {
  if (report.vulnerabilityData === 'unavailable') {
    return chalk.dim('Advisory data was unavailable — vulnerability impact is not shown.');
  }
  if (report.vulnerabilityData === 'partial') {
    return chalk.dim('Advisory data was partial — some ecosystems were not checked.');
  }
  return null;
}

export function renderText(report: FixPlanResponse): string {
  const out: string[] = [];
  out.push(chalk.bold('Vibgrate fix — upgrade plan'));
  out.push(
    chalk.dim(
      `${report.totalCandidates} drifted dependency(ies) analysed · ` +
        `${report.deepAnalysis ? 'deep (major) analysis on' : 'preflight only'}`,
    ),
  );
  const note = dataNote(report);
  if (note) out.push(note);
  if (report.exploitability && report.exploitability.kevPackages > 0) {
    const epss = report.exploitability.maxEpss != null ? `, peak EPSS ${(report.exploitability.maxEpss * 100).toFixed(0)}%` : '';
    out.push(chalk.red(`⚠ ${report.exploitability.kevPackages} package(s) carry a KNOWN-EXPLOITED (KEV) advisory${epss} — prioritise these.`));
  }
  out.push('');
  const visiblePlans = report.plans.filter((plan) => plan.upgrades.length > 0);
  if (visiblePlans.length === 0) {
    out.push(chalk.green('✔ Nothing to upgrade — every tracked dependency is current.'));
    out.push('');
  } else {
    for (const plan of visiblePlans) {
      out.push(planBlock(plan, plan.tier === report.recommended));
      out.push('');
    }
  }
  out.push(chalk.bold('Recommendation'));
  out.push(`  ${chalk.green(report.plans.find((p) => p.tier === report.recommended)?.label ?? report.recommended)} — ${report.rationale}`);
  if (report.unresolved.total) {
    out.push('');
    out.push(chalk.red(`⚠ ${deltaSummary(report.unresolved)} advisory(ies) have no upgrade path in any plan.`));
  }
  return out.join('\n');
}

export function renderMarkdown(report: FixPlanResponse): string {
  const out: string[] = [];
  out.push('# Vibgrate fix — upgrade plan');
  out.push('');
  out.push(
    `${report.totalCandidates} drifted dependency(ies) analysed · ${report.deepAnalysis ? 'deep (major) analysis on' : 'preflight only'}.`,
  );
  const note = dataNote(report);
  if (note) {
    out.push('');
    out.push(`_${report.vulnerabilityData === 'unavailable' ? 'Advisory data was unavailable — vulnerability impact is not shown.' : 'Advisory data was partial — some ecosystems were not checked.'}_`);
  }
  out.push('');
  const visiblePlans = report.plans.filter((plan) => plan.upgrades.length > 0);
  if (visiblePlans.length === 0) {
    out.push('✔ Nothing to upgrade — every tracked dependency is current.');
    out.push('');
  }
  for (const plan of visiblePlans) {
    const rec = plan.tier === report.recommended ? ' ✅ **recommended**' : '';
    out.push(`## ${plan.label}${rec}`);
    out.push('');
    out.push(`_${plan.description}_`);
    out.push('');
    out.push(`- Risk: **${plan.riskScore}/100** (${plan.confidence} confidence)`);
    out.push(`- Upgrades: **${plan.upgrades.length}**`);
    out.push(`- Fixes advisories: ${deltaSummary(plan.fixes)}`);
    if (plan.introduces.total) {
      out.push(`- ⚠ Introduces advisories in target versions: ${deltaSummary(plan.introduces)}`);
    }
    out.push('');
    out.push('| Package | From | To | Kind | Reason |');
    out.push('|---|---|---|---|---|');
    for (const u of plan.upgrades) {
      out.push(`| \`${u.package}\` | ${u.from ?? '?'} | ${u.to ?? '?'} | ${u.kind} | ${u.reason} |`);
    }
    out.push('');
  }
  out.push('## Recommendation');
  out.push('');
  const recLabel = report.plans.find((p) => p.tier === report.recommended)?.label ?? report.recommended;
  out.push(`**${recLabel}** — ${report.rationale}`);
  if (report.unresolved.total) {
    out.push('');
    out.push(`> ⚠ ${deltaSummary(report.unresolved)} advisory(ies) have no upgrade path in any plan.`);
  }
  return out.join('\n');
}
