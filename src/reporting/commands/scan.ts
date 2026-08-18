import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  runCoreScan,
  refineArchitectureWithGraph,
  refineArchitectureWithAstRoles,
  pathExists,
  parseDsn,
  prepareCompressedUpload,
  fetchScanPreflight,
  fetchRiskySymbols,
  PROJECT_TYPE_TO_OSV_ECOSYSTEM,
  computeRepoFingerprint,
  detectVcs,
  resolveRepositoryName,
  parseExcludePatterns,
  loadConfig,
} from '../../core-open/index.js';
import type { ScanOptions, ScanArtifact } from '../../core-open/index.js';
import { analyzeReachability, collectPreflightDependencies } from '../reachability.js';
import type { VgGraph } from '../../schema.js';
import { inventory } from '../../engine/drift.js';
import { loadStandards, checkStandards } from '../../engine/standards.js';
import { loadAdvancedScanHook } from '../advanced-hook.js';
import { VERSION } from '../version.js';
import { resolveIngestHost } from './dsn.js';
import { dashHostForIngestHost } from '../regions.js';
import { resolveDsn } from '../credentials.js';
import { emitIngestIdLine, emitDriftScoreLine } from '../utils/ingest-id-output.js';
import { uploadScanArtifact } from '../utils/upload.js';
import { buildGraph } from '../../engine/build.js';
import { writeArtifacts } from '../../engine/artifacts.js';
import { writeSnapshot } from '../../engine/freshness.js';
import { detectAiAssistant, printAiContextPrompt } from '../ai-context-prompt.js';
import { resolveCliInvocation } from '../../util/cli-invocation.js';

/**
 * Whether `scan` should build the local code map after scoring drift.
 *
 * The code map is a *local artifact* — it writes `.vibgrate/graph.json`, the
 * graph report/html, and a freshness snapshot, and building it runs the
 * memory-heavy in-process TypeScript program. It is therefore skipped whenever
 * the caller has opted out of local artifacts:
 *
 * - `--no-graph`  (`opts.graph === false`) — explicit opt-out.
 * - `--max-privacy` — strongest privacy mode, which means "no local artifacts".
 * - `--no-local-artifacts` — "Do not write .vibgrate JSON artifacts to disk";
 *   graph.json is one of those artifacts, so building it violated the flag's
 *   contract *and* let the optional map build OOM-kill baseline scans (e.g. the
 *   migration `scan --push --no-local-artifacts` path), taking `--push` down
 *   with it even though drift and findings were already computed.
 */
export function shouldBuildCodeMap(opts: {
  graph?: boolean;
  maxPrivacy?: boolean;
  noLocalArtifacts?: boolean;
}): boolean {
  return opts.graph !== false && !opts.maxPrivacy && !opts.noLocalArtifacts;
}

function architectureGraphView(graph: VgGraph) {
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, file: n.file, kind: n.kind })),
    edges: graph.edges.map((e) => ({
      src: e.src,
      dst: e.dst,
      kind: e.kind,
      confidence: e.confidence,
      resolution: e.resolution,
    })),
  };
}

/**
 * Reachability hand-off: post the scan's dependency coordinates to the scan
 * symbols preflight, run the local graph query against the returned risky-symbol
 * manifest, and attach the verdicts to the artifact (uploaded with the push).
 * Best-effort — a failure here never fails or delays the scan.
 */
async function attachReachability(
  artifact: ScanArtifact,
  rootDir: string,
  opts: ScanOptions,
  graph: VgGraph,
): Promise<void> {
  try {
    const dsn = resolveDsn(opts.dsn);
    if (!dsn) return;
    const parsed = parseDsn(dsn);
    if (!parsed) return;
    const ingestHost = opts.region ? resolveIngestHost(opts.region) : parsed.host;

    const dependencies = collectPreflightDependencies(artifact.projects, PROJECT_TYPE_TO_OSV_ECOSYSTEM);
    if (dependencies.length === 0) return;

    const manifest = await fetchRiskySymbols(parsed, ingestHost, dependencies);
    if (manifest.status !== 'ok' || !manifest.advisories) return;

    artifact.reachability = await analyzeReachability({
      graph,
      rootDir,
      manifest: manifest.advisories,
      dependencies,
    });

    if (!opts.quiet && manifest.advisories.length > 0) {
      const tiers = artifact.reachability.findings.reduce<Record<string, number>>((acc, f) => {
        acc[f.tier] = (acc[f.tier] ?? 0) + 1;
        return acc;
      }, {});
      const parts = [
        tiers.reachable ? `${tiers.reachable} reachable` : null,
        tiers.potentially_reachable ? `${tiers.potentially_reachable} potentially reachable` : null,
        tiers.not_reached ? `${tiers.not_reached} not reached` : null,
        tiers.unknown ? `${tiers.unknown} unknown` : null,
      ].filter(Boolean);
      console.log(
        chalk.dim(
          `Reachability: ${manifest.advisories.length} advisor${manifest.advisories.length === 1 ? 'y' : 'ies'} checked against the code map — ${parts.join(', ')}`,
        ),
      );
    }
  } catch (e: unknown) {
    // Unknown ≠ safe: the server scores these findings at full weight. Surface
    // the reason only in strict-less informational form.
    if (!opts.quiet) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(chalk.dim(`Reachability check skipped: ${msg}`));
    }
  }
}

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

  // Compact and compress artifact for upload. `databaseSchemaCaps` lets
  // `scanners.databaseSchema` in vibgrate.config.ts raise/lower the default
  // upload caps (see DOCS.md § Database Schema).
  const config = await loadConfig(rootDir);
  const databaseSchemaCaps = config.scanners !== false ? config.scanners?.databaseSchema : undefined;
  const { body, contentEncoding } = await prepareCompressedUpload(artifact, { databaseSchemaCaps });
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
      force: opts.force,
      // Set only by an automated caller running the scan on the workspace's
      // behalf (e.g. a Vibgrate-hosted remediation run) — never a customer flag.
      runId: process.env.VIBGRATE_SCAN_RUN_ID,
      runToken: process.env.VIBGRATE_SCAN_RUN_TOKEN,
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

/**
 * `--full` extra: report banned dependencies against a committed standards policy
 * (`.vibgrate/standards.json` etc.). Silent when no policy is present, and never
 * changes the exit code — gating stays with `vg drift --fail-on standards`.
 */
function reportStandards(rootDir: string): void {
  const loaded = loadStandards(rootDir);
  if (!loaded.policy) return;
  const violations = checkStandards(loaded.policy, inventory(rootDir).records);
  if (violations.length === 0) {
    console.log(chalk.green('✔') + ' Standards: no banned dependencies in use');
    return;
  }
  console.log(chalk.red(`\n⚠ Standards: ${violations.length} banned dependency(ies) in use`));
  for (const v of violations) {
    const fix = v.use ? chalk.dim(` → use ${v.use}`) : '';
    const why = v.reason ? chalk.dim(` (${v.reason})`) : '';
    console.log(`  ${chalk.red('banned')} ${v.ecosystem}:${v.name}${v.installed ? chalk.dim(` ${v.installed}`) : ''}${fix}${why}`);
  }
}

/**
 * What vgd is doing for this repo right now — printed after a scan (or a
 * skipped one) so re-running `vg` is never a blank "unchanged" line while
 * the semantic index is still warming.
 */
async function printRuntimeSnapshot(
  rootDir: string,
  opts: { daemon?: boolean },
  already?: { repositoryId?: string; socketPath?: string },
): Promise<void> {
  try {
    const { attachVgd } = await import('../../runtime/vgd/attach.js');
    const { vgdRequest } = await import('../../runtime/vgd/client.js');
    const { formatSemanticProgress } = await import('../../runtime/vgd/semantic-status.js');
    let repositoryId = already?.repositoryId;
    let socketPath = already?.socketPath;
    if (!repositoryId || !socketPath) {
      const attached = await attachVgd(rootDir, {
        disabled: opts.daemon === false,
        autoStart: false,
        publish: false,
      });
      if (attached.status !== 'attached' || !attached.repositoryId || !attached.socketPath) return;
      repositoryId = attached.repositoryId;
      socketPath = attached.socketPath;
    }
    const semantic = await vgdRequest({ op: 'embed-status', repositoryId }, { socketPath });
    if (!semantic.ok || !('semantic' in semantic)) return;
    const slot =
      semantic.semantic.slots.find((s) => s.repositoryId === repositoryId) ?? semantic.semantic.slots[0];
    if (!slot) {
      if (semantic.semantic.worker === 'unavailable' && semantic.semantic.reason) {
        console.error(chalk.dim(`  · semantic · ${semantic.semantic.reason}`));
      }
      return;
    }
    console.error(chalk.dim(`  · ${formatSemanticProgress(slot)}`));
  } catch {
    /* no daemon, or it went away — the scan itself already succeeded */
  }
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
  .option('--concurrency <n>', 'Max concurrent registry lookups', '8')
  .option('--push', 'Auto-push results to Vibgrate API after scan')
  .option('--dsn <dsn>', 'DSN token for push (or use VIBGRATE_DSN env)')
  .option('--region <region>', 'Override data residency region for push (us, eu)')
  .option('--strict', 'Fail on push errors')
  .option('--ui-purpose', 'Enable optional UI purpose evidence extraction (slower)')
  .option('--no-local-artifacts', 'Do not write .vibgrate JSON artifacts to disk')
  .option('--max-privacy', 'Enable strongest privacy mode (minimal scanners, no local artifacts)')
  .option('--offline', 'Run without network calls; do not upload results')
  .option('--full', 'Comprehensive scan: turns on known-vulnerability detection (= --vulns) and, when a standards policy exists, a banned-dependency report — on top of drift scoring and the code map')
  .option('--vulns', 'Also scan installed dependencies for known vulnerabilities (OSV online, or advisories from --package-manifest when offline)')
  .option('--package-manifest <file>', 'Use local package-version manifest JSON/ZIP (for offline mode)')
  .option('--project-scan-timeout <seconds>', 'Per-project scan timeout in seconds (default: 180)')
  .option('--drift-budget <score>', 'Fail if DriftScore is above budget (0-100)')
  .option('--drift-worsening <percent>', 'Fail if drift worsens by more than % since baseline')
  .option('--repository-name <name>', 'Override the repository name recorded for this scan (defaults to the directory or package.json name)')
  .option('--force', 'Always create a fresh scan ingest, even if the repository is unchanged since the last scan (skips the unchanged/reuse optimization). Used by scheduled and dashboard-triggered scans.')
  .option('--no-graph', 'Skip building the local code map (the AI/docs index) that scan produces after scoring drift')
  .option('--no-daemon', 'Never auto-start or use the local runtime (vgd) — run everything in this process')
  .option('--quiet', 'Suppress promotional output (the free-plan tracking panel and the AI Context install prompt); scan results are unaffected')
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
    // Commander maps the `--no-local-artifacts` negation flag to
    // `localArtifacts` (default `true`, `false` when the flag is passed) — NOT
    // to `noLocalArtifacts`. Reading the wrong name silently ignored the flag.
    localArtifacts?: boolean;
    maxPrivacy?: boolean;
    offline?: boolean;
    full?: boolean;
    vulns?: boolean;
    packageManifest?: string;
    projectScanTimeout?: string;
    driftBudget?: string;
    driftWorsening?: string;
    repositoryName?: string;
    force?: boolean;
    graph?: boolean;
    /** `--no-daemon` arrives from commander as `daemon === false`. */
    daemon?: boolean;
    quiet?: boolean;
  }) => {
    const rootDir = path.resolve(targetPath);
    if (!(await pathExists(rootDir))) {
      console.error(chalk.red(`Path does not exist: ${rootDir}`));
      process.exit(1);
    }

    const hasDsn = !!resolveDsn(opts.dsn);
    let willPush = !opts.offline && (opts.push || hasDsn);

    // `--no-local-artifacts` arrives from commander as `localArtifacts === false`
    // (the negation flag's camelCase key), so normalise it once here. Reading
    // `opts.noLocalArtifacts` (which never exists) had silently ignored the flag:
    // every .vibgrate artifact — including the memory-heavy code map — was still
    // written, which OOM-killed migration baseline scans mid-map.
    const noLocalArtifacts = opts.localArtifacts === false;

    // Capture first-run before the scan writes .vibgrate/scan_result.json.
    const isFirstRun = !(await pathExists(path.join(rootDir, '.vibgrate', 'scan_result.json')));

    // Region the workspace is pinned to, learned from preflight. Used to route
    // the upload to the correct ingest host up front (the push path also
    // self-heals on a 409 REGION_MISMATCH if preflight didn't run).
    let pinnedRegion: string | undefined;
    // Workspace billing tier + upgrade link, learned from preflight. They select
    // the free-plan upsell panel's audience: a free-tier workspace shows the
    // panel with an upgrade CTA; any paid tier suppresses it. Left undefined when
    // preflight does not run (offline / no push), which keeps the panel hidden
    // for authenticated users rather than risk mislabelling a paid plan.
    let planTier: string | undefined;
    let upgradeUrl: string | undefined;
    // Set when preflight says the workspace's plan cannot accept this upload
    // (repository cap, scan credits, VM meter). A plan limit only blocks the
    // *push* — the local scan always runs; the reason is warned up front and
    // repeated after the results. Under --strict a blocked push is still fatal.
    let pushBlockedReason: string | undefined;

    const blockPush = (reason: string, detailLines: string[]): void => {
      if (opts.strict) {
        console.error(chalk.red(reason));
        for (const line of detailLines) console.error(chalk.dim(line));
        process.exit(1);
      }
      console.error(chalk.yellow(`⚠ ${reason}`));
      for (const line of detailLines) console.error(chalk.dim(`  ${line}`));
      console.error(chalk.dim('  Scanning locally — results will not be uploaded to Vibgrate Cloud.'));
      pushBlockedReason = reason;
      willPush = false;
    };

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
            // Canonical repo identity (credential-redacted by detectVcs) — the
            // server matches on this first, so re-scanning an already-mapped
            // repository under a different display name (e.g. a fresh clone in
            // a temp dir) is not miscounted as a NEW repo against the plan cap.
            remoteUrl: vcs.remoteUrl,
          });
          pinnedRegion = preflight.region;
          planTier = preflight.plan?.tier;
          // Prefer the server's canonical upgrade link; otherwise point at the
          // workspace dashboard on the (possibly region-pinned) ingest host.
          upgradeUrl =
            preflight.upgradeUrl ??
            `https://${dashHostForIngestHost(preflight.ingestHost ?? ingestHost)}/${parsed.workspaceId}`;
          // A plan limit (VM meter, repository cap, scan credits) blocks only
          // the upload — the local scan always runs. blockPush warns with the
          // reason, disables the push, and exits only under --strict.
          if (preflight.vm && !preflight.vm.allowed) {
            blockPush(preflight.error ?? 'VM meter usage exhausted', [
              `VM minutes: ${preflight.vm.used}/${preflight.vm.limit} (${preflight.plan.label} plan) — enable overages or upgrade your plan.`,
            ]);
          } else if (preflight.repositories && !preflight.repositories.allowed) {
            // A NEW repository that would breach the plan's repository cap.
            // Re-scanning an already-mapped repository is never blocked here.
            const max =
              preflight.repositories.max < 0 ? 'unlimited' : String(preflight.repositories.max);
            const detail = [
              `Repositories: ${preflight.repositories.total}/${max} (${preflight.plan.label} plan) — archive a repository or upgrade your plan.`,
            ];
            if (preflight.upgradeUrl) {
              detail.push(`Upgrade: ${preflight.upgradeUrl}`);
            }
            blockPush(
              preflight.error ??
                `Repository limit reached for the ${preflight.plan.label} plan — cannot upload a new repository.`,
              detail,
            );
          } else if (preflight.status === 'error' || !preflight.scans.allowed) {
            blockPush(preflight.error ?? 'Scan ingestion not allowed for this workspace.', [
              `Credits: ${preflight.scans.used}/${preflight.scans.limit} (${preflight.plan.label} plan)`,
            ]);
          } else {
            console.log(
              chalk.dim(
                `Plan: ${preflight.plan.label} — scan credits ${preflight.scans.used}/${preflight.scans.limit} this month`,
              ),
            );
            // `--force` opts out of the unchanged short-circuit so scheduled and
            // dashboard-triggered scans always produce a fresh report.
            if (preflight.repository?.unchanged && !opts.force) {
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
              // A skipped scan still has a daemon and a semantic index — say
              // what they are doing. Re-running `vg` after clearing the
              // terminal used to print only "unchanged" and look idle.
              await printRuntimeSnapshot(rootDir, opts);
              return;
            }
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
      noLocalArtifacts,
      maxPrivacy: opts.maxPrivacy,
      offline: opts.offline,
      // `--full` is the comprehensive umbrella: it turns on vulnerability scanning.
      vulns: opts.vulns || opts.full,
      packageManifest: opts.packageManifest,
      driftBudget: parseNonNegativeNumber(opts.driftBudget, '--drift-budget'),
      driftWorseningPercent: parseNonNegativeNumber(opts.driftWorsening, '--drift-worsening'),
      projectScanTimeout: opts.projectScanTimeout ? parseInt(opts.projectScanTimeout, 10) || undefined : undefined,
      repositoryName: opts.repositoryName?.trim() || undefined,
      force: opts.force,
      quiet: opts.quiet,
      // Auth + plan signals for the free-plan upsell panel. `hasDsn` resolves the
      // full credential precedence — `--dsn`, `VIBGRATE_DSN`, and the stored login
      // credential (`~/.vibgrate/credentials.json`) — which the scanner's own
      // dsn/env-only check cannot see. `planTier`/`upgradeUrl` come from preflight.
      // Together they pick the panel audience: signed out → login CTA; signed in
      // on free → upgrade CTA; signed in on a paid plan → no panel. Without the
      // auth signal, a logged-in user running a bare scan was mislabelled
      // "Vibgrate Free" and shown the login panel even as the run pushed.
      authenticated: hasDsn,
      planTier,
      upgradeUrl,
      // Prefix for the upsell panel's `login → push` hint — `vg` when installed,
      // `npx @vibgrate/cli` when the user ran via npx (where bare `vg` fails).
      invocation: resolveCliInvocation(),
    };

    // `scan` also builds the local code map (the AI/docs index) so one command
    // yields both the DriftScore and a ready graph for `vg ask`/`guide`/`lib`
    // and MCP. We run it as the scan's final `postScan` step so it shares the
    // *single* progress bar (no second bar/logo). Fail-soft — a map problem
    // never fails the scan. Skipped under --no-graph, --max-privacy, and
    // --no-local-artifacts (the map is a local .vibgrate artifact; see
    // shouldBuildCodeMap). An uncatchable OOM in the map build otherwise takes
    // the whole scan — and its --push — down with it.
    const wantGraph = shouldBuildCodeMap({ graph: opts.graph, maxPrivacy: opts.maxPrivacy, noLocalArtifacts });
    // Retained by the postScan hook so the reachability query below can run
    // against the freshly built map without a second (memory-heavy) build.
    let builtGraph: VgGraph | null = null;
    if (wantGraph) {
      scanOpts.postScan = async (report, ctx) => {
        const result = await buildGraph({
          root: rootDir,
          exclude: opts.exclude,
          onParseProgress: (done, total) => report(done, total, 'parsing'),
        });
        builtGraph = result.graph;
        writeArtifacts(result.graph, { root: rootDir });
        // Freshness snapshot → lets `vg serve`/`vg ask` auto-refresh this map
        // when the working tree drifts (see engine/freshness.ts).
        writeSnapshot(rootDir, result.graph.provenance.corpusHash, result.fileStats, {
          exclude: opts.exclude,
        });
        // Refine before format/write — architecture is already on these objects.
        // --no-graph / map failed / --max-privacy never reach here.
        // AST roles first so @Entity / @Controller confirm (or override a
        // filename suffix) before boundary violations are collected.
        refineArchitectureWithAstRoles(
          { projects: ctx.projects, solutions: ctx.solutions, extended: ctx.extended },
          result.fileRoles,
        );
        refineArchitectureWithGraph(
          { projects: ctx.projects, solutions: ctx.solutions, extended: ctx.extended },
          architectureGraphView(result.graph),
        );
        const { counts } = result.graph.meta;
        return `${counts.nodes.toLocaleString()} nodes · ${counts.edges.toLocaleString()} edges`;
      };
    }

    // Open base scan. The optional advanced-analysis hook is a no-op in this
    // open build, so the scan runs entirely on the open base engine.
    const advanced = await loadAdvancedScanHook();
    const artifact = await runCoreScan(rootDir, scanOpts, advanced);

    // The scan just built a code map (its `postScan` step). Start the local
    // runtime if it is not up and hand it that map, so the very first `vg` in a
    // repo leaves behind a warm graph slot and a warming semantic index rather
    // than a daemon that has never heard of this repository. Best-effort and
    // silent: `attachVgd` never throws, and no daemon is a supported setup.
    if (wantGraph && builtGraph) {
      const { attachVgd } = await import('../../runtime/vgd/attach.js');
      const { ActivityLog } = await import('../../runtime/vgd/activity.js');
      const activity = new ActivityLog();
      const attached = await activity.time(
        'attach',
        () => attachVgd(rootDir, { disabled: opts.daemon === false }),
        (a) => {
          if (a.status !== 'attached') return { outcome: 'skip' as const, detail: `${a.reason} — the map stays on disk only` };
          const started = a.started ? 'started vgd' : 'attached to vgd';
          if (a.published?.status === 'published') {
            return {
              outcome: 'ok' as const,
              detail: `${started} · map published ${a.published.gitRef} · ${a.published.nodeCount} nodes`,
            };
          }
          return { outcome: 'ok' as const, detail: started };
        },
      );
      if (!opts.quiet && opts.format !== 'json') {
        for (const line of activity.render()) console.error(line);
        if (attached.status === 'attached') {
          await printRuntimeSnapshot(rootDir, opts, {
            repositoryId: attached.repositoryId,
            socketPath: attached.socketPath,
          });
        }
      }
    }

    // Machine-readable drift score for the remediation agent's before/after gate
    // (no-op unless VIBGRATE_EMIT_MARKERS=1). Emitted from the freshly computed
    // local artifact, so it is available even without --push.
    emitDriftScoreLine(artifact.drift.score);

    // `--full` also surfaces the offline standards/policy check (otherwise only
    // reachable via `vg drift --fail-on standards`). Report-only here — it never
    // changes the exit code; use `vg drift --fail-on standards` to gate CI.
    if (opts.full) {
      reportStandards(rootDir);
    }

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
      console.error(chalk.red(`\nFailing fitness function: DriftScore ${artifact.drift.score}/100 exceeds budget ${scanOpts.driftBudget}.`));
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

    // Reachability hand-off (before push): post the dependency coordinates the
    // scan found in the package manifests to the symbols preflight, then query
    // the freshly built local code map for vulnerable-symbol usage and attach
    // the verdicts to the artifact. Coordinates only go up — never source.
    // Strictly best-effort: any failure leaves reachability absent (Unknown
    // server-side); it never delays exit codes or blocks the push.
    if (willPush && hasDsn && builtGraph) {
      await attachReachability(artifact, rootDir, scanOpts, builtGraph);
    }

    if (willPush) {
      await autoPush(artifact, rootDir, scanOpts);
    } else if (pushBlockedReason) {
      // Repeat the preflight warning after the (long) scan output so the
      // reason the results never reached Vibgrate Cloud is the last thing seen.
      console.error('');
      console.error(chalk.yellow(`⚠ Results were not uploaded: ${pushBlockedReason}`));
      if (upgradeUrl) {
        console.error(chalk.dim(`  Upgrade: ${upgradeUrl}`));
      }
    }

    // On first run with no cloud connection and text output, prompt the user
    // to wire Vibgrate AI Context into their AI assistant.
    const showAiPrompt =
      scanOpts.format === 'text' &&
      !opts.quiet &&
      !hasDsn &&
      !opts.offline &&
      !noLocalArtifacts &&
      !opts.maxPrivacy &&
      isFirstRun;

    if (showAiPrompt) {
      const detectedAssistant = await detectAiAssistant(rootDir);
      printAiContextPrompt(detectedAssistant);
    }
  });
