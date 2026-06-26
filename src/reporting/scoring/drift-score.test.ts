import { describe, it, expect } from 'vitest';
import { computeDriftScore, generateFindings, computeProjectId } from '../scoring/drift-score.js';
import type { ProjectScan, VibgrateConfig } from '../types.js';

// ── Helpers ──

function makeNodeProject(overrides: Partial<ProjectScan> = {}): ProjectScan {
  return {
    type: 'node',
    path: '/test/project',
    name: 'test-project',
    runtime: '>=20.0.0',
    runtimeLatest: '22.0.0',
    runtimeMajorsBehind: 2,
    frameworks: [],
    dependencies: [],
    dependencyAgeBuckets: { current: 10, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    ...overrides,
  };
}

function makeDotnetProject(overrides: Partial<ProjectScan> = {}): ProjectScan {
  return {
    type: 'dotnet',
    path: '/test/dotnet-project',
    name: 'dotnet-project',
    targetFramework: 'net8.0',
    runtime: 'net8.0',
    runtimeLatest: 'net9.0',
    runtimeMajorsBehind: 1,
    frameworks: [],
    dependencies: [],
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 5 },
    ...overrides,
  };
}

// ── computeDriftScore ──

describe('computeDriftScore', () => {
  it('returns 0 (no drift) for a fully current project with no deps', () => {
    const project = makeNodeProject({
      runtimeMajorsBehind: 0,
      dependencyAgeBuckets: { current: 10, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    });
    const result = computeDriftScore([project]);
    expect(result.score).toBe(0);
    expect(result.riskLevel).toBe('low');
  });

  it('returns 0 drift for empty projects array', () => {
    const result = computeDriftScore([]);
    expect(result.score).toBe(0);
    expect(result.riskLevel).toBe('low');
    expect(result.components.runtimeScore).toBe(0);
    expect(result.components.frameworkScore).toBe(0);
    expect(result.components.dependencyScore).toBe(0);
    expect(result.components.eolScore).toBe(0);
  });

  it('penalises runtime 1 major behind', () => {
    const project = makeNodeProject({ runtimeMajorsBehind: 1 });
    const result = computeDriftScore([project]);
    expect(result.components.runtimeScore).toBe(20);
  });

  it('penalises runtime 2 majors behind', () => {
    const project = makeNodeProject({ runtimeMajorsBehind: 2 });
    const result = computeDriftScore([project]);
    expect(result.components.runtimeScore).toBe(50);
  });

  it('penalises runtime 3 majors behind', () => {
    const project = makeNodeProject({ runtimeMajorsBehind: 3 });
    const result = computeDriftScore([project]);
    expect(result.components.runtimeScore).toBe(80);
  });

  it('penalises runtime 4+ majors behind', () => {
    const project = makeNodeProject({ runtimeMajorsBehind: 5 });
    const result = computeDriftScore([project]);
    expect(result.components.runtimeScore).toBe(100);
  });

  it('returns runtimeScore 0 (no drift) when no runtime info', () => {
    const project = makeNodeProject({
      runtimeMajorsBehind: undefined,
      runtime: undefined,
    });
    const result = computeDriftScore([project]);
    expect(result.components.runtimeScore).toBe(0);
  });

  it('computes frameworkScore 0 (no drift) when no frameworks', () => {
    const project = makeNodeProject({ frameworks: [] });
    const result = computeDriftScore([project]);
    expect(result.components.frameworkScore).toBe(0);
  });

  it('penalises frameworks with major lag', () => {
    const project = makeNodeProject({
      frameworks: [
        { name: 'React', currentVersion: '17.0.0', latestVersion: '19.0.0', majorsBehind: 2 },
      ],
    });
    const result = computeDriftScore([project]);
    expect(result.components.frameworkScore).toBeGreaterThan(0);
  });

  it('handles framework with unknown majorsBehind (null)', () => {
    const project = makeNodeProject({
      frameworks: [
        { name: 'React', currentVersion: '18.0.0', latestVersion: null, majorsBehind: null },
      ],
    });
    const result = computeDriftScore([project]);
    expect(result.components.frameworkScore).toBe(0);
  });

  it('computes dependencyScore 0 (no drift) when all current', () => {
    const project = makeNodeProject({
      dependencyAgeBuckets: { current: 20, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    });
    const result = computeDriftScore([project]);
    expect(result.components.dependencyScore).toBe(0);
  });

  it('penalises many 2+ behind deps', () => {
    const project = makeNodeProject({
      dependencyAgeBuckets: { current: 2, oneBehind: 2, twoPlusBehind: 16, unknown: 0 },
    });
    const result = computeDriftScore([project]);
    expect(result.components.dependencyScore).toBeGreaterThan(50);
  });

  it('dependencyScore 0 (no drift) when no deps at all', () => {
    const project = makeNodeProject({
      dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    });
    const result = computeDriftScore([project]);
    expect(result.components.dependencyScore).toBe(0);
  });

  it('eolScore penalises node 2 majors behind', () => {
    const project = makeNodeProject({ runtimeMajorsBehind: 2 });
    const result = computeDriftScore([project]);
    expect(result.components.eolScore).toBe(70);
  });

  it('eolScore penalises dotnet 2 majors behind more heavily', () => {
    const project = makeDotnetProject({ runtimeMajorsBehind: 2 });
    const result = computeDriftScore([project]);
    expect(result.components.eolScore).toBe(80);
  });

  it('eolScore 100 (max drift) for 3+ majors behind', () => {
    const project = makeNodeProject({ runtimeMajorsBehind: 3 });
    const result = computeDriftScore([project]);
    expect(result.components.eolScore).toBe(100);
  });

  it('classifies risk as moderate for scores 31-60', () => {
    // Construct a project that yields a moderate drift score.
    // With no frameworks, frameworkScore is null and weight redistributes
    // so dep buckets must be healthier to stay in the moderate band.
    const project = makeNodeProject({
      runtimeMajorsBehind: 2,
      dependencyAgeBuckets: { current: 10, oneBehind: 3, twoPlusBehind: 2, unknown: 0 },
    });
    const result = computeDriftScore([project]);
    expect(result.riskLevel).toBe('moderate');
  });

  it('classifies risk as high for scores above 60', () => {
    const project = makeNodeProject({
      runtimeMajorsBehind: 4,
      frameworks: [
        { name: 'React', currentVersion: '15.0.0', latestVersion: '19.0.0', majorsBehind: 4 },
      ],
      dependencyAgeBuckets: { current: 1, oneBehind: 1, twoPlusBehind: 18, unknown: 0 },
    });
    const result = computeDriftScore([project]);
    expect(result.riskLevel).toBe('high');
  });

  it('takes worst runtime across multiple projects', () => {
    const p1 = makeNodeProject({ runtimeMajorsBehind: 0 });
    const p2 = makeNodeProject({ runtimeMajorsBehind: 3 });
    const result = computeDriftScore([p1, p2]);
    // runtimeScore uses max lag across all projects → 3 behind = 80 drift
    expect(result.components.runtimeScore).toBe(80);
  });

  it('aggregates dependency buckets across multiple projects', () => {
    const p1 = makeNodeProject({
      dependencyAgeBuckets: { current: 10, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    });
    const p2 = makeNodeProject({
      dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 10, unknown: 0 },
    });
    const result = computeDriftScore([p1, p2]);
    // 50% current, 50% 2+ behind — should drift above 20
    expect(result.components.dependencyScore).toBeGreaterThan(20);
  });

  it('score is a weighted combination', () => {
    const project = makeNodeProject({
      runtimeMajorsBehind: 0,
      dependencyAgeBuckets: { current: 10, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    });
    const result = computeDriftScore([project]);
    // All components show no drift → weighted drift score is 0.
    expect(result.score).toBe(0);
  });
});

// ── generateFindings ──

describe('generateFindings', () => {
  it('generates no findings for a current project', () => {
    const project = makeNodeProject({
      runtimeMajorsBehind: 0,
      dependencyAgeBuckets: { current: 10, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    });
    const findings = generateFindings([project]);
    expect(findings).toHaveLength(0);
  });

  it('generates runtime-eol finding for 3+ majors behind', () => {
    const project = makeNodeProject({ runtimeMajorsBehind: 3 });
    const findings = generateFindings([project]);
    const eol = findings.find((f) => f.ruleId === 'vibgrate/runtime-eol');
    expect(eol).toBeDefined();
    expect(eol!.level).toBe('error');
    expect(eol!.message).toContain('3 major versions behind');
  });

  it('generates runtime-lag finding for 2 majors behind', () => {
    const project = makeNodeProject({ runtimeMajorsBehind: 2 });
    const findings = generateFindings([project]);
    const lag = findings.find((f) => f.ruleId === 'vibgrate/runtime-lag');
    expect(lag).toBeDefined();
    expect(lag!.level).toBe('warning');
  });

  it('does not generate runtime finding for 1 major behind', () => {
    const project = makeNodeProject({ runtimeMajorsBehind: 1 });
    const findings = generateFindings([project]);
    const runtime = findings.filter((f) => f.ruleId.includes('runtime'));
    expect(runtime).toHaveLength(0);
  });

  it('generates framework-major-lag error for lag >= threshold', () => {
    const project = makeNodeProject({
      runtimeMajorsBehind: 0,
      frameworks: [
        { name: 'React', currentVersion: '15.0.0', latestVersion: '19.0.0', majorsBehind: 4 },
      ],
    });
    const findings = generateFindings([project]);
    const fwError = findings.find(
      (f) => f.ruleId === 'vibgrate/framework-major-lag' && f.level === 'error',
    );
    expect(fwError).toBeDefined();
    expect(fwError!.message).toContain('React');
    expect(fwError!.message).toContain('4 major versions behind');
  });

  it('generates framework-major-lag warning for lag at warn threshold', () => {
    const project = makeNodeProject({
      runtimeMajorsBehind: 0,
      frameworks: [
        { name: 'Vue', currentVersion: '2.0.0', latestVersion: '4.0.0', majorsBehind: 2 },
      ],
    });
    const findings = generateFindings([project]);
    const fwWarn = findings.find(
      (f) => f.ruleId === 'vibgrate/framework-major-lag' && f.level === 'warning',
    );
    expect(fwWarn).toBeDefined();
  });

  it('respects custom config thresholds', () => {
    const project = makeNodeProject({
      runtimeMajorsBehind: 0,
      frameworks: [
        { name: 'React', currentVersion: '17.0.0', latestVersion: '19.0.0', majorsBehind: 2 },
      ],
    });

    const strictConfig: VibgrateConfig = {
      thresholds: {
        failOnError: { frameworkMajorLag: 2 },
        warn: { frameworkMajorLag: 1 },
      },
    };

    const findings = generateFindings([project], strictConfig);
    const fwError = findings.find(
      (f) => f.ruleId === 'vibgrate/framework-major-lag' && f.level === 'error',
    );
    expect(fwError).toBeDefined();
  });

  it('generates dependency-rot finding when 2+ behind % exceeds threshold', () => {
    const project = makeNodeProject({
      runtimeMajorsBehind: 0,
      dependencyAgeBuckets: { current: 5, oneBehind: 0, twoPlusBehind: 5, unknown: 0 },
    });
    const findings = generateFindings([project]);
    const rot = findings.find((f) => f.ruleId === 'vibgrate/dependency-rot');
    expect(rot).toBeDefined();
    expect(rot!.level).toBe('error');
    expect(rot!.message).toContain('50%');
  });

  it('generates dependency-rot warning below error threshold but above warn', () => {
    const project = makeNodeProject({
      runtimeMajorsBehind: 0,
      dependencyAgeBuckets: { current: 7, oneBehind: 0, twoPlusBehind: 3, unknown: 0 },
    });
    const findings = generateFindings([project]);
    const rot = findings.find((f) => f.ruleId === 'vibgrate/dependency-rot');
    expect(rot).toBeDefined();
    expect(rot!.level).toBe('warning');
  });

  it('generates dependency-major-lag for individual deps 3+ behind', () => {
    const project = makeNodeProject({
      runtimeMajorsBehind: 0,
      dependencies: [
        {
          package: 'lodash',
          section: 'dependencies',
          currentSpec: '^3.0.0',
          resolvedVersion: '3.10.1',
          latestStable: '6.0.0',
          majorsBehind: 3,
          drift: 'major-behind',
        },
      ],
    });
    const findings = generateFindings([project]);
    const depLag = findings.find((f) => f.ruleId === 'vibgrate/dependency-major-lag');
    expect(depLag).toBeDefined();
    expect(depLag!.level).toBe('error');
    expect(depLag!.message).toContain('lodash');
  });

  it('does not generate dependency-major-lag for deps only 2 behind', () => {
    const project = makeNodeProject({
      runtimeMajorsBehind: 0,
      dependencies: [
        {
          package: 'lodash',
          section: 'dependencies',
          currentSpec: '^3.0.0',
          resolvedVersion: '3.10.1',
          latestStable: '5.0.0',
          majorsBehind: 2,
          drift: 'major-behind',
        },
      ],
    });
    const findings = generateFindings([project]);
    const depLag = findings.find((f) => f.ruleId === 'vibgrate/dependency-major-lag');
    expect(depLag).toBeUndefined();
  });

  it('generates findings for dotnet projects', () => {
    const project = makeDotnetProject({ runtimeMajorsBehind: 3 });
    const findings = generateFindings([project]);
    const eol = findings.find((f) => f.ruleId === 'vibgrate/runtime-eol');
    expect(eol).toBeDefined();
    expect(eol!.message).toContain('.NET');
  });

  it('sets location to project path', () => {
    const project = makeNodeProject({
      path: '/foo/bar',
      runtimeMajorsBehind: 3,
    });
    const findings = generateFindings([project]);
    expect(findings[0]?.location).toBe('/foo/bar');
  });
});

// ── computeProjectId ──

describe('computeProjectId', () => {
  it('returns a 16-character hex string', () => {
    const id = computeProjectId('packages/api', 'api');
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  it('is deterministic for same inputs', () => {
    const id1 = computeProjectId('packages/api', 'api', 'ws-123');
    const id2 = computeProjectId('packages/api', 'api', 'ws-123');
    expect(id1).toBe(id2);
  });

  it('produces different IDs for different paths', () => {
    const id1 = computeProjectId('packages/api', 'api', 'ws-123');
    const id2 = computeProjectId('packages/web', 'api', 'ws-123');
    expect(id1).not.toBe(id2);
  });

  it('produces different IDs for different names', () => {
    const id1 = computeProjectId('packages/api', 'api', 'ws-123');
    const id2 = computeProjectId('packages/api', 'web', 'ws-123');
    expect(id1).not.toBe(id2);
  });

  it('produces different IDs for different workspaces', () => {
    const id1 = computeProjectId('packages/api', 'api', 'ws-123');
    const id2 = computeProjectId('packages/api', 'api', 'ws-456');
    expect(id1).not.toBe(id2);
  });

  it('works without workspaceId', () => {
    const id = computeProjectId('packages/api', 'api');
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  it('without workspace !== with workspace', () => {
    const id1 = computeProjectId('packages/api', 'api');
    const id2 = computeProjectId('packages/api', 'api', 'ws-123');
    expect(id1).not.toBe(id2);
  });
});

// ── Per-project drift scores ──

describe('per-project drift scores', () => {
  it('computes individual scores per project in multi-project scan', () => {
    const p1 = makeNodeProject({
      runtimeMajorsBehind: 0,
      dependencyAgeBuckets: { current: 10, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    });
    const p2 = makeNodeProject({
      runtimeMajorsBehind: 4,
      dependencyAgeBuckets: { current: 1, oneBehind: 1, twoPlusBehind: 18, unknown: 0 },
    });

    // Individual scores
    const score1 = computeDriftScore([p1]);
    const score2 = computeDriftScore([p2]);

    // Aggregate score
    const aggregate = computeDriftScore([p1, p2]);

    // p1 should be healthy (low drift), p2 should be poor (high drift)
    expect(score1.score).toBeLessThan(20);
    expect(score2.score).toBeGreaterThan(70);

    // Aggregate should be between the two (pulled up by p2's drift)
    expect(aggregate.score).toBeLessThan(score2.score);
    expect(aggregate.score).toBeGreaterThan(score1.score);
  });

  it('individual project score matches single-project aggregate', () => {
    const project = makeNodeProject({
      runtimeMajorsBehind: 1,
      frameworks: [
        { name: 'React', currentVersion: '17.0.0', latestVersion: '19.0.0', majorsBehind: 2 },
      ],
      dependencyAgeBuckets: { current: 8, oneBehind: 2, twoPlusBehind: 1, unknown: 0 },
    });

    const singleProjectScore = computeDriftScore([project]);
    // This is exactly what the scan command does for per-project scores
    expect(singleProjectScore.score).toBeGreaterThan(0);
    expect(singleProjectScore.riskLevel).toBeDefined();
    expect(singleProjectScore.components).toBeDefined();
  });
});
