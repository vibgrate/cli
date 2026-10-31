/**
 * Pipfile `[dev-packages]` and requirements files whose names mark them as
 * dev or test are development manifest rows. `[packages]` and
 * `requirements.txt` stay production. A name in both a development file and
 * a production file stays production, and the production declaration supplies
 * the spec, whichever file sorts first. `dev-requirements.txt` is classified
 * from its name; this file does not change which requirements names are read.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PyPICache } from '../src/core-open/scanners/pypi-cache.js';
import { requirementsManifestSection, scanPythonProjects } from '../src/core-open/scanners/python-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const LOCKFILE = `[[package]]
name = "requests"
version = "2.31.0"

[[package]]
name = "shared"
version = "1.2.0"

[[package]]
name = "pytest"
version = "8.3.2"

[[package]]
name = "tox"
version = "4.11.0"

[[package]]
name = "coverage"
version = "7.6.0"

[[package]]
name = "rich"
version = "13.7.1"

[[package]]
name = "certifi"
version = "2024.7.4"
`;

function pipfile(order: 'packages-first' | 'dev-first'): string {
  const packages = `[packages]
requests = "==2.31.0"
shared = "==1.2.0"
`;
  const dev = `[dev-packages]
pytest = "==8.3.2"
shared = "==1.0.0"
`;
  return order === 'packages-first' ? `${packages}\n${dev}` : `${dev}\n${packages}`;
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

async function scan(root: string): Promise<ProjectScan[]> {
  return scanPythonProjects(root, new PyPICache(new Semaphore(1), undefined, true));
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

describe('sbom export: Python Pipfile and requirements development files', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function makeRoot(prefix: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  async function exportDir(root: string, rootPath: string) {
    const projects = await scan(root);
    const scanArtifact = artifact(projects, rootPath);
    const graph = collectLockfileGraph(scanArtifact, root);
    return {
      projects,
      cdx: toCycloneDx(scanArtifact, graph) as Cdx,
      spdx: toSpdx(scanArtifact, graph) as Spdx,
    };
  }

  it('exports Pipfile dev-packages as development rows and keeps a repeated name production', async () => {
    const root = makeRoot('vg-pipfile-scope-');
    fs.writeFileSync(path.join(root, 'poetry.lock'), LOCKFILE);
    fs.writeFileSync(path.join(root, 'Pipfile'), pipfile('packages-first'));
    const first = await exportDir(root, 'pipfile-scope');
    fs.writeFileSync(path.join(root, 'Pipfile'), pipfile('dev-first'));
    const second = await exportDir(root, 'pipfile-scope');
    expect(JSON.stringify(second.cdx)).toBe(JSON.stringify(first.cdx));
    expect(JSON.stringify(second.spdx)).toBe(JSON.stringify(first.spdx));

    const byPackage = new Map(first.projects[0]!.dependencies.map((dep) => [dep.package, dep]));
    expect(byPackage.get('pytest')?.section).toBe('devDependencies');
    expect(byPackage.get('pytest')?.currentSpec).toBe('==8.3.2');
    expect(byPackage.get('requests')?.section).toBe('dependencies');
    expect(byPackage.get('requests')?.currentSpec).toBe('==2.31.0');
    expect(byPackage.get('shared')?.section).toBe('dependencies');
    expect(byPackage.get('shared')?.currentSpec).toBe('==1.2.0');

    expect(vibScope(first.cdx, 'pytest')).toBe('direct');
    expect(scopeOf(first.cdx, 'pytest')).toBe('excluded');
    expect(first.cdx.components.find((row) => row.name === 'pytest')?.version).toBe('8.3.2');
    expect(vibScope(first.cdx, 'requests')).toBe('direct');
    expect(scopeOf(first.cdx, 'requests')).toBeUndefined();
    expect(vibScope(first.cdx, 'shared')).toBe('direct');
    expect(scopeOf(first.cdx, 'shared')).toBeUndefined();
    expect(first.cdx.components.find((row) => row.name === 'shared')?.version).toBe('1.2.0');
    expect(vibScope(first.cdx, 'certifi')).toBe('transitive');
    expect(scopeOf(first.cdx, 'certifi')).toBeUndefined();
    expect(first.cdx.dependencies).toBeUndefined();

    expect(devRels(first.spdx).sort()).toEqual(['pytest']);
    for (const rel of first.spdx.relationships.filter((row) => row.relationshipType === 'DEV_DEPENDENCY_OF')) {
      expect(rel.relatedSpdxElementId).toBe('SPDXRef-DOCUMENT');
    }
  });

  it('exports dev and test requirements files as development rows, in either file order', async () => {
    expect(requirementsManifestSection('dev-requirements.txt')).toBe('devDependencies');
    expect(requirementsManifestSection(path.join('pkg', 'requirements-dev.txt'))).toBe('devDependencies');
    expect(requirementsManifestSection('requirements_dev.txt')).toBe('devDependencies');
    expect(requirementsManifestSection('requirements-test.txt')).toBe('devDependencies');
    expect(requirementsManifestSection('requirements.txt')).toBe('dependencies');
    expect(requirementsManifestSection('requirements-device.txt')).toBe('dependencies');
    expect(requirementsManifestSection('requirements-prod.txt')).toBe('dependencies');

    const root = makeRoot('vg-req-scope-');
    fs.writeFileSync(path.join(root, 'poetry.lock'), LOCKFILE);
    const common = {
      'requirements.txt': 'requests==2.31.0\nshared==1.2.0\n',
      'requirements-test.txt': 'tox==4.11.0\n',
      'requirements-prod.txt': 'coverage==7.6.0\n',
      'requirements-device.txt': 'rich==13.7.1\n',
    };
    function writeRequirements(devFile: string): void {
      for (const name of fs.readdirSync(root)) {
        if (name !== 'poetry.lock') fs.rmSync(path.join(root, name));
      }
      for (const [name, body] of Object.entries(common)) fs.writeFileSync(path.join(root, name), body);
      fs.writeFileSync(path.join(root, devFile), 'pytest==8.3.2\nshared==9.9.9\n');
    }
    // `-` sorts before `.`, so this development file is ordered before requirements.txt.
    writeRequirements('requirements-dev.txt');
    const first = await exportDir(root, 'requirements-scope');
    // `_` sorts after `.`, so requirements.txt is ordered before this development file.
    writeRequirements('requirements_dev.txt');
    const second = await exportDir(root, 'requirements-scope');
    expect(JSON.stringify(second.cdx)).toBe(JSON.stringify(first.cdx));
    expect(JSON.stringify(second.spdx)).toBe(JSON.stringify(first.spdx));

    const byPackage = new Map(first.projects[0]!.dependencies.map((dep) => [dep.package, dep]));
    expect(byPackage.get('pytest')?.section).toBe('devDependencies');
    expect(byPackage.get('pytest')?.currentSpec).toBe('==8.3.2');
    expect(byPackage.get('tox')?.section).toBe('devDependencies');
    expect(byPackage.get('tox')?.currentSpec).toBe('==4.11.0');
    expect(byPackage.get('requests')?.section).toBe('dependencies');
    expect(byPackage.get('coverage')?.section).toBe('dependencies');
    expect(byPackage.get('rich')?.section).toBe('dependencies');
    expect(byPackage.get('shared')?.section).toBe('dependencies');
    expect(byPackage.get('shared')?.currentSpec).toBe('==1.2.0');
    expect(byPackage.has('certifi')).toBe(false);

    expect(vibScope(first.cdx, 'pytest')).toBe('direct');
    expect(scopeOf(first.cdx, 'pytest')).toBe('excluded');
    expect(vibScope(first.cdx, 'tox')).toBe('direct');
    expect(scopeOf(first.cdx, 'tox')).toBe('excluded');
    expect(vibScope(first.cdx, 'requests')).toBe('direct');
    expect(scopeOf(first.cdx, 'requests')).toBeUndefined();
    expect(vibScope(first.cdx, 'coverage')).toBe('direct');
    expect(scopeOf(first.cdx, 'coverage')).toBeUndefined();
    expect(vibScope(first.cdx, 'rich')).toBe('direct');
    expect(scopeOf(first.cdx, 'rich')).toBeUndefined();
    expect(vibScope(first.cdx, 'shared')).toBe('direct');
    expect(scopeOf(first.cdx, 'shared')).toBeUndefined();
    expect(first.cdx.components.find((row) => row.name === 'shared')?.version).toBe('1.2.0');
    expect(vibScope(first.cdx, 'certifi')).toBe('transitive');
    expect(scopeOf(first.cdx, 'certifi')).toBeUndefined();
    expect(first.cdx.dependencies).toBeUndefined();

    expect(devRels(first.spdx).sort()).toEqual(['pytest', 'tox']);
    for (const rel of first.spdx.relationships.filter((row) => row.relationshipType === 'DEV_DEPENDENCY_OF')) {
      expect(rel.relatedSpdxElementId).toBe('SPDXRef-DOCUMENT');
    }
  });
});
