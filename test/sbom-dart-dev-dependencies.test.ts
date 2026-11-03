/**
 * Dart `dev_dependencies` are direct development rows. A package also
 * declared under `dependencies` stays production, and that declaration
 * supplies the spec. SDK entries are skipped in both sections. pub.dev
 * lookups and drift age buckets stay on production rows, so the drift
 * score of a production fixture does not change when development rows
 * are present.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PubCache, type PubDevMeta } from '../src/core-open/scanners/pub-cache.js';
import { scanDartProjects } from '../src/core-open/scanners/dart-scanner.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import { computeDriftScore } from '../src/core-open/scoring/drift-score.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const MANIFEST: PackageVersionManifest = {
  pub: {
    http: { latest: '2.0.0', versions: ['1.2.2', '2.0.0'] },
    provider: { latest: '6.1.2', versions: ['6.1.2'] },
    flutter_lints: { latest: '9.0.0', versions: ['3.0.1', '9.0.0'] },
    mocktail: { latest: '1.0.4', versions: ['1.0.4'] },
    build_runner: { latest: '2.4.9', versions: ['2.4.9'] },
  },
};

const LOCKFILE = `packages:
  build_runner:
    dependency: "direct dev"
    version: "2.4.9"
  flutter_lints:
    dependency: "direct dev"
    version: "3.0.1"
  http:
    dependency: "direct main"
    version: "1.2.2"
  mocktail:
    dependency: "direct dev"
    version: "1.0.4"
  provider:
    dependency: "direct main"
    version: "6.1.2"
`;

const ENVIRONMENT = `name: app
environment:
  sdk: '>=3.2.0 <4.0.0'
`;

const PROD = `dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0
  provider: ^6.1.0
`;

const DEV = `dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_test_inline: { sdk: flutter }
  flutter_lints: ^3.0.0
  mocktail: ^1.0.0
  build_runner: ^2.4.0
  http: ^0.13.0
`;

class RecordingPubCache extends PubCache {
  readonly lookedUp: string[] = [];

  override get(packageName: string): Promise<PubDevMeta> {
    this.lookedUp.push(packageName);
    return super.get(packageName);
  }
}

function pubspec(order: 'deps-first' | 'dev-first' | 'prod-only' | 'dev-only'): string {
  if (order === 'prod-only') return `${ENVIRONMENT}${PROD}`;
  if (order === 'dev-only') return `${ENVIRONMENT}${DEV}`;
  const blocks = order === 'deps-first' ? [PROD, DEV] : [DEV, PROD];
  return [ENVIRONMENT, ...blocks].join('\n');
}

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'dart-dev-dependencies',
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

type Cdx = {
  components: Array<{ name: string; scope?: string; properties: Array<{ name: string; value: string }> }>;
  dependencies?: unknown;
};

type Spdx = {
  packages: Array<{ name: string }>;
  relationships: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
};

function vibScope(cdx: Cdx, name: string): string | undefined {
  const component = cdx.components.find((row) => row.name === name);
  return component?.properties.find((property) => property.name === 'vibgrate:scope')?.value;
}

function relNames(spdx: Spdx, kind: string): string[] {
  return spdx.relationships
    .filter((rel) => rel.relationshipType === kind)
    .map((rel) => spdx.packages[Number(rel.spdxElementId.replace('SPDXRef-Package-', '')) - 1]!.name);
}

describe('sbom export: Dart dev_dependencies', () => {
  let root: string;

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function scan(order: 'deps-first' | 'dev-first' | 'prod-only' | 'dev-only') {
    fs.writeFileSync(path.join(root, 'pubspec.yaml'), pubspec(order));
    fs.writeFileSync(path.join(root, 'pubspec.lock'), LOCKFILE);
    const cache = new RecordingPubCache(new Semaphore(1), MANIFEST, true);
    const projects = await scanDartProjects(root, cache);
    return { root, projects, cache, project: projects[0]! };
  }

  async function exportOrder(order: 'deps-first' | 'dev-first') {
    const scanned = await scan(order);
    const scanArtifact = artifact(scanned.projects);
    const graph = collectLockfileGraph(scanArtifact, scanned.root);
    return {
      ...scanned,
      cdx: toCycloneDx(scanArtifact, graph) as Cdx,
      spdx: toSpdx(scanArtifact, graph) as Spdx,
    };
  }

  it('exports dev-only, prod-only, and a name listed in both sections', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-dart-dev-'));
    const devOnly = await scan('dev-only');
    const devByPackage = new Map(devOnly.project.dependencies.map((dep) => [dep.package, dep]));
    expect([...devByPackage.keys()].sort()).toEqual(['build_runner', 'flutter_lints', 'http', 'mocktail']);
    for (const name of ['flutter_lints', 'mocktail', 'build_runner', 'http']) {
      expect(devByPackage.get(name)?.section).toBe('devDependencies');
      expect(devByPackage.get(name)?.latestStable).toBeNull();
      expect(devByPackage.get(name)?.majorsBehind).toBeNull();
      expect(devByPackage.get(name)?.drift).toBe('unknown');
    }
    expect(devByPackage.get('flutter_lints')).toMatchObject({ currentSpec: '^3.0.0', resolvedVersion: '3.0.1' });
    expect(devByPackage.has('flutter_test')).toBe(false);
    expect(devByPackage.has('flutter_test_inline')).toBe(false);
    expect(devOnly.cache.lookedUp).toEqual([]);
    expect(devOnly.project.dependencyAgeBuckets).toEqual({ current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 });
    expect(devOnly.project.frameworks).toEqual([]);

    const prodOnly = await scan('prod-only');
    const prodByPackage = new Map(prodOnly.project.dependencies.map((dep) => [dep.package, dep]));
    expect([...prodByPackage.keys()].sort()).toEqual(['http', 'provider']);
    expect(prodByPackage.has('flutter')).toBe(false);
    expect(prodByPackage.get('http')).toMatchObject({
      section: 'dependencies',
      currentSpec: '^1.2.0',
      resolvedVersion: '1.2.2',
      latestStable: '2.0.0',
      majorsBehind: 1,
      drift: 'major-behind',
    });
    expect(prodByPackage.get('provider')).toMatchObject({
      section: 'dependencies',
      currentSpec: '^6.1.0',
      resolvedVersion: '6.1.2',
      latestStable: '6.1.2',
      majorsBehind: 0,
      drift: 'current',
    });
    expect(prodOnly.cache.lookedUp).toEqual(['http', 'provider']);
    expect(prodOnly.project.dependencyAgeBuckets).toEqual({ current: 1, oneBehind: 1, twoPlusBehind: 0, unknown: 0 });
    expect(prodOnly.project.frameworks.map((framework) => framework.name).sort()).toEqual(['Provider', 'http']);

    const first = await exportOrder('deps-first');
    const second = await exportOrder('dev-first');
    expect(JSON.stringify(second.cdx)).toBe(JSON.stringify(first.cdx));
    expect(JSON.stringify(second.spdx)).toBe(JSON.stringify(first.spdx));
    expect(second.project.dependencies).toEqual(first.project.dependencies);
    expect(second.project.dependencyAgeBuckets).toEqual(first.project.dependencyAgeBuckets);
    expect(first.cache.lookedUp).toEqual(['http', 'provider']);
    expect(second.cache.lookedUp).toEqual(['http', 'provider']);

    const byPackage = new Map(first.project.dependencies.map((dep) => [dep.package, dep]));
    expect(byPackage.get('http')).toMatchObject({
      section: 'dependencies',
      currentSpec: '^1.2.0',
      resolvedVersion: '1.2.2',
      latestStable: '2.0.0',
      majorsBehind: 1,
      drift: 'major-behind',
    });
    expect(byPackage.get('provider')).toMatchObject({ section: 'dependencies', currentSpec: '^6.1.0' });
    expect(byPackage.get('flutter_lints')).toMatchObject({
      section: 'devDependencies',
      currentSpec: '^3.0.0',
      resolvedVersion: '3.0.1',
      latestStable: null,
      majorsBehind: null,
      drift: 'unknown',
    });
    expect(byPackage.get('mocktail')?.section).toBe('devDependencies');
    expect(byPackage.get('build_runner')?.section).toBe('devDependencies');
    expect(byPackage.has('flutter')).toBe(false);
    expect(byPackage.has('flutter_test')).toBe(false);
    expect(byPackage.has('flutter_test_inline')).toBe(false);
    expect(byPackage.size).toBe(5);
    expect(first.project.dependencies.filter((dep) => dep.package === 'http')).toHaveLength(1);
    expect(first.project.dependencyAgeBuckets).toEqual(prodOnly.project.dependencyAgeBuckets);
    expect(first.project.dependencies.filter((dep) => dep.section !== 'devDependencies')).toEqual(prodOnly.project.dependencies);
    expect(first.project.frameworks).toEqual(prodOnly.project.frameworks);

    const dev = ['build_runner', 'flutter_lints', 'mocktail'];
    for (const name of dev) {
      expect(vibScope(first.cdx, name)).toBe('direct');
      expect(first.cdx.components.find((row) => row.name === name)?.scope).toBe('excluded');
    }
    for (const name of ['http', 'provider']) {
      expect(vibScope(first.cdx, name)).toBe('direct');
      expect(first.cdx.components.find((row) => row.name === name)?.scope).toBeUndefined();
    }
    expect(first.cdx.components.some((row) => row.name === 'flutter' || row.name === 'flutter_test')).toBe(false);
    expect(first.cdx.dependencies).toBeUndefined();
    expect(relNames(first.spdx, 'DEV_DEPENDENCY_OF').sort()).toEqual(dev);
    expect(first.spdx.relationships.some((rel) => rel.relationshipType === 'DEPENDS_ON')).toBe(false);
    expect(first.spdx.relationships.every((rel) => rel.relatedSpdxElementId === 'SPDXRef-DOCUMENT')).toBe(true);
  });

  it('keeps the drift score unchanged when development rows are present', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-dart-dev-'));
    const full = await scan('deps-first');
    const prodOnly = await scan('prod-only');
    expect(full.project.dependencyAgeBuckets).toEqual(prodOnly.project.dependencyAgeBuckets);
    expect(full.project.dependencies.filter((dep) => dep.section !== 'devDependencies')).toEqual(prodOnly.project.dependencies);
    const withDev = computeDriftScore([full.project]);
    const production = computeDriftScore([prodOnly.project]);
    expect(withDev.score).toBe(production.score);
    expect(withDev.riskLevel).toBe(production.riskLevel);
    expect(withDev.components).toEqual(production.components);
    expect(withDev.measured).toEqual(production.measured);
    expect(withDev.mode).toBe(production.mode);
    expect(withDev.dependencyDrift && {
      p95: withDev.dependencyDrift.p95,
      unsupportedShare: withDev.dependencyDrift.unsupportedShare,
      coverage: withDev.dependencyDrift.coverage,
    }).toEqual(production.dependencyDrift && {
      p95: production.dependencyDrift.p95,
      unsupportedShare: production.dependencyDrift.unsupportedShare,
      coverage: production.dependencyDrift.coverage,
    });
    expect(full.cache.lookedUp).toEqual(['http', 'provider']);
    expect(prodOnly.cache.lookedUp).toEqual(['http', 'provider']);
  });
});
