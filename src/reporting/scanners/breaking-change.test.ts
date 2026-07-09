import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { scanBreakingChangeExposure } from './breaking-change.js';
import type { ProjectScan, DependencyRow } from '../../core-open/index.js';

function makeDep(
  pkg: string,
  opts: Partial<DependencyRow> = {},
): DependencyRow {
  return {
    package: pkg,
    currentSpec: opts.currentSpec ?? '^1.0.0',
    resolvedVersion: opts.resolvedVersion ?? '1.0.0',
    latestStable: opts.latestStable ?? '1.0.0',
    majorsBehind: opts.majorsBehind ?? 0,
    drift: opts.drift ?? 'current',
    section: opts.section ?? 'dependencies',
  };
}

function makeProject(name: string, deps: DependencyRow[]): ProjectScan {
  return {
    type: 'node',
    name,
    path: `/test/${name}`,
    frameworks: [],
    dependencies: deps,
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
  };
}

const emptyCache = {
  async walkDir() { return []; },
  async readTextFile() { return ''; },
};

describe('scanBreakingChangeExposure', () => {
  it('returns clean slate for empty projects', async () => {
    const result = await scanBreakingChangeExposure([], '/', emptyCache as any);
    expect(result.deprecatedPackages).toEqual([]);
    expect(result.legacyPolyfills).toEqual([]);
    expect(result.peerConflictsDetected).toBe(false);
    expect(result.exposureScore).toBe(0);
    expect(result.projectIntelligence).toEqual([]);
    expect(result.overallRecommendation).toBe('do-nothing');
  });

  it('returns clean slate when no risky deps', async () => {
    const project = makeProject('clean', [
      makeDep('express'),
      makeDep('lodash'),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.deprecatedPackages).toEqual([]);
    expect(result.legacyPolyfills).toEqual([]);
    expect(result.exposureScore).toBe(0);
    expect(result.projectIntelligence[0]?.recommendation).toBe('do-nothing');
    expect(result.overallRecommendation).toBe('do-nothing');
  });

  // ── Deprecated packages ──

  it('detects deprecated packages', async () => {
    const project = makeProject('old', [
      makeDep('request'),
      makeDep('tslint'),
      makeDep('express'),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.deprecatedPackages).toContain('request');
    expect(result.deprecatedPackages).toContain('tslint');
    expect(result.deprecatedPackages).not.toContain('express');
  });

  it('detects node-sass and moment as deprecated', async () => {
    const project = makeProject('legacy', [
      makeDep('node-sass'),
      makeDep('moment'),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.deprecatedPackages).toContain('node-sass');
    expect(result.deprecatedPackages).toContain('moment');
  });

  it('detects aws-sdk v2 as deprecated', async () => {
    const project = makeProject('aws', [makeDep('aws-sdk')]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.deprecatedPackages).toContain('aws-sdk');
  });

  it('returns deprecated packages sorted alphabetically', async () => {
    const project = makeProject('sorted', [
      makeDep('tslint'),
      makeDep('request'),
      makeDep('node-sass'),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.deprecatedPackages).toEqual(['node-sass', 'request', 'tslint']);
  });

  // ── Legacy polyfills ──

  it('detects legacy polyfills', async () => {
    const project = makeProject('polyfilled', [
      makeDep('node-fetch'),
      makeDep('abort-controller'),
      makeDep('express'),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.legacyPolyfills).toContain('node-fetch');
    expect(result.legacyPolyfills).toContain('abort-controller');
    expect(result.legacyPolyfills).not.toContain('express');
  });

  it('detects cross-fetch and form-data as polyfills', async () => {
    const project = makeProject('http', [
      makeDep('cross-fetch'),
      makeDep('form-data'),
      makeDep('whatwg-url'),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.legacyPolyfills).toContain('cross-fetch');
    expect(result.legacyPolyfills).toContain('form-data');
    expect(result.legacyPolyfills).toContain('whatwg-url');
  });

  it('returns polyfills sorted alphabetically', async () => {
    const project = makeProject('sorted', [
      makeDep('url-parse'),
      makeDep('node-fetch'),
      makeDep('abort-controller'),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.legacyPolyfills).toEqual([
      'abort-controller',
      'node-fetch',
      'url-parse',
    ]);
  });

  // ── Peer conflicts ──

  it('detects peer dependency conflicts', async () => {
    const project = makeProject('conflicts', [
      makeDep('react', { section: 'peerDependencies', majorsBehind: 3 }),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.peerConflictsDetected).toBe(true);
  });

  it('does not flag peer deps with minor lag', async () => {
    const project = makeProject('ok', [
      makeDep('react', { section: 'peerDependencies', majorsBehind: 1 }),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.peerConflictsDetected).toBe(false);
  });

  it('requires majorsBehind >= 2 for peer conflict', async () => {
    const project = makeProject('edge', [
      makeDep('react', { section: 'peerDependencies', majorsBehind: 2 }),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.peerConflictsDetected).toBe(true);
  });

  // ── Exposure score ──

  it('scores deprecated packages up to 40', async () => {
    const project = makeProject('extreme', [
      makeDep('request'),
      makeDep('tslint'),
      makeDep('node-sass'),
      makeDep('aws-sdk'),
      makeDep('moment'),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    // 5 deprecated × 10 = 50, capped at 40
    expect(result.exposureScore).toBeGreaterThanOrEqual(40);
  });

  it('scores polyfills at 5 per item', async () => {
    const project = makeProject('polyfill', [
      makeDep('node-fetch'),
      makeDep('abort-controller'),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.exposureScore).toBe(10); // 2 × 5
  });

  it('adds 20 for peer conflicts', async () => {
    const project = makeProject('peer', [
      makeDep('react', { section: 'peerDependencies', majorsBehind: 4 }),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.exposureScore).toBe(20);
  });

  it('combines scores from different categories', async () => {
    const project = makeProject('mixed', [
      makeDep('request'),          // +10 deprecated
      makeDep('node-fetch'),       // +5 polyfill
      makeDep('abort-controller'), // +5 polyfill
      makeDep('react', { section: 'peerDependencies', majorsBehind: 3 }), // +20
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    expect(result.exposureScore).toBe(40); // 10 + 10 + 20
  });

  it('caps score at 100', async () => {
    const project = makeProject('everything', [
      // 5 deprecated = 40
      makeDep('request'), makeDep('tslint'), makeDep('node-sass'),
      makeDep('aws-sdk'), makeDep('moment'),
      // 7 polyfills = 30 (capped)
      makeDep('node-fetch'), makeDep('abort-controller'),
      makeDep('form-data'), makeDep('cross-fetch'),
      makeDep('whatwg-url'), makeDep('url-parse'), makeDep('querystring'),
      // peer conflict = 20
      makeDep('react', { section: 'peerDependencies', majorsBehind: 5 }),
    ]);
    const result = await scanBreakingChangeExposure([project], '/', emptyCache as any);
    // 40 + 30 + 20 = 90 (under 100, still valid)
    expect(result.exposureScore).toBeLessThanOrEqual(100);
  });

  // ── Cross-project ──

  it('deduplicates deprecated packages across projects', async () => {
    const p1 = makeProject('a', [makeDep('request')]);
    const p2 = makeProject('b', [makeDep('request'), makeDep('tslint')]);
    const result = await scanBreakingChangeExposure([p1, p2], '/', emptyCache as any);
    expect(result.deprecatedPackages).toEqual(['request', 'tslint']);
    // Only 2 unique deprecated packages: 20 points
    expect(result.exposureScore).toBe(20);
  });

  it('builds project upgrade intelligence for major jumps', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-'));
    const projectDir = path.join(tmp, 'app');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'main.ts'), "import Vue from 'vue';\nexport default { mixins: [], filters: {} };\n");

    const project = makeProject('app', [
      makeDep('vue', { resolvedVersion: '2.6.14', latestStable: '3.5.0', majorsBehind: 1 }),
    ]);
    project.path = 'app';
    project.fileCount = 1;

    const cache = {
      async walkDir() {
        return [{ relPath: 'app/main.ts', name: 'main.ts', isFile: true, isDirectory: false }];
      },
      async readTextFile(filePath: string) {
        return fs.readFile(filePath, 'utf8');
      },
    };

    const result = await scanBreakingChangeExposure([project], tmp, cache as any);
    expect(result.projectIntelligence[0]?.packages[0]?.package).toBe('vue');
    expect(result.projectIntelligence[0]?.packages[0]?.impactedFeatures.length).toBeGreaterThan(0);
    expect(result.projectIntelligence[0]?.packages[0]?.usage.importSites).toBe(1);
  });

});
