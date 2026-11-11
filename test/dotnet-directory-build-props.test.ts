/**
 * Target frameworks inherited from Directory.Build.props.
 * A project that sets neither TargetFramework nor TargetFrameworks takes
 * them from the nearest props file at or above its directory, not above
 * the scan root. A value in the project file wins. `$(...)` is not a runtime.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCache } from '../src/core-open/utils/fs.js';
import { scanDotnetProjects } from '../src/core-open/scanners/dotnet-scanner.js';
import { latestStable } from '../src/core-open/runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../src/core-open/runtimes/snapshot.js';
import type { ProjectScan } from '../src/reporting/types.js';

const PROPS = (body: string) => `<Project>
  <PropertyGroup>
    ${body}
  </PropertyGroup>
</Project>
`;

function csproj(propertyGroup: string): string {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    ${propertyGroup}
  </PropertyGroup>
</Project>
`;
}

function lag(tfm: string): number | undefined {
  const major = Number(/^net(\d+)\.\d+$/.exec(tfm)?.[1]);
  const latest = latestStable(BUNDLED_RUNTIME_CATALOG, 'dotnet')?.major;
  if (!Number.isInteger(major) || latest === undefined) return undefined;
  return Math.max(0, latest - major);
}

describe('Directory.Build.props target frameworks', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  async function temp(): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vg-dotnet-props-'));
    dirs.push(dir);
    return dir;
  }

  async function write(dir: string, rel: string, text: string): Promise<void> {
    const file = path.join(dir, rel);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, text);
  }

  function byName(projects: ProjectScan[]): Map<string, ProjectScan> {
    return new Map(projects.map((project) => [project.name, project]));
  }

  it('reports net8.0 and its runtime lag when only Directory.Build.props sets the framework', async () => {
    const root = await temp();
    await write(root, 'Directory.Build.props', PROPS('<TargetFramework>net8.0</TargetFramework>'));
    await write(root, 'src/App/App.csproj', csproj(''));

    const project = (await scanDotnetProjects(root, undefined, new FileCache()))[0];
    expect(project?.name).toBe('App');
    expect(project?.runtime).toBe('net8.0');
    expect(project?.targetFramework).toBe('net8.0');
    expect(project?.runtimeMajorsBehind).toBe(lag('net8.0'));
    expect(project?.runtimeMajorsBehind).toBeGreaterThan(0);
  });

  it('keeps a framework declared on the project ahead of Directory.Build.props', async () => {
    const root = await temp();
    await write(root, 'Directory.Build.props', PROPS('<TargetFramework>net8.0</TargetFramework>'));
    await write(root, 'src/App/App.csproj', csproj('<TargetFramework>net9.0</TargetFramework>'));

    const project = (await scanDotnetProjects(root))[0];
    expect(project?.runtime).toBe('net9.0');
    expect(project?.targetFramework).toBe('net9.0');
    expect(project?.runtimeMajorsBehind).toBe(lag('net9.0'));
  });

  it('does not report an MSBuild property reference as a runtime', async () => {
    const root = await temp();
    await write(root, 'App.csproj', csproj('<TargetFramework>$(SomeProperty)</TargetFramework>'));
    await write(root, 'Multi.csproj', csproj('<TargetFrameworks>$(DefaultTfm);$(Other)</TargetFrameworks>'));
    await write(
      root,
      'Directory.Build.props',
      PROPS('<TargetFramework>$(DefaultTfm)</TargetFramework>'),
    );

    const projects = byName(await scanDotnetProjects(root));
    for (const project of projects.values()) {
      expect(project.runtime).toBeUndefined();
      expect(project.targetFramework).toBeUndefined();
      expect(project.runtimeMajorsBehind).toBeUndefined();
      expect(JSON.stringify(project)).not.toContain('$(');
    }
  });

  it('falls back to props when the project value is only a property reference', async () => {
    const root = await temp();
    await write(root, 'Directory.Build.props', PROPS('<TargetFramework>net8.0</TargetFramework>'));
    await write(root, 'App.csproj', csproj('<TargetFramework>$(DefaultTfm)</TargetFramework>'));

    const project = (await scanDotnetProjects(root))[0];
    expect(project?.runtime).toBe('net8.0');
    expect(project?.runtimeMajorsBehind).toBe(lag('net8.0'));
    expect(JSON.stringify(project)).not.toContain('$(');
  });

  it('keeps a concrete moniker and drops a property reference in the same list', async () => {
    const root = await temp();
    await write(root, 'Directory.Build.props', PROPS('<TargetFramework>net8.0</TargetFramework>'));
    await write(root, 'App.csproj', csproj('<TargetFrameworks>net9.0;$(OtherTfm)</TargetFrameworks>'));

    const project = (await scanDotnetProjects(root))[0];
    expect(project?.runtime).toBe('net9.0');
    expect(JSON.stringify(project)).not.toContain('$(');
  });

  it('uses the nearest Directory.Build.props and does not read one above the scan root', async () => {
    const parent = await temp();
    const root = path.join(parent, 'repo');
    await write(parent, 'Directory.Build.props', PROPS('<TargetFramework>net6.0</TargetFramework>'));
    await write(root, 'Directory.Build.props', PROPS('<TargetFramework>net9.0</TargetFramework>'));
    await write(root, 'src/Directory.Build.props', PROPS('<TargetFramework>net8.0</TargetFramework>'));
    await write(root, 'src/App/App.csproj', csproj(''));
    await write(root, 'other/Other.csproj', csproj(''));

    const projects = byName(await scanDotnetProjects(root));
    expect(projects.get('App')?.runtime).toBe('net8.0');
    expect(projects.get('App')?.runtimeMajorsBehind).toBe(lag('net8.0'));
    expect(projects.get('Other')?.runtime).toBe('net9.0');

    const bare = path.join(parent, 'bare');
    await write(bare, 'leaf/Leaf.csproj', csproj(''));
    const leaf = (await scanDotnetProjects(bare))[0];
    expect(leaf?.name).toBe('Leaf');
    expect(leaf?.runtime).toBeUndefined();
    expect(leaf?.runtimeMajorsBehind).toBeUndefined();
  });

  it('does not walk past the nearest props file when that file sets no framework', async () => {
    const root = await temp();
    await write(root, 'Directory.Build.props', PROPS('<TargetFramework>net8.0</TargetFramework>'));
    await write(root, 'src/Directory.Build.props', PROPS('<Nullable>enable</Nullable>'));
    await write(root, 'src/App/App.csproj', csproj(''));

    const project = (await scanDotnetProjects(root))[0];
    expect(project?.runtime).toBeUndefined();
    expect(project?.runtimeMajorsBehind).toBeUndefined();
  });

  it('reads TargetFrameworks and trims a differently cased element', async () => {
    const root = await temp();
    await write(root, 'Directory.Build.props', `<project>
  <propertygroup>
    <targetframeworks>  net8.0 ; net9.0  </targetframeworks>
  </propertygroup>
</project>
`);
    await write(root, 'App.csproj', csproj(''));

    const project = (await scanDotnetProjects(root))[0];
    expect(project?.runtime).toBe('net8.0');
    expect(project?.targetFramework).toBe('net8.0');
    expect(project?.runtimeMajorsBehind).toBe(lag('net8.0'));
  });

  it('reads a conditioned project element as text, which still wins over props', async () => {
    const root = await temp();
    await write(root, 'Directory.Build.props', PROPS('<TargetFramework>net8.0</TargetFramework>'));
    await write(
      root,
      'App.csproj',
      csproj(`<TargetFramework Condition="'$(TargetFramework)' == ''">net9.0</TargetFramework>`),
    );

    const project = (await scanDotnetProjects(root))[0];
    expect(project?.runtime).toBe('net9.0');
    expect(JSON.stringify(project)).not.toContain('$(');
  });

  it('still scans a project when Directory.Build.props is missing or malformed', async () => {
    const root = await temp();
    await write(root, 'missing/App.csproj', csproj(''));
    await write(root, 'bad/Directory.Build.props', 'this is not xml <<<');
    await write(root, 'bad/Bad.csproj', csproj(''));

    const projects = byName(await scanDotnetProjects(root));
    expect(projects.get('App')?.name).toBe('App');
    expect(projects.get('App')?.runtime).toBeUndefined();
    expect(projects.get('Bad')?.name).toBe('Bad');
    expect(projects.get('Bad')?.runtime).toBeUndefined();
    expect(projects.get('Bad')?.runtimeMajorsBehind).toBeUndefined();
  });
});
