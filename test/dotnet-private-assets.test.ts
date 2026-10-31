import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDotnetProjects } from '../src/core-open/scanners/dotnet-scanner.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'vibgrate-dotnet-assets-'));
}

describe('PrivateAssets on PackageReference', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('marks a PrivateAssets=all attribute as devDependencies, in any letter case', async () => {
    tempDir = await createTempDir();
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Serilog" Version="4.0.0" />
    <PackageReference Include="Microsoft.SourceLink.GitHub" Version="8.0.0" PrivateAssets="all" />
    <PackageReference Include="coverlet.collector" Version="6.0.2" PrivateAssets="All" />
    <PackageReference Include="MinVer" Version="5.0.0" privateassets="ALL" />
  </ItemGroup>
</Project>`;
    await fs.writeFile(path.join(tempDir, 'App.csproj'), csproj);

    const deps = (await scanDotnetProjects(tempDir))[0]!.dependencies;
    expect(deps.find((d) => d.package === 'Serilog')?.section).toBe('dependencies');
    expect(deps.find((d) => d.package === 'Microsoft.SourceLink.GitHub')?.section).toBe('devDependencies');
    expect(deps.find((d) => d.package === 'coverlet.collector')?.section).toBe('devDependencies');
    expect(deps.find((d) => d.package === 'MinVer')?.section).toBe('devDependencies');
  });

  it('marks a PrivateAssets child element of all as devDependencies', async () => {
    tempDir = await createTempDir();
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="StyleCop.Analyzers" Version="1.2.0-beta.556">
      <PrivateAssets>all</PrivateAssets>
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
    </PackageReference>
    <PackageReference Include="Microsoft.CodeAnalysis.NetAnalyzers" Version="8.0.0">
      <privateassets> ALL </privateassets>
    </PackageReference>
  </ItemGroup>
</Project>`;
    await fs.writeFile(path.join(tempDir, 'Analyzers.csproj'), csproj);

    const deps = (await scanDotnetProjects(tempDir))[0]!.dependencies;
    expect(deps.find((d) => d.package === 'StyleCop.Analyzers')?.section).toBe('devDependencies');
    expect(deps.find((d) => d.package === 'Microsoft.CodeAnalysis.NetAnalyzers')?.section).toBe('devDependencies');
  });

  it('keeps PrivateAssets values other than all as production dependencies', async () => {
    tempDir = await createTempDir();
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="MinVer" Version="5.0.0" PrivateAssets="compile" />
    <PackageReference Include="StyleCop.Analyzers" Version="1.2.0-beta.556">
      <PrivateAssets>runtime</PrivateAssets>
    </PackageReference>
  </ItemGroup>
</Project>`;
    await fs.writeFile(path.join(tempDir, 'Compile.csproj'), csproj);

    const deps = (await scanDotnetProjects(tempDir))[0]!.dependencies;
    expect(deps.find((d) => d.package === 'MinVer')?.section).toBe('dependencies');
    expect(deps.find((d) => d.package === 'StyleCop.Analyzers')?.section).toBe('dependencies');
  });

  it('keeps a package in production when another reference omits PrivateAssets=all', async () => {
    tempDir = await createTempDir();
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" PrivateAssets="all" />
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Dapper" Version="2.1.35" />
    <PackageReference Include="Dapper" Version="2.0.0" PrivateAssets="all" />
    <PackageReference Include="coverlet.collector" Version="6.0.0" PrivateAssets="all" />
    <PackageReference Include="coverlet.collector" Version="6.0.2">
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
  </ItemGroup>
</Project>`;
    await fs.writeFile(path.join(tempDir, 'Dup.csproj'), csproj);

    const deps = (await scanDotnetProjects(tempDir))[0]!.dependencies;
    const json = deps.filter((d) => d.package === 'Newtonsoft.Json');
    expect(json).toHaveLength(1);
    expect(json[0]!.section).toBe('dependencies');
    expect(json[0]!.currentSpec).toBe('13.0.3');

    const dapper = deps.filter((d) => d.package === 'Dapper');
    expect(dapper).toHaveLength(1);
    expect(dapper[0]!.section).toBe('dependencies');
    expect(dapper[0]!.currentSpec).toBe('2.1.35');

    const coverlet = deps.filter((d) => d.package === 'coverlet.collector');
    expect(coverlet).toHaveLength(1);
    expect(coverlet[0]!.section).toBe('devDependencies');
    expect(coverlet[0]!.currentSpec).toBe('6.0.0');
  });
});
