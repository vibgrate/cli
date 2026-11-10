/**
 * NuGet Central Package Management: versions live in Directory.Packages.props.
 * A PackageReference with no Version is still a scan row and an SBOM component.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCache } from '../src/core-open/utils/fs.js';
import { scanDotnetProjects } from '../src/core-open/scanners/dotnet-scanner.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { DependencyRow, ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const fixture = fileURLToPath(new URL('./fixtures/nuget-central-packages/', import.meta.url));

const PROPS = (version: string, id = 'Serilog') => `<Project>
  <ItemGroup>
    <PackageVersion Include="${id}" Version="${version}" />
  </ItemGroup>
</Project>
`;

function csproj(body: string): string {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    ${body}
  </ItemGroup>
</Project>
`;
}

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'nuget-central',
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

async function write(dir: string, rel: string, text: string): Promise<void> {
  const file = path.join(dir, rel);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, text);
}

function dep(projects: ProjectScan[], name: string): DependencyRow {
  const row = projects[0]?.dependencies.find((item) => item.package === name);
  expect(row, name).toBeDefined();
  return row!;
}

describe('NuGet Central Package Management', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  async function temp(): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vg-nuget-cpm-'));
    dirs.push(dir);
    return dir;
  }

  it('the example reports Serilog 4.0.1 in the scan and the SBOM', async () => {
    const projects = await scanDotnetProjects(fixture);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.name).toBe('App');
    expect(projects[0]?.path).toBe('src/App');
    const serilog = dep(projects, 'Serilog');
    expect(serilog).toMatchObject({
      section: 'dependencies',
      currentSpec: '4.0.1',
      resolvedVersion: '4.0.1',
      drift: 'unknown',
    });
    expect(projects[0]?.frameworks.find((framework) => framework.name === 'Serilog')?.currentVersion).toBe('4.0.1');

    const scanArtifact = artifact(projects);
    const graph = collectLockfileGraph(scanArtifact, fixture);
    const cdx = toCycloneDx(scanArtifact, graph) as {
      components: Array<{ name: string; version: string; purl?: string; scope?: string; properties: Array<{ name: string; value: string }> }>;
    };
    const spdx = toSpdx(scanArtifact, graph) as {
      packages: Array<{ name: string; versionInfo: string }>;
    };
    const component = cdx.components.find((item) => item.name === 'Serilog');
    expect(component).toMatchObject({
      version: '4.0.1',
      purl: 'pkg:nuget/Serilog@4.0.1',
    });
    expect(component?.scope).toBeUndefined();
    expect(component?.properties.find((property) => property.name === 'vibgrate:scope')?.value).toBe('direct');
    expect(component?.properties.find((property) => property.name === 'vibgrate:currentSpec')?.value).toBe('4.0.1');
    expect(spdx.packages.find((pkg) => pkg.name === 'Serilog')?.versionInfo).toBe('4.0.1');
  });

  it('uses the nearest Directory.Packages.props and does not read one above the scan root', async () => {
    const parent = await temp();
    const root = path.join(parent, 'repo');
    await write(parent, 'Directory.Packages.props', PROPS('9.9.9'));
    await write(root, 'Directory.Packages.props', PROPS('1.0.0'));
    await write(root, 'src/Directory.Packages.props', PROPS('4.0.1'));
    await write(root, 'src/App/App.csproj', csproj('<PackageReference Include="Serilog" />'));
    await write(root, 'other/Other.csproj', csproj('<PackageReference Include="Serilog" />'));

    const projects = await scanDotnetProjects(root);
    const byName = new Map(projects.map((project) => [project.name, project]));
    expect(byName.get('App')?.dependencies.find((item) => item.package === 'Serilog')?.currentSpec).toBe('4.0.1');
    expect(byName.get('Other')?.dependencies.find((item) => item.package === 'Serilog')?.currentSpec).toBe('1.0.0');
  });

  it('matches PackageVersion ids without regard to case, including element names', async () => {
    const root = await temp();
    await write(root, 'Directory.Packages.props', `<project>
  <itemgroup>
    <packageversion include="serilog" version="4.0.1" />
    <PackageVersion Include="Serilog" Version="9.9.9" />
  </itemgroup>
</project>
`);
    await write(root, 'App.csproj', csproj('<PackageReference Include="Serilog" />'));

    const projects = await scanDotnetProjects(root, undefined, new FileCache());
    const serilog = dep(projects, 'Serilog');
    expect(serilog.currentSpec).toBe('4.0.1');
    expect(serilog.resolvedVersion).toBe('4.0.1');
  });

  it('reads a PackageVersion child element and trims the version', async () => {
    const root = await temp();
    await write(root, 'Directory.Packages.props', `<Project>
  <ItemGroup>
    <PackageVersion Include="Serilog">
      <Version>  4.0.1  </Version>
    </PackageVersion>
  </ItemGroup>
</Project>
`);
    await write(root, 'App.csproj', csproj('<PackageReference Include="Serilog" Version="" />'));
    expect(dep(await scanDotnetProjects(root), 'Serilog').currentSpec).toBe('4.0.1');
  });

  it('honours VersionOverride over the central pin and over an inline Version', async () => {
    const root = await temp();
    await write(root, 'App.csproj', csproj(`
    <PackageReference Include="Serilog" Version="2.0.0" VersionOverride="3.1.1" />
    <PackageReference Include="Newtonsoft.Json">
      <VersionOverride>13.0.1</VersionOverride>
    </PackageReference>
    <PackageReference Include="Dapper" Version="2.1.35" />
    <PackageReference Include="coverlet.collector" PrivateAssets="all" />
`));
    await write(root, 'Directory.Packages.props', `<Project>
  <ItemGroup>
    <PackageVersion Include="Serilog" Version="4.0.1" />
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageVersion Include="Dapper" Version="2.0.0" />
    <PackageVersion Include="coverlet.collector" Version="6.0.2" />
  </ItemGroup>
</Project>
`);

    const projects = await scanDotnetProjects(root);
    expect(dep(projects, 'Serilog')).toMatchObject({ currentSpec: '3.1.1', section: 'dependencies' });
    expect(dep(projects, 'Newtonsoft.Json')).toMatchObject({ currentSpec: '13.0.1', section: 'dependencies' });
    expect(dep(projects, 'Dapper')).toMatchObject({ currentSpec: '2.1.35', section: 'dependencies' });
    expect(dep(projects, 'coverlet.collector')).toMatchObject({ currentSpec: '6.0.2', section: 'devDependencies' });
  });

  it('keeps an unresolvable reference as a row with an unknown version', async () => {
    const root = await temp();
    await write(root, 'Directory.Packages.props', 'this is not xml');
    await write(root, 'App.csproj', csproj(`
    <PackageReference Include="Serilog" />
    <PackageReference Include="Missing.Package" />
`));

    const projects = await scanDotnetProjects(root);
    expect(projects).toHaveLength(1);
    const serilog = dep(projects, 'Serilog');
    const missing = dep(projects, 'Missing.Package');
    expect(serilog).toMatchObject({ currentSpec: 'unknown', resolvedVersion: null, drift: 'unknown' });
    expect(missing).toMatchObject({ currentSpec: 'unknown', resolvedVersion: null, drift: 'unknown', section: 'dependencies' });
    expect(projects[0]?.dependencyAgeBuckets.unknown).toBe(2);
    expect(projects[0]?.frameworks.find((framework) => framework.name === 'Serilog')?.currentVersion).toBeNull();

    const cdx = toCycloneDx(artifact(projects)) as {
      components: Array<{ name: string; version: string; purl?: string }>;
    };
    const component = cdx.components.find((item) => item.name === 'Missing.Package');
    expect(component?.version).toBe('unknown');
    expect(component?.purl).toBe('pkg:nuget/Missing.Package');
  });

  it('keeps a versionless reference when no Directory.Packages.props exists', async () => {
    const root = await temp();
    await write(root, 'App.csproj', csproj('<PackageReference Include="Serilog" />'));
    const projects = await scanDotnetProjects(root);
    expect(dep(projects, 'Serilog')).toMatchObject({ currentSpec: 'unknown', resolvedVersion: null });
  });

  it('lets packages.config fill a reference whose version stayed unknown', async () => {
    const root = await temp();
    await write(root, 'Legacy.csproj', csproj('<PackageReference Include="Newtonsoft.Json" />'));
    await write(root, 'packages.config', `<?xml version="1.0" encoding="utf-8"?>
<packages>
  <package id="Newtonsoft.Json" version="11.0.2" targetFramework="net48" />
  <package id="log4net" version="2.0.8" targetFramework="net48" />
</packages>
`);
    const projects = await scanDotnetProjects(root);
    expect(dep(projects, 'Newtonsoft.Json').currentSpec).toBe('11.0.2');
    expect(dep(projects, 'log4net').currentSpec).toBe('2.0.8');
  });
});
