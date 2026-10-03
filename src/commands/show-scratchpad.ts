/**
 * `vg show scratchpad` — the explain scratchpad: every explanation kept with
 * `--keep` (or by an agent over MCP), newest on top (review/scratchpad.ts).
 */
import type { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { renderReviewDocMarkdown } from '../review/doc.js';
import { clearScratchpad, getScratchpad } from '../review/scratchpad.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, out } from '../util/output.js';
import { rootOf } from './util.js';

export function registerShowScratchpad(show: Command): void {
  const cmd = show
    .command('scratchpad')
    .description('the explain scratchpad: explanations kept with --keep, or by an agent, newest on top')
    .option('--format <fmt>', 'output format (md | json)', 'md')
    .option('--clear', 'empty the scratchpad')
    .action(function (this: Command, opts: { format: string; clear?: boolean }) {
      const global = readGlobal(this);
      if (opts.format !== 'md' && opts.format !== 'json') throw new CliError('unknown --format (expected md | json)', ExitCode.USAGE_ERROR);
      const root = rootOf(global);
      if (opts.clear) {
        clearScratchpad(root);
        if (global.json) out(JSON.stringify({ cleared: true }));
        else info(c.dim('  the scratchpad is empty'));
        return;
      }
      const pad = getScratchpad(root);
      if (Boolean(global.json) || opts.format === 'json') {
        out(JSON.stringify(pad, null, 2));
        return;
      }
      if (!pad.doc) {
        info(c.dim('  the scratchpad is empty — keep an explanation with `vg show <name> --diagram --keep` or `vg path <a> <b> --diagram --keep`'));
        return;
      }
      out(renderReviewDocMarkdown(pad.doc).replace(/\n$/, ''));
      for (const s of pad.stale) info(c.yellow(`  ${s.block}: ${s.message} — the code moved since it was kept`));
    });
  applyGlobalOptions(cmd);
}
