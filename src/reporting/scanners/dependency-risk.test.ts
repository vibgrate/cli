import { describe, it, expect } from 'vitest';
import { scanDependencyRisk } from './dependency-risk.js';
import type { ProjectScan, DependencyRow } from '../../core-open/index.js';

function makeDep(pkg: string, overrides: Partial<DependencyRow> = {}): DependencyRow {
  return {
    package: pkg,
    section: 'dependencies',
    currentSpec: '^1.0.0',
    resolvedVersion: '1.0.0',
    latestStable: '1.0.0',
    majorsBehind: 0,
    drift: 'current',
    ...overrides,
  };
}

function makeProject(deps: DependencyRow[]): ProjectScan {
  return {
    type: 'node',
    path: '.',
    name: 'test-project',
    frameworks: [],
    dependencies: deps,
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
  };
}

describe('scanDependencyRisk', () => {
  it('returns empty result for projects with no dependencies', () => {
    const result = scanDependencyRisk([makeProject([])]);
    expect(result.deprecatedPackages).toEqual([]);
    expect(result.nativeModulePackages).toEqual([]);
    expect(result.totalDependencies).toBe(0);
  });

  it('detects deprecated packages', () => {
    const result = scanDependencyRisk([
      makeProject([makeDep('request'), makeDep('express')]),
    ]);
    expect(result.deprecatedPackages).toEqual(['request']);
  });

  it('detects multiple deprecated packages', () => {
    const result = scanDependencyRisk([
      makeProject([
        makeDep('request'),
        makeDep('node-sass'),
        makeDep('tslint'),
      ]),
    ]);
    expect(result.deprecatedPackages).toEqual(['node-sass', 'request', 'tslint']);
  });

  it('detects native module packages', () => {
    const result = scanDependencyRisk([
      makeProject([makeDep('sharp'), makeDep('express')]),
    ]);
    expect(result.nativeModulePackages).toEqual(['sharp']);
  });

  it('detects multiple native module packages', () => {
    const result = scanDependencyRisk([
      makeProject([
        makeDep('sharp'),
        makeDep('bcrypt'),
        makeDep('better-sqlite3'),
      ]),
    ]);
    expect(result.nativeModulePackages).toContain('sharp');
    expect(result.nativeModulePackages).toContain('bcrypt');
    expect(result.nativeModulePackages).toContain('better-sqlite3');
  });

  it('counts total dependencies across all projects', () => {
    const result = scanDependencyRisk([
      makeProject([makeDep('a'), makeDep('b')]),
      makeProject([makeDep('c')]),
    ]);
    expect(result.totalDependencies).toBe(3);
  });

  it('deduplicates deprecated packages across projects', () => {
    const result = scanDependencyRisk([
      makeProject([makeDep('request')]),
      makeProject([makeDep('request')]),
    ]);
    expect(result.deprecatedPackages).toEqual(['request']);
    expect(result.totalDependencies).toBe(2);
  });

  it('detects packages that are both deprecated and native', () => {
    const result = scanDependencyRisk([
      makeProject([makeDep('node-sass')]),
    ]);
    expect(result.deprecatedPackages).toContain('node-sass');
    expect(result.nativeModulePackages).toContain('node-sass');
  });

  it('returns sorted arrays', () => {
    const result = scanDependencyRisk([
      makeProject([
        makeDep('tslint'),
        makeDep('grunt'),
        makeDep('bower'),
      ]),
    ]);
    expect(result.deprecatedPackages).toEqual(['bower', 'grunt', 'tslint']);
  });

  it('does not flag non-deprecated packages', () => {
    const result = scanDependencyRisk([
      makeProject([makeDep('express'), makeDep('react'), makeDep('vitest')]),
    ]);
    expect(result.deprecatedPackages).toEqual([]);
    expect(result.nativeModulePackages).toEqual([]);
  });

  it('handles empty project list', () => {
    const result = scanDependencyRisk([]);
    expect(result.deprecatedPackages).toEqual([]);
    expect(result.nativeModulePackages).toEqual([]);
    expect(result.totalDependencies).toBe(0);
  });
});
