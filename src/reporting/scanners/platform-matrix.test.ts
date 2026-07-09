import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { scanPlatformMatrix } from './platform-matrix.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'vibgrate-platform-test-'));
}

describe('scanPlatformMatrix', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns empty result for empty directory', async () => {
    const result = await scanPlatformMatrix(tempDir);
    expect(result.nodeEngines).toBeUndefined();
    expect(result.dotnetTargetFrameworks).toEqual([]);
    expect(result.nativeModules).toEqual([]);
    expect(result.osAssumptions).toEqual([]);
    expect(result.dockerBaseImages).toEqual([]);
    expect(result.nodeVersionFiles).toEqual([]);
  });

  it('detects node engines from package.json', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ engines: { node: '>=18.0.0', npm: '>=9' } }),
    );
    const result = await scanPlatformMatrix(tempDir);
    expect(result.nodeEngines).toBe('>=18.0.0');
    expect(result.npmEngines).toBe('>=9');
  });

  it('detects pnpm engine constraint', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ engines: { pnpm: '>=8' } }),
    );
    const result = await scanPlatformMatrix(tempDir);
    expect(result.pnpmEngines).toBe('>=8');
  });

  it('detects native module packages in dependencies', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        dependencies: { sharp: '^0.33.0', express: '^4.18.0' },
        devDependencies: { bcrypt: '^5.0.0' },
      }),
    );
    const result = await scanPlatformMatrix(tempDir);
    expect(result.nativeModules).toEqual(['bcrypt', 'sharp']);
  });

  it('detects multiple native modules including platform-specific ones', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        dependencies: { '@swc/core': '^1.0.0', 'better-sqlite3': '^9.0.0' },
        optionalDependencies: { fsevents: '^2.0.0' },
      }),
    );
    const result = await scanPlatformMatrix(tempDir);
    expect(result.nativeModules).toContain('@swc/core');
    expect(result.nativeModules).toContain('better-sqlite3');
    expect(result.nativeModules).toContain('fsevents');
  });

  it('detects bash OS assumption from scripts', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: { start: 'bash run.sh', build: 'tsc' },
      }),
    );
    const result = await scanPlatformMatrix(tempDir);
    expect(result.osAssumptions).toContain('bash-scripts');
  });

  it('detects powershell OS assumption from scripts', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: { deploy: 'powershell deploy.ps1' },
      }),
    );
    const result = await scanPlatformMatrix(tempDir);
    expect(result.osAssumptions).toContain('powershell');
  });

  it('detects .NET target frameworks from .csproj files', async () => {
    await fs.writeFile(
      path.join(tempDir, 'App.csproj'),
      `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
      </Project>`,
    );
    const result = await scanPlatformMatrix(tempDir);
    expect(result.dotnetTargetFrameworks).toEqual(['net8.0']);
  });



  it('detects .NET target frameworks from .vbproj files', async () => {
    await fs.writeFile(
      path.join(tempDir, 'VbApp.vbproj'),
      `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><TargetFramework>net7.0</TargetFramework></PropertyGroup>
      </Project>`,
    );
    const result = await scanPlatformMatrix(tempDir);
    expect(result.dotnetTargetFrameworks).toEqual(['net7.0']);
  });

  it('detects multiple target frameworks', async () => {
    await fs.writeFile(
      path.join(tempDir, 'Lib.csproj'),
      `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><TargetFrameworks>net6.0;net8.0</TargetFrameworks></PropertyGroup>
      </Project>`,
    );
    const result = await scanPlatformMatrix(tempDir);
    expect(result.dotnetTargetFrameworks).toEqual(['net6.0', 'net8.0']);
  });

  it('detects Docker base images from Dockerfile', async () => {
    await fs.writeFile(
      path.join(tempDir, 'Dockerfile'),
      `FROM node:20-alpine AS build
RUN npm install
FROM node:20-alpine
COPY --from=build /app /app`,
    );
    const result = await scanPlatformMatrix(tempDir);
    expect(result.dockerBaseImages).toEqual(['node:20-alpine']);
  });

  it('detects multiple Docker base images', async () => {
    await fs.writeFile(
      path.join(tempDir, 'Dockerfile'),
      `FROM node:20-alpine AS build
RUN npm build`,
    );
    await fs.writeFile(
      path.join(tempDir, 'Dockerfile.api'),
      `FROM mcr.microsoft.com/dotnet/sdk:8.0
RUN dotnet build`,
    );
    const result = await scanPlatformMatrix(tempDir);
    expect(result.dockerBaseImages).toContain('node:20-alpine');
    expect(result.dockerBaseImages).toContain('mcr.microsoft.com/dotnet/sdk:8.0');
  });

  it('handles FROM --platform syntax in Dockerfiles', async () => {
    await fs.writeFile(
      path.join(tempDir, 'Dockerfile'),
      `FROM --platform=linux/amd64 node:20-slim
RUN echo hello`,
    );
    const result = await scanPlatformMatrix(tempDir);
    expect(result.dockerBaseImages).toContain('node:20-slim');
  });

  it('detects .nvmrc file', async () => {
    await fs.writeFile(path.join(tempDir, '.nvmrc'), '20');
    const result = await scanPlatformMatrix(tempDir);
    expect(result.nodeVersionFiles).toContain('.nvmrc');
  });

  it('detects .node-version file', async () => {
    await fs.writeFile(path.join(tempDir, '.node-version'), '20.11.0');
    const result = await scanPlatformMatrix(tempDir);
    expect(result.nodeVersionFiles).toContain('.node-version');
  });

  it('detects .tool-versions file', async () => {
    await fs.writeFile(path.join(tempDir, '.tool-versions'), 'nodejs 20.11.0');
    const result = await scanPlatformMatrix(tempDir);
    expect(result.nodeVersionFiles).toContain('.tool-versions');
  });

  it('collects from nested package.json files', async () => {
    const subDir = path.join(tempDir, 'sub');
    await fs.mkdir(subDir);
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ dependencies: { sharp: '^0.33.0' } }),
    );
    await fs.writeFile(
      path.join(subDir, 'package.json'),
      JSON.stringify({ dependencies: { canvas: '^2.0.0' } }),
    );
    const result = await scanPlatformMatrix(tempDir);
    expect(result.nativeModules).toContain('sharp');
    expect(result.nativeModules).toContain('canvas');
  });

  it('handles malformed package.json gracefully', async () => {
    await fs.writeFile(path.join(tempDir, 'package.json'), 'not json');
    const result = await scanPlatformMatrix(tempDir);
    // Should not throw, just return empty
    expect(result.nativeModules).toEqual([]);
  });
});
