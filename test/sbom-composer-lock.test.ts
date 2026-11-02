/**
 * `vg sbom export` expands `composer.lock`. Production `packages` are
 * transitive when the scan did not declare them. `packages-dev` are
 * development rows. `require-dev` stays out of the scan, so `--no-transitive`
 * (no lockfile graph) omits those rows.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposerCache } from '../src/core-open/scanners/composer-cache.js';
import { scanPhpProjects } from '../src/core-open/scanners/php-scanner.js';
import { LockfileParseError } from '../src/core-open/utils/lockfile-parse.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const SHA1 = 'e'.repeat(40);

const COMPOSER_JSON = {
  name: 'acme/app',
  require: {
    php: '>=8.2',
    'monolog/monolog': '^3.5',
  },
  'require-dev': {
    'phpunit/phpunit': '^10.5',
  },
};

const COMPOSER_LOCK = {
  'content-hash': 'abc',
  packages: [
    {
      name: 'monolog/monolog',
      version: 'v3.5.0',
      dist: { type: 'zip', url: 'https://example.invalid/monolog.zip', shasum: SHA1 },
      require: { 'psr/log': '^2.0 || ^3.0', php: '>=8.1' },
    },
    {
      name: 'psr/log',
      version: '3.0.2',
      require: { php: '>=8.0' },
    },
  ],
  'packages-dev': [
    {
      name: 'phpunit/phpunit',
      version: 'v10.5.0',
      dist: { type: 'zip', shasum: 'f'.repeat(40) },
      require: { 'sebastian/comparator': '^5.0', php: '>=8.1' },
    },
    {
      name: 'sebastian/comparator',
      version: '5.0.1',
    },
  ],
};

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'composer-app',
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

type CdxComponent = {
  name: string;
  version: string;
  purl?: string;
  scope?: string;
  hashes?: Array<{ alg: string; content: string }>;
  properties: Array<{ name: string; value: string }>;
};

type Cdx = {
  components: CdxComponent[];
  dependencies?: unknown;
};

type Spdx = {
  packages: Array<{ name: string; externalRefs?: Array<{ referenceLocator: string }> }>;
  relationships?: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
};

function vibScope(cdx: Cdx, name: string): string | undefined {
  return cdx.components.find((row) => row.name === name)?.properties.find((property) => property.name === 'vibgrate:scope')?.value;
}

function relNames(spdx: Spdx, kind: string): string[] {
  return (spdx.relationships ?? [])
    .filter((rel) => rel.relationshipType === kind)
    .map((rel) => spdx.packages[Number(rel.spdxElementId.replace('SPDXRef-Package-', '')) - 1]!.name);
}

describe('sbom export: composer.lock', () => {
  let root: string;

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function scanned(): Promise<{ projects: ProjectScan[]; cdx: Cdx; spdx: Spdx; again: string }> {
    const projects = await scanPhpProjects(root, new ComposerCache(new Semaphore(1), undefined, true));
    const scanArtifact = artifact(projects);
    const graph = collectLockfileGraph(scanArtifact, root);
    const cdx = toCycloneDx(scanArtifact, graph) as Cdx;
    return {
      projects,
      cdx,
      spdx: toSpdx(scanArtifact, graph) as Spdx,
      again: JSON.stringify(toCycloneDx(scanArtifact, collectLockfileGraph(scanArtifact, root))),
    };
  }

  it('exports transitive packages with Composer purls and packages-dev as development rows', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sbom-composer-'));
    fs.writeFileSync(path.join(root, 'composer.json'), JSON.stringify(COMPOSER_JSON));
    fs.writeFileSync(path.join(root, 'composer.lock'), JSON.stringify(COMPOSER_LOCK));

    const first = await scanned();
    expect(first.again).toBe(JSON.stringify(first.cdx));
    expect(first.projects).toHaveLength(1);
    expect(first.projects[0]!.dependencies.map((dep) => dep.package)).toEqual(['monolog/monolog']);
    expect(first.projects[0]!.dependencies[0]).toMatchObject({
      section: 'dependencies',
      resolvedVersion: '3.5.0',
    });

    const byName = new Map(first.cdx.components.map((row) => [row.name, row]));
    expect([...byName.keys()].sort()).toEqual(['monolog/monolog', 'phpunit/phpunit', 'psr/log', 'sebastian/comparator']);

    expect(byName.get('monolog/monolog')).toMatchObject({
      version: '3.5.0',
      purl: 'pkg:composer/monolog/monolog@3.5.0',
      hashes: [{ alg: 'SHA-1', content: SHA1 }],
    });
    expect(byName.get('monolog/monolog')?.scope).toBeUndefined();
    expect(vibScope(first.cdx, 'monolog/monolog')).toBe('direct');

    expect(byName.get('psr/log')).toMatchObject({
      version: '3.0.2',
      purl: 'pkg:composer/psr/log@3.0.2',
    });
    expect(byName.get('psr/log')?.hashes).toBeUndefined();
    expect(byName.get('psr/log')?.scope).toBeUndefined();
    expect(vibScope(first.cdx, 'psr/log')).toBe('transitive');

    for (const name of ['phpunit/phpunit', 'sebastian/comparator']) {
      expect(vibScope(first.cdx, name)).toBe('transitive');
      expect(byName.get(name)?.scope).toBe('excluded');
    }
    expect(byName.get('phpunit/phpunit')?.purl).toBe('pkg:composer/phpunit/phpunit@10.5.0');
    expect(byName.get('phpunit/phpunit')?.hashes).toEqual([{ alg: 'SHA-1', content: 'f'.repeat(40) }]);
    expect(byName.get('sebastian/comparator')?.hashes).toBeUndefined();
    expect(byName.get('sebastian/comparator')?.purl).toBe('pkg:composer/sebastian/comparator@5.0.1');

    expect(first.cdx.dependencies).toBeUndefined();
    expect(relNames(first.spdx, 'DEV_DEPENDENCY_OF').sort()).toEqual(['phpunit/phpunit', 'sebastian/comparator']);
    expect(first.spdx.relationships?.some((rel) => rel.relationshipType === 'DEPENDS_ON')).toBe(false);
    expect(first.spdx.packages.find((pkg) => pkg.name === 'psr/log')?.externalRefs?.[0]?.referenceLocator).toBe(
      'pkg:composer/psr/log@3.0.2',
    );

    const manifestOnly = toCycloneDx(artifact(first.projects)) as Cdx;
    expect(manifestOnly.components.map((row) => row.name)).toEqual(['monolog/monolog']);
  });

  it('fails the export when composer.lock is truncated', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sbom-composer-bad-'));
    const secret = 'composer_DDDDDDDDDDDDDDDDDDDD';
    fs.writeFileSync(path.join(root, 'composer.json'), JSON.stringify(COMPOSER_JSON));
    fs.writeFileSync(
      path.join(root, 'composer.lock'),
      `{"packages":[{"name":"monolog/monolog","version":"3.5.0","dist":{"shasum":"${secret}"`,
    );
    const projects = await scanPhpProjects(root, new ComposerCache(new Semaphore(1), undefined, true)).catch((err: unknown) => {
      expect(err).toBeInstanceOf(LockfileParseError);
      return [] as ProjectScan[];
    });
    const scanArtifact = artifact(
      projects.length
        ? projects
        : [
            {
              type: 'php',
              path: '.',
              name: 'app',
              frameworks: [],
              dependencies: [],
              dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
            },
          ],
    );
    expect(() => collectLockfileGraph(scanArtifact, root)).toThrow(LockfileParseError);
    try {
      collectLockfileGraph(scanArtifact, root);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('composer.lock');
      expect(message).toContain('truncated or invalid JSON');
      expect(message).not.toContain(secret);
    }
  });
});
