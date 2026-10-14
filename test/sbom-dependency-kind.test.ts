/**
 * Pins CycloneDX component `scope` and SPDX `DEV_DEPENDENCY_OF` /
 * `OPTIONAL_DEPENDENCY_OF` to the manifest section. `vibgrate:scope` stays
 * `direct` or `transitive`. The on-disk fixture matches the example in
 * `docs/sbom-dependency-scope.md`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { DependencyRow, DepSection, ProjectScan, ScanArtifact } from '../src/reporting/types.js';
import type { LockfileGraph } from '../src/engine/lockfile.js';

function dep(name: string, version: string, section: DepSection = 'dependencies'): DependencyRow {
  return {
    package: name,
    section,
    currentSpec: version,
    resolvedVersion: version,
    latestStable: version,
    majorsBehind: 0,
    drift: 'current',
  };
}

function project(name: string, deps: DependencyRow[], relPath = '.'): ProjectScan {
  return {
    type: 'node',
    path: relPath,
    name,
    frameworks: [],
    dependencies: deps,
    dependencyAgeBuckets: { current: deps.length, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
  };
}

function artifact(projects: ProjectScan[], rootPath = 'scope-fixture'): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath,
    drift: {
      score: 10,
      riskLevel: 'low',
      components: { runtimeScore: 10, frameworkScore: 10, dependencyScore: 10, eolScore: 10 },
    },
    findings: [],
    projects,
  };
}

function prop(properties: Array<{ name: string; value: string }>, name: string): string | undefined {
  return properties.find((entry) => entry.name === name)?.value;
}

interface CdxComponent {
  name: string;
  version: string;
  scope?: string;
  purl?: string;
  properties: Array<{ name: string; value: string }>;
}

interface SpdxRelationship {
  spdxElementId: string;
  relatedSpdxElementId: string;
  relationshipType: string;
}

describe('sbom export: manifest section kind', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sbom-kind-'));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function writeScopeLock(): void {
    fs.writeFileSync(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'scope-fixture',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: 'scope-fixture',
            version: '1.0.0',
            dependencies: { 'left-pad': '1.3.0' },
            devDependencies: { typescript: '5.4.5' },
            optionalDependencies: { fsevents: '2.3.3' },
          },
          'node_modules/left-pad': { version: '1.3.0', dependencies: { 'nested-prod': '1.0.0' } },
          'node_modules/nested-prod': { version: '1.0.0' },
          'node_modules/typescript': { version: '5.4.5', dev: true, dependencies: { 'nested-dev': '1.0.0' } },
          'node_modules/nested-dev': { version: '1.0.0', dev: true },
          'node_modules/fsevents': { version: '2.3.3', optional: true },
          'node_modules/dev-optional-pkg': { version: '1.2.3', dev: true, optional: true, devOptional: true },
        },
      }),
    );
  }

  function scopeScan(order: 'declared' | 'reversed' = 'declared'): ScanArtifact {
    const rows = [
      dep('left-pad', '1.3.0', 'dependencies'),
      dep('typescript', '5.4.5', 'devDependencies'),
      dep('fsevents', '2.3.3', 'optionalDependencies'),
    ];
    return artifact([project('scope-fixture', order === 'declared' ? rows : [...rows].reverse())]);
  }

  it('marks production, development, and optional rows in the scope-fixture example', () => {
    writeScopeLock();
    const scan = scopeScan();
    const graph = collectLockfileGraph(scan, root);
    const cdx = toCycloneDx(scan, graph) as {
      serialNumber: string;
      components: CdxComponent[];
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    expect(JSON.stringify(toCycloneDx(scan, graph))).toBe(JSON.stringify(cdx));
    expect(JSON.stringify(toCycloneDx(scopeScan('reversed'), graph))).toBe(JSON.stringify(cdx));

    const row = (name: string): CdxComponent => cdx.components.find((component) => component.name === name)!;
    expect(cdx.components.map((component) => component.name)).toEqual([
      'dev-optional-pkg',
      'fsevents',
      'left-pad',
      'nested-dev',
      'nested-prod',
      'typescript',
    ]);
    expect(row('left-pad').scope).toBe('required');
    expect(row('fsevents').scope).toBe('optional');
    expect(row('typescript').scope).toBe('excluded');
    expect(row('dev-optional-pkg').scope).toBeUndefined();
    expect(row('nested-dev').scope).toBeUndefined();
    expect(row('nested-prod').scope).toBeUndefined();
    expect(prop(row('left-pad').properties, 'vibgrate:scope')).toBe('direct');
    expect(prop(row('typescript').properties, 'vibgrate:scope')).toBe('direct');
    expect(prop(row('fsevents').properties, 'vibgrate:scope')).toBe('direct');
    expect(prop(row('nested-prod').properties, 'vibgrate:scope')).toBe('transitive');
    expect(prop(row('dev-optional-pkg').properties, 'vibgrate:scope')).toBe('transitive');

    expect(cdx.dependencies).toEqual([
      { ref: 'vibgrate-root', dependsOn: ['pkg:npm/fsevents@2.3.3', 'pkg:npm/left-pad@1.3.0'] },
      { ref: 'pkg:npm/dev-optional-pkg@1.2.3', dependsOn: [] },
      { ref: 'pkg:npm/fsevents@2.3.3', dependsOn: [] },
      { ref: 'pkg:npm/left-pad@1.3.0', dependsOn: ['pkg:npm/nested-prod@1.0.0'] },
      { ref: 'pkg:npm/nested-dev@1.0.0', dependsOn: [] },
      { ref: 'pkg:npm/nested-prod@1.0.0', dependsOn: [] },
      { ref: 'pkg:npm/typescript@5.4.5', dependsOn: ['pkg:npm/nested-dev@1.0.0'] },
    ]);

    const spdx = toSpdx(scan, graph) as {
      packages: Array<{ SPDXID: string; name: string; annotations: Array<{ comment: string }> }>;
      relationships: SpdxRelationship[];
    };
    expect(JSON.stringify(toSpdx(scan, graph))).toBe(JSON.stringify(spdx));
    expect(spdx.packages.map((pkg) => [pkg.SPDXID, pkg.name])).toEqual([
      ['SPDXRef-Package-1', 'dev-optional-pkg'],
      ['SPDXRef-Package-2', 'fsevents'],
      ['SPDXRef-Package-3', 'left-pad'],
      ['SPDXRef-Package-4', 'nested-dev'],
      ['SPDXRef-Package-5', 'nested-prod'],
      ['SPDXRef-Package-6', 'typescript'],
    ]);
    expect(spdx.packages.find((pkg) => pkg.name === 'typescript')!.annotations[0]!.comment).toContain('scope=direct');
    expect(spdx.packages.find((pkg) => pkg.name === 'nested-prod')!.annotations[0]!.comment).toContain('scope=transitive');
    expect(spdx.relationships).toEqual([
      { spdxElementId: 'SPDXRef-Package-2', relatedSpdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'OPTIONAL_DEPENDENCY_OF' },
      { spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElementId: 'SPDXRef-Package-3', relationshipType: 'DEPENDS_ON' },
      { spdxElementId: 'SPDXRef-Package-6', relatedSpdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DEV_DEPENDENCY_OF' },
      { spdxElementId: 'SPDXRef-Package-3', relatedSpdxElementId: 'SPDXRef-Package-5', relationshipType: 'DEPENDS_ON' },
      { spdxElementId: 'SPDXRef-Package-6', relatedSpdxElementId: 'SPDXRef-Package-4', relationshipType: 'DEPENDS_ON' },
    ]);
  });

  it('keeps a peer as DEPENDS_ON and omits CycloneDX scope', () => {
    const scan = artifact([
      project('app', [dep('react', '18.2.0', 'peerDependencies'), dep('left-pad', '1.3.0', 'dependencies')]),
    ]);
    const graph: LockfileGraph = {
      components: [
        { package: 'react', version: '18.2.0' },
        { package: 'left-pad', version: '1.3.0' },
      ],
      edges: new Map([['react@18.2.0', ['loose-envify@1.4.0']]]),
      rootDependsOn: ['left-pad@1.3.0', 'react@18.2.0'],
    };
    const cdx = toCycloneDx(scan, graph) as { components: CdxComponent[] };
    const react = cdx.components.find((component) => component.name === 'react')!;
    const leftPad = cdx.components.find((component) => component.name === 'left-pad')!;
    expect(react.scope).toBeUndefined();
    expect(leftPad.scope).toBe('required');
    expect(prop(react.properties, 'vibgrate:scope')).toBe('direct');

    const spdx = toSpdx(scan, graph) as { relationships: SpdxRelationship[] };
    const documentEdges = spdx.relationships.filter((rel) => rel.spdxElementId === 'SPDXRef-DOCUMENT' || rel.relatedSpdxElementId === 'SPDXRef-DOCUMENT');
    expect(documentEdges).toEqual([
      { spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElementId: 'SPDXRef-Package-1', relationshipType: 'DEPENDS_ON' },
      { spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElementId: 'SPDXRef-Package-2', relationshipType: 'DEPENDS_ON' },
    ]);
  });

  it('writes one DEV_DEPENDENCY_OF when the lockfile root list already contains the dev package', () => {
    const scan = artifact([project('app', [dep('typescript', '5.4.5', 'devDependencies')])]);
    const graph: LockfileGraph = {
      components: [{ package: 'typescript', version: '5.4.5' }],
      edges: new Map(),
      rootDependsOn: ['typescript@5.4.5'],
    };
    const spdx = toSpdx(scan, graph) as { relationships: SpdxRelationship[] };
    expect(spdx.relationships).toEqual([
      { spdxElementId: 'SPDXRef-Package-1', relatedSpdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DEV_DEPENDENCY_OF' },
    ]);
  });

  it('sets scope without a graph and omits SPDX relationships', () => {
    const scan = artifact([
      project('app', [
        dep('left-pad', '1.3.0', 'dependencies'),
        dep('typescript', '5.4.5', 'devDependencies'),
        dep('fsevents', '2.3.3', 'optionalDependencies'),
      ]),
    ]);
    const cdx = toCycloneDx(scan) as { components: CdxComponent[]; dependencies?: unknown };
    expect(cdx.dependencies).toBeUndefined();
    expect(cdx.components.map((component) => [component.name, component.scope])).toEqual([
      ['fsevents', 'optional'],
      ['left-pad', 'required'],
      ['typescript', 'excluded'],
    ]);
    const spdx = toSpdx(scan) as { relationships?: unknown };
    expect(spdx.relationships).toBeUndefined();
  });

  it('omits OPTIONAL_DEPENDENCY_OF when the optional row has no install path', () => {
    const optional = dep('fsevents', '^2.3.3', 'optionalDependencies');
    optional.resolvedVersion = null;
    const scan = artifact([project('app', [dep('left-pad', '1.3.0', 'dependencies'), optional])]);
    const graph: LockfileGraph = {
      components: [{ package: 'left-pad', version: '1.3.0' }],
      edges: new Map(),
      rootDependsOn: ['left-pad@1.3.0'],
    };
    const cdx = toCycloneDx(scan, graph) as { components: CdxComponent[] };
    const fsevents = cdx.components.find((component) => component.name === 'fsevents')!;
    expect(fsevents.version).toBe('unknown');
    expect(fsevents.scope).toBe('optional');
    const spdx = toSpdx(scan, graph) as { relationships: SpdxRelationship[] };
    expect(spdx.relationships).toEqual([
      { spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElementId: 'SPDXRef-Package-2', relationshipType: 'DEPENDS_ON' },
    ]);
    expect(spdx.relationships.some((rel) => rel.relationshipType === 'OPTIONAL_DEPENDENCY_OF')).toBe(false);
  });

  it('changes the document id when only the manifest section changes', () => {
    const production = artifact([project('app', [dep('left-pad', '1.3.0', 'dependencies')])]);
    const development = artifact([project('app', [dep('left-pad', '1.3.0', 'devDependencies')])]);
    const prodDoc = toCycloneDx(production) as { serialNumber: string; components: CdxComponent[] };
    const devDoc = toCycloneDx(development) as { serialNumber: string; components: CdxComponent[] };
    expect(prodDoc.components[0]!.scope).toBe('required');
    expect(devDoc.components[0]!.scope).toBe('excluded');
    expect(devDoc.serialNumber).not.toBe(prodDoc.serialNumber);
    expect((toSpdx(development) as { documentNamespace: string }).documentNamespace).not.toBe(
      (toSpdx(production) as { documentNamespace: string }).documentNamespace,
    );
  });

  it('keeps the first project section when a later project disagrees', () => {
    const scan = artifact([
      project('api', [dep('left-pad', '1.3.0', 'dependencies')]),
      project('web', [dep('left-pad', '1.3.0', 'devDependencies')], 'web'),
    ]);
    const cdx = toCycloneDx(scan) as { components: CdxComponent[] };
    expect(cdx.components).toHaveLength(1);
    expect(cdx.components[0]!.scope).toBe('required');
    expect(prop(cdx.components[0]!.properties, 'vibgrate:scope')).toBe('direct');
    expect(prop(cdx.components[0]!.properties, 'vibgrate:mergeWarning')).toContain('Dropped differing manifest metadata');
  });
});
