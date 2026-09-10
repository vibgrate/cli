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
import { dedupePlans } from '../planning/dedupe.js';
import { estimateDriftScore } from '../planning/expected-drift.js';
import { applyPlan, type NpmPackageManager, type WorkspaceTarget } from '../planning/apply.js';
import { detectWorkspaceRoot } from './update.js';
import type { FixCandidateInput, FixPlanRequest, FixPlanResponse, PlanTier, PlannedUpgrade, UpgradeConflict, UpgradeKind, UpgradePlan } from '../planning/types.js';

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

/** Best-effort semver bump classification from two `major.minor.patch...` strings. */
function classifyBump(from: string | null, to: string | null): UpgradeKind {
  const a = /^v?(\d+)\.(\d+)\.(\d+)/.exec(from ?? '');
  const b = /^v?(\d+)\.(\d+)\.(\d+)/.exec(to ?? '');
  if (!a || !b) return 'unknown';
  if (Number(b[1]) !== Number(a[1])) return 'major';
  if (Number(b[2]) !== Number(a[2])) return 'minor';
  if (Number(b[3]) !== Number(a[3])) return 'patch';
  return 'unknown';
}

/**
 * Narrow candidates to a specific, caller-chosen subset before planning — the
 * mechanism a caller (a script, or the VS Code extension's grouped "Fix N
 * Patch/Minor/Major Upgrades" action) uses to plan+apply exactly one Dependabot-
 * style batch instead of every drifted dependency at once. `--packages` and
 * `--kind` compose (both narrow further when both are given).
 */
function filterCandidates(candidates: RawCandidate[], opts: { packages?: string[]; kind?: UpgradeKind }): RawCandidate[] {
  let out = candidates;
  if (opts.packages && opts.packages.length > 0) {
    const wanted = new Set(opts.packages.map((p) => p.trim()).filter(Boolean));
    out = out.filter((c) => wanted.has(c.package));
  }
  if (opts.kind) {
    out = out.filter((c) => classifyBump(c.from, c.to) === opts.kind);
  }
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
  .description('Get ranked, risk-tiered upgrade plans from the hosted planner and optionally apply them (prompts before changing files; --yes applies non-interactively, --dry-run previews, --no-apply only prints). Requires login/DSN.')
  .argument('[path]', 'Path to analyse', '.')
  .option('--in <file>', 'Scan artifact to read', '.vibgrate/scan_result.json')
  .option('--format <format>', 'Output format (text|json|md)', 'text')
  .option('--dsn <dsn>', 'DSN token (or use VIBGRATE_DSN env / "vg login")')
  .option('--region <region>', 'Override data residency region (us, eu)')
  .option('--repository-name <name>', 'Override the repository name recorded for this plan')
  .option('--plan <tier>', 'Apply a specific plan non-interactively (safe|balanced|aggressive)')
  .option('--yes', 'Apply the recommended plan without prompting')
  .option('--dry-run', 'Preview the recommended plan (or --plan <tier>) without applying; never prompts')
  .option('--no-apply', 'Only print the plans; never modify the project')
  .option('--packages <names>', 'Plan/apply only these packages (comma-separated) — for grouping a specific batch instead of every drifted dependency')
  .option('--kind <bump>', 'Plan/apply only upgrades of this semver bump kind (patch|minor|major) — combine with --packages to target one Dependabot-style batch')
  .option('--force', 'Apply a plan even if the planner flagged a blocking cross-package conflict within it')
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
    packages?: string;
    kind?: string;
    force?: boolean;
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

    const kindFilter = opts.kind as UpgradeKind | undefined;
    if (kindFilter && kindFilter !== 'patch' && kindFilter !== 'minor' && kindFilter !== 'major') {
      console.error(chalk.red(`Invalid --kind value '${opts.kind}'. Use one of: patch, minor, major.`));
      process.exit(1);
    }
    const packageFilter = opts.packages
      ? opts.packages
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : undefined;

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

    const raw = filterCandidates(collectCandidates(artifact), { packages: packageFilter, kind: kindFilter });
    if ((packageFilter || kindFilter) && raw.length === 0) {
      console.log(chalk.green('\n✔ Nothing to upgrade — no drifted dependency matches that selection.'));
      return;
    }

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

    // Collapse duplicate plans onto the lowest-risk tier before anything is
    // rendered or selected: a tier whose upgrade set is identical to a
    // lower-risk tier's adds no real choice. Requests for a collapsed tier
    // (--plan, the server's recommendation) resolve via the alias map.
    const { plans: dedupedPlans, canonicalTier } = dedupePlans(response.plans);
    response.plans = dedupedPlans;
    response.recommended = canonicalTier.get(response.recommended) ?? response.recommended;

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
      await runApplyFlow(rootDir, artifact, response, opts, canonicalTier);
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
        // Measured against the most-fixing plan (not the 'aggressive' tier by
        // name — that tier may have been collapsed as a duplicate).
        const maxFixable = Math.max(0, ...response.plans.map((p) => p.fixes.bySeverity[sev] ?? 0));
        const notFixedByRecommended = maxFixable - (recommended?.fixes.bySeverity[sev] ?? 0);
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

/**
 * Split a plan's conflicts into blocking vs. advisory, and decide whether apply
 * should be refused. `--force` lifts a block but the conflicts are still shown
 * — pure and exported so the decision is unit-testable without spawning any
 * real package-manager process.
 */
export function gateConflicts(plan: UpgradePlan, force?: boolean): { blocking: UpgradeConflict[]; advisory: UpgradeConflict[]; blocked: boolean } {
  const blocking = (plan.conflicts ?? []).filter((c) => c.severity === 'blocking');
  const advisory = (plan.conflicts ?? []).filter((c) => c.severity === 'advisory');
  return { blocking, advisory, blocked: blocking.length > 0 && !force };
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
  opts: { plan?: string; yes?: boolean; dryRun?: boolean; force?: boolean },
  canonicalTier?: Map<PlanTier, PlanTier>,
): Promise<void> {
  const nonEmpty = response.plans.filter((p) => p.upgrades.length > 0);
  if (nonEmpty.length === 0) {
    console.log(chalk.green('\n✔ Nothing to upgrade — every tracked dependency is current.'));
    return;
  }

  let chosen: UpgradePlan | undefined;
  if (opts.plan) {
    // A tier collapsed as a duplicate resolves to the surviving lower-risk plan.
    const tier = canonicalTier?.get(opts.plan as PlanTier) ?? opts.plan;
    chosen = response.plans.find((p) => p.tier === tier);
    if (!chosen) {
      console.error(chalk.red(`Unknown plan '${opts.plan}'. Use safe, balanced, or aggressive.`));
      process.exit(1);
    }
  } else if (nonEmpty.length === 1) {
    chosen = nonEmpty[0];
  } else if (opts.yes || opts.dryRun) {
    // --yes applies the recommended plan without a pick. --dry-run previews that
    // same plan without prompting: asking which tier to "apply" is meaningless
    // when nothing is written. Pass --plan <tier> to dry-run a specific plan.
    chosen = response.plans.find((p) => p.tier === response.recommended) ?? nonEmpty[0];
    if (opts.dryRun && !opts.yes && nonEmpty.length > 1) {
      console.log(
        chalk.dim(
          `\nDry-run previews the recommended (${chosen.tier}) plan — nothing will be written. ` +
            'Pass --plan <safe|balanced|aggressive> to preview another tier.',
        ),
      );
    }
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    const tier = await promptPlanSelection(response);
    if (!tier) {
      console.log(chalk.dim('No plan applied.'));
      return;
    }
    chosen = response.plans.find((p) => p.tier === tier);
  } else {
    console.log(chalk.dim('\nMultiple plans available — re-run with --plan <tier> or --yes to apply, or --dry-run to preview the recommended plan.'));
    return;
  }
  if (!chosen || chosen.upgrades.length === 0) {
    console.log(chalk.dim('Selected plan has no upgrades.'));
    return;
  }

  const gate = gateConflicts(chosen, opts.force);
  for (const c of gate.advisory) {
    console.log(chalk.yellow(`  ⚠ conflict: ${c.packages.join(', ')} — ${c.reason}`));
  }
  if (gate.blocking.length > 0 && !opts.dryRun) {
    console.log(chalk.bold.red(`\n✖ ${gate.blocking.length} cross-package conflict(s) in the ${chosen.label} plan:`));
    for (const c of gate.blocking) console.log(chalk.red(`  ✖ ${c.packages.join(', ')} — ${c.reason}`));
    if (gate.blocked) {
      console.log(chalk.dim('Nothing applied. Re-run with --force to apply anyway, or --plan <tier> for a plan without this conflict.'));
      process.exitCode = 2;
      return;
    }
    console.log(chalk.dim('--force set — applying despite the conflict above.'));
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
