/**
 * Multi-project lockfile merge for `vg sbom export`.
 *
 * The fixture is two sub-projects. Their lockfiles share left-pad@1.3.0 and
 * install different versions of widget. The shared package's dependency lists
 * differ, so the merge keeps the first project path and warns. Nothing here
 * contacts the network.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectLockfileGraph,
  collectMergeWarnings,
  sbomCommand,
  toCycloneDx,
  toSpdx,
} from '../src/reporting/commands/sbom.js';
import type { DependencyRow, ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/sbom-multi-project');

const LOSSY_EDGE_WARNING =
  'Dropped a different dependency list for npm package "left-pad@1.3.0" from project "web"; kept the list from project "docs".';

function dep(name: string, version: string, drift: DependencyRow['drift'] = 'current', majorsBehind: number | null = 0): DependencyRow {
  return {
    package: name,
    section: 'dependencies',
    currentSpec: version,
    resolvedVersion: version,
    latestStable: version,
    majorsBehind,
    drift,
  };
}

function project(name: string, relPath: string, type: ProjectScan['type'], deps: DependencyRow[]): ProjectScan {
  return {
    type,
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
    rootPath: 'workspace',
    drift: {
      score: 10,
      riskLevel: 'low',
      components: { runtimeScore: 10, frameworkScore: 10, dependencyScore: 10, eolScore: 10 },
    },
    findings: [],
    projects,
  };
}

function copyFixture(root: string): void {
  fs.cpSync(FIXTURE, root, { recursive: true });
}

function scanned(): ScanArtifact {
  return artifact([
    project('web', 'apps/web', 'node', [dep('left-pad', '1.3.0'), dep('widget', '1.0.0')]),
    project('docs', 'apps/docs', 'node', [dep('left-pad', '1.3.0')]),
  ]);
}

function prop(properties: Array<{ name: string; value: string }>, name: string): string | undefined {
  return properties.find((entry) => entry.name === name)?.value;
}

function props(properties: Array<{ name: string; value: string }>, name: string): string[] {
  return properties.filter((entry) => entry.name === name).map((entry) => entry.value);
}

describe('sbom export: multi-project lockfile merge', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sbom-merge-'));
    copyFixture(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps one shared component, records every project, splits versions, and repeats byte-for-byte', () => {
    const scan = scanned();
    const graph = collectLockfileGraph(scan, root);
    const first = toCycloneDx(scan, graph);
    const second = toCycloneDx(scan, collectLockfileGraph(scan, root));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(toSpdx(scan, graph))).toBe(JSON.stringify(toSpdx(scan, collectLockfileGraph(scan, root))));

    const cdx = first as {
      components: Array<{
        name: string;
        version: string;
        purl: string;
        'bom-ref': string;
        properties: Array<{ name: string; value: string }>;
      }>;
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    expect(cdx.components.map((c) => `${c.purl}`)).toEqual([
      'pkg:npm/left-pad@1.3.0',
      'pkg:npm/once@1.3.0',
      'pkg:npm/once@1.4.0',
      'pkg:npm/widget@1.0.0',
      'pkg:npm/widget@2.0.0',
    ]);
    expect(new Set(cdx.components.map((c) => c['bom-ref'])).size).toBe(cdx.components.length);

    const left = cdx.components[0]!;
    expect(prop(left.properties, 'vibgrate:project')).toBe('web');
    expect(prop(left.properties, 'vibgrate:projects')).toBe('docs, web');
    expect(prop(left.properties, 'vibgrate:scope')).toBe('direct');
    expect(props(left.properties, 'vibgrate:mergeWarning')).toEqual([LOSSY_EDGE_WARNING]);

    const widgetOld = cdx.components.find((c) => c.purl === 'pkg:npm/widget@1.0.0')!;
    const widgetNew = cdx.components.find((c) => c.purl === 'pkg:npm/widget@2.0.0')!;
    expect(prop(widgetOld.properties, 'vibgrate:scope')).toBe('direct');
    expect(prop(widgetOld.properties, 'vibgrate:projects')).toBe('web');
    expect(prop(widgetNew.properties, 'vibgrate:scope')).toBe('transitive');
    expect(prop(widgetNew.properties, 'vibgrate:project')).toBe('docs');
    expect(prop(widgetNew.properties, 'vibgrate:projects')).toBe('docs');
    expect(props(widgetOld.properties, 'vibgrate:mergeWarning')).toEqual([]);
    expect(props(widgetNew.properties, 'vibgrate:mergeWarning')).toEqual([]);

    // apps/docs sorts before apps/web, so its dependency list is the one kept.
    // The document root follows that same first lockfile, not web's.
    expect(cdx.dependencies).toEqual([
      { ref: 'vibgrate-root', dependsOn: ['pkg:npm/left-pad@1.3.0', 'pkg:npm/widget@2.0.0'] },
      { ref: 'pkg:npm/left-pad@1.3.0', dependsOn: ['pkg:npm/once@1.3.0'] },
      { ref: 'pkg:npm/once@1.3.0', dependsOn: [] },
      { ref: 'pkg:npm/once@1.4.0', dependsOn: [] },
      { ref: 'pkg:npm/widget@1.0.0', dependsOn: [] },
      { ref: 'pkg:npm/widget@2.0.0', dependsOn: [] },
    ]);

    const spdx = toSpdx(scan, graph) as {
      packages: Array<{ name: string; versionInfo: string; annotations: Array<{ comment: string }> }>;
      relationships: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
    };
    expect(spdx.packages[0]!.annotations[0]!.comment).toContain('project=web');
    expect(spdx.packages[0]!.annotations[0]!.comment).toContain('projects=docs, web');
    expect(spdx.packages[0]!.annotations[0]!.comment).toContain('scope=direct');
    expect(spdx.packages[0]!.annotations.map((a) => a.comment)).toContain(LOSSY_EDGE_WARNING);
    expect(spdx.packages.find((p) => p.name === 'widget' && p.versionInfo === '2.0.0')!.annotations[0]!.comment).toContain(
      'scope=transitive',
    );
    expect(spdx.relationships).toEqual([
      { spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElementId: 'SPDXRef-Package-1', relationshipType: 'DEPENDS_ON' },
      { spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElementId: 'SPDXRef-Package-5', relationshipType: 'DEPENDS_ON' },
      { spdxElementId: 'SPDXRef-Package-1', relatedSpdxElementId: 'SPDXRef-Package-2', relationshipType: 'DEPENDS_ON' },
    ]);
    expect(collectMergeWarnings(scan, graph)).toEqual([LOSSY_EDGE_WARNING]);
  });

  it('does not warn when the shared package has the same dependency list', () => {
    fs.writeFileSync(
      path.join(root, 'apps/docs/package-lock.json'),
      JSON.stringify({
        name: 'docs',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'docs', dependencies: { 'left-pad': '1.3.0', widget: '2.0.0' } },
          'node_modules/left-pad': { version: '1.3.0', dependencies: { once: '1.4.0' } },
          'node_modules/once': { version: '1.4.0' },
          'node_modules/widget': { version: '2.0.0' },
        },
      }),
    );
    const scan = scanned();
    const graph = collectLockfileGraph(scan, root);
    const cdx = toCycloneDx(scan, graph) as {
      components: Array<{ purl: string; properties: Array<{ name: string; value: string }> }>;
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    const again = JSON.stringify(toCycloneDx(scan, collectLockfileGraph(scan, root)));
    expect(again).toBe(JSON.stringify(cdx));
    const left = cdx.components.find((c) => c.purl === 'pkg:npm/left-pad@1.3.0')!;
    expect(prop(left.properties, 'vibgrate:projects')).toBe('docs, web');
    expect(props(left.properties, 'vibgrate:mergeWarning')).toEqual([]);
    expect(cdx.dependencies.find((d) => d.ref === 'pkg:npm/left-pad@1.3.0')!.dependsOn).toEqual(['pkg:npm/once@1.4.0']);
    expect(collectMergeWarnings(scan, graph)).toEqual([]);
    expect(cdx.components.map((c) => c.purl)).toContain('pkg:npm/widget@1.0.0');
    expect(cdx.components.map((c) => c.purl)).toContain('pkg:npm/widget@2.0.0');
  });

  it('keeps contributing projects sorted when the scan artifact lists projects in reverse', () => {
    const forward = scanned();
    const reversed = artifact([...forward.projects].reverse());
    const graph = collectLockfileGraph(forward, root);
    const a = toCycloneDx(forward, graph) as {
      components: Array<{ purl: string; properties: Array<{ name: string; value: string }> }>;
    };
    const b = toCycloneDx(reversed, graph) as typeof a;
    const left = (doc: typeof a) => doc.components.find((c) => c.purl === 'pkg:npm/left-pad@1.3.0')!;
    expect(prop(left(a).properties, 'vibgrate:project')).toBe('web');
    expect(prop(left(b).properties, 'vibgrate:project')).toBe('docs');
    expect(prop(left(a).properties, 'vibgrate:projects')).toBe('docs, web');
    expect(prop(left(b).properties, 'vibgrate:projects')).toBe('docs, web');
    expect(props(left(a).properties, 'vibgrate:mergeWarning')).toEqual(props(left(b).properties, 'vibgrate:mergeWarning'));
  });

  it('gives a Python sub-project its own purl type when the other lockfiles are npm', () => {
    fs.mkdirSync(path.join(root, 'services/api'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'services/api/poetry.lock'),
      ['[[package]]', 'name = "left-pad"', 'version = "1.3.0"', '', '[[package]]', 'name = "click"', 'version = "8.1.7"', ''].join(
        '\n',
      ),
    );
    const scan = artifact([
      ...scanned().projects,
      project('api', 'services/api', 'python', [dep('click', '8.1.7')]),
    ]);
    const graph = collectLockfileGraph(scan, root);
    const cdx = toCycloneDx(scan, graph) as {
      components: Array<{ name: string; version: string; purl: string; properties: Array<{ name: string; value: string }> }>;
    };
    const again = JSON.stringify(toCycloneDx(scan, collectLockfileGraph(scan, root)));
    expect(again).toBe(JSON.stringify(cdx));
    const pads = cdx.components.filter((c) => c.name === 'left-pad' && c.version === '1.3.0');
    expect(pads.map((c) => c.purl).sort()).toEqual(['pkg:npm/left-pad@1.3.0', 'pkg:pypi/left-pad@1.3.0']);
    const py = pads.find((c) => c.purl === 'pkg:pypi/left-pad@1.3.0')!;
    expect(prop(py.properties, 'vibgrate:projects')).toBe('api');
    expect(prop(py.properties, 'vibgrate:scope')).toBe('transitive');
    const click = cdx.components.find((c) => c.purl === 'pkg:pypi/click@8.1.7')!;
    expect(prop(click.properties, 'vibgrate:scope')).toBe('direct');
    expect(prop(click.properties, 'vibgrate:projects')).toBe('api');
    const warnings = collectMergeWarnings(scan, graph);
    expect(warnings).toContain(LOSSY_EDGE_WARNING);
    expect(warnings).toContain(
      'Dependency edges are not recorded for pypi package "left-pad@1.3.0" from project "api". An empty dependsOn is not a claim that the package has no dependencies.',
    );
    expect(warnings).toContain(
      'Dependency edges are not recorded for pypi package "click@8.1.7" from project "api". An empty dependsOn is not a claim that the package has no dependencies.',
    );
    const spdx = toSpdx(scan, graph) as {
      packages: Array<{ name: string; externalRefs: Array<{ referenceLocator: string }>; annotations: Array<{ comment: string }> }>;
    };
    expect(spdx.packages.filter((p) => p.name === 'left-pad').map((p) => p.externalRefs[0]!.referenceLocator).sort()).toEqual([
      'pkg:npm/left-pad@1.3.0',
      'pkg:pypi/left-pad@1.3.0',
    ]);
    expect(spdx.packages.find((p) => p.externalRefs[0]!.referenceLocator === 'pkg:pypi/left-pad@1.3.0')!.annotations.map((a) => a.comment)).toContain(
      'Dependency edges are not recorded for pypi package "left-pad@1.3.0" from project "api". An empty dependsOn is not a claim that the package has no dependencies.',
    );
  });

  it('warns when a project type has no ecosystem and the lockfile is recorded as npm', () => {
    fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'tools/package-lock.json'),
      JSON.stringify({
        name: 'tools',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'tools' },
          'node_modules/poison': { version: '5.0.0' },
        },
      }),
    );
    const scan = artifact([project('tools', 'tools', 'elixir', [])]);
    const graph = collectLockfileGraph(scan, root);
    const warning = 'Ecosystem unknown for elixir project "tools"; package "poison@5.0.0" is recorded as npm.';
    const cdx = toCycloneDx(scan, graph) as {
      components: Array<{ purl: string; properties: Array<{ name: string; value: string }> }>;
    };
    expect(JSON.stringify(toCycloneDx(scan, collectLockfileGraph(scan, root)))).toBe(JSON.stringify(cdx));
    expect(cdx.components.map((c) => c.purl)).toEqual(['pkg:npm/poison@5.0.0']);
    expect(props(cdx.components[0]!.properties, 'vibgrate:mergeWarning')).toEqual([warning]);
    const spdx = toSpdx(scan, graph) as { packages: Array<{ annotations: Array<{ comment: string }> }> };
    expect(spdx.packages[0]!.annotations.map((a) => a.comment)).toContain(warning);
    expect(collectMergeWarnings(scan, graph)).toEqual([warning]);
  });

  it('warns when a later manifest row for the same identity carries different metadata', () => {
    const scan = artifact([
      project('web', 'apps/web', 'node', [dep('left-pad', '1.3.0', 'current', 0)]),
      project('docs', 'apps/docs', 'node', [dep('left-pad', '1.3.0', 'major-behind', 2)]),
    ]);
    const warning =
      'Dropped differing manifest metadata for npm package "left-pad@1.3.0" from project "docs"; kept the row from project "web".';
    const cdx = toCycloneDx(scan) as {
      components: Array<{ purl: string; properties: Array<{ name: string; value: string }> }>;
    };
    expect(cdx.components).toHaveLength(1);
    expect(prop(cdx.components[0]!.properties, 'vibgrate:project')).toBe('web');
    expect(prop(cdx.components[0]!.properties, 'vibgrate:projects')).toBe('docs, web');
    expect(prop(cdx.components[0]!.properties, 'vibgrate:drift')).toBe('current');
    expect(props(cdx.components[0]!.properties, 'vibgrate:mergeWarning')).toEqual([warning]);
    expect(collectMergeWarnings(scan)).toEqual([warning]);
  });

  it('prints merge warnings on stderr and writes the same document on a second run', async () => {
    const scan = scanned();
    const artifactPath = path.join(root, 'scan.json');
    fs.writeFileSync(artifactPath, JSON.stringify(scan));
    const stderr: string[] = [];
    const stdout: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(' '));
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout.push(args.map(String).join(' '));
    });
    try {
      await sbomCommand.parseAsync(['export', '--in', artifactPath, '--root', root, '--format', 'cyclonedx'], { from: 'user' });
      await sbomCommand.parseAsync(['export', '--in', artifactPath, '--root', root, '--format', 'cyclonedx'], { from: 'user' });
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
    expect(stdout).toHaveLength(2);
    expect(stdout[0]).toBe(stdout[1]);
    expect(stdout[0]).toContain('"bomFormat": "CycloneDX"');
    expect(stderr.join('\n')).toContain(`warning [VG_WARN_SBOM_LOSSY_EDGES]: ${LOSSY_EDGE_WARNING}`);
    expect(stderr.join('\n')).not.toContain('http');
  });
});
