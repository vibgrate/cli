import { Command } from 'commander';
import { inventory, enrichOnline, ECOSYSTEMS } from '../engine/drift.js';
import { loadStandards, checkStandards, STANDARDS_FILES, type StandardViolation } from '../engine/standards.js';
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
    .option('--fail-on <level>', 'exit 2 on violations — major|minor (version drift) or standards (enterprise policy)')
    .action(async function (this: Command, opts: { online?: boolean; failOn?: string }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      if (opts.online && global.local) {
        throw new CliError('--online conflicts with --local (no network in local mode)', ExitCode.USAGE_ERROR);
      }
      if (opts.failOn && !['major', 'minor', 'standards'].includes(opts.failOn)) {
        throw new CliError(`--fail-on must be one of: major, minor, standards (got "${opts.failOn}")`, ExitCode.USAGE_ERROR);
      }
      const inv = inventory(root);
      if (opts.online && !global.local) await enrichOnline(inv.records);

      // Enterprise standards gate (D9/S5.2): check the inventory against the committed policy.
      let standards: { policyPath: string | null; defined: boolean; violations: StandardViolation[] } | null = null;
      if (opts.failOn === 'standards') {
        const loaded = loadStandards(root);
        if (loaded.path && !loaded.policy) {
          throw new CliError(`standards policy at ${loaded.path} is not valid JSON`, ExitCode.USAGE_ERROR);
        }
        standards = { policyPath: loaded.path, defined: !!loaded.policy, violations: loaded.policy ? checkStandards(loaded.policy, inv.records) : [] };
      }

      if (global.json) {
        json(standards ? { ...inv, standards } : inv);
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
        if (standards) printStandards(standards);
      }

      if (standards && standards.violations.length) {
        throw new CliError(`${standards.violations.length} banned dependency(ies) violate standards`, ExitCode.GATE_FAILED);
      }
      if (opts.failOn && opts.failOn !== 'standards') {
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

function printStandards(s: { defined: boolean; violations: StandardViolation[] }): void {
  if (!s.defined) {
    info(c.dim(`  no standards policy (${STANDARDS_FILES.join(' or ')}) — nothing to enforce`));
    return;
  }
  if (s.violations.length === 0) {
    info(c.green('  standards: no banned dependencies in use'));
    return;
  }
  info(c.red(`  standards: ${s.violations.length} banned dependency(ies)`));
  for (const v of s.violations) {
    const fix = v.use ? c.dim(` → use ${v.use}`) : '';
    const why = v.reason ? c.dim(` (${v.reason})`) : '';
    info(`    ${c.red('banned')} ${v.ecosystem}:${v.name}${v.installed ? c.dim(` ${v.installed}`) : ''}${fix}${why}`);
  }
}
