import { Command } from 'commander';
import { buildVersionTimelines, findPackageAnyEcosystem, gitHistoryAvailable } from '../core-open/index.js';
import { readScanArtifact } from '../mcp/vuln-data.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg why <package>` — who introduced a dependency, and any open vulnerabilities
 * it carries, from git history. Thin blame/why surface over the Phase-0 version
 * timeline plus the last scan's attributed vulnerability data. Offline + local.
 */
export function registerWhy(program: Command): void {
  const cmd = program
    .command('why')
    .description('who introduced a dependency (and any open vulnerabilities), from git history')
    .argument('<package>', 'package name to explain')
    .action(async function (this: Command, pkg: string) {
      const global = readGlobal(this);
      const root = rootOf(global);

      if (!(await gitHistoryAvailable(root))) {
        throw new CliError(
          'git history is required for `vg why` (not a git repository, or git is unavailable)',
          ExitCode.USAGE_ERROR,
        );
      }

      const timelines = await buildVersionTimelines(root);
      const pt = timelines ? findPackageAnyEcosystem(timelines, pkg) ?? null : null;

      // Open vulnerabilities for this package, from the last `vg scan --vulns`.
      const artifact = readScanArtifact(root);
      const vulnPkg = artifact?.extended?.vulnerabilities?.packages.find((p) => p.package === pkg) ?? null;

      if (global.json) {
        json({ package: pkg, history: pt?.changes ?? [], vulnerabilities: vulnPkg?.advisories ?? [] });
        return;
      }

      info(`${c.cyan('vg why')} ${c.bold(pkg)}`);
      if (!pt || pt.changes.length === 0) {
        info(c.dim('  no git history found for this package (npm lockfile). It may not be an npm dependency,'));
        info(c.dim('  or the lockfile predates its introduction.'));
      } else {
        for (let i = 0; i < pt.changes.length; i++) {
          const ch = pt.changes[i];
          const verb = i === 0 ? c.green('added') : c.yellow('→');
          const date = ch.commit.date.slice(0, 10);
          info(
            `  ${verb} ${c.bold(ch.version)} ${c.dim(`${ch.commit.shortSha} ${date} ${ch.commit.authorName}`)}`,
          );
          info(c.dim(`      ${ch.commit.subject}`));
        }
      }

      if (vulnPkg && vulnPkg.advisories.length) {
        info('');
        info(c.red(`  ${vulnPkg.advisories.length} open vulnerabilit${vulnPkg.advisories.length === 1 ? 'y' : 'ies'} at ${pkg}@${vulnPkg.version}:`));
        for (const adv of vulnPkg.advisories) {
          const cve = adv.aliases.find((a) => a.startsWith('CVE-'));
          const idLabel = cve && cve !== adv.id ? `${adv.id} (${cve})` : adv.id;
          const cvss = adv.cvss != null ? ` cvss ${adv.cvss}` : '';
          const fixed = adv.fixedVersions.length ? ` — fixed in ${adv.fixedVersions.join(', ')}` : ' — no fix available';
          info(`    ${severityTag(adv.severity)} ${idLabel}${c.dim(cvss)}${c.dim(fixed)}`);
          if (adv.introduced) {
            const exposure = adv.exposureDays != null ? `, ${adv.exposureDays}d exposed` : '';
            info(
              c.dim(
                `        introduced by ${adv.introduced.authorName} in ${adv.introduced.shortSha} on ${adv.introduced.date.slice(0, 10)}${exposure}`,
              ),
            );
          }
        }
      } else if (artifact?.extended?.vulnerabilities) {
        info('');
        info(c.green('  no known vulnerabilities for this package in the last scan'));
      } else {
        info('');
        info(c.dim('  run `vg scan --vulns` to check this package for known vulnerabilities'));
      }
    });
  applyGlobalOptions(cmd);
}

function severityTag(severity: string): string {
  switch (severity) {
    case 'critical':
      return c.red('critical');
    case 'high':
      return c.red('high');
    case 'moderate':
      return c.yellow('moderate');
    case 'low':
      return c.dim('low');
    default:
      return c.dim(severity);
  }
}
