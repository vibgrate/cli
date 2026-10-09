/**
 * Pins the documented `vg sbom export` contract for several resolved versions
 * of one package: identity, dedup, scope, order, and the known limitations
 * (artifact order, last lockfile path wins the edges, PyPI purl folding).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { DependencyRow, ProjectScan, ScanArtifact } from '../src/reporting/types.js';

function dep(name: string, version: string): DependencyRow {
  return {
    package: name,
    section: 'dependencies',
    currentSpec: version,
    resolvedVersion: version,
    latestStable: version,
    majorsBehind: 0,
    drift: 'current',
  };
}

function project(name: string, relPath: string, deps: DependencyRow[]): ProjectScan {
  return {
    type: 'node',
    path: relPath,
    name,
    frameworks: [],
    dependencies: deps,
    dependencyAgeBuckets: { current: deps.length, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
  };
}

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'shared',
    drift: {
      score: 10,
      riskLevel: 'low',
      components: { runtimeScore: 10, frameworkScore: 10, dependencyScore: 10, eolScore: 10 },
    },
    findings: [],
    projects,
  };
}

/** npm package-lock v3. Key order is the order edges are visited. */
function lockfile(packageOrder: 'other-last' | 'widget-last'): Record<string, unknown> {
  const top = {
    name: 'shared-root',
    version: '1.0.0',
    dependencies: { 'left-pad': '1.3.0', widget: '1.0.0' },
  };
  const hoisted = { version: '1.3.0' };
  const widget = { version: '1.0.0', dependencies: { 'left-pad': '1.2.0' } };
  const nestedViaWidget = { version: '1.2.0', dependencies: { once: '1.4.0' } };
  const once140 = { version: '1.4.0' };
  const nestedViaOther = { version: '1.2.0', dependencies: { once: '1.3.0' } };
  const once130 = { version: '1.3.0' };
  const packages: Record<string, unknown> = { '': top };
  packages['node_modules/left-pad'] = hoisted;
  packages['node_modules/widget'] = widget;
  if (packageOrder === 'other-last') {
    packages['node_modules/widget/node_modules/left-pad'] = nestedViaWidget;
    packages['node_modules/widget/node_modules/left-pad/node_modules/once'] = once140;
    packages['node_modules/other/node_modules/left-pad'] = nestedViaOther;
    packages['node_modules/other/node_modules/left-pad/node_modules/once'] = once130;
  } else {
    packages['node_modules/other/node_modules/left-pad'] = nestedViaOther;
    packages['node_modules/other/node_modules/left-pad/node_modules/once'] = once130;
    packages['node_modules/widget/node_modules/left-pad'] = nestedViaWidget;
    packages['node_modules/widget/node_modules/left-pad/node_modules/once'] = once140;
  }
  return { name: 'shared-root', lockfileVersion: 3, requires: true, packages };
}

function scopeOf(properties: Array<{ name: string; value: string }>, key: string): string | undefined {
  return properties.find((p) => p.name === key)?.value;
}

describe('sbom export: several versions of one package', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sbom-versions-'));
    fs.mkdirSync(path.join(root, 'extra'));
    fs.writeFileSync(
      path.join(root, 'extra', 'package-lock.json'),
      JSON.stringify({
        name: 'shared-extra',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'shared-extra', dependencies: { 'left-pad': '1.3.0' } },
          'node_modules/left-pad': { version: '1.3.0' },
          'node_modules/ms': { version: '2.1.3' },
        },
      }),
    );
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function scanned(): ScanArtifact {
    return artifact([
      project('shared-root', '.', [dep('left-pad', '1.3.0'), dep('widget', '1.0.0')]),
      project('shared-extra', 'extra', [dep('left-pad', '1.3.0'), dep('once', '1.4.0')]),
    ]);
  }

  function writeRootLock(order: 'other-last' | 'widget-last'): void {
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lockfile(order)));
  }

  it('keeps two versions, dedupes name@version, and repeats byte-for-byte', () => {
    writeRootLock('other-last');
    const scan = scanned();
    const graph = collectLockfileGraph(scan, root);
    const cdx = toCycloneDx(scan, graph) as {
      serialNumber: string;
      components: Array<{
        name: string;
        version: string;
        purl: string;
        'bom-ref': string;
        properties: Array<{ name: string; value: string }>;
      }>;
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    const again = toCycloneDx(scan, graph);
    expect(JSON.stringify(again)).toBe(JSON.stringify(cdx));
    expect(toSpdx(scan, graph)).toEqual(toSpdx(scan, collectLockfileGraph(scan, root)));

    const rows = cdx.components.map((c) => ({
      name: c.name,
      version: c.version,
      bom: c['bom-ref'],
      purl: c.purl,
      scope: scopeOf(c.properties, 'vibgrate:scope'),
      project: scopeOf(c.properties, 'vibgrate:project'),
    }));
    expect(rows).toEqual([
      { name: 'left-pad', version: '1.2.0', bom: 'pkg:npm/left-pad@1.2.0', purl: 'pkg:npm/left-pad@1.2.0', scope: 'transitive', project: 'shared-root' },
      { name: 'left-pad', version: '1.3.0', bom: 'pkg:npm/left-pad@1.3.0', purl: 'pkg:npm/left-pad@1.3.0', scope: 'direct', project: 'shared-root' },
      { name: 'ms', version: '2.1.3', bom: 'pkg:npm/ms@2.1.3', purl: 'pkg:npm/ms@2.1.3', scope: 'transitive', project: 'shared-extra' },
      { name: 'once', version: '1.3.0', bom: 'pkg:npm/once@1.3.0', purl: 'pkg:npm/once@1.3.0', scope: 'transitive', project: 'shared-root' },
      { name: 'once', version: '1.4.0', bom: 'pkg:npm/once@1.4.0', purl: 'pkg:npm/once@1.4.0', scope: 'direct', project: 'shared-extra' },
      { name: 'widget', version: '1.0.0', bom: 'pkg:npm/widget@1.0.0', purl: 'pkg:npm/widget@1.0.0', scope: 'direct', project: 'shared-root' },
    ]);
    expect(new Set(rows.map((r) => r.bom)).size).toBe(rows.length);

    // The later `packages` path of left-pad@1.2.0 (other → once@1.3.0) supplies the edge.
    // ms exists only in the nested lockfile, so the root graph leaves it with no edges.
    expect(cdx.dependencies).toEqual([
      { ref: 'vibgrate-root', dependsOn: ['pkg:npm/left-pad@1.3.0', 'pkg:npm/widget@1.0.0'] },
      { ref: 'pkg:npm/left-pad@1.2.0', dependsOn: ['pkg:npm/once@1.3.0'] },
      { ref: 'pkg:npm/left-pad@1.3.0', dependsOn: [] },
      { ref: 'pkg:npm/ms@2.1.3', dependsOn: [] },
      { ref: 'pkg:npm/once@1.3.0', dependsOn: [] },
      { ref: 'pkg:npm/once@1.4.0', dependsOn: [] },
      { ref: 'pkg:npm/widget@1.0.0', dependsOn: ['pkg:npm/left-pad@1.2.0'] },
    ]);

    const spdx = toSpdx(scan, graph) as {
      packages: Array<{
        SPDXID: string;
        name: string;
        versionInfo: string;
        externalRefs: Array<{ referenceLocator: string }>;
        annotations: Array<{ comment: string }>;
      }>;
      relationships: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
    };
    expect(spdx.packages.map((p) => [p.SPDXID, p.name, p.versionInfo, p.externalRefs[0]!.referenceLocator])).toEqual([
      ['SPDXRef-Package-1', 'left-pad', '1.2.0', 'pkg:npm/left-pad@1.2.0'],
      ['SPDXRef-Package-2', 'left-pad', '1.3.0', 'pkg:npm/left-pad@1.3.0'],
      ['SPDXRef-Package-3', 'ms', '2.1.3', 'pkg:npm/ms@2.1.3'],
      ['SPDXRef-Package-4', 'once', '1.3.0', 'pkg:npm/once@1.3.0'],
      ['SPDXRef-Package-5', 'once', '1.4.0', 'pkg:npm/once@1.4.0'],
      ['SPDXRef-Package-6', 'widget', '1.0.0', 'pkg:npm/widget@1.0.0'],
    ]);
    expect(spdx.packages[1]!.annotations[0]!.comment).toContain('scope=direct');
    expect(spdx.packages[0]!.annotations[0]!.comment).toContain('scope=transitive');
    expect(spdx.relationships).toEqual([
      { spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElementId: 'SPDXRef-Package-2', relationshipType: 'DEPENDS_ON' },
      { spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElementId: 'SPDXRef-Package-6', relationshipType: 'DEPENDS_ON' },
      { spdxElementId: 'SPDXRef-Package-1', relatedSpdxElementId: 'SPDXRef-Package-4', relationshipType: 'DEPENDS_ON' },
      { spdxElementId: 'SPDXRef-Package-6', relatedSpdxElementId: 'SPDXRef-Package-1', relationshipType: 'DEPENDS_ON' },
    ]);
  });

  it('uses the last lockfile path when one version is installed twice', () => {
    writeRootLock('other-last');
    const scan = scanned();
    const first = toCycloneDx(scan, collectLockfileGraph(scan, root)) as {
      serialNumber: string;
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    writeRootLock('widget-last');
    const second = toCycloneDx(scan, collectLockfileGraph(scan, root)) as {
      serialNumber: string;
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    const edge = (doc: typeof first): string[] => doc.dependencies.find((d) => d.ref === 'pkg:npm/left-pad@1.2.0')!.dependsOn;
    expect(edge(first)).toEqual(['pkg:npm/once@1.3.0']);
    expect(edge(second)).toEqual(['pkg:npm/once@1.4.0']);
    expect(second.serialNumber).not.toBe(first.serialNumber);
  });

  it('keeps attribution from artifact project order and assigns SPDX IDs from the stable component order', () => {
    writeRootLock('other-last');
    const forward = scanned();
    const reversed = artifact([...forward.projects].reverse());
    const graph = collectLockfileGraph(forward, root);
    const a = toCycloneDx(forward, graph) as {
      serialNumber: string;
      components: Array<{ name: string; version: string; purl: string; properties: Array<{ name: string; value: string }> }>;
    };
    const b = toCycloneDx(reversed, graph) as typeof a;
    const left = (doc: typeof a) => doc.components.find((c) => c.name === 'left-pad' && c.version === '1.3.0')!;
    expect(left(a).purl).toBe('pkg:npm/left-pad@1.3.0');
    expect(left(b).purl).toBe(left(a).purl);
    expect(scopeOf(left(a).properties, 'vibgrate:project')).toBe('shared-root');
    expect(scopeOf(left(b).properties, 'vibgrate:project')).toBe('shared-extra');
    expect(b.serialNumber).not.toBe(a.serialNumber);

    const spdxA = toSpdx(forward, graph) as { packages: Array<{ SPDXID: string; name: string }> };
    const spdxB = toSpdx(reversed, graph) as { packages: Array<{ SPDXID: string; name: string }> };
    expect(spdxA.packages.map((p) => p.SPDXID)).toEqual(spdxB.packages.map((p) => p.SPDXID));
    expect(spdxA.packages.find((p) => p.name === 'widget')!.SPDXID).toBe('SPDXRef-Package-6');
    expect(spdxB.packages.find((p) => p.name === 'widget')!.SPDXID).toBe(spdxA.packages.find((p) => p.name === 'widget')!.SPDXID);
  });

  it('omits lockfile-only versions when the lockfile graph is absent (--no-transitive)', () => {
    const scan = scanned();
    const cdx = toCycloneDx(scan) as {
      components: Array<{ name: string; version: string; properties: Array<{ name: string; value: string }> }>;
      dependencies?: unknown;
    };
    expect(cdx.components.map((c) => `${c.name}@${c.version}`)).toEqual(['left-pad@1.3.0', 'once@1.4.0', 'widget@1.0.0']);
    expect(cdx.components.map((c) => scopeOf(c.properties, 'vibgrate:scope'))).toEqual(['direct', 'direct', 'direct']);
    expect(cdx.dependencies).toBeUndefined();
    const spdx = toSpdx(scan) as { packages: Array<{ name: string; versionInfo: string }>; relationships?: unknown };
    expect(spdx.packages.map((p) => `${p.name}@${p.versionInfo}`)).toEqual(['left-pad@1.3.0', 'once@1.4.0', 'widget@1.0.0']);
    expect(spdx.relationships).toBeUndefined();
  });

  it('emits one CycloneDX bom-ref for two PyPI spellings of the same version', () => {
    const py = (name: string): ProjectScan => ({
      ...project(name, name, [dep(name === 'a' ? 'Flask' : 'flask', '3.0.0')]),
      type: 'python',
    });
    const scan = artifact([py('a'), py('b')]);
    const cdx = toCycloneDx(scan) as { components: Array<{ name: string; purl: string; 'bom-ref': string }> };
    expect(cdx.components.map((c) => c.name)).toEqual(['Flask', 'flask']);
    expect(cdx.components.map((c) => c.purl)).toEqual(['pkg:pypi/flask@3.0.0', 'pkg:pypi/flask@3.0.0']);
    expect(cdx.components.map((c) => c['bom-ref'])).toEqual(['pkg:pypi/flask@3.0.0', 'pkg:pypi/flask@3.0.0']);
    const spdx = toSpdx(scan) as {
      packages: Array<{ SPDXID: string; externalRefs: Array<{ referenceLocator: string }> }>;
    };
    expect(spdx.packages.map((p) => p.SPDXID)).toEqual(['SPDXRef-Package-1', 'SPDXRef-Package-2']);
    expect(spdx.packages.map((p) => p.externalRefs[0]!.referenceLocator)).toEqual([
      'pkg:pypi/flask@3.0.0',
      'pkg:pypi/flask@3.0.0',
    ]);
  });
});
