// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import chalk from 'chalk';
import type { ScanArtifact, BillingSummary, ExtendedScanResults, InventoryItem, ServiceDependencyItem, ArchitectureResult } from '../types.js';
import { driftBar } from '../ui/bar.js';
import { titleBox, panelBox } from '../ui/box.js';

/**
 * Format a billable project-equivalent figure to at most 2 decimal places,
 * trimming trailing zeros (0.20 → "0.2", 1.50 → "1.5", 3.00 → "3", 0.24 → "0.24").
 * Sub-1 fractions therefore never collapse to "0".
 */
function formatBillable(value: number): string {
  return String(Number(value.toFixed(2)));
}

export interface FormatTextOptions {
  /**
   * True when the scan ran without a Vibgrate workspace DSN (the free, local
   * path). Drives the "Keep tracking your DriftScore" upsell panel. Defaults
   * to false so callers that don't know the auth state never surface it.
   */
  free?: boolean;
}

export function formatText(artifact: ScanArtifact, opts: FormatTextOptions = {}): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(...titleBox('Vibgrate Drift Report'));
  lines.push('');

  // Per-project
  for (const project of artifact.projects) {
    lines.push(chalk.bold(`  ── ${project.name} `) + chalk.dim(`(${project.type}) ${project.path}`));

    if (project.runtime) {
      const behindStr = project.runtimeMajorsBehind !== undefined && project.runtimeMajorsBehind > 0
        ? chalk.yellow(` (${project.runtimeMajorsBehind} major${project.runtimeMajorsBehind > 1 ? 's' : ''} behind)`)
        : chalk.green(' (current)');
      lines.push(`     Runtime: ${project.runtime}${behindStr}`);
    }

    if (project.targetFramework) {
      lines.push(`     Target:  ${project.targetFramework}`);
    }

    if (project.frameworks.length > 0) {
      lines.push('     Frameworks:');
      for (const fw of project.frameworks) {
        const lag = fw.majorsBehind !== null
          ? (fw.majorsBehind === 0 ? chalk.green('current') : chalk.yellow(`${fw.majorsBehind} behind`))
          : chalk.dim('unknown');
        lines.push(`       ${fw.name}: ${fw.currentVersion ?? '?'} → ${fw.latestVersion ?? '?'} (${lag})`);
      }
    }

    // Dependency buckets
    const b = project.dependencyAgeBuckets;
    const total = b.current + b.oneBehind + b.twoPlusBehind + b.unknown;
    if (total > 0) {
      lines.push('     Dependencies:');
      lines.push(`       ${chalk.green(`${b.current} current`)}  ${chalk.yellow(`${b.oneBehind} 1-behind`)}  ${chalk.red(`${b.twoPlusBehind} 2+ behind`)}  ${chalk.dim(`${b.unknown} unknown`)}`);
    }

    lines.push('');
  }

  if (artifact.delta !== undefined) {
    // Drift is "lower is better": a negative delta means drift fell (good),
    // a positive delta means drift rose (bad).
    const deltaStr = artifact.delta < 0
      ? chalk.green(`${artifact.delta}`)
      : artifact.delta > 0
        ? chalk.red(`+${artifact.delta}`)
        : chalk.dim('0');
    lines.push(chalk.bold('  Drift Delta: ') + deltaStr + ' (vs baseline)');
    lines.push('');
  }

  // Extended scan results
  if (artifact.extended) {
    lines.push(...formatExtended(artifact.extended));
  }

  // Findings
  if (artifact.findings.length > 0) {
    const errors = artifact.findings.filter((f) => f.level === 'error');
    const warnings = artifact.findings.filter((f) => f.level === 'warning');
    const notes = artifact.findings.filter((f) => f.level === 'note');
    const summary = [
      errors.length > 0 ? chalk.red(`${errors.length} error${errors.length !== 1 ? 's' : ''}`) : '',
      warnings.length > 0 ? chalk.yellow(`${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`) : '',
      notes.length > 0 ? chalk.blue(`${notes.length} note${notes.length !== 1 ? 's' : ''}`) : '',
    ].filter(Boolean).join(chalk.dim(', '));

    lines.push(chalk.bold.underline(`  Findings`) + chalk.dim(` (${summary})`));
    for (const f of artifact.findings) {
      const icon = f.level === 'error' ? chalk.red('✖') : f.level === 'warning' ? chalk.yellow('⚠') : chalk.blue('ℹ');
      lines.push(`    ${icon} ${f.message}`);
      lines.push(chalk.dim(`      ${f.ruleId} in ${f.location}`));
    }
    lines.push('');
  }

  // Priority actions
  const actions = generatePriorityActions(artifact);
  if (actions.length > 0) {
    lines.push(...titleBox('Top Priority Actions'));
    lines.push('');
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      const num = chalk.bold.cyan(`  ${i + 1}.`);
      lines.push(`${num} ${chalk.bold(a.title)}`);
      lines.push(chalk.dim(`     ${a.explanation}`));
      if (a.impact) lines.push(`     Impact: ${chalk.green(a.impact)}`);
      lines.push('');
    }
  }

  // Architecture Layers (just above drift summary)
  if (artifact.extended?.architecture) {
    lines.push(...formatArchitectureDiagram(artifact.extended.architecture));
  }

  // NOTE: Mermaid diagrams (relationshipDiagram) are intentionally not rendered in CLI output.
  // They are still included in JSON output for dashboard/API consumption.

  if (artifact.solutions && artifact.solutions.length > 0) {
    lines.push(...titleBox('Solution Drift Summary'));
    lines.push('');
    for (const solution of artifact.solutions) {
      const solScore = solution.drift?.score;
      const color = typeof solScore === 'number' ? (solScore <= 30 ? chalk.green : solScore <= 60 ? chalk.yellow : chalk.red) : chalk.dim;
      lines.push(`  • ${solution.name} (${solution.projectPaths.length} projects) — ${typeof solScore === 'number' ? color(`${solScore}/100`) : chalk.dim('n/a')}`);
    }
    lines.push('');
  }

  // Score summary
  const scoreColor = artifact.drift.score <= 30 ? chalk.green :
    artifact.drift.score <= 60 ? chalk.yellow : chalk.red;

  lines.push(...titleBox('Drift Score Summary'));
  lines.push('');
  lines.push(chalk.bold('  Drift Score:  ') + scoreColor.bold(`${artifact.drift.score}/100`));
  lines.push(chalk.bold('  Risk Level:   ') + riskBadge(artifact.drift.riskLevel));
  lines.push(chalk.bold('  Projects:     ') + `${artifact.projects.length}`);

  // Project classification breakdown + billable projects ("micro-project pricing").
  // Billing is a commercial signal attached by the full scan; the open base scan omits it.
  const billing = artifact.billing;
  if (billing) {
    // Show each size's billable *contribution* (count ÷ its ratio) to 1–2 dp, and
    // the repository total to 1–2 dp — not the floored integer. A single scan can
    // bill a fraction (e.g. 2 micro projects → 0.2); flooring it to "0" would
    // wrongly read as free, when those fractions add up across repositories and
    // are only rounded down after the whole estate is summed.
    const parts: string[] = [];
    if (billing.standardCount > 0)
      parts.push(`${chalk.cyan(formatBillable(billing.standardCount))} standard`);
    if (billing.smallCount > 0)
      parts.push(`${chalk.cyan(formatBillable(billing.smallCount / billing.smallBillingRatio))} small`);
    if (billing.microCount > 0)
      parts.push(`${chalk.cyan(formatBillable(billing.microCount / billing.microBillingRatio))} micro`);
    if (billing.nanoCount > 0)
      parts.push(`${chalk.cyan(formatBillable(billing.nanoCount / billing.nanoBillingRatio))} nano`);

    lines.push(
      chalk.bold('  Classified:   ') +
        `${chalk.cyan(billing.nanoCount)} nano · ${chalk.cyan(billing.microCount)} micro · ${chalk.cyan(billing.smallCount)} small · ${chalk.cyan(billing.standardCount)} standard`,
    );
    const raw = formatBillable(billing.billableProjectsRaw);
    lines.push(
      chalk.bold('  Billable:     ') +
        chalk.bold.white(raw) +
        chalk.dim(
          ` · ${billing.totalScanned} detected → ${raw} billable project${billing.billableProjectsRaw === 1 ? '' : 's'} (micro-project pricing)`,
        ),
    );
    if (parts.length > 0) {
      lines.push(chalk.dim('                ') + parts.join(chalk.dim(' · ')));
    }
    // When the total is fractional, make the "not free" point explicit.
    if (billing.billableProjectsRaw !== Math.floor(billing.billableProjectsRaw)) {
      lines.push(
        chalk.dim('                These fractions add up across repositories, then round down to whole billable projects.'),
      );
    }
  }

  if (artifact.vcs) {
    const vcsParts: string[] = [artifact.vcs.type];
    if (artifact.vcs.branch) vcsParts.push(artifact.vcs.branch);
    if (artifact.vcs.shortSha) vcsParts.push(chalk.dim(artifact.vcs.shortSha));
    lines.push(chalk.bold('  VCS:          ') + vcsParts.join(' '));
  }

  lines.push('');

  // Score breakdown
  const m = new Set(artifact.drift.measured ?? ['runtime', 'framework', 'dependency', 'eol']);
  lines.push('  ' + chalk.bold.underline('Score Breakdown'));
  lines.push(`    Runtime:      ${m.has('runtime') ? scoreBar(artifact.drift.components.runtimeScore) : chalk.dim('n/a')}`);
  lines.push(`    Frameworks:   ${m.has('framework') ? scoreBar(artifact.drift.components.frameworkScore) : chalk.dim('n/a')}`);
  lines.push(`    Dependencies: ${m.has('dependency') ? scoreBar(artifact.drift.components.dependencyScore) : chalk.dim('n/a')}`);
  lines.push(`    EOL Risk:     ${m.has('eol') ? scoreBar(artifact.drift.components.eolScore) : chalk.dim('n/a')}`);
  lines.push('');

  const scannedParts: string[] = [`Scanned at ${artifact.timestamp}`];
  if (artifact.durationMs !== undefined) {
    const secs = (artifact.durationMs / 1000).toFixed(1);
    scannedParts.push(`${secs}s`);
  }
  if (artifact.filesScanned !== undefined) {
    scannedParts.push(`${artifact.filesScanned} file${artifact.filesScanned !== 1 ? 's' : ''} scanned`);
  }
  if (artifact.treeSummary) {
    scannedParts.push(`${artifact.treeSummary.totalFiles.toLocaleString()} workspace files`);
    scannedParts.push(`${artifact.treeSummary.totalDirs.toLocaleString()} dirs`);
  }
  lines.push(chalk.dim(`  ${scannedParts.join(' · ')}`));
  lines.push('');

  // Free-plan upsell: only when the user has no workspace DSN (they scanned
  // locally) and this scan produced a billing roll-up to price against.
  if (opts.free && artifact.billing) {
    lines.push(...renderUpsellPanel(artifact.billing));
    lines.push('');
  }

  return lines.join('\n');
}

// ── Free-plan upsell ("Keep tracking your DriftScore") ──

// Banded, per-billable-project monthly rates, mirrored from the public pricing
// page (packages/vibgrate-website/components/PricingPage.tsx). The marginal
// rate drops as an estate grows; a single repo's billable projects sit in the
// first band. Keep these in sync with the pricing page and llms.txt.
const PRICE_EDGES = [0, 25, 100, 300, 500];
const PRICE_RATES = {
  team: [6, 5, 4, 3.5],
  business: [15, 12, 10, 8],
};

/** Monthly cost for `billableProjects` under a banded rate table. */
function estimateMonthly(billableProjects: number, rates: number[]): number {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const lo = PRICE_EDGES[i];
    const hi = i === 3 ? Infinity : PRICE_EDGES[i + 1];
    if (billableProjects > lo) {
      total += (Math.min(billableProjects, hi) - lo) * rates[i];
    }
  }
  // Round to whole cents to avoid binary-float noise (e.g. 0.1 * 3 = 0.30000004).
  return Math.round(total * 100) / 100;
}

/** Whole dollars when integral, otherwise two decimal places. */
function formatMoney(value: number): string {
  return value === Math.floor(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

/** The teal call-out panel shown to free (no-DSN) users after a scan. */
function renderUpsellPanel(billing: BillingSummary): string[] {
  const raw = billing.billableProjectsRaw;
  const team = estimateMonthly(raw, PRICE_RATES.team);
  const business = estimateMonthly(raw, PRICE_RATES.business);
  const rawLabel = formatBillable(raw);

  const body = [
    `You're on Vibgrate Free — this scan ran locally and`,
    `isn't tracked over time.`,
    ``,
    chalk.bold(`Tracked monthly on Vibgrate Cloud, this repo would cost:`),
    `  ${chalk.bold('Team')}       ${chalk.bold.white(formatMoney(team))} / mo`,
    `  ${chalk.bold('Business')}   ${chalk.bold.white(formatMoney(business))} / mo`,
    chalk.dim(`  (${rawLabel} billable project${raw === 1 ? '' : 's'}, banded per-project pricing)`),
    ``,
    chalk.bold(`Vibgrate Cloud adds:`),
    `  ${chalk.cyan('•')} DriftScore tracked over time — trends, not snapshots`,
    `  ${chalk.cyan('•')} Scheduled scans that run automatically — no CI wiring`,
    `  ${chalk.cyan('•')} Alerts when drift crosses the budget you set`,
    ``,
    chalk.dim(`Free forever: 1 repository, 5 pushed scans / month.`),
    `${chalk.bold('Start tracking:')}  ${chalk.cyan('vg login')}  →  ${chalk.cyan('vg push')}`,
  ];

  // Brand teal (#3FB0A4) border so the panel stands out from the cyan report boxes.
  return panelBox('KEEP TRACKING YOUR DRIFTSCORE', body, chalk.hex('#3FB0A4'), 60);
}

function riskBadge(level: string): string {
  switch (level) {
    case 'low': return chalk.bgGreen.black(' LOW ');
    case 'moderate': return chalk.bgYellow.black(' MODERATE ');
    case 'high': return chalk.bgRed.white(' HIGH ');
    default: return level;
  }
}

function scoreBar(score: number): string {
  // Drift bar: the fill shows how much drift exists (0 = empty/best, 100 = full/worst).
  // Sub-cell gradient fill (green → the score's own risk colour) for a smoother read.
  return driftBar(score, 20);
}

// ── Extended results summary ──

const CATEGORY_LABELS: Record<string, string> = {
  frontend: 'Frontend',
  metaFrameworks: 'Meta-frameworks',
  bundlers: 'Bundlers',
  css: 'CSS / UI',
  backend: 'Backend',
  orm: 'ORM / Database',
  testing: 'Testing',
  lintFormat: 'Lint & Format',
  apiMessaging: 'API & Messaging',
  observability: 'Observability',
  payment: 'Payment',
  auth: 'Auth',
  email: 'Email',
  cloud: 'Cloud',
  databases: 'Databases',
  messaging: 'Messaging',
  crm: 'CRM & Comms',
  storage: 'Storage',
  search: 'Search & AI',
};

function formatExtended(ext: ExtendedScanResults): string[] {
  const lines: string[] = [];

  // ── Tooling Inventory ──
  if (ext.toolingInventory) {
    const inv = ext.toolingInventory;
    const categories = Object.entries(inv).filter(([, items]) => items.length > 0);
    if (categories.length > 0) {
      lines.push(chalk.bold.underline('  Tech Stack'));
      for (const [cat, items] of categories) {
        const label = CATEGORY_LABELS[cat] ?? cat;
        const names = (items as InventoryItem[]).map((i: InventoryItem) => chalk.white(i.name)).join(chalk.dim(', '));
        lines.push(`    ${chalk.cyan(label)}: ${names}`);
      }
      lines.push('');
    }
  }

  // ── Service Dependencies ──
  if (ext.serviceDependencies) {
    const svc = ext.serviceDependencies;
    const categories = Object.entries(svc).filter(([, items]) => items.length > 0);
    if (categories.length > 0) {
      lines.push(chalk.bold.underline('  Services & Integrations'));
      for (const [cat, items] of categories) {
        const label = CATEGORY_LABELS[cat] ?? cat;
        const names = (items as ServiceDependencyItem[]).map((i: ServiceDependencyItem) => {
          const ver = i.version ? chalk.dim(` ${i.version}`) : '';
          return chalk.white(i.name) + ver;
        }).join(chalk.dim(', '));
        lines.push(`    ${chalk.cyan(label)}: ${names}`);
      }
      lines.push('');
    }
  }

  // ── Breaking Change Exposure ──
  if (ext.breakingChangeExposure) {
    const bc = ext.breakingChangeExposure;
    if (bc.deprecatedPackages.length > 0 || bc.legacyPolyfills.length > 0) {
      lines.push(chalk.bold.underline('  Breaking Change Exposure'));

      const exposureColor = bc.exposureScore >= 40 ? chalk.red :
        bc.exposureScore >= 20 ? chalk.yellow : chalk.green;
      lines.push(`    Exposure Score: ${exposureColor.bold(`${bc.exposureScore}/100`)}`);

      if (bc.deprecatedPackages.length > 0) {
        lines.push(`    ${chalk.red('Deprecated')}: ${bc.deprecatedPackages.map((p) => chalk.dim(p)).join(', ')}`);
      }
      if (bc.legacyPolyfills.length > 0) {
        lines.push(`    ${chalk.yellow('Polyfills')}: ${bc.legacyPolyfills.map((p) => chalk.dim(p)).join(', ')}`);
      }
      if (bc.peerConflictsDetected) {
        lines.push(`    ${chalk.red('⚠')} Peer dependency conflicts detected`);
      }
      lines.push(`    Recommendation: ${chalk.bold(bc.overallRecommendation)}`);

      const projectsWithPlans = bc.projectIntelligence.filter((p) => p.packages.length > 0).slice(0, 3);
      if (projectsWithPlans.length > 0) {
        lines.push('    Major Upgrade Intelligence:');
        for (const p of projectsWithPlans) {
          lines.push(`      - ${p.project} (${p.recommendation})`);
          for (const pkg of p.packages.slice(0, 2)) {
            lines.push(`        · ${pkg.package} ${pkg.currentVersion ?? '?'} → ${pkg.targetVersion ?? '?'} | touched ~${pkg.usage.touchedPercent}% | ${pkg.automatable}`);
          }
        }
      }
      lines.push('');
    }
  }

  // ── TypeScript Modernity ──
  if (ext.tsModernity && ext.tsModernity.typescriptVersion) {
    const ts = ext.tsModernity;
    lines.push(chalk.bold.underline('  TypeScript'));
    const parts: string[] = [];
    parts.push(`v${ts.typescriptVersion}`);
    if (ts.strict === true) parts.push(chalk.green('strict ✔'));
    else if (ts.strict === false) parts.push(chalk.yellow('strict ✖'));
    if (ts.moduleType) parts.push(ts.moduleType.toUpperCase());
    if (ts.target) parts.push(`target: ${ts.target}`);
    lines.push(`    ${parts.join(chalk.dim(' · '))}`);
    lines.push('');
  }

  // ── Build & Deploy ──
  if (ext.buildDeploy) {
    const bd = ext.buildDeploy;
    const hasSomething = bd.ci.length > 0 || bd.docker.dockerfileCount > 0 || bd.packageManagers.length > 0;
    if (hasSomething) {
      lines.push(chalk.bold.underline('  Build & Deploy'));
      if (bd.ci.length > 0) lines.push(`    CI: ${bd.ci.join(', ')}`);
      if (bd.docker.dockerfileCount > 0) {
        lines.push(`    Docker: ${bd.docker.dockerfileCount} Dockerfile${bd.docker.dockerfileCount !== 1 ? 's' : ''} (${bd.docker.baseImages.join(', ')})`);
      }
      if (bd.packageManagers.length > 0) lines.push(`    Package Managers: ${bd.packageManagers.join(', ')}`);
      if (bd.monorepoTools.length > 0) lines.push(`    Monorepo: ${bd.monorepoTools.join(', ')}`);
      if (bd.iac.length > 0) lines.push(`    IaC: ${bd.iac.join(', ')}`);
      lines.push('');
    }
  }



  // ── Product Purpose Evidence ──
  if (ext.uiPurpose) {
    const up = ext.uiPurpose;
    lines.push(chalk.bold.underline('  Product Purpose Signals'));
    lines.push(`    Frameworks: ${up.detectedFrameworks.length > 0 ? up.detectedFrameworks.join(', ') : chalk.dim('unknown')}`);
    lines.push(`    Evidence: ${up.topEvidence.length}${up.capped ? chalk.dim(` of ${up.evidenceCount} (capped)`) : ''}`);

    const top = up.topEvidence.slice(0, 8);
    if (top.length > 0) {
      lines.push('    Top Signals:');
      for (const item of top) {
        lines.push(`      - [${item.kind}] ${item.value} ${chalk.dim(`(${item.file})`)}`);
      }
    }

    if (up.unknownSignals.length > 0) {
      lines.push('    Unknowns:');
      for (const u of up.unknownSignals.slice(0, 4)) {
        lines.push(`      - ${chalk.yellow(u)}`);
      }
    }

    lines.push('');
  }

  // ── Security Posture (compact) ──
  if (ext.securityPosture) {
    const sec = ext.securityPosture;
    lines.push(chalk.bold.underline('  Security Posture'));
    const checks: string[] = [];
    checks.push(sec.lockfilePresent ? chalk.green('Lockfile ✔') : chalk.red('Lockfile ✖'));
    checks.push(sec.gitignoreCoversEnv ? chalk.green('.env ✔') : chalk.red('.env ✖'));
    checks.push(sec.gitignoreCoversNodeModules ? chalk.green('node_modules ✔') : chalk.yellow('node_modules ✖'));
    if (sec.multipleLockfileTypes) checks.push(chalk.yellow('Multiple lockfiles ⚠'));
    if (sec.envFilesTracked) checks.push(chalk.red('Env files tracked ✖'));
    lines.push(`    ${checks.join(chalk.dim(' · '))}`);
    lines.push('');
  }
  // ── Platform Matrix (compact) ──
  if (ext.platformMatrix) {
    const pm = ext.platformMatrix;
    if (pm.nativeModules.length > 0 || pm.dockerBaseImages.length > 0) {
      lines.push(chalk.bold.underline('  Platform'));
      if (pm.nativeModules.length > 0) {
        lines.push(`    Native modules: ${pm.nativeModules.map((m) => chalk.dim(m)).join(', ')}`);
      }
      if (pm.osAssumptions.length > 0) {
        lines.push(`    OS assumptions: ${pm.osAssumptions.join(', ')}`);
      }
      lines.push('');
    }
  }


  // ── Code Quality (compact) ──
  if (ext.codeQuality) {
    const cq = ext.codeQuality;
    lines.push(chalk.bold.underline('  Code Quality'));
    lines.push(`    Files: ${chalk.white(`${cq.filesAnalyzed}`)} · Functions: ${chalk.white(`${cq.functionsAnalyzed}`)} · Avg complexity: ${chalk.white(`${cq.avgCyclomaticComplexity}`)} · Avg length: ${chalk.white(`${cq.avgFunctionLength}`)} lines`);
    lines.push(`    Max nesting: ${cq.maxNestingDepth} · Circular deps: ${cq.circularDependencies} · Dead code: ${cq.deadCodePercent}%`);
    if (cq.godFiles.length > 0) {
      const preview = cq.godFiles.slice(0, 3).map((f) => `${f.path} (${f.lines} lines)`).join(', ');
      lines.push(`    ${chalk.yellow('God files')}: ${preview}`);
    }
    lines.push('');
  }
  // ── Dependency Graph (compact) ──
  if (ext.dependencyGraph) {
    const dg = ext.dependencyGraph;
    if (dg.lockfileType) {
      lines.push(chalk.bold.underline('  Dependency Graph'));
      lines.push(`    ${dg.lockfileType}: ${chalk.white(`${dg.totalUnique}`)} unique, ${chalk.white(`${dg.totalInstalled}`)} installed`);
      if (dg.duplicatedPackages.length > 0) {
        lines.push(`    ${chalk.yellow(`${dg.duplicatedPackages.length} duplicated`)} packages`);
      }
      if (dg.phantomDependencies.length > 0) {
        lines.push(`    ${chalk.red(`${dg.phantomDependencies.length} phantom`)} dependencies`);
      }
      lines.push('');
    }
  }

  return lines;
}

// ── Architecture layer diagram ──

interface PriorityAction {
  title: string;
  explanation: string;
  impact?: string;
  severity: number;
}

function formatArchitectureDiagram(arch: ArchitectureResult): string[] {
  const lines: string[] = [];
  lines.push(...titleBox('Architecture Layers'));
  lines.push('');
  lines.push(chalk.bold('  Archetype: ') + `${arch.archetype}` + chalk.dim(` (${Math.round(arch.archetypeConfidence * 100)}% confidence)`));
  lines.push(`  Files classified: ${arch.totalClassified}` + (arch.unclassified > 0 ? chalk.dim(` (${arch.unclassified} unclassified)`) : ''));
  lines.push('');
  if (arch.layers.length > 0) {
    for (const layer of arch.layers) {
      const risk = layer.riskLevel === 'none' ? chalk.dim('none') : layer.riskLevel === 'low' ? chalk.green('low') : layer.riskLevel === 'moderate' ? chalk.yellow('moderate') : chalk.red('high');
      lines.push(`    ${chalk.bold(layer.layer)}  ${layer.fileCount} file${layer.fileCount !== 1 ? 's' : ''}  drift ${scoreBar(layer.driftScore)}  risk ${risk}`);
    }
    lines.push('');
  }
  return lines;
}

function generatePriorityActions(artifact: ScanArtifact): PriorityAction[] {
  const actions: PriorityAction[] = [];

  // 1. EOL runtimes (highest priority)
  const eolProjects = artifact.projects.filter(
    (p) => p.runtimeMajorsBehind !== undefined && p.runtimeMajorsBehind >= 3,
  );
  if (eolProjects.length > 0) {
    const names = eolProjects.map((p) => p.name).join(', ');
    let detail = `End-of-life runtimes no longer receive security patches and block ecosystem upgrades.`;
    const fileLines: string[] = [];
    for (const p of eolProjects) {
      fileLines.push(`\n     ./${p.path}`);
      fileLines.push(`\n       ${p.runtime} → ${p.runtimeLatest} (${p.runtimeMajorsBehind} major${p.runtimeMajorsBehind! > 1 ? 's' : ''} behind)`);
    }
    detail += fileLines.join('');
    actions.push({
      title: `Upgrade EOL runtime${eolProjects.length > 1 ? 's' : ''} in ${names}`,
      explanation: detail,
      impact: `−${Math.min(eolProjects.length * 10, 30)} drift points (runtime & EOL)`,
      severity: 100,
    });
  }

  // 2. Severely outdated frameworks (3+ majors behind)
  const severeFrameworks: { name: string; fw: string; behind: number; project: string; projectPath: string }[] = [];
  for (const p of artifact.projects) {
    for (const fw of p.frameworks) {
      if (fw.majorsBehind !== null && fw.majorsBehind >= 3) {
        severeFrameworks.push({ name: fw.name, fw: `${fw.currentVersion} → ${fw.latestVersion}`, behind: fw.majorsBehind, project: p.name, projectPath: p.path });
      }
    }
  }
  if (severeFrameworks.length > 0) {
    const worst = severeFrameworks.sort((a, b) => b.behind - a.behind)[0];
    const others = severeFrameworks.length > 1 ? ` (+${severeFrameworks.length - 1} more)` : '';
    let detail = `${worst.behind} major versions behind. Major framework drift increases breaking change risk and blocks access to security fixes and performance improvements.`;
    const fileLines: string[] = [];
    let shown = 0;
    for (const sf of severeFrameworks) {
      if (shown >= 8) break;
      fileLines.push(`\n     ./${sf.projectPath}`);
      fileLines.push(`\n       ${sf.name}: ${sf.fw} (${sf.behind} major${sf.behind > 1 ? 's' : ''} behind)`);
      shown++;
    }
    const remaining = severeFrameworks.length - shown;
    detail += fileLines.join('');
    if (remaining > 0) detail += `\n     ... and ${remaining} more`;
    actions.push({
      title: `Upgrade ${worst.name} ${worst.fw} in ${worst.project}${others}`,
      explanation: detail,
      impact: `−5–15 drift points`,
      severity: 90,
    });
  }

  // 3. High dependency rot (>40% 2+ behind)
  for (const p of artifact.projects) {
    const b = p.dependencyAgeBuckets;
    const total = b.current + b.oneBehind + b.twoPlusBehind;
    if (total === 0) continue;
    const twoPlusPct = Math.round((b.twoPlusBehind / total) * 100);
    if (twoPlusPct >= 40) {
      let detail = `${b.twoPlusBehind} of ${total} dependencies are 2+ majors behind. Run \`npm outdated\` and prioritise packages with known CVEs or breaking API changes.`;

      // Show the worst offenders with file paths and versions
      const worstDeps = p.dependencies
        .filter((d) => d.majorsBehind !== null && d.majorsBehind >= 2)
        .sort((a, b2) => (b2.majorsBehind ?? 0) - (a.majorsBehind ?? 0));
      if (worstDeps.length > 0) {
        const depLines: string[] = [];
        let shown = 0;
        depLines.push(`\n     ./${p.path}`);
        for (const dep of worstDeps) {
          if (shown >= 8) break;
          const current = dep.resolvedVersion ?? dep.currentSpec;
          const latest = dep.latestStable ?? '?';
          depLines.push(`\n       ${dep.package}: ${current} → ${latest} (${dep.majorsBehind} major${dep.majorsBehind! > 1 ? 's' : ''} behind)`);
          shown++;
        }
        const remaining = worstDeps.length - shown;
        detail += depLines.join('');
        if (remaining > 0) detail += `\n     ... and ${remaining} more`;
      }

      actions.push({
        title: `Reduce dependency rot in ${p.name} (${twoPlusPct}% severely outdated)`,
        explanation: detail,
        impact: `−5–10 drift points`,
        severity: 80 + twoPlusPct / 10,
      });
    }
  }

  // 4. Framework 2 majors behind (important but not critical)
  const twoMajorFrameworks: { name: string; project: string; projectPath: string; fw: string }[] = [];
  for (const p of artifact.projects) {
    for (const fw of p.frameworks) {
      if (fw.majorsBehind === 2) {
        twoMajorFrameworks.push({ name: fw.name, project: p.name, projectPath: p.path, fw: `${fw.currentVersion} → ${fw.latestVersion}` });
      }
    }
  }
  // Deduplicate by framework name (same framework across projects)
  const uniqueTwo = [...new Map(twoMajorFrameworks.map((f) => [f.name, f])).values()];
  if (uniqueTwo.length > 0) {
    const list = uniqueTwo.slice(0, 3).map((f) => `${f.name} (${f.fw})`).join(', ');
    const moreCount = uniqueTwo.length > 3 ? ` +${uniqueTwo.length - 3} more` : '';
    let detail = `These frameworks are 2 major versions behind. Create upgrade tickets and check migration guides — the gap will widen with each new release.`;
    const fileLines: string[] = [];
    let shown = 0;
    for (const tf of twoMajorFrameworks) {
      if (shown >= 8) break;
      fileLines.push(`\n     ./${tf.projectPath}`);
      fileLines.push(`\n       ${tf.name}: ${tf.fw}`);
      shown++;
    }
    const remaining = twoMajorFrameworks.length - shown;
    detail += fileLines.join('');
    if (remaining > 0) detail += `\n     ... and ${remaining} more`;
    actions.push({
      title: `Plan major framework upgrades: ${list}${moreCount}`,
      explanation: detail,
      impact: `−5–10 drift points`,
      severity: 60,
    });
  }

  // 5. Breaking change exposure
  if (artifact.extended?.breakingChangeExposure) {
    const bc = artifact.extended.breakingChangeExposure;
    const total = bc.deprecatedPackages.length + bc.legacyPolyfills.length;
    if (total > 0) {
      const items = [...bc.deprecatedPackages, ...bc.legacyPolyfills].slice(0, 5).join(', ');
      const moreCount = total > 5 ? ` +${total - 5} more` : '';
      let detail = `${total} package${total !== 1 ? 's' : ''} are deprecated or legacy polyfills. These receive no updates and may have known vulnerabilities.`;

      // Map deprecated/polyfill packages back to projects with versions
      const allPkgNames = new Set([...bc.deprecatedPackages, ...bc.legacyPolyfills]);
      const fileLines: string[] = [];
      let shown = 0;
      for (const p of artifact.projects) {
        const matches = p.dependencies.filter((d) => allPkgNames.has(d.package));
        if (matches.length === 0) continue;
        if (shown >= 10) break;
        fileLines.push(`\n     ./${p.path}`);
        for (const dep of matches) {
          if (shown >= 10) break;
          const ver = dep.resolvedVersion ?? dep.currentSpec;
          const label = bc.deprecatedPackages.includes(dep.package) ? 'deprecated' : 'polyfill';
          fileLines.push(`\n       ${dep.package}: ${ver} (${label})`);
          shown++;
        }
      }
      const remaining = total - shown;
      detail += fileLines.join('');
      if (remaining > 0) detail += `\n     ... and ${remaining} more`;

      actions.push({
        title: `Replace deprecated/legacy packages: ${items}${moreCount}`,
        explanation: detail,
        severity: 55,
      });
    }
  }

  // 6. Phantom dependencies
  if (artifact.extended?.dependencyGraph) {
    const dg = artifact.extended.dependencyGraph;
    const phantomCount = dg.phantomDependencies.length;
    if (phantomCount >= 10) {
      let detail = `Packages used in code but not declared in package.json. These rely on transitive installs and can break unpredictably when other packages update.`;

      // Build per-project breakdown from details if available
      const details = dg.phantomDependencyDetails;
      if (details && details.length > 0) {
        // Group by sourcePath
        const byPath = new Map<string, { package: string; spec: string }[]>();
        for (const d of details) {
          if (!byPath.has(d.sourcePath)) byPath.set(d.sourcePath, []);
          byPath.get(d.sourcePath)!.push({ package: d.package, spec: d.spec });
        }
        const pathLines: string[] = [];
        let shown = 0;
        for (const [srcPath, pkgs] of byPath) {
          if (shown >= 10) break;
          pathLines.push(`\n     ./${srcPath}`);
          for (const pkg of pkgs) {
            if (shown >= 10) break;
            pathLines.push(`\n       ${pkg.package}: ${pkg.spec}`);
            shown++;
          }
        }
        const remaining = phantomCount - shown;
        detail += pathLines.join('');
        if (remaining > 0) detail += `\n     ... and ${remaining} more`;
      }

      actions.push({
        title: `Fix ${phantomCount} phantom dependencies`,
        explanation: detail,
        severity: 45,
      });
    }
  }

  // 7. Security posture issues
  if (artifact.extended?.securityPosture) {
    const sec = artifact.extended.securityPosture;
    if (sec.envFilesTracked || !sec.lockfilePresent) {
      const issues: string[] = [];
      if (sec.envFilesTracked) issues.push('.env files are tracked in git');
      if (!sec.lockfilePresent) issues.push('no lockfile found');
      let detail: string;
      if (sec.envFilesTracked) {
        detail = 'Environment files may contain secrets. Add them to .gitignore and rotate any exposed credentials immediately.';
        detail += '\n     ./.gitignore';
        detail += '\n       Add: .env, .env.*, .env.local';
      } else {
        detail = 'Without a lockfile, installs are non-deterministic. Run the install command to generate one and commit it.';
        detail += '\n     ./';
        detail += `\n       Missing: ${sec.lockfileTypes.length > 0 ? sec.lockfileTypes.join(', ') + ' (multiple types detected)' : 'package-lock.json, pnpm-lock.yaml, or yarn.lock'}`;
      }
      actions.push({
        title: `Fix security posture: ${issues.join(', ')}`,
        explanation: detail,
        severity: 95,
      });
    }
  }

  // 8. Duplicate packages in dependency graph
  if (artifact.extended?.dependencyGraph) {
    const dupes = artifact.extended.dependencyGraph.duplicatedPackages;
    const highImpactDupes = dupes.filter((d) => d.versions.length >= 3);
    if (highImpactDupes.length >= 3) {
      let detail = `${highImpactDupes.length} packages have 3+ versions installed. Run \`npm dedupe\` to reduce bundle size and install time.`;
      const dupeLines: string[] = [];
      let shown = 0;
      for (const d of highImpactDupes) {
        if (shown >= 8) break;
        dupeLines.push(`\n       ${d.name}: ${d.versions.join(', ')} (${d.consumers} consumer${d.consumers !== 1 ? 's' : ''})`);
        shown++;
      }
      const remaining = highImpactDupes.length - shown;
      detail += dupeLines.join('');
      if (remaining > 0) detail += `\n     ... and ${remaining} more`;
      actions.push({
        title: `Deduplicate heavily-versioned packages`,
        explanation: detail,
        severity: 35,
      });
    }
  }

  // Sort by severity (most urgent first) and take top 5
  actions.sort((a, b) => b.severity - a.severity);
  return actions.slice(0, 5);
}
