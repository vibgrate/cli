/**
 * PEP 735 `[dependency-groups]` and Poetry dependency groups are development
 * manifest rows. `{include-group = "..."}` expands to that group's requirements.
 * Group names are normalised. An include cycle warns once and stops.
 * A name also declared as a production requirement stays production.
 * A name in a dev group and an optional extra, with no production row, stays
 * a development dependency. A name in all three stays optional.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PyPICache } from '../src/core-open/scanners/pypi-cache.js';
import { scanPythonProjects } from '../src/core-open/scanners/python-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const LOCKFILE = `[[package]]
name = "httpx"
version = "0.27.2"

[[package]]
name = "shared"
version = "1.2.0"

[[package]]
name = "psycopg"
version = "3.1.18"

[[package]]
name = "coverage"
version = "7.6.0"

[[package]]
name = "pytest"
version = "8.3.2"

[[package]]
name = "mypy"
version = "1.11.2"

[[package]]
name = "requests"
version = "2.31.0"

[[package]]
name = "black"
version = "24.1.0"

[[package]]
name = "sphinx"
version = "7.2.0"

[[package]]
name = "tox"
version = "4.11.0"

[[package]]
name = "certifi"
version = "2024.7.4"

[[package]]
name = "rich"
version = "13.7.1"
`;

function groupsManifest(order: 'groups-first' | 'project-first'): string {
  const groups = `[dependency-groups]
dev = [
  "pytest>=8",
  "shared>=1",
  "coverage>=7",
  "ruff>=0.6",
  "rich>=13",
  {include-group = "typing"},
]
typing = ["mypy>=1.8"]
`;
  const project = `[project]
name = "app"
dependencies = ["httpx>=0.27", "shared>=1", "rich>=13"]

[project.optional-dependencies]
db = ["psycopg>=3.1"]
check = ["coverage>=7"]
pretty = ["rich>=13"]
`;
  return order === 'groups-first' ? `${groups}\n${project}` : `${project}\n${groups}`;
}

const POETRY_MANIFEST = `[tool.poetry]
name = "app"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
requests = "2.31.0"
shared = "1.2.0"

[tool.poetry.group.dev.dependencies]
pytest = "^8.0.0"
shared = "^1.0.0"
python = "^3.12"

[tool.poetry.group."docs".dependencies]
sphinx = "7.2.0"

[tool.poetry.group.test.dependencies]
black = { version = "24.1.0", optional = true }

[tool.poetry.dev-dependencies]
tox = "4.11.0"
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

describe('sbom export: Python dependency groups', () => {
  let root: string;

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function exportToml(toml: string, rootPath: string) {
    fs.writeFileSync(path.join(root, 'pyproject.toml'), toml);
    fs.writeFileSync(path.join(root, 'poetry.lock'), LOCKFILE);
    const projects = await scan(root);
    const scanArtifact = artifact(projects, rootPath);
    const graph = collectLockfileGraph(scanArtifact, root);
    return {
      projects,
      cdx: toCycloneDx(scanArtifact, graph) as Cdx,
      spdx: toSpdx(scanArtifact, graph) as Spdx,
    };
  }

  it('exports a dependency-group package as a direct development dependency', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pyproject-groups-'));
    const first = await exportToml(groupsManifest('project-first'), 'pyproject-groups');
    const second = await exportToml(groupsManifest('groups-first'), 'pyproject-groups');
    expect(JSON.stringify(second.cdx)).toBe(JSON.stringify(first.cdx));
    expect(JSON.stringify(second.spdx)).toBe(JSON.stringify(first.spdx));

    const byPackage = new Map(first.projects[0]!.dependencies.map((dep) => [dep.package, dep]));
    expect(byPackage.get('pytest')?.section).toBe('devDependencies');
    expect(byPackage.get('mypy')?.section).toBe('devDependencies');
    expect(byPackage.get('ruff')?.section).toBe('devDependencies');
    expect(byPackage.get('coverage')?.section).toBe('devDependencies');
    expect(byPackage.get('shared')?.section).toBe('dependencies');
    expect(byPackage.get('httpx')?.section).toBe('dependencies');
    expect(byPackage.get('psycopg')?.section).toBe('optionalDependencies');
    expect(byPackage.get('rich')?.section).toBe('optionalDependencies');
    expect(byPackage.has('typing')).toBe(false);
    expect(byPackage.has('python')).toBe(false);

    expect(vibScope(first.cdx, 'pytest')).toBe('direct');
    expect(scopeOf(first.cdx, 'pytest')).toBe('excluded');
    expect(vibScope(first.cdx, 'mypy')).toBe('direct');
    expect(scopeOf(first.cdx, 'mypy')).toBe('excluded');
    expect(vibScope(first.cdx, 'ruff')).toBe('direct');
    expect(scopeOf(first.cdx, 'ruff')).toBe('excluded');
    expect(first.cdx.components.find((row) => row.name === 'ruff')?.version).toBe('unknown');
    expect(vibScope(first.cdx, 'coverage')).toBe('direct');
    expect(scopeOf(first.cdx, 'coverage')).toBe('excluded');
    expect(vibScope(first.cdx, 'httpx')).toBe('direct');
    expect(scopeOf(first.cdx, 'httpx')).toBeUndefined();
    expect(vibScope(first.cdx, 'shared')).toBe('direct');
    expect(scopeOf(first.cdx, 'shared')).toBeUndefined();
    expect(scopeOf(first.cdx, 'psycopg')).toBe('optional');
    expect(scopeOf(first.cdx, 'rich')).toBe('optional');
    expect(vibScope(first.cdx, 'certifi')).toBe('transitive');
    expect(scopeOf(first.cdx, 'certifi')).toBeUndefined();
    expect(first.cdx.components.some((row) => row.name === 'typing' || row.name === 'python')).toBe(false);
    expect(first.cdx.dependencies).toBeUndefined();

    expect(devRels(first.spdx).sort()).toEqual(['coverage', 'mypy', 'pytest', 'ruff']);
    const optionalRels = first.spdx.relationships
      .filter((rel) => rel.relationshipType === 'OPTIONAL_DEPENDENCY_OF')
      .map((rel) => first.spdx.packages[Number(rel.spdxElementId.replace('SPDXRef-Package-', '')) - 1]!.name);
    expect(optionalRels.sort()).toEqual(['psycopg', 'rich']);
    expect(first.spdx.relationships.some((rel) => rel.relationshipType === 'DEV_DEPENDENCY_OF' && rel.relatedSpdxElementId !== 'SPDXRef-DOCUMENT')).toBe(false);
  });

  it('exports Poetry dependency groups and legacy dev-dependencies the same way', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pyproject-poetry-groups-'));
    const exported = await exportToml(POETRY_MANIFEST, 'pyproject-poetry-groups');

    const byPackage = new Map(exported.projects[0]!.dependencies.map((dep) => [dep.package, dep]));
    expect(byPackage.get('pytest')?.section).toBe('devDependencies');
    expect(byPackage.get('black')?.section).toBe('devDependencies');
    expect(byPackage.get('sphinx')?.section).toBe('devDependencies');
    expect(byPackage.get('tox')?.section).toBe('devDependencies');
    expect(byPackage.get('requests')?.section).toBe('dependencies');
    expect(byPackage.get('shared')?.section).toBe('dependencies');
    expect(byPackage.has('python')).toBe(false);
    expect(exported.projects[0]!.runtime).toBe('^3.11');

    expect(vibScope(exported.cdx, 'pytest')).toBe('direct');
    expect(scopeOf(exported.cdx, 'pytest')).toBe('excluded');
    expect(scopeOf(exported.cdx, 'black')).toBe('excluded');
    expect(scopeOf(exported.cdx, 'sphinx')).toBe('excluded');
    expect(scopeOf(exported.cdx, 'tox')).toBe('excluded');
    expect(scopeOf(exported.cdx, 'requests')).toBeUndefined();
    expect(scopeOf(exported.cdx, 'shared')).toBeUndefined();
    expect(vibScope(exported.cdx, 'shared')).toBe('direct');
    expect(exported.cdx.components.some((row) => row.name === 'python')).toBe(false);
    expect(exported.cdx.dependencies).toBeUndefined();

    expect(devRels(exported.spdx).sort()).toEqual(['black', 'pytest', 'sphinx', 'tox']);
    for (const rel of exported.spdx.relationships.filter((row) => row.relationshipType === 'DEV_DEPENDENCY_OF')) {
      expect(rel.relatedSpdxElementId).toBe('SPDXRef-DOCUMENT');
    }
  });

  it('expands an included group, including a requirement listed only there', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pyproject-include-group-'));
    fs.writeFileSync(
      path.join(root, 'pyproject.toml'),
      `[project]
name = "app"
dependencies = ["httpx>=0.27"]

[dependency-groups]
dev = [
  {include-group = 'lint'},
  "ruff>=9",
]
lint = [
  {include-group = "typing"},
  "ruff==1.0.0",
  "only-via-include>=2",
  "httpx==1.0.0",
]
typing = ["mypy>=1.8"]
`,
    );
    const projects = await scan(root);
    const byPackage = new Map(projects[0]!.dependencies.map((dep) => [dep.package, dep]));
    // The include is expanded before the later direct requirement, so the
    // included spec is the one kept. Walking arrays and skipping the include
    // would keep ruff>=9 instead.
    expect(byPackage.get('ruff')?.section).toBe('devDependencies');
    expect(byPackage.get('ruff')?.currentSpec).toBe('==1.0.0');
    expect(byPackage.get('only-via-include')?.section).toBe('devDependencies');
    expect(byPackage.get('only-via-include')?.currentSpec).toBe('>=2');
    expect(byPackage.get('mypy')?.section).toBe('devDependencies');
    expect(byPackage.get('mypy')?.currentSpec).toBe('>=1.8');
    expect(byPackage.has('lint')).toBe(false);
    expect(byPackage.has('typing')).toBe(false);
    expect(byPackage.get('httpx')?.section).toBe('dependencies');
    expect(byPackage.get('httpx')?.currentSpec).toBe('>=0.27');
  });

  it('stops an include cycle after one warning', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pyproject-include-cycle-'));
    fs.writeFileSync(
      path.join(root, 'pyproject.toml'),
      `[project]
name = "app"

[dependency-groups]
a = ["alpha>=1", {include-group = "b"}]
b = ["beta>=1", {include-group = "a"}]
`,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const projects = await scan(root);
      const byPackage = new Map(projects[0]!.dependencies.map((dep) => [dep.package, dep]));
      expect(byPackage.get('alpha')?.section).toBe('devDependencies');
      expect(byPackage.get('beta')?.section).toBe('devDependencies');
      expect(byPackage.has('a')).toBe(false);
      expect(byPackage.has('b')).toBe(false);
      const cycles = warn.mock.calls.filter((args) => String(args[0]).includes('include cycle detected'));
      expect(cycles).toHaveLength(1);
      expect(String(cycles[0]![0])).toContain('a, b');
    } finally {
      warn.mockRestore();
    }
  });

  it('normalises dependency group names when resolving include-group', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pyproject-include-normalise-'));
    fs.writeFileSync(
      path.join(root, 'pyproject.toml'),
      `[project]
name = "app"

[dependency-groups]
dev = [
  {include-group = "Dev_Tools"},
  "ruff>=0.9",
]
"dev-tools" = ["ruff==0.6.0", "from-dev-tools>=1"]
`,
    );
    const projects = await scan(root);
    const byPackage = new Map(projects[0]!.dependencies.map((dep) => [dep.package, dep]));
    expect(byPackage.get('ruff')?.section).toBe('devDependencies');
    expect(byPackage.get('ruff')?.currentSpec).toBe('==0.6.0');
    expect(byPackage.get('from-dev-tools')?.section).toBe('devDependencies');
    expect(byPackage.has('Dev_Tools')).toBe(false);
    expect(byPackage.has('dev-tools')).toBe(false);
  });
});
