import { Command } from 'commander';
import {
  buildVersionTimelines,
  findPackageAnyEcosystem,
  findVersionCrossings,
  gitHistoryAvailable,
  normalizeConstraint,
  versionSatisfies,
  type VersionCrossing,
} from '../core-open/index.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg bisect <package> <constraint>` — pinpoint the commit where a dependency
 * crossed a version line, from git history. Where `vg why` narrates every version
 * transition, `bisect` answers a targeted question: "when did we cross *this*
 * line" — e.g. when a vulnerable dependency was finally patched past the fixed
 * version, or when a major was adopted. A thin surface over the same offline,
 * no-checkout version timeline that attribution uses. Offline + local.
 *
 * `--assert` turns it into a CI gate: exit non-zero when the current resolved
 * version does NOT satisfy the constraint (the fix has not been adopted yet).
 */
export function registerBisect(program: Command): void {
  const cmd = program
    .command('bisect')
    .description('pinpoint the commit where a dependency crossed a version line, from git history')
    .argument('<package>', 'package name to bisect')
    .argument('<constraint>', 'target version or semver range (a bare version means ">=" that version)')
    .option('--assert', 'exit non-zero when the current version does not satisfy the constraint (CI gate)')
    .action(async function (this: Command, pkg: string, constraintArg: string) {
      const global = readGlobal(this);
      const opts = this.opts<{ assert?: boolean }>();
      const root = rootOf(global);

      if (!(await gitHistoryAvailable(root))) {
        throw new CliError(
          'git history is required for `vg bisect` (not a git repository, or git is unavailable)',
          ExitCode.USAGE_ERROR,
        );
      }

      const range = normalizeConstraint(constraintArg);
      if (!range) {
        throw new CliError(
          `not a valid version or semver range: ${constraintArg}`,
          ExitCode.USAGE_ERROR,
        );
      }

      const timelines = await buildVersionTimelines(root);
      const pt = timelines ? findPackageAnyEcosystem(timelines, pkg) ?? null : null;

      // No history for this package (not an npm/pip/... dependency, or the
      // lockfile predates it) — distinct from "found, but never crossed".
      if (!pt || pt.changes.length === 0) {
        if (global.json) {
          json({ package: pkg, constraint: range, found: false, satisfiedNow: false, crossings: [] });
          return;
        }
        info(`${c.cyan('vg bisect')} ${c.bold(pkg)} ${c.dim(range)}`);
        info(c.dim('  no git history found for this package (lockfile). It may not be a resolved'));
        info(c.dim('  dependency in a supported ecosystem, or the lockfile predates its introduction.'));
        throw new CliError(`no version history for ${pkg}`, ExitCode.NOT_FOUND);
      }

      const crossings = findVersionCrossings(pt, range);
      const current = pt.changes[pt.changes.length - 1];
      const satisfiedNow = versionSatisfies(current.version, range);
      const firstEntered = crossings.find((cr) => cr.kind === 'entered') ?? null;

      if (global.json) {
        json({
          package: pt.name,
          ecosystem: pt.ecosystem,
          constraint: range,
          currentVersion: current.version,
          satisfiedNow,
          firstEntered,
          crossings,
        });
      } else {
        info(`${c.cyan('vg bisect')} ${c.bold(pt.name)} ${c.dim(range)}`);
        const verdict = satisfiedNow
          ? c.green(`current ${current.version} satisfies ${range}`)
          : c.yellow(`current ${current.version} does not satisfy ${range}`);
        info(`  ${verdict}`);
        info('');

        if (!firstEntered) {
          info(c.dim(`  never crossed ${range} in git history`));
          info(
            c.dim(
              `  latest in history: ${current.version} ${c.dim(`(${current.commit.shortSha} ${current.commit.date.slice(0, 10)})`)}`,
            ),
          );
        } else {
          info(`  ${c.bold('first reached')} ${range}:`);
          printCrossing(firstEntered, true);
          // Surface later flips (a downgrade that left the line, a re-bump) so a
          // regression after the fix isn't silently hidden behind the first hit.
          const rest = crossings.slice(crossings.indexOf(firstEntered) + 1);
          if (rest.length) {
            info('');
            info(c.dim(`  ${rest.length} later crossing${rest.length === 1 ? '' : 's'}:`));
            for (const cr of rest) printCrossing(cr, false);
          }
        }
      }

      if (opts.assert && !satisfiedNow) {
        throw new CliError(
          `${pt.name}@${current.version} does not satisfy ${range}`,
          ExitCode.GATE_FAILED,
        );
      }
    });
  applyGlobalOptions(cmd);
}

function printCrossing(cr: VersionCrossing, primary: boolean): void {
  const arrow = cr.kind === 'entered' ? c.green('→') : c.yellow('↓');
  const date = cr.commit.date.slice(0, 10);
  const from = cr.previousVersion ? c.dim(` from ${cr.previousVersion}`) : c.dim(' (added)');
  const ver = primary ? c.bold(cr.version) : cr.version;
  info(`    ${arrow} ${ver}${from} ${c.dim(`${cr.commit.shortSha} ${date} ${cr.commit.authorName}`)}`);
  info(c.dim(`        ${cr.commit.subject}`));
}
