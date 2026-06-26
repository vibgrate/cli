import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  runCoreScan,
  pathExists,
  parseDsn,
  prepareCompressedUpload,
  fetchScanPreflight,
  computeRepoFingerprint,
  detectVcs,
  resolveRepositoryName,
  parseExcludePatterns,
} from '../../core-open/index.js';
import type { ScanOptions, ScanArtifact } from '../../core-open/index.js';
import { loadAdvancedScanHook } from '../advanced-hook.js';
import { VERSION } from '../version.js';
import { resolveIngestHost } from './dsn.js';
import { dashHostForIngestHost } from '../regions.js';
import { resolveDsn } from '../credentials.js';
import { emitIngestIdLine } from '../utils/ingest-id-output.js';
import { uploadScanArtifact } from '../utils/upload.js';

/** Auto-push scan artifact to Vibgrate API */
async function autoPush(
  artifact: ScanArtifact,
  rootDir: string,
  opts: ScanOptions,
): Promise<void> {
  const dsn = resolveDsn(opts.dsn);
  if (!dsn) {
    console.error(chalk.red('No DSN provided for push.'));
    console.error(chalk.dim('Run "vibgrate login", set VIBGRATE_DSN, or use the --dsn flag.'));
    if (opts.strict) process.exit(1);
    return;
  }

  const parsed = parseDsn(dsn);
  if (!parsed) {
    console.error(chalk.red('Invalid DSN format.'));
    if (opts.strict) process.exit(1);
    return;
  }

  // Compact and compress artifact for upload
  const { body, contentEncoding } = await prepareCompressedUpload(artifact);
  const timestamp = String(Date.now());

  let host = parsed.host;
  if (opts.region) {
    try {
      host = resolveIngestHost(opts.region);
    } catch (e: unknown) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      if (opts.strict) process.exit(1);
      return;
    }
  }

  const originalSize = JSON.stringify(artifact).length;
  const compressedSize = body.length;
  const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(0);
  console.log(chalk.dim(`Uploading to ${host}... (${(compressedSize / 1024).toFixed(0)} KB, ${ratio}% smaller)`));

  try {
    // Auto-retries against the workspace's pinned region on a 409 REGION_MISMATCH.
    const { response, host: uploadedHost } = await uploadScanArtifact({
      scheme: parsed.scheme,
      host,
      keyId: parsed.keyId,
      secret: parsed.secret,
      body,
      contentEncoding,
      timestamp,
    });
    host = uploadedHost;

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const result = await response.json() as {
      status: string;
      ingestId?: string;
      unchanged?: boolean;
      previousIngestId?: string;
      lastScannedAt?: string;
    };

    if (result.unchanged) {
      console.log(
        chalk.green('✔')
          + ` Repository unchanged since ${result.lastScannedAt ?? 'last scan'} — skipped upload (no credit used).`,
      );
      if (result.previousIngestId) {
        emitIngestIdLine(result.previousIngestId, { unchanged: true });
        const dashUrl = `https://${dashHostForIngestHost(host)}/${parsed.workspaceId}/scan/${result.previousIngestId}`;
        console.log(chalk.dim(`  Previous report: ${dashUrl}`));
      } else if (opts.strict) {
        console.error(chalk.red('Repository unchanged but no previous ingest id returned.'));
        process.exit(1);
      }
      return;
    }

    console.log(chalk.green('✔') + ` Scan queued for processing (${result.ingestId ?? 'ok'})`);
    if (result.ingestId) {
      emitIngestIdLine(result.ingestId);
      const dashUrl = `https://${dashHostForIngestHost(host)}/${parsed.workspaceId}/scan/${result.ingestId}`;
      // On Windows, stderr/stdout desync can leave residual content on lines.
      // Use ANSI escape: \x1B[0G = move to column 0, \x1B[2K = erase entire line
      const CLEAR_LINE = process.platform === 'win32' ? '\x1B[0G\x1B[2K' : '';
      console.log('');
      console.log(CLEAR_LINE + chalk.dim('  Processing continues in the background. Results available shortly.'));
      console.log('');
      console.log(CLEAR_LINE + chalk.cyan('────────────────────────────────────────────────────────────────────────────────'));
      console.log(CLEAR_LINE + chalk.bold('  📊 View Scan Report'));
      console.log(CLEAR_LINE + '  ' + chalk.underline.cyan(dashUrl));
      console.log(CLEAR_LINE + chalk.cyan('────────────────────────────────────────────────────────────────────────────────'));
      console.log('');
      console.log('');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(chalk.red(`Upload failed: ${msg}`));
    if (opts.strict) process.exit(1);
  }
}

/**
 * Commander collector for the repeatable `--exclude` flag. Each occurrence
 * may itself hold several comma/semicolon-separated globs, so we expand and
 * accumulate them across every use of the flag.
 */
function collectExcludes(value: string, previous: string[]): string[] {
  return [...previous, ...parseExcludePatterns(value)];
}

function parseNonNegativeNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return parsed;
}

export const scanCommand = new Command('scan')
  .description('Scan a project for upgrade drift')
  .argument('[path]', 'Path to scan', '.')
  .option('--out <file>', 'Output file path')
  .option('--format <format>', 'Output format (text|json|sarif|md)', 'text')
  .option('--fail-on <level>', 'Fail on warn or error')
  .option('--baseline <file>', 'Compare against baseline')
  .option('--changed-only', 'Only scan changed files')
  .option(
    '-e, --exclude <glob>',
    'Exclude paths matching a glob pattern. Repeatable, and a single value may list several patterns separated by commas or semicolons (e.g. --exclude "legacy/**,vendor/**"). Merged with excludes from the config file.',
    collectExcludes,
    [],
  )
  .option('--concurrency <n>', 'Max concurrent npm calls', '8')
  .option('--push', 'Auto-push results to Vibgrate API after scan')
  .option('--dsn <dsn>', 'DSN token for push (or use VIBGRATE_DSN env)')
  .option('--region <region>', 'Override data residency region for push (us, eu)')
  .option('--strict', 'Fail on push errors')
  .option('--ui-purpose', 'Enable optional UI purpose evidence extraction (slower)')
  .option('--no-local-artifacts', 'Do not write .vibgrate JSON artifacts to disk')
  .option('--max-privacy', 'Enable strongest privacy mode (minimal scanners, no local artifacts)')
  .option('--offline', 'Run without network calls; do not upload results')
  .option('--package-manifest <file>', 'Use local package-version manifest JSON/ZIP (for offline mode)')
  .option('--project-scan-timeout <seconds>', 'Per-project scan timeout in seconds (default: 180)')
  .option('--drift-budget <score>', 'Fail if drift score is above budget (0-100)')
  .option('--drift-worsening <percent>', 'Fail if drift worsens by more than % since baseline')
  .option('--repository-name <name>', 'Override the repository name recorded for this scan (defaults to the directory or package.json name)')
  .action(async (targetPath: string, opts: {
    out?: string;
    format: string;
    failOn?: string;
    baseline?: string;
    changedOnly?: boolean;
    exclude: string[];
    concurrency: string;
    push?: boolean;
    dsn?: string;
    region?: string;
    strict?: boolean;
    uiPurpose?: boolean;
    noLocalArtifacts?: boolean;
    maxPrivacy?: boolean;
    offline?: boolean;
    packageManifest?: string;
    projectScanTimeout?: string;
    driftBudget?: string;
    driftWorsening?: string;
    repositoryName?: string;
  }) => {
    const rootDir = path.resolve(targetPath);
    if (!(await pathExists(rootDir))) {
      console.error(chalk.red(`Path does not exist: ${rootDir}`));
      process.exit(1);
    }

    const hasDsn = !!resolveDsn(opts.dsn);
    const willPush = !opts.offline && (opts.push || hasDsn);

    // Region the workspace is pinned to, learned from preflight. Used to route
    // the upload to the correct ingest host up front (the push path also
    // self-heals on a 409 REGION_MISMATCH if preflight didn't run).
    let pinnedRegion: string | undefined;

    if (willPush && hasDsn) {
      const dsn = resolveDsn(opts.dsn)!;
      const parsed = parseDsn(dsn);
      if (parsed) {
        const ingestHost = opts.region ? resolveIngestHost(opts.region) : parsed.host;
        const vcs = await detectVcs(rootDir);
        const fingerprint = await computeRepoFingerprint(rootDir, vcs);
        const repositoryName = opts.repositoryName?.trim() || await resolveRepositoryName(rootDir);
        try {
          const preflight = await fetchScanPreflight(parsed, ingestHost, {
            repositoryName,
            vcsSha: fingerprint.vcsSha,
          });
          pinnedRegion = preflight.region;
          if (preflight.vm && !preflight.vm.allowed) {
            console.error(chalk.red(preflight.error ?? 'VM meter usage exhausted'));
            console.error(
              chalk.dim(
                `VM minutes: ${preflight.vm.used}/${preflight.vm.limit} (${preflight.plan.label} plan) — enable overages or upgrade your plan.`,
              ),
            );
            process.exit(1);
          }
          // A new repository that would breach the plan's repository cap is
          // blocked before the (expensive) local scan runs. Re-scanning an
          // already-mapped repository is never blocked here.
          if (preflight.repositories && !preflight.repositories.allowed) {
            console.error(
              chalk.red(
                preflight.error ??
                  `Repository limit reached for the ${preflight.plan.label} plan — cannot scan a new repository.`,
              ),
            );
            const max =
              preflight.repositories.max < 0 ? 'unlimited' : String(preflight.repositories.max);
            console.error(
              chalk.dim(
                `Repositories: ${preflight.repositories.total}/${max} (${preflight.plan.label} plan) — archive a repository or upgrade your plan.`,
              ),
            );
            if (preflight.upgradeUrl) {
              console.error(chalk.dim(`  Upgrade: ${preflight.upgradeUrl}`));
            }
            process.exit(1);
          }
          if (preflight.status === 'error' || !preflight.scans.allowed) {
            console.error(chalk.red(preflight.error ?? 'Scan ingestion not allowed for this workspace.'));
            console.error(
              chalk.dim(
                `Credits: ${preflight.scans.used}/${preflight.scans.limit} (${preflight.plan.label} plan)`,
              ),
            );
            if (opts.strict) process.exit(1);
            process.exit(1);
          }
          console.log(
            chalk.dim(
              `Plan: ${preflight.plan.label} — scan credits ${preflight.scans.used}/${preflight.scans.limit} this month`,
            ),
          );
          if (preflight.repository?.unchanged) {
            console.log(
              chalk.green('✔')
                + ` Repository unchanged at ${preflight.repository.lastVcsSha?.slice(0, 7) ?? 'same revision'} — skipping scan.`,
            );
            if (preflight.repository.lastIngestId) {
              emitIngestIdLine(preflight.repository.lastIngestId, { unchanged: true });
              const dashUrl = `https://${dashHostForIngestHost(ingestHost)}/${parsed.workspaceId}/scan/${preflight.repository.lastIngestId}`;
              console.log(chalk.dim(`  Latest report: ${dashUrl}`));
            } else if (opts.strict) {
              console.error(chalk.red('Repository unchanged but no previous ingest id available.'));
              process.exit(1);
            }
            return;
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(chalk.yellow(`Preflight check failed: ${msg}`));
          if (opts.strict) process.exit(1);
        }
      }
    }

    const scanOpts: ScanOptions = {
      vibgrateVersion: VERSION,
      out: opts.out,
      format: (opts.format as 'text' | 'json' | 'sarif' | 'md') || 'text',
      failOn: opts.failOn as 'warn' | 'error' | undefined,
      baseline: opts.baseline,
      changedOnly: opts.changedOnly,
      exclude: opts.exclude,
      concurrency: parseInt(opts.concurrency, 10) || 8,
      push: opts.push,
      dsn: opts.dsn,
      // An explicit --region wins; otherwise route to the workspace's pinned
      // region as reported by preflight.
      region: opts.region ?? pinnedRegion,
      strict: opts.strict,
      uiPurpose: opts.uiPurpose,
      noLocalArtifacts: opts.noLocalArtifacts,
      maxPrivacy: opts.maxPrivacy,
      offline: opts.offline,
      packageManifest: opts.packageManifest,
      driftBudget: parseNonNegativeNumber(opts.driftBudget, '--drift-budget'),
      driftWorseningPercent: parseNonNegativeNumber(opts.driftWorsening, '--drift-worsening'),
      projectScanTimeout: opts.projectScanTimeout ? parseInt(opts.projectScanTimeout, 10) || undefined : undefined,
      repositoryName: opts.repositoryName?.trim() || undefined,
    };

    // Open base scan. The optional advanced-analysis hook is a no-op in this
    // open build, so the scan runs entirely on the open base engine.
    const advanced = await loadAdvancedScanHook();
    const artifact = await runCoreScan(rootDir, scanOpts, advanced);

    // Check fail-on thresholds
    if (opts.failOn) {
      const hasErrors = artifact.findings.some((f: { level: string }) => f.level === 'error');
      const hasWarnings = artifact.findings.some((f: { level: string }) => f.level === 'warning');

      if (opts.failOn === 'error' && hasErrors) {
        console.error(chalk.red(`\nFailing: ${artifact.findings.filter((f: { level: string }) => f.level === 'error').length} error finding(s) detected.`));
        process.exit(2);
      }
      if (opts.failOn === 'warn' && (hasErrors || hasWarnings)) {
        console.error(chalk.red(`\nFailing: findings detected at warn level or above.`));
        process.exit(2);
      }
    }

    if (scanOpts.driftBudget !== undefined && artifact.drift.score > scanOpts.driftBudget) {
      console.error(chalk.red(`\nFailing fitness function: drift score ${artifact.drift.score}/100 exceeds budget ${scanOpts.driftBudget}.`));
      process.exit(2);
    }

    if (scanOpts.driftWorseningPercent !== undefined) {
      if (artifact.delta === undefined) {
        console.error(chalk.red('\nFailing fitness function: --drift-worsening requires --baseline to compare against previous drift.'));
        process.exit(2);
      }

      if (artifact.delta > 0) {
        const baselineScore = artifact.drift.score - artifact.delta;
        const denominator = Math.max(Math.abs(baselineScore), 0.0001);
        const worseningPercent = (artifact.delta / denominator) * 100;

        if (worseningPercent > scanOpts.driftWorseningPercent) {
          console.error(chalk.red(`\nFailing fitness function: drift worsened by ${worseningPercent.toFixed(2)}% (threshold ${scanOpts.driftWorseningPercent}%).`));
          process.exit(2);
        }
      }
    }

    if (willPush) {
      await autoPush(artifact, rootDir, scanOpts);
    }
  });
