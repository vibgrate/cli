import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toCycloneDx, toSpdx, formatDeltaText, npmPurl, purlFor, collectLockfileGraph, collectPurlWarnings, sbomCommand } from './sbom.js';
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

  /**
   * Names that cannot be a purl name. A space percent-encodes to a purl-shaped
   * string; an empty path segment encodes to `pkg:golang/github.com//sse@…`.
   * Neither is a Package URL.
   */
  const unencodableNames = ['foo bar', 'github.com//sse'] as const;

  it('keeps a component when its name cannot be encoded as a purl, without inventing one', () => {
    const secretPath = '/var/lib/secret-workspace';
    const artifact = makeArtifact('5.3.0', 90);
    artifact.rootPath = secretPath;
    artifact.projects[0]!.dependencies[0]!.currentSpec = `file:${secretPath}/id_rsa`;
    artifact.projects[0]!.dependencies.push({
      package: 'foo bar',
      section: 'dependencies',
      currentSpec: `file:${secretPath}/id_rsa`,
      resolvedVersion: '1.0.0',
      latestStable: null,
      majorsBehind: null,
      drift: 'unknown',
    });

    const sbom = toCycloneDx(artifact) as {
      components: Array<{
        name: string;
        purl?: string;
        'bom-ref': string;
        properties: Array<{ name: string; value: string }>;
      }>;
    };
    expect(JSON.stringify(sbom)).toBe(JSON.stringify(toCycloneDx(artifact)));

    const chalk = sbom.components.find((c) => c.name === 'chalk');
    expect(chalk?.purl).toBe('pkg:npm/chalk@5.3.0');
    expect(chalk?.['bom-ref']).toBe('pkg:npm/chalk@5.3.0');
    expect(chalk?.properties.some((p) => p.name === 'vibgrate:purlStatus')).toBe(false);

    const broken = sbom.components.find((c) => c.name === 'foo bar');
    expect(broken).toBeDefined();
    expect(broken?.purl).toBeUndefined();
    expect(broken?.['bom-ref']).toBe('vibgrate:npm:foo bar@1.0.0');
    expect(broken?.['bom-ref'].startsWith('pkg:')).toBe(false);
    const status = broken?.properties.find((p) => p.name === 'vibgrate:purlStatus')?.value;
    const warning = broken?.properties.find((p) => p.name === 'vibgrate:purlWarning')?.value ?? '';
    expect(status).toBe('unavailable');
    expect(warning).toContain('npm');
    expect(warning).toContain('foo bar');
    expect(warning).toContain('regenerate the SBOM');
    expect(warning).not.toContain(secretPath);
    expect(warning).not.toContain('id_rsa');
    expect(JSON.stringify(sbom)).not.toContain('foo%20bar');
    expect(JSON.stringify(sbom)).not.toContain('pkg:npm/foo');

    const warnings = collectPurlWarnings(
      // Same order the export command prints: direct dependencies, document order.
      [
        {
          project: 'app',
          package: 'chalk',
          version: '5.3.0',
          currentSpec: '5.3.0',
          drift: 'current',
          majorsBehind: 0,
          scope: 'direct',
          ecosystem: 'npm',
          ecosystemLabel: 'npm',
        },
        {
          project: 'app',
          package: 'foo bar',
          version: '1.0.0',
          currentSpec: '1.0.0',
          drift: 'unknown',
          majorsBehind: null,
          scope: 'direct',
          ecosystem: 'npm',
          ecosystemLabel: 'npm',
        },
      ],
    );
    expect(warnings).toEqual([warning]);
  });

  it('rejects an empty purl path segment and a non-ASCII name instead of percent-encoding them', () => {
    expect(purlFor('npm', 'chalk', '5.3.0')).toBe('pkg:npm/chalk@5.3.0');
    expect(purlFor('go', 'github.com//sse', '1.2.3')).toBeUndefined();
    expect(purlFor('npm', 'café', '1.0.0')).toBeUndefined();
    expect(purlFor('not-a-registry' as never, 'left-pad', '1.0.0')).toBeUndefined();

    for (const packageName of unencodableNames) {
      const artifact = makeArtifact('1.2.3', 90);
      artifact.projects[0]!.type = packageName.includes('//') ? 'go' : 'node';
      artifact.projects[0]!.dependencies[0]!.package = packageName;
      artifact.projects[0]!.dependencies[0]!.resolvedVersion = '1.2.3';
      artifact.projects[0]!.dependencies[0]!.currentSpec = '1.2.3';
      const cyclonedx = JSON.stringify(toCycloneDx(artifact));
      const spdx = toSpdx(artifact) as {
        packages: Array<{ name: string; externalRefs?: unknown; annotations: Array<{ comment: string }> }>;
      };
      expect(cyclonedx).toBe(JSON.stringify(toCycloneDx(artifact)));
      expect(cyclonedx).not.toContain('%20');
      expect(cyclonedx).not.toContain('%2F%2F');
      expect(cyclonedx).toContain('"vibgrate:purlStatus"');
      expect(cyclonedx).toContain(packageName);
      const pkg = spdx.packages.find((p) => p.name === packageName);
      expect(pkg).toBeDefined();
      expect(pkg?.externalRefs).toBeUndefined();
      expect(pkg?.annotations.some((a) => a.comment.includes('purlStatus=unavailable'))).toBe(true);
      expect(pkg?.annotations.some((a) => a.comment.includes(packageName) && a.comment.includes('regenerate the SBOM'))).toBe(true);
      expect(JSON.stringify(spdx)).not.toContain('pkg:');
    }
  });

  it('does not key the dependency graph with an invented purl when a name cannot be encoded', () => {
    const artifact = makeArtifact('5.3.0', 90);
    artifact.projects[0]!.dependencies.push({
      package: 'foo bar',
      section: 'dependencies',
      currentSpec: '1.0.0',
      resolvedVersion: '1.0.0',
      latestStable: null,
      majorsBehind: null,
      drift: 'unknown',
    });
    const graph: LockfileGraph = {
      components: [
        { package: 'chalk', version: '5.3.0' },
        { package: 'foo bar', version: '1.0.0' },
      ],
      edges: new Map([['chalk@5.3.0', ['foo bar@1.0.0']]]),
      rootDependsOn: ['chalk@5.3.0'],
    };
    const sbom = toCycloneDx(artifact, graph) as { dependencies: Array<{ ref: string; dependsOn: string[] }> };
    expect(sbom.dependencies).toEqual([
      { ref: 'vibgrate-root', dependsOn: ['pkg:npm/chalk@5.3.0'] },
      { ref: 'pkg:npm/chalk@5.3.0', dependsOn: ['vibgrate:npm:foo bar@1.0.0'] },
      { ref: 'vibgrate:npm:foo bar@1.0.0', dependsOn: [] },
    ]);
    expect(JSON.stringify(sbom)).not.toContain('foo%20bar');
  });

  it('prints the same warning on export and leaves it out of the document path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sbom-purl-'));
    const artifact = makeArtifact('1.0.0', 90);
    artifact.projects[0]!.dependencies[0]!.package = 'foo bar';
    artifact.projects[0]!.dependencies[0]!.resolvedVersion = '1.0.0';
    artifact.projects[0]!.dependencies[0]!.currentSpec = '1.0.0';
    const inFile = path.join(dir, 'scan.json');
    fs.writeFileSync(inFile, JSON.stringify(artifact));
    const errors: string[] = [];
    const logs: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (msg?: unknown) => {
      logs.push(String(msg));
    };
    console.error = (msg?: unknown) => {
      errors.push(String(msg));
    };
    try {
      await sbomCommand.parseAsync(['node', 'sbom', 'export', '--in', inFile, '--no-transitive']);
    } finally {
      console.log = origLog;
      console.error = origError;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const stderr = errors.join('\n');
    expect(stderr).toContain('foo bar');
    expect(stderr).toContain('npm');
    expect(stderr).toContain('regenerate the SBOM');
    expect(stderr).not.toContain(dir);
    const body = JSON.parse(logs.join('\n')) as { components: Array<{ purl?: string; properties: Array<{ name: string; value: string }> }> };
    expect(body.components[0]?.purl).toBeUndefined();
    expect(body.components[0]?.properties.find((p) => p.name === 'vibgrate:purlStatus')?.value).toBe('unavailable');
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
