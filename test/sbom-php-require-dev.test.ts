/**
 * composer.json `require-dev` is a development manifest row.
 * A name also declared in `require` stays production, and that declaration
 * supplies the spec. Packagist lookups and drift age buckets stay on
 * production rows, so the drift score does not change.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposerCache, type PackagistMeta } from '../src/core-open/scanners/composer-cache.js';
import { scanPhpProjects } from '../src/core-open/scanners/php-scanner.js';
import { computeDriftScore } from '../src/core-open/scoring/drift-score.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const MANIFEST: PackageVersionManifest = {
  composer: {
    'monolog/monolog': { latest: '3.7.0', versions: ['3.7.0', '2.9.3'] },
    'guzzlehttp/guzzle': { latest: '7.9.2', versions: ['7.9.2', '7.8.1'] },
    'phpunit/phpunit': { latest: '11.5.0', versions: ['11.5.0', '10.5.45'] },
    'phpstan/phpstan': { latest: '2.0.0', versions: ['2.0.0', '1.11.0'] },
  },
};

const LOCKFILE = {
  packages: [
    { name: 'monolog/monolog', version: 'v2.9.3' },
    { name: 'guzzlehttp/guzzle', version: 'v7.8.1' },
    { name: 'only-in-lock/prod', version: 'v1.0.0' },
  ],
  'packages-dev': [
    { name: 'phpunit/phpunit', version: 'v10.5.45' },
    { name: 'phpstan/phpstan', version: 'v1.11.0' },
    { name: 'only-in-lock/dev', version: 'v2.0.0' },
  ],
};

const PROD_REQUIRE = {
  php: '>=8.2',
  'ext-json': '*',
  'monolog/monolog': '^2.0',
  'guzzlehttp/guzzle': '^7.8',
};

const DEV_REQUIRE = {
  'ext-mbstring': '*',
  'phpunit/phpunit': '^10.5',
  'phpstan/phpstan': '^1.11',
  'monolog/monolog': '^1.0',
};

class RecordingComposerCache extends ComposerCache {
  readonly lookedUp: string[] = [];

  override get(packageName: string): Promise<PackagistMeta> {
    this.lookedUp.push(packageName);
    return super.get(packageName);
  }
}

function artifact(projects: ProjectScan[], rootPath: string): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath,
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
  components: Array<{ name: string; version: string; scope?: string; properties: Array<{ name: string; value: string }> }>;
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

function scopeOf(cdx: Cdx, name: string): string | undefined {
  return cdx.components.find((row) => row.name === name)?.scope;
}

function devRels(spdx: Spdx): string[] {
  return spdx.relationships
    .filter((rel) => rel.relationshipType === 'DEV_DEPENDENCY_OF')
    .map((rel) => spdx.packages[Number(rel.spdxElementId.replace('SPDXRef-Package-', '')) - 1]!.name);
}

describe('composer.json require-dev rows', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function writeProject(composer: Record<string, unknown>, lock: unknown = LOCKFILE): { root: string; cache: RecordingComposerCache } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-composer-dev-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'composer.json'), `${JSON.stringify(composer, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'composer.lock'), `${JSON.stringify(lock, null, 2)}\n`);
    const cache = new RecordingComposerCache(new Semaphore(1), MANIFEST, true);
    return { root, cache };
  }

  async function scan(composer: Record<string, unknown>, lock?: unknown): Promise<{ project: ProjectScan; lookedUp: string[] }> {
    const { root, cache } = writeProject(composer, lock);
    const projects = await scanPhpProjects(root, cache);
    expect(projects).toHaveLength(1);
    return { project: projects[0]!, lookedUp: cache.lookedUp };
  }

  it('keeps a dev-only package, a prod-only package, and one production row when a name is in both tables', async () => {
    const devOnly = await scan({
      require: { php: '>=8.2', 'ext-json': '*' },
      'require-dev': { 'phpunit/phpunit': '^10.5', 'ext-mbstring': '*' },
    });
    expect(devOnly.project.dependencies).toEqual([
      {
        package: 'phpunit/phpunit',
        section: 'devDependencies',
        currentSpec: '^10.5',
        resolvedVersion: '10.5.45',
        latestStable: null,
        majorsBehind: null,
        drift: 'unknown',
      },
    ]);
    expect(devOnly.lookedUp).toEqual([]);
    expect(devOnly.project.dependencyAgeBuckets).toEqual({ current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 });
    expect(devOnly.project.frameworks).toEqual([]);

    const prodOnly = await scan({ require: PROD_REQUIRE });
    const byProd = new Map(prodOnly.project.dependencies.map((dep) => [dep.package, dep]));
    expect([...byProd.keys()]).toEqual(['monolog/monolog', 'guzzlehttp/guzzle']);
    expect(byProd.get('monolog/monolog')).toMatchObject({
      section: 'dependencies',
      currentSpec: '^2.0',
      resolvedVersion: '2.9.3',
      latestStable: '3.7.0',
      majorsBehind: 1,
      drift: 'major-behind',
    });
    expect(byProd.get('guzzlehttp/guzzle')).toMatchObject({
      section: 'dependencies',
      currentSpec: '^7.8',
      resolvedVersion: '7.8.1',
      latestStable: '7.9.2',
      majorsBehind: 0,
      drift: 'minor-behind',
    });
    expect(prodOnly.lookedUp).toEqual(['monolog/monolog', 'guzzlehttp/guzzle']);
    expect(prodOnly.project.frameworks.map((framework) => framework.name).sort()).toEqual(['Guzzle', 'Monolog']);

    const both = await scan({
      'require-dev': DEV_REQUIRE,
      require: PROD_REQUIRE,
    });
    const byBoth = new Map(both.project.dependencies.map((dep) => [dep.package, dep]));
    expect(both.project.dependencies.map((dep) => dep.package)).toEqual([
      'monolog/monolog',
      'guzzlehttp/guzzle',
      'phpstan/phpstan',
      'phpunit/phpunit',
    ]);
    expect(byBoth.get('monolog/monolog')).toMatchObject({
      section: 'dependencies',
      currentSpec: '^2.0',
      resolvedVersion: '2.9.3',
    });
    expect(byBoth.get('guzzlehttp/guzzle')?.section).toBe('dependencies');
    expect(byBoth.get('phpunit/phpunit')).toMatchObject({
      section: 'devDependencies',
      currentSpec: '^10.5',
      resolvedVersion: '10.5.45',
      latestStable: null,
      majorsBehind: null,
      drift: 'unknown',
    });
    expect(byBoth.get('phpstan/phpstan')).toMatchObject({
      section: 'devDependencies',
      currentSpec: '^1.11',
      resolvedVersion: '1.11.0',
      latestStable: null,
      majorsBehind: null,
      drift: 'unknown',
    });
    expect(byBoth.has('only-in-lock/prod')).toBe(false);
    expect(byBoth.has('only-in-lock/dev')).toBe(false);
    expect(both.lookedUp).toEqual(['monolog/monolog', 'guzzlehttp/guzzle']);
    expect(both.project.frameworks.map((framework) => framework.name).sort()).toEqual(['Guzzle', 'Monolog']);
    expect(both.project.dependencyAgeBuckets).toEqual(prodOnly.project.dependencyAgeBuckets);
    expect(both.project.dependencies.filter((dep) => dep.section !== 'devDependencies')).toEqual(prodOnly.project.dependencies);
    expect(computeDriftScore([both.project])).toEqual(computeDriftScore([prodOnly.project]));
  });

  it('exports a require-dev package as a direct development dependency', async () => {
    const { root, cache } = writeProject({
      'require-dev': DEV_REQUIRE,
      require: PROD_REQUIRE,
    });
    const projects = await scanPhpProjects(root, cache);
    const scanArtifact = artifact(projects, 'composer-require-dev');
    const graph = collectLockfileGraph(scanArtifact, root);
    const cdx = toCycloneDx(scanArtifact, graph) as Cdx;
    const spdx = toSpdx(scanArtifact, graph) as Spdx;

    expect(vibScope(cdx, 'phpunit/phpunit')).toBe('direct');
    expect(scopeOf(cdx, 'phpunit/phpunit')).toBe('excluded');
    expect(cdx.components.find((row) => row.name === 'phpunit/phpunit')?.version).toBe('10.5.45');
    expect(vibScope(cdx, 'phpstan/phpstan')).toBe('direct');
    expect(scopeOf(cdx, 'phpstan/phpstan')).toBe('excluded');
    expect(vibScope(cdx, 'monolog/monolog')).toBe('direct');
    expect(scopeOf(cdx, 'monolog/monolog')).toBeUndefined();
    expect(scopeOf(cdx, 'guzzlehttp/guzzle')).toBeUndefined();
    // composer.lock is expanded: lockfile-only packages are transitive rows,
    // and a `packages-dev` entry keeps its development mark.
    expect(vibScope(cdx, 'only-in-lock/prod')).toBe('transitive');
    expect(scopeOf(cdx, 'only-in-lock/prod')).toBeUndefined();
    expect(vibScope(cdx, 'only-in-lock/dev')).toBe('transitive');
    expect(scopeOf(cdx, 'only-in-lock/dev')).toBe('excluded');
    expect(cdx.components.some((row) => row.name === 'php' || row.name.startsWith('ext-'))).toBe(false);
    expect(cdx.dependencies).toBeUndefined();

    expect(devRels(spdx).sort()).toEqual(['only-in-lock/dev', 'phpstan/phpstan', 'phpunit/phpunit']);
    expect(spdx.relationships.some((rel) => rel.relationshipType === 'DEV_DEPENDENCY_OF' && rel.relatedSpdxElementId !== 'SPDXRef-DOCUMENT')).toBe(false);
    expect(spdx.relationships.some((rel) => rel.relationshipType === 'DEPENDS_ON')).toBe(false);
    expect(spdx.packages.some((pkg) => pkg.name === 'monolog/monolog')).toBe(true);
  });
});
