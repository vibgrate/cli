import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toCycloneDx, toSpdx, formatDeltaText, npmPurl, purlFor, collectLockfileGraph, collectPurlWarnings, describeUnavailablePurl, collectLicenseWarnings, describeUnrepresentableLicense } from './sbom.js';
import { buildDependencyLicense } from '../../core-open/licenses/dependency-license.js';
import { LICENSE_PARSE_FAILED, licenseParseDiagnostic } from '../../core-open/licenses/diagnostic.js';
import { normalizeLicense } from '../../core-open/licenses/normalize.js';
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
    expect(sbom.components[0]).not.toHaveProperty('licenses');
  });

  it('exports SPDX with package entries', () => {
    const sbom = toSpdx(makeArtifact('5.3.0', 90)) as {
      spdxVersion: string;
      packages: Array<{ name: string; licenseDeclared: string; licenseConcluded: string }>;
      hasExtractedLicensingInfos?: unknown;
    };
    expect(sbom.spdxVersion).toBe('SPDX-2.3');
    expect(sbom.packages[0].name).toBe('chalk');
    expect(sbom.packages[0].licenseDeclared).toBe('NOASSERTION');
    expect(sbom.packages[0].licenseConcluded).toBe('NOASSERTION');
    expect(sbom.hasExtractedLicensingInfos).toBeUndefined();
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
   * A name that cannot be a purl name. `encodeURIComponent` used to turn the
   * space into `pkg:npm/foo%20bar@1.0.0`, which is a purl-shaped string, and
   * an empty path segment (`@scope/`) used to become `pkg:npm/%40scope/`.
   * The component stays; the purl is omitted; the status is explicit.
   */
  it('keeps a component whose name cannot be a Package URL and marks the purl unavailable', () => {
    const artifact = makeArtifact('5.3.0', 90);
    artifact.rootPath = '/var/private/checkout';
    const chalk = artifact.projects[0]!.dependencies[0]!;
    artifact.projects[0]!.dependencies.push(
      { ...chalk, package: 'foo bar', currentSpec: '1.0.0', resolvedVersion: '1.0.0' },
      { ...chalk, package: '@scope/', currentSpec: '2.0.0', resolvedVersion: '2.0.0' },
      { ...chalk, package: 'café', currentSpec: '3.0.0', resolvedVersion: '3.0.0' },
    );

    const cyclone = toCycloneDx(artifact) as {
      components: Array<{
        name: string;
        version: string;
        purl?: string;
        'bom-ref': string;
        properties: Array<{ name: string; value: string }>;
      }>;
    };
    const again = JSON.stringify(toCycloneDx(artifact));
    expect(JSON.stringify(cyclone)).toBe(again);
    expect(again).not.toContain('foo%20bar');
    expect(again).not.toContain('pkg:npm/foo');
    expect(again).not.toContain('%40scope/');
    expect(again).not.toContain('%C3%A9');

    expect(cyclone.components.map((c) => c.name)).toEqual(['chalk', 'foo bar', '@scope/', 'café']);
    expect(cyclone.components[0]!.purl).toBe('pkg:npm/chalk@5.3.0');

    for (const name of ['foo bar', '@scope/', 'café']) {
      const row = cyclone.components.find((c) => c.name === name)!;
      expect(row.purl).toBeUndefined();
      expect(row['bom-ref'].startsWith('pkg:')).toBe(false);
      expect(row['bom-ref']).toBe(`vibgrate:npm:${name}@${row.version}`);
      const status = row.properties.find((p) => p.name === 'vibgrate:purlStatus')?.value;
      const warning = row.properties.find((p) => p.name === 'vibgrate:purlWarning')?.value;
      expect(status).toBe('unavailable');
      expect(warning).toBe(describeUnavailablePurl('npm', name, row.version));
      expect(warning).toContain(`npm package "${name}"`);
      expect(warning).not.toContain('/var/private');
    }

    const warnings = collectPurlWarnings(artifact);
    expect(warnings).toEqual([
      describeUnavailablePurl('npm', 'foo bar', '1.0.0'),
      describeUnavailablePurl('npm', '@scope/', '2.0.0'),
      describeUnavailablePurl('npm', 'café', '3.0.0'),
    ]);
    expect(warnings[0]).toContain('whitespace or a non-ASCII character');
    expect(warnings[1]).toContain('empty path segment');

    const spdx = toSpdx(artifact) as {
      packages: Array<{
        name: string;
        externalRefs?: Array<{ referenceType: string; referenceLocator: string }>;
        annotations: Array<{ comment: string }>;
      }>;
    };
    expect(JSON.stringify(toSpdx(artifact))).toBe(JSON.stringify(spdx));
    const bad = spdx.packages.find((p) => p.name === 'foo bar')!;
    expect(bad.externalRefs).toBeUndefined();
    expect(bad.annotations[0]!.comment).toContain('purlStatus=unavailable');
    expect(bad.annotations[1]!.comment).toBe(warnings[0]);
    expect(spdx.packages.find((p) => p.name === 'chalk')!.externalRefs?.[0]?.referenceLocator).toBe('pkg:npm/chalk@5.3.0');
  });

  it('does not put a rejected purl on a dependency-graph edge', () => {
    const artifact = makeArtifact('5.3.0', 90);
    const chalk = artifact.projects[0]!.dependencies[0]!;
    artifact.projects[0]!.dependencies.push({ ...chalk, package: 'foo bar', currentSpec: '1.0.0', resolvedVersion: '1.0.0' });
    const graph: LockfileGraph = {
      components: [
        { package: 'chalk', version: '5.3.0' },
        { package: 'foo bar', version: '1.0.0' },
      ],
      edges: new Map([['chalk@5.3.0', ['foo bar@1.0.0']]]),
      rootDependsOn: ['chalk@5.3.0', 'foo bar@1.0.0'],
    };
    const sbom = toCycloneDx(artifact, graph) as {
      components: Array<{ name: string; 'bom-ref': string; purl?: string }>;
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    const badRef = sbom.components.find((c) => c.name === 'foo bar')!['bom-ref'];
    expect(badRef).toBe('vibgrate:npm:foo bar@1.0.0');
    expect(sbom.dependencies).toEqual([
      { ref: 'vibgrate-root', dependsOn: ['pkg:npm/chalk@5.3.0', badRef] },
      { ref: 'pkg:npm/chalk@5.3.0', dependsOn: [badRef] },
      { ref: badRef, dependsOn: [] },
    ]);
    expect(JSON.stringify(sbom.dependencies)).not.toContain('pkg:npm/foo');
  });

  it('purlFor returns null for a bad name, an empty segment, and an unknown ecosystem', () => {
    expect(purlFor('npm', 'foo bar', '1.0.0')).toBeNull();
    expect(purlFor('npm', '@scope/', '2.0.0')).toBeNull();
    expect(purlFor('go', 'github.com//sse', 'v1.0.0')).toBeNull();
    expect(purlFor('npm', 'chalk', '^1.2.3')).toBeNull();
    expect(purlFor('not-a-registry' as never, 'chalk', '1.0.0')).toBeNull();
    expect(npmPurl('chalk', '5.3.0')).toBe('pkg:npm/chalk@5.3.0');
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

  it('repeats a license-parse diagnostic in SPDX and CycloneDX, and omits it when the license is explicitly unknown', () => {
    const plain = makeArtifact('5.3.0', 90);
    expect((toSpdx(plain) as { annotations?: unknown }).annotations).toBeUndefined();
    expect((toCycloneDx(plain) as { metadata: { properties?: unknown } }).metadata.properties).toBeUndefined();

    const message =
      'Could not resolve SPDX license "not-a-real-license" for bad at apps/web. Replace it with a canonical SPDX id or expression, or NOASSERTION if the license is intentionally unknown.';
    const withFailure = makeArtifact('5.3.0', 90);
    withFailure.findings = [
      {
        ruleId: 'vibgrate/dependency-rot',
        level: 'warning',
        message: 'unrelated',
        location: 'apps/web',
      },
      {
        ruleId: LICENSE_PARSE_FAILED,
        level: 'warning',
        message,
        location: 'apps/web',
        details: { raw: 'not-a-real-license' },
      },
    ];

    const spdx = toSpdx(withFailure) as {
      annotations: Array<{ annotationType: string; annotationDate: string; comment: string }>;
    };
    expect(spdx.annotations).toEqual([
      {
        annotationType: 'OTHER',
        annotator: 'Tool: @vibgrate/cli',
        annotationDate: '2026-02-19T00:00:00.000Z',
        comment: `${LICENSE_PARSE_FAILED}: ${message}`,
      },
    ]);
    expect(JSON.stringify(spdx)).not.toContain('unrelated');

    const cdx = toCycloneDx(withFailure) as {
      metadata: { properties: Array<{ name: string; value: string }> };
      serialNumber: string;
    };
    expect(cdx.metadata.properties).toEqual([
      { name: LICENSE_PARSE_FAILED, value: `apps/web: ${message}` },
    ]);
    expect(toCycloneDx(withFailure)).toEqual(cdx);
    expect(cdx.serialNumber).not.toBe((toCycloneDx(plain) as { serialNumber: string }).serialNumber);
  });

  it('formats dependency deltas', () => {
    const base = makeArtifact('5.2.0', 80);
    const current = makeArtifact('5.3.0', 76);
    const text = formatDeltaText(base, current);
    expect(text).toContain('DriftScore delta: -4.00 points');
    expect(text).toContain('Changed dependencies (1)');
  });
});

describe('sbom declared licenses', () => {
  function declared(raw: string | null, spdxId: string | null) {
    return {
      raw,
      spdxId,
      source: raw ? ('registry' as const) : ('none' as const),
      confidence: raw ? 1 : 0,
    };
  }

  /** Repro rows: listed id, LicenseRef, compound, exception, invalid ref, and no license. */
  function licenseArtifact(): ScanArtifact {
    const artifact = makeArtifact('1.0.0', 10);
    const base = artifact.projects[0]!.dependencies[0]!;
    const row = (name: string, version: string, license?: ReturnType<typeof declared>) => ({
      ...base,
      package: name,
      currentSpec: version,
      resolvedVersion: version,
      ...(license ? { license } : {}),
    });
    artifact.projects[0]!.dependencies = [
      row('mit-pkg', '1.0.0', declared('MIT', 'MIT')),
      // spdxId left null: a scan that has not canonicalised the ref still exports it from `raw`.
      row('acme-pkg', '2.0.0', declared('LicenseRef-Acme-1.0', null)),
      row('or-pkg', '3.0.0', declared('MIT OR LicenseRef-Acme-1.0', null)),
      row('with-pkg', '4.0.0', declared('Apache-2.0 WITH LLVM-exception', null)),
      row('bad-pkg', '5.0.0', declared('LicenseRef-has space', null)),
      row('bare-pkg', '6.0.0'),
      row('empty-pkg', '7.0.0', declared(null, null)),
      row('unknown-pkg', '8.0.0', declared('NOASSERTION', null)),
      row('zed-pkg', '9.0.0', declared('LicenseRef-Zed-1.0', null)),
    ];
    return artifact;
  }

  const badWarning = describeUnrepresentableLicense('npm', 'bad-pkg', '5.0.0', 'LicenseRef-has space');

  it('writes representable licenses into CycloneDX and warns, by name, for an invalid ref', () => {
    const artifact = licenseArtifact();
    const sbom = toCycloneDx(artifact) as {
      serialNumber: string;
      components: Array<{
        name: string;
        licenses?: Array<{ license?: { id: string }; expression?: string }>;
        properties: Array<{ name: string; value: string }>;
      }>;
    };
    expect(JSON.stringify(toCycloneDx(artifact))).toBe(JSON.stringify(sbom));
    expect(sbom.serialNumber).toBe((toCycloneDx(artifact) as { serialNumber: string }).serialNumber);

    const byName = new Map(sbom.components.map((component) => [component.name, component]));
    expect(byName.get('mit-pkg')!.licenses).toEqual([{ license: { id: 'MIT' } }]);
    expect(byName.get('acme-pkg')!.licenses).toEqual([{ expression: 'LicenseRef-Acme-1.0' }]);
    expect(byName.get('or-pkg')!.licenses).toEqual([{ expression: 'MIT OR LicenseRef-Acme-1.0' }]);
    expect(byName.get('with-pkg')!.licenses).toEqual([{ expression: 'Apache-2.0 WITH LLVM-exception' }]);
    expect(byName.get('zed-pkg')!.licenses).toEqual([{ expression: 'LicenseRef-Zed-1.0' }]);

    for (const name of ['bad-pkg', 'bare-pkg', 'empty-pkg', 'unknown-pkg']) {
      expect(byName.get(name)).not.toHaveProperty('licenses');
    }

    const bad = byName.get('bad-pkg')!;
    expect(bad.properties.find((property) => property.name === 'vibgrate:licenseStatus')?.value).toBe('unavailable');
    expect(bad.properties.find((property) => property.name === 'vibgrate:licenseWarning')?.value).toBe(badWarning);
    expect(badWarning).toContain('npm package "bad-pkg"');
    expect(badWarning).toContain('version "5.0.0"');
    expect(collectLicenseWarnings(artifact)).toEqual([badWarning]);

    const json = JSON.stringify(sbom);
    expect(json).not.toMatch(/"id": "LicenseRef-/);
    expect(json).not.toContain('"id": ""');
    expect(json).not.toContain('"expression": ""');
    expect(json).not.toContain('"licenses": []');
  });

  it('writes SPDX licenseDeclared, concludes nothing, and dedupes extracted LicenseRefs', () => {
    const artifact = licenseArtifact();
    const sbom = toSpdx(artifact) as {
      documentNamespace: string;
      packages: Array<{
        name: string;
        licenseDeclared: string;
        licenseConcluded: string;
        annotations: Array<{ comment: string }>;
      }>;
      hasExtractedLicensingInfos: Array<{ licenseId: string; extractedText: string; name: string }>;
    };
    expect(JSON.stringify(toSpdx(artifact))).toBe(JSON.stringify(sbom));
    expect(sbom.documentNamespace).toBe((toSpdx(artifact) as { documentNamespace: string }).documentNamespace);

    const byName = new Map(sbom.packages.map((pkg) => [pkg.name, pkg]));
    expect(byName.get('mit-pkg')!.licenseDeclared).toBe('MIT');
    expect(byName.get('acme-pkg')!.licenseDeclared).toBe('LicenseRef-Acme-1.0');
    expect(byName.get('or-pkg')!.licenseDeclared).toBe('MIT OR LicenseRef-Acme-1.0');
    expect(byName.get('with-pkg')!.licenseDeclared).toBe('Apache-2.0 WITH LLVM-exception');
    expect(byName.get('zed-pkg')!.licenseDeclared).toBe('LicenseRef-Zed-1.0');
    for (const name of ['bad-pkg', 'bare-pkg', 'empty-pkg', 'unknown-pkg']) {
      expect(byName.get(name)!.licenseDeclared).toBe('NOASSERTION');
    }
    for (const pkg of sbom.packages) {
      expect(pkg.licenseConcluded).toBe('NOASSERTION');
      expect(pkg.licenseDeclared).not.toBe('');
    }

    const bad = byName.get('bad-pkg')!;
    expect(bad.annotations[0]!.comment).toContain('licenseStatus=unavailable');
    expect(bad.annotations[1]!.comment).toBe(badWarning);
    expect(byName.get('mit-pkg')!.annotations).toHaveLength(1);
    expect(byName.get('mit-pkg')!.annotations[0]!.comment).not.toContain('licenseStatus');

    expect(sbom.hasExtractedLicensingInfos).toEqual([
      {
        licenseId: 'LicenseRef-Acme-1.0',
        extractedText: 'License text for LicenseRef-Acme-1.0 was not included in the scan artifact.',
        name: 'LicenseRef-Acme-1.0',
      },
      {
        licenseId: 'LicenseRef-Zed-1.0',
        extractedText: 'License text for LicenseRef-Zed-1.0 was not included in the scan artifact.',
        name: 'LicenseRef-Zed-1.0',
      },
    ]);
    expect(JSON.stringify(sbom)).not.toContain('"licenseDeclared": ""');
    expect(JSON.stringify(sbom.hasExtractedLicensingInfos)).not.toContain('LLVM-exception');
    expect(JSON.stringify(sbom.hasExtractedLicensingInfos)).not.toContain('LicenseRef-has space');
  });

  it('changes the document id when a declared license changes, and only then', () => {
    const artifact = licenseArtifact();
    const cyclone = toCycloneDx(artifact) as { serialNumber: string };
    const spdx = toSpdx(artifact) as { documentNamespace: string };
    expect((toCycloneDx(artifact) as { serialNumber: string }).serialNumber).toBe(cyclone.serialNumber);
    expect((toSpdx(artifact) as { documentNamespace: string }).documentNamespace).toBe(spdx.documentNamespace);

    const changed = licenseArtifact();
    changed.projects[0]!.dependencies[0]!.license = declared('ISC', 'ISC');
    expect((toCycloneDx(changed) as { serialNumber: string }).serialNumber).not.toBe(cyclone.serialNumber);
    expect((toSpdx(changed) as { documentNamespace: string }).documentNamespace).not.toBe(spdx.documentNamespace);

    const plain = makeArtifact('5.3.0', 90);
    expect((toCycloneDx(plain) as { serialNumber: string }).serialNumber).toBe(
      (toCycloneDx(makeArtifact('5.3.0', 90)) as { serialNumber: string }).serialNumber,
    );
  });

  it('does not flag a valid LicenseRef as a license parse failure', () => {
    expect(licenseParseDiagnostic('LicenseRef-Acme-1.0', 'apps/web/package.json', 'acme-pkg')).toBeNull();
    expect(licenseParseDiagnostic('MIT OR LicenseRef-Acme-1.0', 'apps/web/package.json', 'or-pkg')).toBeNull();
    expect(licenseParseDiagnostic('Apache-2.0 WITH LLVM-exception', 'apps/web/package.json', 'with-pkg')).toBeNull();
    expect(normalizeLicense('LicenseRef-Acme-1.0').matchStatus).not.toBe('unknown');
    expect(normalizeLicense('LicenseRef-Acme-1.0').spdxId).toBe('LicenseRef-Acme-1.0');
    expect(buildDependencyLicense('LicenseRef-Acme-1.0', 'registry').spdxId).toBe('LicenseRef-Acme-1.0');

    const bad = licenseParseDiagnostic('LicenseRef-has space', 'apps/web/package.json', 'bad-pkg');
    expect(bad?.code).toBe(LICENSE_PARSE_FAILED);
    expect(bad?.message).toContain('bad-pkg');
    expect(bad?.message).toContain('LicenseRef-has space');
  });

  it('canonicalizes a single SPDX id and keeps LicenseRef-Proprietary out of license.id', () => {
    const artifact = makeArtifact('1.0.0', 1);
    const base = artifact.projects[0]!.dependencies[0]!;
    artifact.projects[0]!.dependencies = [
      { ...base, package: 'lower', license: declared('mit', 'MIT') },
      { ...base, package: 'prop', currentSpec: '2.0.0', resolvedVersion: '2.0.0', license: declared('LicenseRef-Proprietary', 'LicenseRef-Proprietary') },
    ];
    const cyclone = toCycloneDx(artifact) as {
      components: Array<{ name: string; licenses: Array<{ license?: { id: string }; expression?: string }> }>;
    };
    expect(cyclone.components.find((component) => component.name === 'lower')!.licenses).toEqual([{ license: { id: 'MIT' } }]);
    expect(cyclone.components.find((component) => component.name === 'prop')!.licenses).toEqual([{ expression: 'LicenseRef-Proprietary' }]);
    const spdx = toSpdx(artifact) as {
      hasExtractedLicensingInfos: Array<{ licenseId: string }>;
    };
    expect(spdx.hasExtractedLicensingInfos.map((info) => info.licenseId)).toEqual(['LicenseRef-Proprietary']);
  });

  it('keeps the first project\'s license when two projects share name@version', () => {
    const artifact = makeArtifact('1.0.0', 1);
    const base = artifact.projects[0]!.dependencies[0]!;
    artifact.projects[0]!.dependencies[0] = { ...base, license: declared('MIT', 'MIT') };
    artifact.projects.push({
      ...artifact.projects[0]!,
      name: 'other',
      dependencies: [{ ...base, license: declared('Apache-2.0', 'Apache-2.0') }],
    } as ProjectScan);
    const sbom = toCycloneDx(artifact) as { components: Array<{ licenses: Array<{ license: { id: string } }> }> };
    expect(sbom.components).toHaveLength(1);
    expect(sbom.components[0]!.licenses).toEqual([{ license: { id: 'MIT' } }]);
  });
});
