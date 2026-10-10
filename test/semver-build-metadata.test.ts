import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanDartProjects } from '../src/core-open/scanners/dart-scanner.js';
import { scanDotnetProjects } from '../src/core-open/scanners/dotnet-scanner.js';
import { scanGoProjects } from '../src/core-open/scanners/go-scanner.js';
import { scanJavaProjects } from '../src/core-open/scanners/java-scanner.js';
import { scanNodeProjects } from '../src/core-open/scanners/node-scanner.js';
import { scanPhpProjects } from '../src/core-open/scanners/php-scanner.js';
import { scanPythonProjects } from '../src/core-open/scanners/python-scanner.js';
import { scanRubyProjects } from '../src/core-open/scanners/ruby-scanner.js';
import { scanRustProjects } from '../src/core-open/scanners/rust-scanner.js';
import { scanSwiftProjects } from '../src/core-open/scanners/swift-scanner.js';
import { CargoCache } from '../src/core-open/scanners/cargo-cache.js';
import { ComposerCache } from '../src/core-open/scanners/composer-cache.js';
import { GoCache } from '../src/core-open/scanners/go-cache.js';
import { MavenCache } from '../src/core-open/scanners/maven-cache.js';
import { NpmCache } from '../src/core-open/scanners/npm-cache.js';
import { NuGetCache } from '../src/core-open/scanners/nuget-cache.js';
import { PubCache } from '../src/core-open/scanners/pub-cache.js';
import { PyPICache } from '../src/core-open/scanners/pypi-cache.js';
import { RubyGemsCache } from '../src/core-open/scanners/rubygems-cache.js';
import { SwiftCache } from '../src/core-open/scanners/swift-cache.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';

const BUILD = '1.2.3+build.7';
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../examples/semver-build-metadata');

function offline() {
  return new Semaphore(1);
}

async function scanFixture(): Promise<ProjectScan[]> {
  const sem = offline();
  const [node, go, java, python, ruby, php, dart, swift, rust, dotnet] = await Promise.all([
    scanNodeProjects(fixtureDir, new NpmCache(fixtureDir, sem, undefined, true)),
    scanGoProjects(fixtureDir, new GoCache(sem, undefined, true)),
    scanJavaProjects(fixtureDir, new MavenCache(sem, undefined, true)),
    scanPythonProjects(fixtureDir, new PyPICache(sem, undefined, true)),
    scanRubyProjects(fixtureDir, new RubyGemsCache(sem, undefined, true)),
    scanPhpProjects(fixtureDir, new ComposerCache(sem, undefined, true)),
    scanDartProjects(fixtureDir, new PubCache(sem, undefined, true)),
    scanSwiftProjects(fixtureDir, new SwiftCache(sem, undefined, true)),
    scanRustProjects(fixtureDir, new CargoCache(sem, undefined, true)),
    scanDotnetProjects(fixtureDir, new NuGetCache(sem, undefined, true)),
  ]);
  return [...node, ...go, ...java, ...python, ...ruby, ...php, ...dart, ...swift, ...rust, ...dotnet];
}

function resolved(projects: ProjectScan[], projectPath: string, pkg: string): string | null {
  const project = projects.find((p) => p.path === projectPath);
  const dep = project?.dependencies.find((d) => d.package === pkg);
  return dep?.resolvedVersion ?? null;
}

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.0',
    rootPath: 'semver-build-metadata',
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

describe('SemVer build metadata in scan JSON and SBOMs', () => {
  it('records +build from lockfiles and manifests', async () => {
    const projects = await scanFixture();
    expect(resolved(projects, '.', 'example-build-meta')).toBe(BUILD);
    expect(resolved(projects, 'go', 'example.com/with-build')).toBe(BUILD);
    expect(projects.find((p) => p.path === 'go')?.dependencies[0]?.currentSpec).toBe(`v${BUILD}`);
    expect(resolved(projects, 'java', 'com.example:build-meta')).toBe(BUILD);
    expect(resolved(projects, 'java-gradle', 'com.example:locked')).toBe(BUILD);
    expect(resolved(projects, 'python', 'example-build-meta')).toBe(BUILD);
    expect(resolved(projects, 'ruby', 'example-build-meta')).toBe(BUILD);
    expect(resolved(projects, 'php', 'example/build-meta')).toBe(BUILD);
    expect(resolved(projects, 'dart', 'example_build_meta')).toBe(BUILD);
    expect(resolved(projects, 'swift', 'build-meta')).toBe(BUILD);
    expect(resolved(projects, 'rust', 'example-build-meta')).toBe(BUILD);
    expect(resolved(projects, 'rust-declared', 'example-build-meta')).toBe(BUILD);
    expect(resolved(projects, 'dotnet', 'Example.BuildMeta')).toBe(BUILD);
    expect(JSON.stringify(projects)).toContain(BUILD);
    expect(JSON.stringify(projects)).not.toContain('"resolvedVersion":"1.2.3"');
  });

  it('keeps the suffix on CycloneDX and SPDX components, including the purl', async () => {
    const projects = await scanFixture();
    const graph = collectLockfileGraph(artifact(projects), fixtureDir);
    const cdx = toCycloneDx(artifact(projects), graph) as {
      components: Array<{ name: string; version: string; purl?: string }>;
    };
    const spdx = toSpdx(artifact(projects), graph) as {
      packages: Array<{ versionInfo?: string; externalRefs?: Array<{ referenceLocator?: string }> }>;
    };

    expect(cdx.components.map((c) => c.version)).not.toContain('1.2.3');
    expect(cdx.components.some((c) => c.version.includes('+build.7'))).toBe(true);
    expect(cdx.components.find((c) => c.purl === 'pkg:npm/example-build-meta@1.2.3%2Bbuild.7')).toBeTruthy();
    expect(cdx.components.filter((c) => c.name === 'example.com/with-build')).toEqual([
      expect.objectContaining({
        version: `v${BUILD}`,
        purl: 'pkg:golang/example.com/with-build@v1.2.3%2Bbuild.7',
      }),
    ]);

    const spdxVersions = spdx.packages.map((p) => p.versionInfo);
    expect(spdxVersions).not.toContain('1.2.3');
    expect(spdxVersions.some((v) => v?.includes('+build.7'))).toBe(true);
    const locators = spdx.packages.flatMap((p) => p.externalRefs?.map((r) => r.referenceLocator) ?? []);
    expect(locators).toContain('pkg:npm/example-build-meta@1.2.3%2Bbuild.7');
    expect(locators).toContain('pkg:golang/example.com/with-build@v1.2.3%2Bbuild.7');
  });
});
