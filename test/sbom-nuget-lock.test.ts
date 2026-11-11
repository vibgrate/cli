/**
 * `vg sbom export` reads `packages.lock.json`: transitive packages are
 * `transitive` components with `pkg:nuget` purls and SHA-512 digests, two
 * target frameworks that resolve one version stay one component, and
 * `Project` entries are left out.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDotnetProjects } from '../src/core-open/scanners/dotnet-scanner.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const BSON_HASH = createHash('sha512').update('newtonsoft-json-bson').digest('base64');
const MEMORY_HASH = createHash('sha512').update('system-memory').digest('base64');

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net8.0;net6.0</TargetFrameworks>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
`;

const LOCKFILE = {
  version: 1,
  dependencies: {
    '.NETCoreApp,Version=v8.0': {
      'Newtonsoft.Json': {
        type: 'Direct',
        requested: '[13.0.3, )',
        resolved: '13.0.3',
        dependencies: {
          'Newtonsoft.Json.Bson': '1.0.2',
        },
      },
      'system.memory': {
        type: 'Transitive',
        resolved: '4.5.5',
        contentHash: MEMORY_HASH,
      },
      'App.Tests': {
        type: 'Project',
        resolved: '1.0.0',
      },
    },
    '.NETCoreApp,Version=v6.0': {
      'Newtonsoft.Json': {
        type: 'Direct',
        requested: '[13.0.3, )',
        resolved: '13.0.3',
        dependencies: {
          'Newtonsoft.Json.Bson': '[1.0.2, )',
        },
      },
      'System.Memory': {
        type: 'Transitive',
        resolved: '4.5.5',
        contentHash: MEMORY_HASH,
      },
      'Newtonsoft.Json.Bson': {
        type: 'Transitive',
        resolved: '1.0.2',
        contentHash: BSON_HASH,
      },
    },
  },
};

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'nuget-lock',
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

interface CdxComponent {
  name: string;
  version: string;
  purl?: string;
  hashes?: Array<{ alg: string; content: string }>;
  properties: Array<{ name: string; value: string }>;
}

describe('sbom export: NuGet packages.lock.json', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  async function exported() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-nuget-sbom-'));
    fs.writeFileSync(path.join(root, 'App.csproj'), CSPROJ);
    fs.writeFileSync(path.join(root, 'packages.lock.json'), JSON.stringify(LOCKFILE));
    const projects = await scanDotnetProjects(root);
    const scanArtifact = artifact(projects);
    const graph = collectLockfileGraph(scanArtifact, root);
    const cdx = toCycloneDx(scanArtifact, graph) as {
      components: CdxComponent[];
      dependencies?: Array<{ ref: string; dependsOn: string[] }>;
    };
    const spdx = toSpdx(scanArtifact, graph) as {
      packages: Array<{ name: string; versionInfo: string; checksums?: Array<{ algorithm: string; checksumValue: string }> }>;
      relationships?: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
    };
    return { projects, cdx, spdx };
  }

  it('exports a transitive package with a NuGet purl and a SHA-512 digest', async () => {
    const { cdx, spdx } = await exported();
    const bson = cdx.components.find((component) => component.name === 'Newtonsoft.Json.Bson');
    expect(bson?.version).toBe('1.0.2');
    expect(bson?.purl).toBe('pkg:nuget/Newtonsoft.Json.Bson@1.0.2');
    expect(bson?.hashes).toEqual([{ alg: 'SHA-512', content: BSON_HASH }]);
    expect(bson?.properties.find((property) => property.name === 'vibgrate:scope')?.value).toBe('transitive');

    const spdxBson = spdx.packages.find((pkg) => pkg.name === 'Newtonsoft.Json.Bson');
    expect(spdxBson?.checksums).toEqual([{ algorithm: 'SHA512', checksumValue: BSON_HASH }]);

    const direct = cdx.components.find((component) => component.name === 'Newtonsoft.Json');
    expect(direct?.purl).toBe('pkg:nuget/Newtonsoft.Json@13.0.3');
    expect(direct?.properties.find((property) => property.name === 'vibgrate:scope')?.value).toBe('direct');
    const directRef = direct?.purl;
    const bsonRef = bson?.purl;
    const edge = cdx.dependencies?.find((node) => node.ref === directRef);
    expect(edge?.dependsOn).toEqual([bsonRef]);
  });

  it('exports one component when two target frameworks resolve the same version', async () => {
    const { cdx } = await exported();
    const memory = cdx.components.filter((component) => component.name.toLowerCase() === 'system.memory');
    expect(memory).toEqual([
      expect.objectContaining({
        name: 'System.Memory',
        version: '4.5.5',
        purl: 'pkg:nuget/System.Memory@4.5.5',
        hashes: [{ alg: 'SHA-512', content: MEMORY_HASH }],
      }),
    ]);
    expect(memory[0]?.properties.find((property) => property.name === 'vibgrate:scope')?.value).toBe('transitive');
  });

  it('does not export Project entries', async () => {
    const { projects, cdx, spdx } = await exported();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.dependencies.map((dep) => dep.package)).toEqual(['Newtonsoft.Json']);
    const names = [
      ...cdx.components.map((component) => component.name),
      ...spdx.packages.map((pkg) => pkg.name),
    ];
    expect(names.some((name) => name.toLowerCase() === 'app.tests')).toBe(false);
  });
});
