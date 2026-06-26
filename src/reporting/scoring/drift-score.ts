import * as crypto from 'node:crypto';
import type { ProjectScan, DriftScore, Finding, ScanArtifact, RiskLevel, VibgrateConfig } from '../types.js';

/**
 * Version of the drift-score methodology (weighting + formula). Bump this ONLY
 * when the weighting or calculation changes — never for routine CLI releases —
 * so the dashboard can tell whether two scores are directly comparable and avoid
 * drawing trend lines across a methodology change.
 */
export const DRIFT_SCORE_METHODOLOGY_VERSION = 'driftscore-2.0';

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

function dependencyScore(projects: ProjectScan[]): number | null {
  let totalCurrent = 0;
  let totalOne = 0;
  let totalTwo = 0;
  let totalUnknown = 0;

  for (const p of projects) {
    totalCurrent += p.dependencyAgeBuckets.current;
    totalOne += p.dependencyAgeBuckets.oneBehind;
    totalTwo += p.dependencyAgeBuckets.twoPlusBehind;
    totalUnknown += p.dependencyAgeBuckets.unknown;
  }

  const total = totalCurrent + totalOne + totalTwo;
  if (total === 0) return null;

  const currentPct = totalCurrent / total;
  const onePct = totalOne / total;
  const twoPct = totalTwo / total;

  // Score based on distribution
  return clamp(Math.round(currentPct * 100 - onePct * 10 - twoPct * 40), 0, 100);
}

function eolScore(projects: ProjectScan[]): number | null {
  // Check if any runtime is near EOL
  const hasRuntimeData = projects.some((p) => p.runtimeMajorsBehind !== undefined);
  if (!hasRuntimeData) return null; // No runtime info — don't score

  let score = 100;

  for (const p of projects) {
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

export function computeDriftScore(projects: ProjectScan[]): DriftScore {
  const rs = runtimeScore(projects);
  const fs = frameworkScore(projects);
  const ds = dependencyScore(projects);
  const es = eolScore(projects);

  // Weighted combination — redistribute weight from null (no-data) components
  const components: { score: number | null; weight: number }[] = [
    { score: rs, weight: 0.25 },
    { score: fs, weight: 0.25 },
    { score: ds, weight: 0.30 },
    { score: es, weight: 0.20 },
  ];

  // DriftScore v2 convention: 0 = no drift (best), 100 = maximum drift (worst).
  // Components are computed on a "health" scale and inverted to drift here.
  const toDrift = (health: number) => 100 - health;
  const buildComponents = (): DriftScore['components'] => ({
    runtimeScore: toDrift(Math.round(rs ?? 100)),
    frameworkScore: toDrift(Math.round(fs ?? 100)),
    dependencyScore: toDrift(Math.round(ds ?? 100)),
    eolScore: toDrift(Math.round(es ?? 100)),
  });

  const active = components.filter((c) => c.score !== null);
  if (active.length === 0) {
    // No data at all — neutral score (no measurable drift)
    return {
      score: 0,
      riskLevel: 'low',
      components: buildComponents(),
      methodologyVersion: DRIFT_SCORE_METHODOLOGY_VERSION,
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
  const measured: ('runtime' | 'framework' | 'dependency' | 'eol')[] = [];
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
    // Runtime EOL check
    if (project.runtimeMajorsBehind !== undefined && project.runtimeMajorsBehind >= 3) {
      const runtimeLabel =
        project.type === 'node' ? 'Node.js' :
        project.type === 'dotnet' ? '.NET' :
        project.type === 'python' ? 'Python' :
        project.type === 'java' ? 'Java' : project.type;
      findings.push({
        ruleId: 'vibgrate/runtime-eol',
        level: 'error',
        message: `${runtimeLabel} runtime "${project.runtime}" is ${project.runtimeMajorsBehind} major versions behind (latest: ${project.runtimeLatest}). Likely at or past EOL.`,
        location: project.path,
      });
    } else if (project.runtimeMajorsBehind !== undefined && project.runtimeMajorsBehind >= 2) {
      const runtimeLabel =
        project.type === 'node' ? 'Node.js' :
        project.type === 'dotnet' ? '.NET' :
        project.type === 'python' ? 'Python' :
        project.type === 'java' ? 'Java' : project.type;
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
