import { Command } from 'commander';
import { inventory, enrichOnline, ECOSYSTEMS } from '../engine/drift.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg drift` (VG-CLI-SPEC §5) — dependency currency. Offline by default
 * (inventory + installed versions); `--online` opt-in queries the npm registry
 * for latest versions. Full CVE/EOL governance is the Vibgrate platform.
 */
export function registerDrift(program: Command): void {
  const cmd = program
    .command('drift')
    .description('what is outdated across dependencies (offline; --online for currency)')
    .option('--online', 'query the npm registry for latest versions (opt-in network)')
    .option('--fail-on <level>', 'exit 2 if any dep drifts at/above level (major|minor)')
    .action(async function (this: Command, opts: { online?: boolean; failOn?: string }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      if (opts.online && global.local) {
        throw new CliError('--online conflicts with --local (no network in local mode)', ExitCode.USAGE_ERROR);
      }
      const inv = inventory(root);
      if (opts.online && !global.local) await enrichOnline(inv.records);

      if (global.json) {
        json(inv);
      } else {
        const breakdown = ECOSYSTEMS.filter((e) => inv.counts[e] > 0).map((e) => `${e} ${inv.counts[e]}`).join(' · ');
        info(`${c.cyan('vg drift')} · ${inv.counts.total} dependencies${breakdown ? ` (${breakdown})` : ''}`);
        if (opts.online) {
          const drifted = inv.records.filter((r) => r.drift && r.drift !== 'current' && r.drift !== 'unknown');
          if (drifted.length === 0) info(c.green('  all checked dependencies are current'));
          for (const r of drifted.sort((a, b) => rank(b.drift) - rank(a.drift))) {
            const tag = r.drift === 'major' ? c.red('major') : r.drift === 'minor' ? c.yellow('minor') : c.dim('patch');
            info(`  ${tag} ${r.name} ${c.dim(`${r.installed} → ${r.latest}`)}`);
          }
        } else {
          info(c.dim('  offline inventory — run with --online for currency vs the npm registry'));
          info(c.dim('  CVE/EOL/governance: the Vibgrate platform (vg push)'));
        }
      }

      if (opts.failOn) {
        const threshold = opts.failOn === 'minor' ? 2 : 3; // minor includes major
        const bad = inv.records.filter((r) => rank(r.drift) >= threshold);
        if (bad.length) {
          throw new CliError(`${bad.length} dependency(ies) drift at/above ${opts.failOn}`, ExitCode.GATE_FAILED);
        }
      }
    });
  applyGlobalOptions(cmd);
}

function rank(drift?: string): number {
  return drift === 'major' ? 3 : drift === 'minor' ? 2 : drift === 'patch' ? 1 : 0;
}
