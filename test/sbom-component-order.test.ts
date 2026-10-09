/**
 * Component order in `vg sbom export` is the Package URL when one is written,
 * otherwise the name, then the version, then the ecosystem. Two exports of the
 * same fixture match, including when the scan lists projects and dependencies
 * in the opposite order (the order a directory walk can return).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { LockfileGraph } from '../src/engine/lockfile.js';
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
    rootPath: 'order-fixture',
    drift: {
      score: 10,
      riskLevel: 'low',
      components: { runtimeScore: 10, frameworkScore: 10, dependencyScore: 10, eolScore: 10 },
    },
    findings: [],
    projects,
  };
}

function writeLock(root: string, rel: string, body: unknown): void {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(body));
}

/** Same packages; project and dependency arrays run in the other direction. */
function reverseScan(scan: ScanArtifact): ScanArtifact {
  return artifact(
    [...scan.projects].reverse().map((projectScan) => ({
      ...projectScan,
      dependencies: [...projectScan.dependencies].reverse(),
    })),
  );
}

/** Same edges and components, inserted in the opposite order. */
function reverseGraph(graph: LockfileGraph): LockfileGraph {
  const edges = graph.edges
    ? new Map([...graph.edges.entries()].reverse().map(([key, children]) => [key, [...children].reverse()]))
    : undefined;
  return {
    ...graph,
    components: [...graph.components].reverse(),
    edges,
    rootDependsOn: [...graph.rootDependsOn].reverse(),
  };
}

describe('sbom export: stable component order', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sbom-order-'));
    writeLock(root, 'apps/docs', {
      name: 'docs',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'docs', dependencies: { once: '1.4.0' } },
        'node_modules/once': { version: '1.4.0' },
      },
    });
    writeLock(root, 'apps/web', {
      name: 'web',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'web', dependencies: { 'left-pad': '1.3.0', widget: '1.0.0' } },
        'node_modules/left-pad': { version: '1.3.0' },
        'node_modules/widget': { version: '1.0.0', dependencies: { 'ansi-styles': '6.2.1' } },
        'node_modules/ansi-styles': { version: '6.2.1' },
      },
    });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('exports the same component and dependency order twice, independent of scan order', () => {
    const scan = artifact([
      project('web', 'apps/web', [dep('widget', '1.0.0'), dep('left-pad', '1.3.0'), dep('foo bar', '1.0.0')]),
      project('docs', 'apps/docs', [dep('once', '1.4.0')]),
    ]);
    const graph = collectLockfileGraph(scan, root);
    const again = collectLockfileGraph(scan, root);
    expect(graph).toBeDefined();

    const first = toCycloneDx(scan, graph);
    const second = toCycloneDx(scan, again);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(toSpdx(scan, again))).toBe(JSON.stringify(toSpdx(scan, graph)));

    const reversed = toCycloneDx(reverseScan(scan), reverseGraph(graph!));
    const cdx = first as {
      components: Array<{ name: string; purl?: string; 'bom-ref': string }>;
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    const rev = reversed as typeof cdx;
    const identity = (doc: typeof cdx): string[] => doc.components.map((c) => c.purl ?? c['bom-ref']);

    expect(identity(cdx)).toEqual([
      'vibgrate:npm:foo bar@1.0.0',
      'pkg:npm/ansi-styles@6.2.1',
      'pkg:npm/left-pad@1.3.0',
      'pkg:npm/once@1.4.0',
      'pkg:npm/widget@1.0.0',
    ]);
    expect(identity(rev)).toEqual(identity(cdx));
    expect(cdx.dependencies.map((d) => d.ref)).toEqual(['vibgrate-root', ...identity(cdx)]);
    expect(rev.dependencies).toEqual(cdx.dependencies);

    const spdx = toSpdx(scan, graph) as {
      packages: Array<{ name: string; versionInfo: string; SPDXID: string }>;
      relationships: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
    };
    const spdxRev = toSpdx(reverseScan(scan), reverseGraph(graph!)) as typeof spdx;
    expect(spdx.packages.map((p) => `${p.SPDXID} ${p.name}@${p.versionInfo}`)).toEqual([
      'SPDXRef-Package-1 foo bar@1.0.0',
      'SPDXRef-Package-2 ansi-styles@6.2.1',
      'SPDXRef-Package-3 left-pad@1.3.0',
      'SPDXRef-Package-4 once@1.4.0',
      'SPDXRef-Package-5 widget@1.0.0',
    ]);
    expect(spdxRev.packages.map((p) => p.SPDXID)).toEqual(spdx.packages.map((p) => p.SPDXID));
    expect(spdxRev.relationships).toEqual(spdx.relationships);
  });
});
