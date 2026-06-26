import { Command } from 'commander';
import { readSavings } from '../engine/savings.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg savings` (VG-DEVELOPMENT-PLAN §5) — a local, privacy-safe, honestly
 * estimated report of context tokens / $ saved vs a grep/read baseline.
 * Nothing leaves the machine. Recording is opt-in via `vg serve --savings`.
 */
export function registerSavings(program: Command): void {
  const cmd = program
    .command('savings')
    .description('local, privacy-safe report of tokens/$ saved vs a grep baseline (estimates)')
    .option('--days <n>', 'window in days', '30')
    .action(function (this: Command) {
      const global = readGlobal(this);
      const days = Number(this.opts().days) || 30;
      const report = readSavings(rootOf(global), days, Date.now());

      if (global.json) {
        json(report);
        return;
      }

      info(`${c.cyan('vg savings')} · last ${days} days ${c.dim('(local, nothing left your machine)')}`);
      if (!report.enabled && report.queries === 0) {
        info(c.dim('  recording is off. Enable with `vg serve --savings`, then query via MCP.'));
        return;
      }
      if (report.queries === 0) {
        info(c.dim('  no queries recorded yet in this window'));
        return;
      }
      info(`  queries ${report.queries} · context tokens ${fmt(report.vgTokens)}  (grep/read baseline ≈ ${fmt(report.baselineTokens)})  → ${report.ratio}× fewer`);
      info(`  est. cost (${report.rateLabel}): $${report.estCostVg} vs $${report.estCostBaseline}  → saved ≈ $${report.saved}`);
      info(c.dim('  estimates with stated assumptions (~4 chars/token; ~400 tokens/file baseline); scales with repo size.'));
    });
  applyGlobalOptions(cmd);
}

function fmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
