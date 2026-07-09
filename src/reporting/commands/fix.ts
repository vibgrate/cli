import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  runCoreScan,
  projectTypeToVulnEcosystem,
  detectVcs,
  computeRepoFingerprint,
  resolveRepositoryName,
  parseDsn,
  type ScanOptions,
  type ScanArtifact,
  type ProjectType,
  type VulnSeverity,
} from '../../core-open/index.js';
import { pathExists, readJsonFile } from '../utils/fs.js';
import { scanStaleness } from '../utils/scan-freshness.js';
import { loadAdvancedScanHook } from '../advanced-hook.js';
import { VERSION } from '../version.js';
import { resolveDsn } from '../credentials.js';
import { resolveIngestHost } from './dsn.js';
import { dashHostForIngestHost } from '../regions.js';
import { resolveCliInvocation } from '../../util/cli-invocation.js';
import * as readline from 'node:readline';
import { analyzeTree, type SourceEcosystem } from '../planning/usage.js';
import { requestFixPlan, parseFixPlanResponse } from '../utils/fix-plan.js';
import { renderText, renderMarkdown } from '../planning/render.js';
import { estimateDriftScore } from '../planning/expected-drift.js';
import { applyPlan, type NpmPackageManager, type WorkspaceTarget } from '../planning/apply.js';
import { detectWorkspaceRoot } from './update.js';
import type { FixCandidateInput, FixPlanRequest, FixPlanResponse, PlanTier, PlannedUpgrade, UpgradePlan } from '../planning/types.js';

const SEVERITY_RANK: Record<VulnSeverity, number> = { unknown: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** Map a scanned project type to the ecosystem id sent to the planner (all ecosystems, not just npm). */
function ecosystemId(type: ProjectType): string {
  return projectTypeToVulnEcosystem(type) ?? type;
}

/** Which ecosystems we can cheaply read source for, to gather usage + contracts. */
function sourceEcosystem(ecosystem: string): SourceEcosystem {
  if (ecosystem === 'npm') return 'npm';
  if (ecosystem === 'pypi') return 'pypi';
  return 'unknown';
}

interface RawCandidate {
  package: string;
  ecosystem: string;
  source: SourceEcosystem;
  from: string | null;
  to: string | null;
  majorsBehind: number | null;
  section?: string;
}

/** Collect deduped, drifted dependencies across every ecosystem in the scan artifact. */
function collectCandidates(artifact: ScanArtifact): RawCandidate[] {
  const seen = new Set<string>();
  const out: RawCandidate[] = [];
  for (const project of artifact.projects ?? []) {
    const ecosystem = ecosystemId(project.type);
    for (const dep of project.dependencies ?? []) {
      const key = `${ecosystem}\0${dep.package}`;
      if (seen.has(key)) continue;
      if (!dep.latestStable || dep.latestStable === dep.resolvedVersion) continue;
      if (dep.drift === 'current' || dep.drift === 'unknown') continue;
      seen.add(key);
      out.push({
        package: dep.package,
        ecosystem,
        source: sourceEcosystem(ecosystem),
        from: dep.resolvedVersion,
        to: dep.latestStable,
        majorsBehind: dep.majorsBehind,
        section: dep.section,
      });
    }
  }
  out.sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.package.localeCompare(b.package));
  return out;
}

/**
 * Runs a drift scan for `vg fix` when no usable prior scan exists. Injectable so
 * tests can exercise the auto-scan decision without a network round-trip; the
 * default runs the real core scan WITHOUT the code map (drift is all `fix`
 * needs), writing JSON quietly to a scratch file so nothing lands on stdout.
 */
export type FixScanner = (rootDir: string) => Promise<ScanArtifact>;

const defaultFixScanner: FixScanner = async (rootDir) => {
  const scratch = path.join(os.tmpdir(), `vg-fix-scan-${process.pid}.json`);
  const scanOpts: ScanOptions = { vibgrateVersion: VERSION, format: 'json', out: scratch, quiet: true, concurrency: 8 };
  const advanced = await loadAdvancedScanHook();
  return runCoreScan(rootDir, scanOpts, advanced);
};

/**
 * Load the scan artifact `vg fix` plans against, re-scanning when there is no
 * usable prior scan. A scan is re-run when the artifact is **missing** OR when it
 * is **out of date** with the working tree — a manifest edit or a lockfile bump
 * (e.g. from a previous `vg fix`) since the scan means the on-disk drift no
 * longer reflects the repository, so planning against it would upgrade the wrong
 * versions. Freshness is scoped to dependency manifests/lockfiles and fails open
 * (see {@link scanStaleness}).
 */
export async function loadArtifact(
  rootDir: string,
  inFile: string,
  scan: FixScanner = defaultFixScanner,
): Promise<ScanArtifact> {
  const artifactPath = path.isAbsolute(inFile) ? inFile : path.join(rootDir, inFile);
  if (await pathExists(artifactPath)) {
    const staleness = scanStaleness(rootDir, artifactPath);
    if (!staleness.stale) {
      return readJsonFile<ScanArtifact>(artifactPath);
    }
    console.error(
      chalk.dim(
        `Scan is out of date (${staleness.newestChanged ?? 'a dependency manifest'} changed since the last scan) — re-running a drift scan first (code map skipped)…`,
      ),
    );
  } else {
    console.error(chalk.dim('No scan found — running a drift scan first (code map skipped)…'));
  }
  return scan(rootDir);
}

/** Best-effort, non-sensitive repository identity for dataset association + plan caching. */
async function repositoryIdentity(rootDir: string, override?: string): Promise<{ name?: string; vcsSha?: string }> {
  try {
    const vcs = await detectVcs(rootDir);
    const fingerprint = await computeRepoFingerprint(rootDir, vcs);
    const name = override?.trim() || (await resolveRepositoryName(rootDir));
    return { name, vcsSha: fingerprint.vcsSha };
  } catch {
    return { name: override?.trim() || undefined };
  }
}

export const fixCommand = new Command('fix')
  .description('Analyse drift and get ranked, risk-tiered upgrade plans from the hosted planner (requires login/DSN; read-only — never edits your project)')
  .argument('[path]', 'Path to analyse', '.')
  .option('--in <file>', 'Scan artifact to read', '.vibgrate/scan_result.json')
  .option('--format <format>', 'Output format (text|json|md)', 'text')
  .option('--dsn <dsn>', 'DSN token (or use VIBGRATE_DSN env / "vg login")')
  .option('--region <region>', 'Override data residency region (us, eu)')
  .option('--repository-name <name>', 'Override the repository name recorded for this plan')
  .option('--plan <tier>', 'Apply a specific plan non-interactively (safe|balanced|aggressive)')
  .option('--yes', 'Apply the recommended plan without prompting')
  .option('--dry-run', 'Show what would change without applying')
  .option('--no-apply', 'Only print the plans; never modify the project')
  .option('--fail-on-vulns <severity>', 'Exit non-zero if the recommended plan leaves an advisory at/above this severity unresolved (low|moderate|high|critical)')
  .action(async (targetPath: string, opts: {
    in: string;
    format: string;
    dsn?: string;
    region?: string;
    repositoryName?: string;
    plan?: string;
    yes?: boolean;
    dryRun?: boolean;
    apply?: boolean; // commander maps --no-apply → apply === false
    failOnVulns?: string;
  }) => {
    const rootDir = path.resolve(targetPath);
    if (!(await pathExists(rootDir))) {
      console.error(chalk.red(`Path does not exist: ${rootDir}`));
      process.exit(1);
    }

    const failOn = opts.failOnVulns as VulnSeverity | undefined;
    if (failOn && !(failOn in SEVERITY_RANK)) {
      console.error(chalk.red(`Invalid --fail-on-vulns value '${opts.failOnVulns}'. Use one of: low, moderate, high, critical.`));
      process.exit(1);
    }

    // `vg fix` is a paid, hosted capability — it needs a DSN. No local planning
    // fallback exists (the planning intelligence is server-side by design).
    const dsn = resolveDsn(opts.dsn);
    if (!dsn) {
      const cli = resolveCliInvocation();
      console.error(chalk.red('vg fix needs a Vibgrate login.'));
      console.error(
        chalk.dim(
          `Run "${cli} login" (or set VIBGRATE_DSN / pass --dsn) to analyse upgrades with the hosted planner. ` +
            'See https://vibgrate.com/cli for details.',
        ),
      );
      process.exit(1);
    }
    const parsed = parseDsn(dsn);
    if (!parsed) {
      console.error(chalk.red('Invalid DSN format. Re-run "vg login" or check VIBGRATE_DSN.'));
      process.exit(1);
    }

    let host: string;
    try {
      host = opts.region ? resolveIngestHost(opts.region) : parsed.host;
    } catch (e: unknown) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }

    let artifact: ScanArtifact;
    try {
      artifact = await loadArtifact(rootDir, opts.in);
    } catch (e: unknown) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exit(1);
    }

    const raw = collectCandidates(artifact);

    // Gather usage + contracts from local source (never leaves the machine except
    // as the aggregate counts/symbols the planner needs). One bounded walk.
    const usage = analyzeTree(
      rootDir,
      raw.filter((c) => c.source !== 'unknown').map((c) => ({ name: c.package, ecosystem: c.source })),
    );

    const candidates: FixCandidateInput[] = raw.map((c) => {
      const u = usage.get(c.package);
      return {
        package: c.package,
        ecosystem: c.ecosystem,
        currentVersion: c.from,
        latestVersion: c.to,
        majorsBehind: c.majorsBehind,
        section: c.section,
        ...(u && (u.importSites > 0 || u.filesTouched > 0)
          ? { usage: { importSites: u.importSites, filesTouched: u.filesTouched } }
          : {}),
        ...(u && u.contracts.length ? { contracts: u.contracts } : {}),
      };
    });

    const request: FixPlanRequest = {
      cliVersion: VERSION,
      repository: await repositoryIdentity(rootDir, opts.repositoryName),
      candidates,
    };

    let response: FixPlanResponse;
    try {
      const { response: httpResponse } = await requestFixPlan({
        scheme: parsed.scheme,
        host,
        keyId: parsed.keyId,
        secret: parsed.secret,
        request,
        timestamp: String(Date.now()),
      });
      if (!httpResponse.ok) {
        handleHttpError(httpResponse, parsed.workspaceId, host);
        return; // handleHttpError exits, but keep the type-checker happy.
      }
      response = await parseFixPlanResponse(httpResponse);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(chalk.red(`Could not reach the upgrade planner: ${msg}`));
      console.error(chalk.dim('Check your connection and try again, or see https://vibgrate.com/help.'));
      process.exit(1);
    }

    if (response.status === 'error') {
      console.error(chalk.red(response.error ?? 'The planner returned an error.'));
      if (response.requestId) console.error(chalk.dim(`  (ref ${response.requestId})`));
      process.exit(1);
    }

    // Augment each plan with an estimated post-upgrade DriftScore (client-side).
    const currentDrift = artifact.drift?.score;
    if (typeof currentDrift === 'number') {
      response.currentDriftScore = currentDrift;
      for (const plan of response.plans) {
        const upgraded = new Set(plan.upgrades.map((u) => u.package));
        const expected = estimateDriftScore(artifact, upgraded);
        plan.expectedDriftScore = expected;
        plan.driftDelta = expected - currentDrift;
      }
    }

    emit(response, opts.format);

    // Apply flow (text mode only; --no-apply / json / md are report-only).
    if (opts.format === 'text' && opts.apply !== false) {
      await runApplyFlow(rootDir, artifact, response, opts);
    }

    if (failOn) {
      // Advisories the *recommended* plan does not remediate = the estate's open
      // advisories minus what the recommended plan fixes, evaluated by severity.
      const recommended = response.plans.find((p) => p.tier === response.recommended);
      const threshold = SEVERITY_RANK[failOn];
      let stillOpen = 0;
      for (const sev of Object.keys(SEVERITY_RANK) as VulnSeverity[]) {
        if (SEVERITY_RANK[sev] < threshold) continue;
        const open = response.unresolved.bySeverity[sev] ?? 0;
        // Anything the recommended plan itself does not fix also counts as open.
        const notFixedByRecommended =
          (response.plans.find((p) => p.tier === 'aggressive')?.fixes.bySeverity[sev] ?? 0) -
          (recommended?.fixes.bySeverity[sev] ?? 0);
        stillOpen += open + Math.max(0, notFixedByRecommended);
      }
      if (stillOpen > 0) {
        console.error(
          chalk.red(`\nFailing: the recommended plan leaves ${stillOpen} advisory(ies) at/above ${failOn} unresolved.`),
        );
        process.exit(2);
      }
    }
  });

/** Turn a non-2xx planner response into an actionable, non-leaky error and exit. */
function handleHttpError(response: Response, workspaceId: string, host: string): never {
  const upgradeUrl = `https://${dashHostForIngestHost(host)}/${workspaceId}`;
  if (response.status === 401 || response.status === 403) {
    console.error(chalk.red('Not authorised. Your DSN may be invalid or lack access to this workspace.'));
    console.error(chalk.dim('Re-run "vg login" or check VIBGRATE_DSN.'));
    process.exit(1);
  }
  if (response.status === 402) {
    console.error(chalk.red('vg fix is a paid capability that is not enabled on your current plan.'));
    console.error(chalk.dim(`Upgrade to enable the hosted upgrade planner: ${upgradeUrl}`));
    process.exit(1);
  }
  if (response.status === 429) {
    console.error(chalk.red('Rate limited by the planner. Wait a moment and try again.'));
    process.exit(1);
  }
  console.error(chalk.red(`The planner returned HTTP ${response.status}.`));
  console.error(chalk.dim('Try again shortly, or see https://vibgrate.com/help.'));
  process.exit(1);
}

function emit(report: FixPlanResponse, format: string): void {
  switch (format) {
    case 'json':
      console.log(JSON.stringify(report, null, 2));
      break;
    case 'md':
      console.log(renderMarkdown(report));
      break;
    case 'text':
    default:
      console.log(renderText(report));
      break;
  }
}

/** Normalise a project's scan path to a directory relative to the repo root. */
function relProjectDir(rootDir: string, projectPath: string): string {
  const rel = path.isAbsolute(projectPath) ? path.relative(rootDir, projectPath) : projectPath;
  return rel === '' ? '.' : rel;
}

/**
 * Build a resolver mapping each upgrade to the workspace manifest(s) that
 * actually declare it, so the pin command edits the right `package.json` (and
 * a monorepo dep never lands in the root manifest by accident).
 *
 * Ownership is keyed by `${ecosystem}\0${package}` — identical to how
 * {@link collectCandidates} keys candidates — but drawn from *every* project in
 * the artifact, not deduped, so a dependency declared in several workspace
 * packages resolves to all of them. Dirs are sorted for deterministic output.
 * A dependency with no located owner falls back to the root manifest (with
 * `-w` when the root is a pnpm workspace, so the command no longer crashes).
 */
export async function buildTargetResolver(
  rootDir: string,
  artifact: ScanArtifact,
): Promise<(upgrade: PlannedUpgrade) => WorkspaceTarget[]> {
  const rootIsWorkspace = await detectWorkspaceRoot(rootDir);
  const owners = new Map<string, Set<string>>();
  for (const project of artifact.projects ?? []) {
    const ecosystem = ecosystemId(project.type);
    const dir = relProjectDir(rootDir, project.path);
    for (const dep of project.dependencies ?? []) {
      const key = `${ecosystem}\0${dep.package}`;
      (owners.get(key) ?? owners.set(key, new Set()).get(key)!).add(dir);
    }
  }
  const rootFallback: WorkspaceTarget[] = [{ dir: '.', isWorkspaceRoot: rootIsWorkspace }];
  return (upgrade) => {
    const dirs = owners.get(`${upgrade.ecosystem}\0${upgrade.package}`);
    if (!dirs || dirs.size === 0) return rootFallback;
    return [...dirs]
      .sort((a, b) => a.localeCompare(b))
      .map((dir) => ({ dir, isWorkspaceRoot: dir === '.' && rootIsWorkspace }));
  };
}

/** The npm-family package manager to drive npm upgrades, from the scan. */
function npmPackageManager(artifact: ScanArtifact): NpmPackageManager {
  for (const p of artifact.projects ?? []) {
    if ((p.type === 'node' || p.type === 'typescript') && p.packageManager) {
      const pm = p.packageManager;
      if (pm === 'pnpm' || pm === 'yarn' || pm === 'bun' || pm === 'npm') return pm;
    }
  }
  return 'npm';
}

/** Interactive plan picker (TTY). Resolves to the chosen tier, or null to cancel. */
function promptPlanSelection(response: FixPlanResponse): Promise<PlanTier | null> {
  const plans = response.plans.filter((p) => p.upgrades.length > 0);
  console.log(chalk.bold('\nSelect a plan to apply:'));
  plans.forEach((p, i) => {
    const rec = p.tier === response.recommended ? chalk.green(' (recommended)') : '';
    const drift =
      typeof p.expectedDriftScore === 'number' && typeof response.currentDriftScore === 'number'
        ? ` · DriftScore ${response.currentDriftScore}→${p.expectedDriftScore}`
        : '';
    console.log(`  ${i + 1}) ${chalk.bold(p.label)}${rec}  risk ${p.riskScore}/100 · ${p.upgrades.length} upgrade(s)${drift}`);
  });
  const defaultIdx = plans.findIndex((p) => p.tier === response.recommended);
  const def = defaultIdx >= 0 ? defaultIdx + 1 : 1;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`Plan [1-${plans.length}, default ${def}, q to cancel]: `, (ans) => {
      rl.close();
      const t = ans.trim().toLowerCase();
      if (t === 'q' || t === 'quit') return resolve(null);
      const n = t === '' ? def : Number.parseInt(t, 10);
      if (!Number.isInteger(n) || n < 1 || n > plans.length) return resolve(null);
      resolve(plans[n - 1].tier);
    });
  });
}

/** Choose a plan (flags → single-plan → interactive → non-interactive default), apply it, and report. */
async function runApplyFlow(
  rootDir: string,
  artifact: ScanArtifact,
  response: FixPlanResponse,
  opts: { plan?: string; yes?: boolean; dryRun?: boolean },
): Promise<void> {
  const nonEmpty = response.plans.filter((p) => p.upgrades.length > 0);
  if (nonEmpty.length === 0) {
    console.log(chalk.green('\n✔ Nothing to upgrade — every tracked dependency is current.'));
    return;
  }

  let chosen: UpgradePlan | undefined;
  if (opts.plan) {
    chosen = response.plans.find((p) => p.tier === opts.plan);
    if (!chosen) {
      console.error(chalk.red(`Unknown plan '${opts.plan}'. Use safe, balanced, or aggressive.`));
      process.exit(1);
    }
  } else if (nonEmpty.length === 1) {
    chosen = nonEmpty[0];
  } else if (opts.yes) {
    chosen = response.plans.find((p) => p.tier === response.recommended) ?? nonEmpty[0];
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    const tier = await promptPlanSelection(response);
    if (!tier) {
      console.log(chalk.dim('No plan applied.'));
      return;
    }
    chosen = response.plans.find((p) => p.tier === tier);
  } else {
    console.log(chalk.dim('\nMultiple plans available — re-run with --plan <tier> or --yes to apply, or --dry-run to preview.'));
    return;
  }
  if (!chosen || chosen.upgrades.length === 0) {
    console.log(chalk.dim('Selected plan has no upgrades.'));
    return;
  }

  const pm = npmPackageManager(artifact);
  const resolveTargets = await buildTargetResolver(rootDir, artifact);
  const results = applyPlan(rootDir, chosen.upgrades, { dryRun: opts.dryRun, packageManager: pm, resolveTargets });

  if (opts.dryRun) {
    console.log(chalk.bold(`\nDry run — ${chosen.label} plan (${chosen.upgrades.length} upgrade(s)):`));
    for (const r of results) {
      if (r.status === 'manual') console.log(chalk.yellow(`  ⚠ ${r.package}: ${r.detail}`));
      else console.log(chalk.dim(`  ${r.package}: ${r.detail}`));
    }
    if (typeof chosen.expectedDriftScore === 'number') {
      console.log(chalk.dim(`Expected DriftScore after apply: ~${chosen.expectedDriftScore} (was ${response.currentDriftScore ?? '?'}).`));
    }
    return;
  }

  const applied = results.filter((r) => r.status === 'applied');
  const failed = results.filter((r) => r.status === 'failed');
  const manual = results.filter((r) => r.status === 'manual');

  console.log(chalk.bold(`\nApplied the ${chosen.label} plan:`));
  console.log(
    chalk.green(`  ✔ ${applied.length} upgraded`) +
      (failed.length ? chalk.red(`   ✖ ${failed.length} failed`) : '') +
      (manual.length ? chalk.yellow(`   ⚠ ${manual.length} need manual work`) : ''),
  );
  for (const r of failed) console.log(chalk.red(`    ✖ ${r.package} → ${r.to}: ${r.detail ?? 'failed'}`));
  for (const r of manual) console.log(chalk.yellow(`    ⚠ ${r.package} → ${r.to}: ${r.detail}`));
  if (typeof chosen.expectedDriftScore === 'number' && typeof response.currentDriftScore === 'number') {
    const delta = chosen.expectedDriftScore - response.currentDriftScore;
    console.log(
      `  Expected DriftScore: ${response.currentDriftScore} → ~${chosen.expectedDriftScore} (${delta <= 0 ? '' : '+'}${delta}). ` +
        'Re-run `vg` to confirm the actual score.',
    );
  }
  if (failed.length) process.exitCode = 2;
}
