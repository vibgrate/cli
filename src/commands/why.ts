import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { gitTopLevel, isGitRepo } from '../review/git.js';
import { lineProvenance, sessionTitle, TRAILER, turnsTouching } from '../review/provenance.js';
import { lookupProvenance, repoIdentity, type CloudLookup } from '../review/provenance-cloud.js';
import { cloudDsn } from '../review/doc-comments.js';
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
    .description('who introduced a dependency (and any open vulnerabilities), from git history; or, for <file:line>, which commit and VG Code session wrote that line')
    .argument('<package>', 'package name to explain, or file:line')
    .option('--cloud', 'file:line: read sessions that ran on another machine from Vibgrate Cloud (shared with `vg review trailer push`)')
    .option('--dsn <dsn>', 'DSN token for --cloud (or use VIBGRATE_DSN / `vg login`)')
    .action(async function (this: Command, pkg: string, opts: { cloud?: boolean; dsn?: string }) {
      const global = readGlobal(this);
      const root = rootOf(global);

      const at = /^(.+):(\d+)$/.exec(pkg);
      if (at && fs.existsSync(path.resolve(root, at[1]))) {
        await whyLine(root, at[1], Number(at[2]), Boolean(global.json), opts);
        return;
      }

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
          if (adv.cvssDiagnostic) info(c.yellow(`        ${adv.cvssDiagnostic}`));
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

/**
 * `vg why <file:line>`: the commit that last changed the line, and the VG Code
 * sessions its Vibgrate-Session trailers name, with what each was asked about
 * that file. The agent's answers are its own account, not verified. With
 * `--cloud`, a session that is not on this machine is read from Vibgrate
 * Cloud, where `vg review trailer push` shared it.
 */
async function whyLine(root: string, file: string, line: number, asJson: boolean, opts: { cloud?: boolean; dsn?: string }): Promise<void> {
  if (!isGitRepo(root)) throw new CliError('`vg why <file:line>` needs a git repository', ExitCode.USAGE_ERROR);
  const top = gitTopLevel(root);
  const rel = path.relative(top, path.resolve(root, file)).split(path.sep).join('/');
  const p = lineProvenance(top, rel, line);
  const absent = p.sessions.filter((s) => !s.found).map((s) => s.id);
  const fromCloud = new Map<string, CloudLookup>();
  if (opts.cloud && absent.length > 0) {
    for (const s of await lookupProvenance(cloudDsn(opts.dsn), repoIdentity(top), absent)) fromCloud.set(s.id, s);
  }
  const sessions = p.sessions.map((s) => {
    if (s.found) {
      return { id: s.id, title: sessionTitle(s.found), model: s.found.model ?? null, turns: turnsTouching(s.found, top, rel), source: 'local' as const };
    }
    const cloud = fromCloud.get(s.id);
    if (cloud) {
      const turns = cloud.turns.filter((t) => t.files.includes(rel)).map((t) => ({ turn: t.turn, asked: t.asked, answered: t.answered }));
      return { id: s.id, title: cloud.title, model: cloud.model, turns, source: 'cloud' as const };
    }
    return { id: s.id, title: null, model: null, turns: [], source: null };
  });
  if (asJson) {
    json({ file: rel, line, commit: p.commit, sessions: sessions.map((s) => ({ ...s, found: s.source !== null })) });
    return;
  }
  info(`${c.cyan('vg why')} ${c.bold(`${rel}:${line}`)}`);
  if (!p.commit) {
    info(c.dim('  not committed yet, or git could not blame this line'));
    return;
  }
  info(`  ${c.bold(p.commit.sha.slice(0, 12))} ${p.commit.subject} ${c.dim(`${p.commit.author} ${p.commit.date.slice(0, 10)}`)}`);
  if (sessions.length === 0) {
    info(c.dim(`  no ${TRAILER} trailer on this commit — turn it on for future commits with \`vg review trailer on\``));
    return;
  }
  for (const s of sessions) {
    if (s.source === null) {
      info(
        c.dim(
          opts.cloud
            ? `  VG Code session ${s.id} is not on this machine and was not shared to Vibgrate Cloud (\`vg review trailer push\` where it ran)`
            : `  VG Code session ${s.id} is not on this machine — add --cloud to read it from Vibgrate Cloud if it was shared`,
        ),
      );
      continue;
    }
    info(`  VG Code session ${c.bold(s.id)}: ${s.title}${s.model ? c.dim(` · ${s.model}`) : ''}${s.source === 'cloud' ? c.dim(' · from Vibgrate Cloud') : ''}`);
    for (const t of s.turns) {
      info(`    turn ${t.turn} asked: ${t.asked.replace(/\s+/g, ' ').slice(0, 300)}`);
      if (t.answered) info(c.dim(`      the agent's account (unverified): ${t.answered.replace(/\s+/g, ' ').slice(0, 300)}`));
    }
    if (s.turns.length === 0) info(c.dim('    no turn in this session lists this file'));
  }
}
