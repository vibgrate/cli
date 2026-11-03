/**
 * `Pipfile.lock` is an SBOM lockfile. `default` and `develop` packages are
 * components with PyPI purls. A name that appears only in `develop` is a
 * development row. A name in both sections stays production. Editable and
 * path entries are skipped. A manifest row keeps its section.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PyPICache } from '../src/core-open/scanners/pypi-cache.js';
import { scanPythonProjects } from '../src/core-open/scanners/python-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const WHEEL = 'a'.repeat(64);
const SDIST = 'b'.repeat(64);
const COVERAGE = 'c'.repeat(64);

const PIPFILE = `[packages]
requests = "==2.31.0"
black = "==24.1.0"

[dev-packages]
pytest = "==8.3.2"
`;

function lockfile(sectionOrder: 'default-first' | 'develop-first'): string {
  const sections: Record<string, unknown> = {
    default: {
      requests: { version: '==2.31.0', hashes: [`sha256:${SDIST}`, `sha256:${WHEEL}`] },
      certifi: { version: '==2024.7.4' },
      shared: { version: '==1.2.0' },
      localpkg: { version: '==0.1.0', editable: true, path: '.' },
      vendor: { version: '==1.0.0', path: './vendor/pkg' },
    },
    develop: {
      pytest: { version: '==8.3.2', hashes: [`sha256:${COVERAGE}`] },
      coverage: { version: '==7.6.0', hashes: [`sha256:${COVERAGE}`] },
      shared: { version: '==9.9.9' },
      black: { version: '==24.1.0' },
      'editable-dev': { editable: true, path: './tools' },
      gitpkg: { git: 'https://example.invalid/repo.git', ref: 'main' },
    },
  };
  const ordered = sectionOrder === 'default-first'
    ? { default: sections.default, develop: sections.develop }
    : { develop: sections.develop, default: sections.default };
  return JSON.stringify(ordered);
}

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'pipfile-lock',
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

async function scan(root: string): Promise<ProjectScan[]> {
  return scanPythonProjects(root, new PyPICache(new Semaphore(1), undefined, true));
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
  packages: Array<{ name: string; checksums?: Array<{ algorithm: string; checksumValue: string }> }>;
  relationships?: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
};

function vibScope(cdx: Cdx, name: string): string | undefined {
  const component = cdx.components.find((row) => row.name === name);
  return component?.properties.find((property) => property.name === 'vibgrate:scope')?.value;
}

function scopeOf(cdx: Cdx, name: string): string | undefined {
  return cdx.components.find((row) => row.name === name)?.scope;
}

function devRels(spdx: Spdx): string[] {
  return (spdx.relationships ?? [])
    .filter((rel) => rel.relationshipType === 'DEV_DEPENDENCY_OF')
    .map((rel) => spdx.packages[Number(rel.spdxElementId.replace('SPDXRef-Package-', '')) - 1]!.name);
}

describe('sbom export: Pipfile.lock', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  async function exportOrder(root: string, sectionOrder: 'default-first' | 'develop-first') {
    fs.writeFileSync(path.join(root, 'Pipfile.lock'), lockfile(sectionOrder));
    const projects = await scan(root);
    const scanArtifact = artifact(projects);
    const graph = collectLockfileGraph(scanArtifact, root);
    return {
      projects,
      cdx: toCycloneDx(scanArtifact, graph) as Cdx,
      spdx: toSpdx(scanArtifact, graph) as Spdx,
    };
  }

  it('exports default and develop packages with PyPI purls, marks a develop-only package, and skips editable entries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pipfile-lock-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'Pipfile'), PIPFILE);
    const first = await exportOrder(root, 'default-first');
    const second = await exportOrder(root, 'develop-first');
    expect(JSON.stringify(second.cdx)).toBe(JSON.stringify(first.cdx));
    expect(JSON.stringify(second.spdx)).toBe(JSON.stringify(first.spdx));

    const byPackage = new Map(first.projects[0]!.dependencies.map((dep) => [dep.package, dep]));
    expect(byPackage.get('requests')?.section).toBe('dependencies');
    expect(byPackage.get('black')?.section).toBe('dependencies');
    expect(byPackage.get('pytest')?.section).toBe('devDependencies');
    expect(byPackage.has('coverage')).toBe(false);
    expect(byPackage.has('certifi')).toBe(false);
    expect(byPackage.has('shared')).toBe(false);
    expect(byPackage.has('localpkg')).toBe(false);

    const names = first.cdx.components.map((row) => row.name);
    expect(names).toEqual(['black', 'certifi', 'coverage', 'pytest', 'requests', 'shared', 'shared']);
    const purl = (name: string, version: string): string | undefined =>
      first.cdx.components.find((row) => row.name === name && row.version === version)?.purl;
    expect(purl('requests', '2.31.0')).toBe('pkg:pypi/requests@2.31.0');
    expect(purl('certifi', '2024.7.4')).toBe('pkg:pypi/certifi@2024.7.4');
    expect(purl('pytest', '8.3.2')).toBe('pkg:pypi/pytest@8.3.2');
    expect(purl('coverage', '7.6.0')).toBe('pkg:pypi/coverage@7.6.0');
    expect(purl('shared', '1.2.0')).toBe('pkg:pypi/shared@1.2.0');
    expect(purl('shared', '9.9.9')).toBe('pkg:pypi/shared@9.9.9');
    expect(purl('black', '24.1.0')).toBe('pkg:pypi/black@24.1.0');
    expect(names).not.toContain('localpkg');
    expect(names).not.toContain('vendor');
    expect(names).not.toContain('editable-dev');
    expect(names).not.toContain('gitpkg');

    expect(vibScope(first.cdx, 'requests')).toBe('direct');
    expect(scopeOf(first.cdx, 'requests')).toBeUndefined();
    expect(vibScope(first.cdx, 'black')).toBe('direct');
    expect(scopeOf(first.cdx, 'black')).toBeUndefined();
    expect(vibScope(first.cdx, 'pytest')).toBe('direct');
    expect(scopeOf(first.cdx, 'pytest')).toBe('excluded');
    expect(vibScope(first.cdx, 'coverage')).toBe('transitive');
    expect(scopeOf(first.cdx, 'coverage')).toBe('excluded');
    expect(vibScope(first.cdx, 'certifi')).toBe('transitive');
    expect(scopeOf(first.cdx, 'certifi')).toBeUndefined();
    const sharedRows = first.cdx.components.filter((row) => row.name === 'shared');
    expect(sharedRows.map((row) => row.scope)).toEqual([undefined, undefined]);
    expect(sharedRows.map((row) => row.properties.find((property) => property.name === 'vibgrate:scope')?.value)).toEqual([
      'transitive',
      'transitive',
    ]);
    expect(first.cdx.dependencies).toBeUndefined();

    const requests = first.cdx.components.find((row) => row.name === 'requests');
    expect(requests?.hashes).toEqual([
      { alg: 'SHA-256', content: WHEEL },
      { alg: 'SHA-256', content: SDIST },
    ]);

    expect(devRels(first.spdx).sort()).toEqual(['coverage', 'pytest']);
    for (const rel of (first.spdx.relationships ?? []).filter((row) => row.relationshipType === 'DEV_DEPENDENCY_OF')) {
      expect(rel.relatedSpdxElementId).toBe('SPDXRef-DOCUMENT');
    }
    expect((first.spdx.relationships ?? []).some((rel) => rel.relationshipType === 'DEPENDS_ON')).toBe(false);
    const requestsPkg = first.spdx.packages.find((pkg) => pkg.name === 'requests');
    expect(requestsPkg?.checksums).toEqual([
      { algorithm: 'SHA256', checksumValue: WHEEL },
      { algorithm: 'SHA256', checksumValue: SDIST },
    ]);
  });
});
