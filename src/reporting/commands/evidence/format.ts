// ── Human-readable rendering for Vibgrate Evidence ──
// Terse, scannable output. The disclaimer rides along on every determination.

import chalk from 'chalk';
import type { ExposureResult, Regime } from './types.js';
import type { ReadinessReport, ReadinessItem } from './readiness.js';
import { listRegimes } from './regimes.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function formatExposure(result: ExposureResult, regime: Regime): string {
  const lines: string[] = [];
  const affected = result.products.filter((p) => p.status === 'affected');
  const undetermined = result.products.filter((p) => p.status === 'undetermined');
  const releaseCount = affected.reduce((n, p) => n + p.releases.length, 0);

  if (result.overallStatus === 'affected') {
    lines.push(chalk.red(`  EXPOSURE FOUND`) + ` — ${affected.length} product(s) · ${releaseCount} shipped release(s)`);
  } else if (result.overallStatus === 'undetermined') {
    lines.push(chalk.yellow(`  UNDETERMINED`) + ` — ${undetermined.length} product(s) need manual review`);
  } else {
    lines.push(chalk.green(`  NOT AFFECTED`) + ` — no shipped release contains the vulnerable component`);
  }
  lines.push('');

  if (affected.length) {
    lines.push('  ' + chalk.dim(pad('Product', 22) + pad('Shipped versions', 24) + pad('Markets', 16) + 'Support'));
    lines.push('  ' + chalk.dim('─'.repeat(74)));
    for (const p of affected) {
      const versions = p.affectedVersions.join(', ') || '—';
      const markets = p.memberStates.join(' ') || '—';
      const support =
        p.supportStatus === 'in_support' ? chalk.green('in support') : p.supportStatus === 'expired' ? chalk.yellow(p.supportDetail ?? 'expired') : chalk.dim('not declared');
      lines.push('  ' + pad(p.productName, 22) + pad(versions, 24) + pad(markets, 16) + support);
    }
    lines.push('');
  }

  for (const p of undetermined) {
    lines.push('  ' + chalk.yellow('undetermined') + `  ${p.productName} — ${p.reason}`);
  }
  if (undetermined.length) lines.push('');

  lines.push('  ' + chalk.dim('Coordinator') + `     ${result.coordinatorCsirt ?? chalk.yellow('not set — run `vg evidence init --coordinator`')}`);
  lines.push(
    '  ' + chalk.dim('Filing person') + `   ${result.responsiblePerson ? `${result.responsiblePerson.name} · authority: ${result.responsiblePerson.filingAuthority ? chalk.green('yes') : chalk.yellow('no')}` : chalk.yellow('not set')}`,
  );
  lines.push('  ' + chalk.dim('Advisory') + `        ${result.advisory.id}` + (result.advisory.kevListed ? chalk.yellow('  · KEV-listed') : '') + chalk.dim(`  (${result.advisory.sourceProvenance})`));
  lines.push('');
  lines.push('  ' + chalk.dim('Evidence') + `  ${chalk.green(result.meta.evidenceId)}   deterministic · kernel ${result.meta.kernelVersion}`);
  lines.push('  ' + chalk.dim(`          data-pack ${result.meta.dataPackVersion} · timestamp ${result.meta.timestamp.source}`));
  lines.push('');
  if (result.overallStatus === 'affected') {
    const stage = regime.clocks[0]?.stage ?? 'early-warning';
    lines.push('  ' + chalk.dim('Next →') + `  vg evidence pack ${result.advisory.id} --regime ${regime.id} --stage=${stage}`);
    lines.push('');
  }
  lines.push('  ' + chalk.dim(regime.disclaimer));
  return lines.join('\n');
}

export function formatReadiness(report: ReadinessReport, regime: Regime): string {
  const lines: string[] = [];
  const mark = (item: ReadinessItem): string =>
    item.status === 'ready' ? chalk.green('✔') : item.status === 'gap' ? chalk.red('✗') : chalk.dim('–');
  lines.push('  ' + chalk.bold(`Readiness — ${regime.name}`) + `   ${chalk.bold(String(report.score))}%  (${report.ready}/${report.assessable} ready)`);
  lines.push('');
  for (const item of report.items) {
    lines.push('  ' + mark(item) + ' ' + pad(item.label, 52) + '  ' + chalk.dim(item.detail));
    if (item.status === 'gap' && item.fix) lines.push('      ' + chalk.dim('fix: ') + chalk.cyan(item.fix));
  }
  lines.push('');
  lines.push('  ' + chalk.dim(report.disclaimer));
  return lines.join('\n');
}

export function formatRegimeList(): string {
  const lines: string[] = ['  ' + chalk.bold('Available regimes')];
  lines.push('');
  for (const r of listRegimes()) {
    lines.push('  ' + chalk.cyan(pad(r.id, 16)) + r.name + chalk.dim(`  (${r.jurisdiction})`));
    const clocks = r.clocks.map((c) => `${c.stage} ${c.within}`).join(' · ');
    lines.push('    ' + chalk.dim(clocks));
    lines.push('    ' + chalk.dim(`submission: ${r.submission.target}${r.submission.api ? '' : ' — manual (no API)'}`));
  }
  return lines.join('\n');
}
