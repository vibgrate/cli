/**
 * Pipfile `[dev-packages]` and dev/test requirements filenames are development
 * manifest rows. `requirements.txt` and other requirements names stay production.
 * A name also declared in a production file stays production, and that
 * production row supplies the spec, whichever file is read first.
 *
 * `dev-requirements.txt` uses the same filename classification. Parsing that
 * name is separate from this classification, so these fixtures use the
 * requirements files the scanner already reads.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PyPICache } from '../src/core-open/scanners/pypi-cache.js';
import { requirementsSection, scanPythonProjects } from '../src/core-open/scanners/python-scanner.js';
import { FileCache } from '../src/core-open/utils/fs.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const PIPFILE = `[packages]
requests = "==2.31.0"
shared = "==1.2.0"

[dev-packages]
pytest = "==8.3.2"
shared = "==9.9.9"
`;

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

function pypi(): PyPICache {
  return new PyPICache(new Semaphore(1), undefined, true);
}

async function scan(root: string, cache?: FileCache): Promise<ProjectScan[]> {
  return scanPythonProjects(root, pypi(), cache);
}

type Cdx = {
  components: Array<{ name: string; version: string; scope?: string; properties: Array<{ name: string; value: string }> }>;
  dependencies?: unknown;
};

type Spdx = {
  packages: Array<{ name: string }>;
  relationships: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
};

function exported(projects: ProjectScan[], root: string, rootPath: string) {
  const scanArtifact = artifact(projects, rootPath);
  const graph = collectLockfileGraph(scanArtifact, root);
  return {
    cdx: toCycloneDx(scanArtifact, graph) as Cdx,
    spdx: toSpdx(scanArtifact, graph) as Spdx,
  };
}

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

/** Discovery order for one project, so a test can read the dev file first. */
class OrderedManifestCache extends FileCache {
  constructor(private readonly names: readonly string[]) {
    super();
  }

  override async findFiles(rootDir: string, predicate: (name: string) => boolean): Promise<string[]> {
    return this.names.filter((name) => predicate(name)).map((name) => path.join(rootDir, name));
  }
}

describe('sbom export: Pipfile dev-packages and requirements dev files', () => {
  it('classifies dev and test requirements filenames, including dev-requirements.txt', () => {
    expect(requirementsSection('requirements-dev.txt')).toBe('devDependencies');
    expect(requirementsSection('requirements_dev.txt')).toBe('devDependencies');
    expect(requirementsSection('requirements-test.txt')).toBe('devDependencies');
    expect(requirementsSection('dev-requirements.txt')).toBe('devDependencies');
    expect(requirementsSection('requirements.txt')).toBeUndefined();
    expect(requirementsSection('requirements-ci.txt')).toBeUndefined();
  });

  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('exports a Pipfile dev-packages row as a development dependency', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pipfile-dev-'));
    fs.writeFileSync(path.join(root, 'Pipfile'), PIPFILE);

    const projects = await scan(root);
    const again = await scan(root);
    expect(again).toEqual(projects);

    const byPackage = new Map(projects[0]!.dependencies.map((dep) => [dep.package, dep]));
    expect(byPackage.get('pytest')?.section).toBe('devDependencies');
    expect(byPackage.get('pytest')?.currentSpec).toBe('==8.3.2');
    expect(byPackage.get('requests')?.section).toBe('dependencies');
    expect(byPackage.get('requests')?.currentSpec).toBe('==2.31.0');
    expect(byPackage.get('shared')?.section).toBe('dependencies');
    expect(byPackage.get('shared')?.currentSpec).toBe('==1.2.0');
    expect(byPackage.get('shared')?.resolvedVersion).toBe('1.2.0');

    const { cdx, spdx } = exported(projects, root, 'pipfile-dev');
    expect(vibScope(cdx, 'pytest')).toBe('direct');
    expect(scopeOf(cdx, 'pytest')).toBe('excluded');
    expect(vibScope(cdx, 'requests')).toBe('direct');
    expect(scopeOf(cdx, 'requests')).toBeUndefined();
    expect(vibScope(cdx, 'shared')).toBe('direct');
    expect(scopeOf(cdx, 'shared')).toBeUndefined();
    expect(cdx.components.find((row) => row.name === 'shared')?.version).toBe('1.2.0');
    expect(cdx.dependencies).toBeUndefined();
    expect(devRels(spdx).sort()).toEqual(['pytest']);
    for (const rel of spdx.relationships.filter((row) => row.relationshipType === 'DEV_DEPENDENCY_OF')) {
      expect(rel.relatedSpdxElementId).toBe('SPDXRef-DOCUMENT');
    }
  });

  it('exports dev and test requirements files as development dependencies', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-requirements-dev-'));
    fs.writeFileSync(path.join(root, 'requirements.txt'), 'flask==3.0.3\n');
    fs.writeFileSync(path.join(root, 'requirements-dev.txt'), 'pytest==8.3.2\n');
    fs.writeFileSync(path.join(root, 'requirements_dev.txt'), 'coverage==7.6.0\n');
    fs.writeFileSync(path.join(root, 'requirements-test.txt'), 'tox==4.11.0\n');
    fs.writeFileSync(path.join(root, 'requirements-ci.txt'), 'ruff==0.6.9\n');

    const projects = await scan(root);
    const again = await scan(root);
    expect(again).toEqual(projects);

    const byPackage = new Map(projects[0]!.dependencies.map((dep) => [dep.package, dep]));
    expect(byPackage.get('flask')?.section).toBe('dependencies');
    expect(byPackage.get('pytest')?.section).toBe('devDependencies');
    expect(byPackage.get('coverage')?.section).toBe('devDependencies');
    expect(byPackage.get('tox')?.section).toBe('devDependencies');
    expect(byPackage.get('ruff')?.section).toBe('dependencies');

    const { cdx, spdx } = exported(projects, root, 'requirements-dev');
    expect(vibScope(cdx, 'pytest')).toBe('direct');
    expect(scopeOf(cdx, 'pytest')).toBe('excluded');
    expect(scopeOf(cdx, 'coverage')).toBe('excluded');
    expect(scopeOf(cdx, 'tox')).toBe('excluded');
    expect(scopeOf(cdx, 'flask')).toBeUndefined();
    expect(scopeOf(cdx, 'ruff')).toBeUndefined();
    expect(vibScope(cdx, 'flask')).toBe('direct');
    expect(vibScope(cdx, 'ruff')).toBe('direct');
    expect(cdx.dependencies).toBeUndefined();
    expect(devRels(spdx).sort()).toEqual(['coverage', 'pytest', 'tox']);
    for (const rel of spdx.relationships.filter((row) => row.relationshipType === 'DEV_DEPENDENCY_OF')) {
      expect(rel.relatedSpdxElementId).toBe('SPDXRef-DOCUMENT');
    }
  });

  it('keeps a name listed in requirements.txt and requirements-dev.txt as production in either file order', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-requirements-order-'));
    fs.writeFileSync(path.join(root, 'requirements.txt'), 'flask==3.0.3\nshared==2.0.0\n');
    fs.writeFileSync(path.join(root, 'requirements-dev.txt'), 'pytest==8.3.2\nshared==9.9.9\n');

    const devFirst = await scan(root, new OrderedManifestCache(['requirements-dev.txt', 'requirements.txt']));
    const prodFirst = await scan(root, new OrderedManifestCache(['requirements.txt', 'requirements-dev.txt']));
    const devExport = exported(devFirst, root, 'requirements-order');
    const prodExport = exported(prodFirst, root, 'requirements-order');
    expect(JSON.stringify(prodExport.cdx)).toBe(JSON.stringify(devExport.cdx));
    expect(JSON.stringify(prodExport.spdx)).toBe(JSON.stringify(devExport.spdx));

    const byPackage = new Map(devFirst[0]!.dependencies.map((dep) => [dep.package, dep]));
    expect(byPackage.get('shared')?.section).toBe('dependencies');
    expect(byPackage.get('shared')?.currentSpec).toBe('==2.0.0');
    expect(byPackage.get('shared')?.resolvedVersion).toBe('2.0.0');
    expect(byPackage.get('flask')?.section).toBe('dependencies');
    expect(byPackage.get('pytest')?.section).toBe('devDependencies');
    expect(byPackage.get('pytest')?.currentSpec).toBe('==8.3.2');

    expect(scopeOf(devExport.cdx, 'shared')).toBeUndefined();
    expect(devExport.cdx.components.find((row) => row.name === 'shared')?.version).toBe('2.0.0');
    expect(scopeOf(devExport.cdx, 'pytest')).toBe('excluded');
    expect(scopeOf(devExport.cdx, 'flask')).toBeUndefined();
    expect(devRels(devExport.spdx).sort()).toEqual(['pytest']);
  });
});
