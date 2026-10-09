/**
 * SemVer build metadata (`1.2.3+build.4`) round-trips through scan JSON and
 * `vg sbom` JSON. The version field keeps the `+`. The purl percent-encodes it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NpmCache } from '../src/core-open/scanners/npm-cache.js';
import { scanNodeProjects } from '../src/core-open/scanners/node-scanner.js';
import { ComposerCache } from '../src/core-open/scanners/composer-cache.js';
import { scanPhpProjects } from '../src/core-open/scanners/php-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ScanArtifact } from '../src/reporting/types.js';

const VERSION = '1.2.3+build.4';

function artifactFrom(project: ScanArtifact['projects'][number], rootPath: string): ScanArtifact {
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
    projects: [project],
  };
}

describe('SemVer build metadata in scan and sbom JSON', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('round-trips an npm lockfile version through scan JSON and both SBOM formats', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-semver-build-npm-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'plus-fixture', version: '1.0.0', dependencies: { 'left-pad': VERSION } }),
    );
    fs.writeFileSync(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'plus-fixture',
        lockfileVersion: 3,
        packages: {
          '': { name: 'plus-fixture', dependencies: { 'left-pad': VERSION } },
          'node_modules/left-pad': { version: VERSION },
        },
      }),
    );

    const projects = await scanNodeProjects(
      root,
      new NpmCache(root, new Semaphore(1), { npm: { 'left-pad': { latest: '1.3.0', versions: [VERSION, '1.3.0'] } } }, true),
    );
    expect(projects[0]!.dependencies[0]!.resolvedVersion).toBe(VERSION);
    const scanJson = JSON.stringify({ projects });
    expect(JSON.parse(scanJson).projects[0].dependencies[0].resolvedVersion).toBe(VERSION);
    expect(scanJson).toContain(VERSION);
    expect(scanJson).not.toContain('1.2.3%2Bbuild.4');

    const artifact = artifactFrom(projects[0]!, 'plus-fixture');
    const cyclone = toCycloneDx(artifact) as { components: Array<{ version: string; purl: string }> };
    const cycloneJson = JSON.stringify(cyclone);
    expect(JSON.stringify(toCycloneDx(artifact))).toBe(cycloneJson);
    expect(cyclone.components[0]!.version).toBe(VERSION);
    expect(cyclone.components[0]!.purl).toBe('pkg:npm/left-pad@1.2.3%2Bbuild.4');
    expect(JSON.parse(cycloneJson).components[0].version).toBe(VERSION);

    const spdx = toSpdx(artifact) as { packages: Array<{ versionInfo: string; externalRefs: Array<{ referenceLocator: string }> }> };
    expect(spdx.packages[0]!.versionInfo).toBe(VERSION);
    expect(spdx.packages[0]!.externalRefs[0]!.referenceLocator).toBe('pkg:npm/left-pad@1.2.3%2Bbuild.4');
  });

  it('round-trips a composer.lock version that semver.clean used to strip', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-semver-build-php-'));
    fs.writeFileSync(
      path.join(root, 'composer.json'),
      JSON.stringify({ name: 'acme/app', require: { 'monolog/monolog': VERSION } }),
    );
    fs.writeFileSync(
      path.join(root, 'composer.lock'),
      JSON.stringify({
        packages: [{ name: 'monolog/monolog', version: VERSION }],
        'packages-dev': [],
      }),
    );

    const projects = await scanPhpProjects(root, new ComposerCache(new Semaphore(1), undefined, true));
    expect(projects).toHaveLength(1);
    expect(projects[0]!.dependencies.map((d) => [d.package, d.resolvedVersion])).toEqual([['monolog/monolog', VERSION]]);
    const scanJson = JSON.stringify({ projects });
    expect(JSON.parse(scanJson).projects[0].dependencies[0].resolvedVersion).toBe(VERSION);
    expect(scanJson).not.toContain('%2B');

    const artifact = artifactFrom(projects[0]!, 'acme/app');
    const cyclone = toCycloneDx(artifact) as { components: Array<{ version: string; purl: string }> };
    expect(JSON.stringify(toCycloneDx(artifact))).toBe(JSON.stringify(cyclone));
    expect(cyclone.components[0]!.version).toBe(VERSION);
    expect(cyclone.components[0]!.purl).toBe('pkg:composer/monolog/monolog@1.2.3%2Bbuild.4');
  });
});
