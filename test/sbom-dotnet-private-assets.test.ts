/**
 * .NET `PrivateAssets="all"` is a dev manifest row, in attribute form and in
 * child-element form. The match ignores letter case and surrounding spaces.
 * Any other value stays production. The same package referenced again without
 * `PrivateAssets="all"` stays production, and that production reference
 * supplies the version. Age buckets still count every kept row.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDotnetProjects } from '../src/core-open/scanners/dotnet-scanner.js';
import { NuGetCache } from '../src/core-open/scanners/nuget-cache.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/dotnet-private-assets/App.csproj', import.meta.url));

/** package → section. Order is the scanner's code-unit sort (all drift unknown). */
const SECTIONS: Array<[string, string]> = [
  ['Microsoft.CodeAnalysis.NetAnalyzers', 'devDependencies'],
  ['Microsoft.SourceLink.GitHub', 'devDependencies'],
  ['MinVer', 'dependencies'],
  ['Serilog', 'dependencies'],
  ['SonarAnalyzer.CSharp', 'devDependencies'],
  ['StyleCop.Analyzers', 'devDependencies'],
  ['coverlet.collector', 'dependencies'],
];

const DEV = new Set([
  'Microsoft.CodeAnalysis.NetAnalyzers',
  'Microsoft.SourceLink.GitHub',
  'SonarAnalyzer.CSharp',
  'StyleCop.Analyzers',
]);

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'dotnet-private-assets',
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

describe('sbom export: .NET PrivateAssets=all', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('marks build-only references as dev and keeps a production duplicate', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-dotnet-private-assets-'));
    fs.copyFileSync(FIXTURE, path.join(root, 'App.csproj'));

    const projects = await scanDotnetProjects(root, new NuGetCache(new Semaphore(1), undefined, true));
    expect(projects).toHaveLength(1);
    const project = projects[0]!;
    expect(project.dependencies.map((dep) => [dep.package, dep.section])).toEqual(SECTIONS);
    expect(project.dependencies.find((dep) => dep.package === 'Serilog')?.currentSpec).toBe('3.1.1');
    expect(project.dependencies.find((dep) => dep.package === 'MinVer')?.currentSpec).toBe('4.3.0');
    expect(project.dependencies.find((dep) => dep.package === 'coverlet.collector')?.section).toBe('dependencies');
    expect(project.dependencyAgeBuckets).toEqual({
      current: 0,
      oneBehind: 0,
      twoPlusBehind: 0,
      unknown: SECTIONS.length,
    });

    const scanArtifact = artifact(projects);
    const graph = collectLockfileGraph(scanArtifact, root);
    const cdx = toCycloneDx(scanArtifact, graph) as {
      components: Array<{ name: string; scope?: string; properties: Array<{ name: string; value: string }> }>;
      dependencies?: unknown;
    };
    const byName = new Map(cdx.components.map((component) => [component.name, component]));
    const vibScope = (name: string): string | undefined =>
      byName.get(name)?.properties.find((property) => property.name === 'vibgrate:scope')?.value;

    expect(cdx.components.map((component) => component.name)).toEqual(SECTIONS.map(([name]) => name));
    for (const [name] of SECTIONS) expect(vibScope(name)).toBe('direct');
    expect(cdx.dependencies).toBeUndefined();

    for (const [name] of SECTIONS) {
      expect(byName.get(name)?.scope).toBe(DEV.has(name) ? 'excluded' : undefined);
    }

    const spdx = toSpdx(scanArtifact, graph) as {
      packages: Array<{ name: string; annotations: Array<{ comment: string }> }>;
      relationships: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
    };
    const id = (name: string): string => `SPDXRef-Package-${spdx.packages.findIndex((pkg) => pkg.name === name) + 1}`;
    const rel = (name: string): { relationshipType: string; relatedSpdxElementId: string } | undefined => {
      const element = id(name);
      const found = spdx.relationships.find((row) => row.spdxElementId === element);
      return found
        ? { relationshipType: found.relationshipType, relatedSpdxElementId: found.relatedSpdxElementId }
        : undefined;
    };

    for (const pkg of spdx.packages) {
      expect(pkg.annotations.some((note) => note.comment.includes('scope=direct'))).toBe(true);
    }
    for (const [name] of SECTIONS) {
      expect(rel(name)).toEqual(
        DEV.has(name)
          ? { relationshipType: 'DEV_DEPENDENCY_OF', relatedSpdxElementId: 'SPDXRef-DOCUMENT' }
          : undefined,
      );
    }
    expect(spdx.relationships.some((row) => row.relationshipType === 'DEPENDS_ON')).toBe(false);
  });
});
