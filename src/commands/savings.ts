import { Command } from 'commander';
import { readSavings, readUsage, type UsageReport } from '../engine/savings.js';
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
      const root = rootOf(global);
      const now = Date.now();
      const report = readSavings(root, days, now);
      const usage = readUsage(root, days, now);

      if (global.json) {
        json({ ...report, usage });
        return;
      }

      info(`${c.cyan('vg savings')} · last ${days} days ${c.dim('(local, nothing left your machine)')}`);
      if (usage.totals.calls === 0) {
        info(
          c.dim(
            report.enabled
              ? '  no calls recorded yet in this window'
              : '  recording is off. Enable it for MCP with `vg serve --savings`, and for CLI calls by passing `--client=<ai>` to vg.',
          ),
        );
        return;
      }

      // Token-savings summary — only the grep-baseline tools (query_graph / get_node).
      if (report.queries > 0) {
        info(`  queries ${report.queries} · context tokens ${fmt(report.vgTokens)}  (grep/read baseline ≈ ${fmt(report.baselineTokens)})  → ${report.ratio}× fewer`);
        info(`  est. cost (${report.rateLabel}): $${report.estCostVg} vs $${report.estCostBaseline}  → saved ≈ $${report.saved}`);
        info(c.dim('  estimates with stated assumptions (~4 chars/token; ~400 tokens/file baseline); scales with repo size.'));
      }

      // Per-command breakdown — every recorded tool, its outcomes, and success rate.
      printBreakdown(usage);
      // The command-vs-MCP split and which AI is calling.
      printSplit(usage);
    });
  applyGlobalOptions(cmd);
}

function fmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Render the per-command usage table: calls, complete/partial/miss, success %. */
function printBreakdown(usage: UsageReport): void {
  info('');
  info(c.bold('  by command') + c.dim('  (complete = full result · partial = capped/paginated · miss = no result)'));
  const nameW = Math.max(7, ...usage.commands.map((cmd) => cmd.tool.length));
  const header =
    '    ' +
    'command'.padEnd(nameW) +
    ['calls', 'complete', 'partial', 'miss', 'success%', 'avg ms'].map((h) => h.padStart(9)).join('');
  info(c.dim(header));
  for (const cmd of usage.commands) {
    info(
      '    ' +
        cmd.tool.padEnd(nameW) +
        String(cmd.calls).padStart(9) +
        String(cmd.complete).padStart(9) +
        String(cmd.partial).padStart(9) +
        String(cmd.miss).padStart(9) +
        `${cmd.successPct}%`.padStart(9) +
        // Absent ≠ zero: calls recorded before timing existed show '—'.
        (cmd.avgMs === null ? '—' : String(cmd.avgMs)).padStart(9),
    );
  }
  const t = usage.totals;
  info(c.dim('    ' + '─'.repeat(nameW + 54)));
  info(
    '    ' +
      c.bold('total'.padEnd(nameW)) +
      String(t.calls).padStart(9) +
      String(t.complete).padStart(9) +
      String(t.partial).padStart(9) +
      String(t.miss).padStart(9) +
      ''.padStart(9) +
      ''.padStart(9),
  );
  info(c.dim(`    avg success across commands: ${usage.avgSuccessPct}%`));
}

/**
 * Render the command-vs-MCP split (how calls arrived) and which AI client made
 * them — the signals that show whether assistants use the MCP tools or shell out
 * to `vg`, and that feed the opt-in share-stats upload.
 */
function printSplit(usage: UsageReport): void {
  const label = (key: string): string => (key === 'mcp' ? 'MCP tools' : key === 'cli' ? 'vg CLI' : key);
  if (usage.sources.length) {
    info('');
    info(c.bold('  by source') + c.dim('  (how the call arrived)'));
    for (const s of usage.sources) {
      const pct = usage.totals.calls ? Math.round((s.calls / usage.totals.calls) * 100) : 0;
      info(`    ${label(s.key).padEnd(12)} ${String(s.calls).padStart(6)} calls ${c.dim(`(${pct}%)`)}`);
    }
  }
  if (usage.clients.length) {
    info('');
    info(c.bold('  by client') + c.dim('  (which AI is calling; pass --client to vg to attribute CLI calls)'));
    for (const cl of usage.clients) {
      info(`    ${cl.key.padEnd(12)} ${String(cl.calls).padStart(6)} calls`);
    }
  }
}
