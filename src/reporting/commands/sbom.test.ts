import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toCycloneDx, toSpdx, formatDeltaText, npmPurl, purlFor, collectLockfileGraph } from './sbom.js';
import type { ProjectScan, ScanArtifact } from '../types.js';
import type { LockfileGraph } from '../../engine/lockfile.js';

/** A graph with no resolved edges — same shape `fullDependencyGraph` returns for pnpm/yarn. */
function componentsOnlyGraph(components: LockfileGraph['components']): LockfileGraph {
  return { components, edges: undefined, rootDependsOn: [] };
}

function makeArtifact(version: string, driftScore: number): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'repo',
    drift: {
      score: driftScore,
      riskLevel: 'moderate',
      components: { runtimeScore: 70, frameworkScore: 70, dependencyScore: 70, eolScore: 70 },
    },
    findings: [],
    projects: [
      {
        type: 'node',
        path: '.',
        name: 'app',
        frameworks: [],
        dependencies: [
          {
            package: 'chalk',
            section: 'dependencies',
            currentSpec: version,
            resolvedVersion: version,
            latestStable: '5.3.0',
            majorsBehind: 0,
            drift: 'current',
          },
        ],
        dependencyAgeBuckets: { current: 1, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
      },
    ],
  };
}

describe('sbom helpers', () => {
  it('exports CycloneDX with components', () => {
    const sbom = toCycloneDx(makeArtifact('5.3.0', 90)) as { bomFormat: string; components: Array<{ name: string }> };
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(sbom.components[0].name).toBe('chalk');
  });

  it('exports SPDX with package entries', () => {
    const sbom = toSpdx(makeArtifact('5.3.0', 90)) as { spdxVersion: string; packages: Array<{ name: string }> };
    expect(sbom.spdxVersion).toBe('SPDX-2.3');
    expect(sbom.packages[0].name).toBe('chalk');
  });

  it('folds lockfile-only packages in as transitive components alongside the direct ones', () => {
    const sbom = toCycloneDx(
      makeArtifact('5.3.0', 90),
      componentsOnlyGraph([
        { package: 'ansi-styles', version: '6.2.1' },
        { package: 'chalk', version: '5.3.0' }, // already reported as direct — must not duplicate
      ]),
    ) as {
      components: Array<{ name: string; version: string; properties: Array<{ name: string; value: string }> }>;
    };
    expect(sbom.components).toHaveLength(2);
    const scopeOf = (name: string): string | undefined =>
      sbom.components.find((c) => c.name === name)?.properties.find((p) => p.name === 'vibgrate:scope')?.value;
    expect(scopeOf('chalk')).toBe('direct');
    expect(scopeOf('ansi-styles')).toBe('transitive');
  });

  it('SPDX likewise includes transitive lockfile packages', () => {
    const sbom = toSpdx(makeArtifact('5.3.0', 90), componentsOnlyGraph([{ package: 'ansi-styles', version: '6.2.1' }])) as {
      packages: Array<{ name: string }>;
    };
    expect(sbom.packages.map((p) => p.name)).toEqual(['chalk', 'ansi-styles']);
  });

  it('gives every CycloneDX component and the root a purl-based bom-ref, and a matching purl field', () => {
    const sbom = toCycloneDx(makeArtifact('5.3.0', 90)) as {
      metadata: { component: { 'bom-ref': string } };
      components: Array<{ 'bom-ref': string; purl: string; name: string; version: string }>;
    };
    expect(sbom.metadata.component['bom-ref']).toBe('vibgrate-root');
    expect(sbom.components[0].purl).toBe('pkg:npm/chalk@5.3.0');
    expect(sbom.components[0]['bom-ref']).toBe(sbom.components[0].purl);
  });

  it('formats a scoped package purl with the namespace as its own segment, not percent-encoded together', () => {
    expect(npmPurl('@modelcontextprotocol/sdk', '1.29.0')).toBe('pkg:npm/%40modelcontextprotocol/sdk@1.29.0');
  });

  it('SPDX externalRefs carry the same purl format', () => {
    const sbom = toSpdx(makeArtifact('5.3.0', 90)) as { packages: Array<{ externalRefs: Array<{ referenceLocator: string }> }> };
    expect(sbom.packages[0].externalRefs[0].referenceLocator).toBe('pkg:npm/chalk@5.3.0');
  });

  it('emits a CycloneDX dependency graph when the lockfile resolves real edges, keyed by purl', () => {
    const graph: LockfileGraph = {
      components: [
        { package: 'chalk', version: '5.3.0' },
        { package: 'ansi-styles', version: '6.2.1' },
      ],
      edges: new Map([['chalk@5.3.0', ['ansi-styles@6.2.1']]]),
      rootDependsOn: ['chalk@5.3.0'],
    };
    const sbom = toCycloneDx(makeArtifact('5.3.0', 90), graph) as {
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    expect(sbom.dependencies).toEqual([
      { ref: 'vibgrate-root', dependsOn: ['pkg:npm/chalk@5.3.0'] },
      { ref: 'pkg:npm/chalk@5.3.0', dependsOn: ['pkg:npm/ansi-styles@6.2.1'] },
      { ref: 'pkg:npm/ansi-styles@6.2.1', dependsOn: [] },
    ]);
  });

  it('SPDX expresses the same edges as DEPENDS_ON relationships', () => {
    const graph: LockfileGraph = {
      components: [
        { package: 'chalk', version: '5.3.0' },
        { package: 'ansi-styles', version: '6.2.1' },
      ],
      edges: new Map([['chalk@5.3.0', ['ansi-styles@6.2.1']]]),
      rootDependsOn: ['chalk@5.3.0'],
    };
    const sbom = toSpdx(makeArtifact('5.3.0', 90), graph) as {
      relationships: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
    };
    expect(sbom.relationships).toEqual([
      { spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElementId: 'SPDXRef-Package-1', relationshipType: 'DEPENDS_ON' },
      { spdxElementId: 'SPDXRef-Package-1', relatedSpdxElementId: 'SPDXRef-Package-2', relationshipType: 'DEPENDS_ON' },
    ]);
  });

  it('omits the dependency graph entirely when the lockfile format has no resolved edges, rather than lying with an empty one', () => {
    const sbom = toCycloneDx(makeArtifact('5.3.0', 90), componentsOnlyGraph([{ package: 'ansi-styles', version: '6.2.1' }])) as Record<
      string,
      unknown
    >;
    expect(sbom.dependencies).toBeUndefined();
    const spdx = toSpdx(makeArtifact('5.3.0', 90), componentsOnlyGraph([{ package: 'ansi-styles', version: '6.2.1' }])) as Record<
      string,
      unknown
    >;
    expect(spdx.relationships).toBeUndefined();
  });

  it('produces a deterministic serialNumber for identical content', () => {
    const a = toCycloneDx(makeArtifact('5.3.0', 90)) as { serialNumber: string };
    const b = toCycloneDx(makeArtifact('5.3.0', 90)) as { serialNumber: string };
    expect(a.serialNumber).toBe(b.serialNumber);
    expect(a.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Different dependency version ⇒ different id.
    const c = toCycloneDx(makeArtifact('5.2.0', 90)) as { serialNumber: string };
    expect(c.serialNumber).not.toBe(a.serialNumber);
  });

  it('purlFor picks the right registry per ecosystem, not always npm', () => {
    expect(purlFor('npm', 'chalk', '5.3.0')).toBe('pkg:npm/chalk@5.3.0');
    expect(purlFor('pypi', 'Flask-SQLAlchemy', '3.0.0')).toBe('pkg:pypi/flask-sqlalchemy@3.0.0');
    expect(purlFor('rust', 'anyhow', '1.0.104')).toBe('pkg:cargo/anyhow@1.0.104');
    expect(purlFor('go', 'github.com/gin-contrib/sse', 'v1.1.0')).toBe('pkg:golang/github.com/gin-contrib/sse@v1.1.0');
    expect(purlFor('java', 'com.google.code.gson:gson', '2.11.0')).toBe('pkg:maven/com.google.code.gson/gson@2.11.0');
    expect(purlFor('ruby', 'rails', '7.1.0')).toBe('pkg:gem/rails@7.1.0');
    expect(purlFor('php', 'monolog/monolog', '3.5.0')).toBe('pkg:composer/monolog/monolog@3.5.0');
    expect(purlFor('dotnet', 'Newtonsoft.Json', '13.0.3')).toBe('pkg:nuget/Newtonsoft.Json@13.0.3');
    expect(purlFor('dart', 'http', '1.2.0')).toBe('pkg:pub/http@1.2.0');
  });

  it('a non-npm project gets purls in its own registry, not pkg:npm', () => {
    const artifact = makeArtifact('1.9.0', 90);
    artifact.projects[0]!.type = 'go';
    artifact.projects[0]!.dependencies[0]!.package = 'github.com/gin-contrib/sse';
    const sbom = toCycloneDx(artifact) as { components: Array<{ purl: string }> };
    expect(sbom.components[0].purl).toBe('pkg:golang/github.com/gin-contrib/sse@1.9.0');
  });

  it('dedupes a direct dependency shared by several scanned projects (a Cargo/npm workspace or Gradle multi-module repo) into one component', () => {
    const artifact = makeArtifact('5.3.0', 90);
    artifact.projects.push({ ...artifact.projects[0]!, name: 'other-workspace-member' } as ProjectScan);
    const sbom = toCycloneDx(artifact) as { components: Array<{ name: string }> };
    expect(sbom.components).toHaveLength(1);
  });

  it('dedupes a Go direct dependency against its own go.sum-derived transitive entry despite the `v` prefix mismatch', () => {
    const artifact = makeArtifact('v1.1.0', 90);
    artifact.projects[0]!.type = 'go';
    artifact.projects[0]!.dependencies[0]!.package = 'github.com/gin-contrib/sse';
    artifact.projects[0]!.dependencies[0]!.currentSpec = 'v1.1.0';
    // The scanner's resolvedVersion runs go.mod's pinned version through
    // semver.clean, which drops the leading `v` — go.sum keeps it.
    artifact.projects[0]!.dependencies[0]!.resolvedVersion = '1.1.0';
    const graph: LockfileGraph = {
      components: [{ package: 'github.com/gin-contrib/sse', version: 'v1.1.0' }],
      edges: undefined,
      rootDependsOn: [],
      ecosystem: 'go',
    };
    const sbom = toCycloneDx(artifact, graph) as { components: Array<{ name: string; version: string }> };
    expect(sbom.components).toHaveLength(1);
    expect(sbom.components[0]!.version).toBe('v1.1.0');
  });

  it('never reports a declared range, dist-tag, or protocol spec as if it were an installed version', () => {
    const withUnresolvedVersion = (spec: string): ScanArtifact => {
      const artifact = makeArtifact(spec, 90);
      artifact.projects[0]!.dependencies[0]!.resolvedVersion = null;
      return artifact;
    };
    for (const spec of ['^5.3.0', '*', 'latest', 'workspace:*', 'npm:string-width@^4.2.3']) {
      const sbom = toCycloneDx(withUnresolvedVersion(spec)) as {
        components: Array<{ name: string; version: string; purl: string; 'bom-ref': string }>;
      };
      expect(sbom.components[0]!.version).toBe('unknown');
      // No `@version` suffix on the purl either — a version-less purl is
      // valid syntax, unlike `pkg:npm/chalk@^5.3.0` or `@workspace:*`.
      expect(sbom.components[0]!.purl).toBe('pkg:npm/chalk');
      expect(sbom.components[0]!['bom-ref']).toBe('pkg:npm/chalk');
    }
  });

  it('still reports a concrete pinned version normally (no false positives from the range guard)', () => {
    const sbom = toCycloneDx(makeArtifact('5.3.0', 90)) as { components: Array<{ version: string; purl: string }> };
    expect(sbom.components[0]!.version).toBe('5.3.0');
    expect(sbom.components[0]!.purl).toBe('pkg:npm/chalk@5.3.0');
  });

  describe('collectLockfileGraph', () => {
    let root: string;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sbom-monorepo-'));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('merges every scanned sub-project\'s own lockfile, not just root\'s', () => {
      fs.writeFileSync(
        path.join(root, 'package-lock.json'),
        JSON.stringify({ packages: { '': {}, 'node_modules/chalk': { version: '5.3.0' } } }),
      );
      fs.mkdirSync(path.join(root, 'docs'));
      fs.writeFileSync(
        path.join(root, 'docs', 'package-lock.json'),
        JSON.stringify({ packages: { '': {}, 'node_modules/vitepress': { version: '1.6.4' } } }),
      );
      const artifact = makeArtifact('5.3.0', 90);
      artifact.projects.push({ ...artifact.projects[0]!, name: 'docs', path: 'docs', dependencies: [] } as ProjectScan);

      const graph = collectLockfileGraph(artifact, root);
      expect(graph?.components).toContainEqual({ package: 'chalk', version: '5.3.0' });
      expect(graph?.components).toContainEqual({ package: 'vitepress', version: '1.6.4' });
    });

    it('returns undefined when no scanned project path has a lockfile', () => {
      expect(collectLockfileGraph(makeArtifact('5.3.0', 90), root)).toBeUndefined();
    });
  });

  it('formats dependency deltas', () => {
    const base = makeArtifact('5.2.0', 80);
    const current = makeArtifact('5.3.0', 76);
    const text = formatDeltaText(base, current);
    expect(text).toContain('DriftScore delta: -4.00 points');
    expect(text).toContain('Changed dependencies (1)');
  });
});
