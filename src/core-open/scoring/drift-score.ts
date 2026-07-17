// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as crypto from 'node:crypto';
import type { ProjectScan, DriftScore, Finding, RiskLevel, VibgrateConfig } from '../types.js';
import { aggregateDependencyDrift } from './dependency-drift-v3.js';

/**
 * Version of the drift-score methodology (weighting + formula). Bump this ONLY
 * when the weighting or calculation changes — never for routine CLI releases —
 * so the dashboard can tell whether two scores are directly comparable and avoid
 * drawing trend lines across a methodology change.
 *
 * driftscore-3.0 (DRIFTSCORE-V3-SPEC): the dependency pillar is the
 * libyear-backbone blend — time-distance primary (0.55·T), semver-distance
 * fallback (0.45·V) — with the four production data-quality guards and p95 tail
 * aggregation (0.5·mean + 0.3·p95 + 0.2·unsupported_share). The former
 * standalone freshness add-on (0.15) is folded into it, so the pillar weighting
 * returns to the four-pillar shape (runtime .25 / framework .25 / dependency
 * .30 / EOL .20). See `dependency-drift-v3.ts`.
 *
 * Not yet threaded (spec §6.1, follow-up): per-dependency unsupported/EOL and
 * abandoned signals that fire the ≥70 / ≥50 floors, and transitive weighting
 * from the lockfile graph — manifest deps default to direct until then.
 */
export const DRIFT_SCORE_METHODOLOGY_VERSION = 'driftscore-3.0';

/** Default thresholds per PRD section 15 */
const DEFAULT_THRESHOLDS: Required<NonNullable<VibgrateConfig['thresholds']>> = {
  failOnError: {
    eolDays: 180,
    frameworkMajorLag: 3,
    dependencyTwoPlusPercent: 50,
  },
  warn: {
    frameworkMajorLag: 2,
    dependencyTwoPlusPercent: 30,
  },
};

// ── Score computation ──

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function runtimeScore(projects: ProjectScan[]): number | null {
  if (projects.length === 0) return null;

  const lags = projects
    .map((p) => p.runtimeMajorsBehind)
    .filter((v): v is number => v !== undefined);

  if (lags.length === 0) return null; // No runtime info — don't score

  const maxLag = Math.max(...lags);
  // 0 behind = 100, 1 = 80, 2 = 50, 3 = 20, 4+ = 0
  if (maxLag === 0) return 100;
  if (maxLag === 1) return 80;
  if (maxLag === 2) return 50;
  if (maxLag === 3) return 20;
  return 0;
}

function frameworkScore(projects: ProjectScan[]): number | null {
  const allFrameworks = projects.flatMap((p) => p.frameworks);
  if (allFrameworks.length === 0) return null;

  const lags = allFrameworks
    .map((f) => f.majorsBehind)
    .filter((v): v is number => v !== null);

  if (lags.length === 0) return null;

  const maxLag = Math.max(...lags);
  const avgLag = lags.reduce((a, b) => a + b, 0) / lags.length;

  // Blend max and average lag
  const maxPenalty = Math.min(maxLag * 20, 100);
  const avgPenalty = Math.min(avgLag * 15, 100);
  return clamp(100 - (maxPenalty * 0.6 + avgPenalty * 0.4), 0, 100);
}

const MONTH_MS = 1000 * 60 * 60 * 24 * 30;

function eolScore(projects: ProjectScan[]): number | null {
  // Score from real end-of-life dates (Runtime Catalog) when available, falling
  // back to the major-version-lag proxy when a runtime cycle can't be matched.
  const hasRuntimeData = projects.some(
    (p) => p.runtimeMajorsBehind !== undefined || (p.runtimeEol !== undefined && p.runtimeEol !== null),
  );
  if (!hasRuntimeData) return null; // No runtime info — don't score

  let score = 100;
  const now = Date.now();

  for (const p of projects) {
    // ── Real EOL (preferred) ──
    if (p.runtimeEol === true) {
      score = Math.min(score, 0); // past vendor end-of-life
      continue;
    }
    if (p.runtimeEol === false) {
      // Supported — graduated penalty as the real EOL date approaches.
      if (p.runtimeEolDate) {
        const remaining = Date.parse(p.runtimeEolDate) - now;
        if (!Number.isNaN(remaining)) {
          if (remaining <= 6 * MONTH_MS) score = Math.min(score, 40);
          else if (remaining <= 12 * MONTH_MS) score = Math.min(score, 75);
        }
      }
      continue;
    }

    // ── Lag-proxy fallback (runtimeEol unknown) ──
    if (p.type === 'node' && p.runtimeMajorsBehind !== undefined) {
      // Rough EOL proximity based on major version lag
      if (p.runtimeMajorsBehind >= 3) score = Math.min(score, 0);   // Definitely EOL
      else if (p.runtimeMajorsBehind >= 2) score = Math.min(score, 30); // Near EOL
      else if (p.runtimeMajorsBehind >= 1) score = Math.min(score, 70); // Approaching
    }
    if (p.type === 'dotnet' && p.runtimeMajorsBehind !== undefined) {
      if (p.runtimeMajorsBehind >= 3) score = Math.min(score, 0);
      else if (p.runtimeMajorsBehind >= 2) score = Math.min(score, 20);
      else if (p.runtimeMajorsBehind >= 1) score = Math.min(score, 60);
    }
    if (p.type === 'python' && p.runtimeMajorsBehind !== undefined) {
      // For Python, runtimeMajorsBehind counts minor versions (3.9 vs 3.13 = 4 behind)
      if (p.runtimeMajorsBehind >= 6) score = Math.min(score, 0);    // Very old (e.g. Python 2.x or 3.7)
      else if (p.runtimeMajorsBehind >= 4) score = Math.min(score, 20); // e.g. 3.9 when 3.13 is current
      else if (p.runtimeMajorsBehind >= 2) score = Math.min(score, 60); // e.g. 3.11 when 3.13 is current
    }
    if (p.type === 'java' && p.runtimeMajorsBehind !== undefined) {
      if (p.runtimeMajorsBehind >= 10) score = Math.min(score, 0);    // e.g. Java 8 or 11 when 21 is current
      else if (p.runtimeMajorsBehind >= 4) score = Math.min(score, 30); // e.g. Java 17 when 21 is current
      else if (p.runtimeMajorsBehind >= 1) score = Math.min(score, 70);
    }
  }

  return score;
}

/** Fraction of dependencies whose drift could be resolved (known vs unknown). */
function coverageConfidence(projects: ProjectScan[]): number | null {
  let known = 0;
  let unknown = 0;
  for (const p of projects) {
    known += p.dependencyAgeBuckets.current + p.dependencyAgeBuckets.oneBehind + p.dependencyAgeBuckets.twoPlusBehind;
    unknown += p.dependencyAgeBuckets.unknown;
  }
  const total = known + unknown;
  if (total === 0) return null;
  return Math.round((known / total) * 100) / 100;
}

/**
 * Compute the workspace DriftScore.
 *
 * Methodology `driftscore-2.0`: the score runs 0–100 where **0 means no drift
 * (fully current, best) and 100 means maximum drift (worst)** — i.e. higher is
 * worse, consistent with RiskScore and the "drift budget" mental model. Each
 * component is likewise reported as drift (0 = current). This inverts the
 * pre-2.0 convention where higher meant healthier.
 */
export function computeDriftScore(projects: ProjectScan[]): DriftScore {
  // driftscore-3.0 dependency pillar: the libyear-backbone per-dependency blend
  // (`dependency-drift-v3.ts`) with the p95 tail term. Computed once so its
  // provenance (`mode`) and detail (`p95`/`top`/…) can also be surfaced on the
  // score envelope (§6.3). Reported as a HEALTH score here (higher = fresher)
  // so it slots into the health-scale blend below, which inverts to drift at the
  // end. Replaces the driftscore-2.0 age-bucket formula, which counted
  // minor-behind as "current" and let one ancient dep average into invisibility.
  // The former standalone freshness pillar folds in here — the time term IS the
  // libyear signal.
  const depAgg = aggregateDependencyDrift(
    projects.flatMap((p) => p.dependencies),
    // Per-dependency context for the v3 floors: an unsupported/deprecated major
    // floors drift at 70, an abandoned ("no pulse") package at 50. Threaded from
    // the row where the ecosystem scanner set it; absent → the floor doesn't
    // fire (spec §6.1). Transitive weighting still awaits the lockfile graph, so
    // manifest deps default to direct.
    (dep) => ({ unsupported: dep.unsupported === true, abandoned: dep.abandoned === true }),
  );
  const rs = runtimeScore(projects);
  const fs = frameworkScore(projects);
  const ds = depAgg ? 100 - depAgg.drift : null;
  const es = eolScore(projects);

  // Weighted combination — redistribute weight from null (no-data) components.
  // driftscore-3.0 four-pillar weighting: freshness is no longer a separate
  // additive component — its libyear signal is the time term inside the
  // dependency pillar now (see `dependencyScore`).
  const components: { score: number | null; weight: number }[] = [
    { score: rs, weight: 0.25 },
    { score: fs, weight: 0.25 },
    { score: ds, weight: 0.30 },
    { score: es, weight: 0.20 },
  ];

  const confidence = coverageConfidence(projects) ?? undefined;

  // DriftScore v2 convention: 0 = no drift (best), 100 = maximum drift (worst).
  // Components are computed internally on a "health" scale (higher = healthier)
  // and inverted here so every emitted number reads as drift.
  const toDrift = (health: number) => 100 - health;

  const buildComponents = (): DriftScore['components'] => {
    const c: DriftScore['components'] = {
      runtimeScore: toDrift(Math.round(rs ?? 100)),
      frameworkScore: toDrift(Math.round(fs ?? 100)),
      dependencyScore: toDrift(Math.round(ds ?? 100)),
      eolScore: toDrift(Math.round(es ?? 100)),
    };
    return c;
  };

  // Score envelope (§6.3): the dependency pillar's provenance (`mode`) and its
  // v3 detail (`p95`/`unsupportedShare`/`coverage`/ranked `top`), for
  // explainability, the `~` branding, and the per-package breakdown. Present
  // only when there were scoreable dependencies.
  const envelope: Pick<DriftScore, 'mode' | 'dependencyDrift'> = depAgg
    ? {
        mode: depAgg.mode,
        dependencyDrift: {
          p95: depAgg.p95,
          unsupportedShare: depAgg.unsupportedShare,
          coverage: depAgg.coverage,
          top: depAgg.top.map((t) => ({
            package: t.package,
            drift: t.drift,
            mode: t.mode,
            unsupported: t.unsupported,
            flags: t.flags,
          })),
        },
      }
    : {};

  const active = components.filter((c) => c.score !== null);
  if (active.length === 0) {
    // No data at all — neutral score (no measurable drift)
    return {
      score: 0,
      riskLevel: 'low',
      components: buildComponents(),
      methodologyVersion: DRIFT_SCORE_METHODOLOGY_VERSION,
      ...(confidence !== undefined ? { confidence } : {}),
      ...envelope,
    };
  }

  // Redistribute weight proportionally across components that have data
  const totalActiveWeight = active.reduce((sum, c) => sum + c.weight, 0);
  let health = 0;
  for (const c of active) {
    health += c.score! * (c.weight / totalActiveWeight);
  }
  const score = toDrift(Math.round(health));

  // Risk bands on the drift scale: 0–30 low, 31–60 moderate, 61–100 high.
  let riskLevel: RiskLevel;
  if (score <= 30) riskLevel = 'low';
  else if (score <= 60) riskLevel = 'moderate';
  else riskLevel = 'high';

  // Track which components had data
  const measured: ('runtime' | 'framework' | 'dependency' | 'eol' | 'freshness')[] = [];
  if (rs !== null) measured.push('runtime');
  if (fs !== null) measured.push('framework');
  if (ds !== null) measured.push('dependency');
  if (es !== null) measured.push('eol');

  return {
    score,
    riskLevel,
    components: buildComponents(),
    measured,
    methodologyVersion: DRIFT_SCORE_METHODOLOGY_VERSION,
    ...(confidence !== undefined ? { confidence } : {}),
    ...envelope,
  };
}

// ── Findings generation ──

export function generateFindings(
  projects: ProjectScan[],
  config?: VibgrateConfig,
): Finding[] {
  const thresholds = {
    failOnError: { ...DEFAULT_THRESHOLDS.failOnError, ...config?.thresholds?.failOnError },
    warn: { ...DEFAULT_THRESHOLDS.warn, ...config?.thresholds?.warn },
  };

  const findings: Finding[] = [];

  for (const project of projects) {
    const runtimeLabel =
      project.type === 'node' ? 'Node.js' :
      project.type === 'dotnet' ? '.NET' :
      project.type === 'python' ? 'Python' :
      project.type === 'java' ? 'Java' : project.type;

    // Runtime EOL check — prefer real end-of-life dates over the lag proxy.
    if (project.runtimeEol === true) {
      const when = project.runtimeEolDate ? ` on ${project.runtimeEolDate}` : '';
      findings.push({
        ruleId: 'vibgrate/runtime-eol',
        level: 'error',
        message: `${runtimeLabel} runtime "${project.runtime}" reached end-of-life${when} (latest: ${project.runtimeLatest}).`,
        location: project.path,
      });
    } else if (project.runtimeMajorsBehind !== undefined && project.runtimeMajorsBehind >= 3) {
      findings.push({
        ruleId: 'vibgrate/runtime-eol',
        level: 'error',
        message: `${runtimeLabel} runtime "${project.runtime}" is ${project.runtimeMajorsBehind} major versions behind (latest: ${project.runtimeLatest}). Likely at or past EOL.`,
        location: project.path,
      });
    } else if (project.runtimeMajorsBehind !== undefined && project.runtimeMajorsBehind >= 2) {
      findings.push({
        ruleId: 'vibgrate/runtime-lag',
        level: 'warning',
        message: `${runtimeLabel} runtime "${project.runtime}" is ${project.runtimeMajorsBehind} major versions behind (latest: ${project.runtimeLatest}).`,
        location: project.path,
      });
    }

    // Framework lag check
    for (const fw of project.frameworks) {
      if (fw.majorsBehind !== null && thresholds.failOnError.frameworkMajorLag !== undefined && fw.majorsBehind >= thresholds.failOnError.frameworkMajorLag) {
        findings.push({
          ruleId: 'vibgrate/framework-major-lag',
          level: 'error',
          message: `${fw.name} is ${fw.majorsBehind} major versions behind (current: ${fw.currentVersion}, latest: ${fw.latestVersion}).`,
          location: project.path,
        });
      } else if (fw.majorsBehind !== null && thresholds.warn.frameworkMajorLag !== undefined && fw.majorsBehind >= thresholds.warn.frameworkMajorLag) {
        findings.push({
          ruleId: 'vibgrate/framework-major-lag',
          level: 'warning',
          message: `${fw.name} is ${fw.majorsBehind} major versions behind (current: ${fw.currentVersion}, latest: ${fw.latestVersion}).`,
          location: project.path,
        });
      }
    }

    // Dependency rot check
    const totalDeps = project.dependencyAgeBuckets.current +
      project.dependencyAgeBuckets.oneBehind +
      project.dependencyAgeBuckets.twoPlusBehind;

    if (totalDeps > 0) {
      const twoPlusPct = (project.dependencyAgeBuckets.twoPlusBehind / totalDeps) * 100;

      if (thresholds.failOnError.dependencyTwoPlusPercent !== undefined && twoPlusPct >= thresholds.failOnError.dependencyTwoPlusPercent) {
        findings.push({
          ruleId: 'vibgrate/dependency-rot',
          level: 'error',
          message: `${Math.round(twoPlusPct)}% of dependencies are 2+ major versions behind in ${project.name}.`,
          location: project.path,
        });
      } else if (thresholds.warn.dependencyTwoPlusPercent !== undefined && twoPlusPct >= thresholds.warn.dependencyTwoPlusPercent) {
        findings.push({
          ruleId: 'vibgrate/dependency-rot',
          level: 'warning',
          message: `${Math.round(twoPlusPct)}% of dependencies are 2+ major versions behind in ${project.name}.`,
          location: project.path,
        });
      }
    }

    // Individual major-behind dependencies (2+ majors)
    for (const dep of project.dependencies) {
      if (dep.majorsBehind !== null && dep.majorsBehind >= 3) {
        findings.push({
          ruleId: 'vibgrate/dependency-major-lag',
          level: 'error',
          message: `${dep.package} is ${dep.majorsBehind} major versions behind (spec: ${dep.currentSpec}, latest: ${dep.latestStable}).`,
          location: project.path,
        });
      }
    }
  }

  return findings;
}

/**
 * Compute a deterministic project ID.
 * Hash of `${relativePath}:${projectName}:${workspaceId}`.
 * The workspaceId ties the ID to a specific DSN/workspace so the same
 * project scanned under different workspaces gets distinct IDs.
 * If no workspaceId is available (local-only scans), it is omitted from the hash.
 */
export function computeProjectId(
  relativePath: string,
  projectName: string,
  workspaceId?: string,
): string {
  const input = workspaceId
    ? `${relativePath}:${projectName}:${workspaceId}`
    : `${relativePath}:${projectName}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}


/**
 * Compute a deterministic solution ID.
 * Hash of `${relativePath}:${solutionName}:${workspaceId}`.
 */
export function computeSolutionId(
  relativePath: string,
  solutionName: string,
  workspaceId?: string,
): string {
  const input = workspaceId
    ? `${relativePath}:${solutionName}:${workspaceId}`
    : `${relativePath}:${solutionName}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}
