/**
 * F# SDK-style projects (.fsproj) are discovered by vg scan the same way as
 * .csproj: target framework, NuGet PackageReferences, central package versions,
 * Directory.Build.props, and solution membership.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCoreScan } from '../src/core-open/index.js';
import { scanDotnetProjects } from '../src/core-open/scanners/dotnet-scanner.js';
import { collectLockfileGraph, toCycloneDx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const fixture = fileURLToPath(new URL('./fixtures/fsharp-fsproj/', import.meta.url));

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'fsharp-fsproj',
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

describe('F# .fsproj projects', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  async function temp(): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vg-fsproj-'));
    dirs.push(dir);
    return dir;
  }

  async function write(dir: string, rel: string, text: string): Promise<void> {
    const file = path.join(dir, rel);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, text);
  }

  it('lists the F# project, its target framework, central package versions, and the SBOM', async () => {
    const projects = await scanDotnetProjects(fixture);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      type: 'dotnet',
      name: 'App',
      path: 'src/App',
      targetFramework: 'net8.0',
      runtime: 'net8.0',
    });
    const deps = [...(projects[0]?.dependencies ?? [])].sort((a, b) => a.package.localeCompare(b.package));
    expect(deps.map((dep) => ({ package: dep.package, section: dep.section, currentSpec: dep.currentSpec }))).toEqual([
      { package: 'FSharp.Core', section: 'dependencies', currentSpec: '8.0.400' },
      { package: 'Newtonsoft.Json', section: 'dependencies', currentSpec: '13.0.3' },
    ]);

    const cdx = toCycloneDx(artifact(projects), collectLockfileGraph(artifact(projects), fixture)) as {
      components: Array<{ name: string; version: string; purl?: string }>;
    };
    expect(cdx.components.find((item) => item.name === 'FSharp.Core')).toMatchObject({
      version: '8.0.400',
      purl: 'pkg:nuget/FSharp.Core@8.0.400',
    });
    expect(cdx.components.find((item) => item.name === 'Newtonsoft.Json')).toMatchObject({
      version: '13.0.3',
      purl: 'pkg:nuget/Newtonsoft.Json@13.0.3',
    });
  });

  it('attaches the F# project to the solution that references the .fsproj', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const scanned = await runCoreScan(fixture, {
        format: 'json',
        concurrency: 1,
        offline: true,
        noLocalArtifacts: true,
        quiet: true,
      });
      const project = scanned.projects.find((item) => item.name === 'App');
    expect(project?.targetFramework).toBe('net8.0');
    expect(project?.solutionName).toBe('App');
      const solution = scanned.solutions?.find((item) => item.name === 'App');
      expect(solution?.projectPaths).toContain('src/App/App.fsproj');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('reads an .fsproj that the directory walk skips when the solution names it', async () => {
    const root = await temp();
    await write(
      root,
      'node_modules/hidden/Hidden.fsproj',
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="FSharp.Core" Version="8.0.100" />
  </ItemGroup>
</Project>`,
    );
    await write(
      root,
      'App.sln',
      `Project("{F2A71F9B-5D33-11D2-A97A-00C04F79EFBC}") = "Hidden", "node_modules\\hidden\\Hidden.fsproj", "{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}"\nEndProject\n`,
    );

    const projects = await scanDotnetProjects(root);
    expect(projects.map((project) => project.name)).toEqual(['Hidden']);
    expect(projects[0]?.targetFramework).toBe('net8.0');
    expect(projects[0]?.dependencies.map((dep) => dep.package)).toEqual(['FSharp.Core']);
  });

  it('takes TargetFramework from Directory.Build.props for an .fsproj that sets none', async () => {
    const root = await temp();
    await write(
      root,
      'Directory.Build.props',
      `<Project>
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
</Project>`,
    );
    await write(
      root,
      'src/Lib/Lib.fsproj',
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="FSharp.Core" Version="8.0.100" />
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>`,
    );

    const project = (await scanDotnetProjects(root))[0];
    expect(project?.name).toBe('Lib');
    expect(project?.targetFramework).toBe('net8.0');
    expect(project?.runtime).toBe('net8.0');
    expect(project?.dependencies.map((dep) => dep.package).sort()).toEqual(['FSharp.Core', 'Newtonsoft.Json']);
  });

  it('still names .csproj, .vbproj, and .sqlproj projects from their file names', async () => {
    const root = await temp();
    const project = (body = '<TargetFramework>net8.0</TargetFramework>') =>
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${body}</PropertyGroup></Project>`;
    await write(root, 'CsApp/CsApp.csproj', project());
    await write(root, 'VbApp/VbApp.vbproj', project());
    await write(root, 'Db/Db.sqlproj', project(''));
    await write(root, 'Fun/Fun.fsproj', project());

    const byName = new Map((await scanDotnetProjects(root)).map((item) => [item.name, item]));
    expect([...byName.keys()].sort()).toEqual(['CsApp', 'Db', 'Fun', 'VbApp']);
    expect(byName.get('CsApp')?.targetFramework).toBe('net8.0');
    expect(byName.get('VbApp')?.targetFramework).toBe('net8.0');
    expect(byName.get('Fun')?.targetFramework).toBe('net8.0');
    expect(byName.get('Db')?.type).toBe('dotnet');
  });
});
