/**
 * A multi-module Maven build often writes a sibling dependency as
 * `${project.groupId}` and `${project.version}` (inherited from the parent).
 * Those coordinates have to be resolved or the dependency is dropped from the
 * scan and from SBOM export. An explicit `<properties>` entry still wins, and
 * a reference that cannot be resolved stays omitted.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MavenCache } from '../src/core-open/scanners/maven-cache.js';
import { scanJavaProjects } from '../src/core-open/scanners/java-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { collectLockfileGraph, toCycloneDx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/maven-reactor-coordinates', import.meta.url));

const CHILD_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.acme</groupId>
    <artifactId>parent</artifactId>
    <version>2.5.0</version>
  </parent>
  <artifactId>child</artifactId>
  <version>\${revision}</version>
  <properties>
    <revision>8.8.8</revision>
    <project.groupId>com.override</project.groupId>
  </properties>
  <dependencies>
    <dependency>
      <groupId>\${project.groupId}</groupId>
      <artifactId>from-property</artifactId>
      <version>\${project.version}</version>
    </dependency>
    <dependency>
      <groupId>\${pom.parent.groupId}</groupId>
      <artifactId>from-parent</artifactId>
      <version>\${project.parent.version}</version>
    </dependency>
    <dependency>
      <groupId>\${pom.groupId}</groupId>
      <artifactId>alias</artifactId>
      <version>\${pom.version}</version>
    </dependency>
    <dependency>
      <groupId>\${missing.group}</groupId>
      <artifactId>ghost</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>
`;

function offlineMavenCache(): MavenCache {
  const cache = new MavenCache(new Semaphore(1));
  vi.spyOn(cache, 'get').mockImplementation(async () => ({
    latest: null,
    stableVersions: [],
    latestStableOverall: null,
  }));
  return cache;
}

function artifact(projects: ProjectScan[], rootPath: string): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath,
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

function spec(project: ProjectScan | undefined, name: string): string | undefined {
  return project?.dependencies.find((dep) => dep.package === name)?.currentSpec;
}

describe('Maven project coordinates in dependency versions', () => {
  let root: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('keeps a sibling dependency that uses ${project.version} and ${project.groupId}', async () => {
    const projects = await scanJavaProjects(FIXTURE, offlineMavenCache());
    expect(projects.map((project) => project.name).sort()).toEqual(['app', 'core', 'demo-parent']);

    const core = projects.find((project) => project.name === 'core');
    const app = projects.find((project) => project.name === 'app');
    expect(core?.dependencies.map((dep) => [dep.package, dep.currentSpec])).toEqual([
      ['com.acme.demo:shared', '1.4.0'],
    ]);
    expect(app?.dependencies.map((dep) => [dep.package, dep.currentSpec])).toEqual([
      ['com.acme.demo:core', '2.5.0'],
    ]);
    expect(app?.dependencies.some((dep) => dep.package.includes('ghost') || dep.package.includes('unresolved') || dep.package.includes('${'))).toBe(false);

    const scanArtifact = artifact(projects, 'maven-reactor-coordinates');
    const graph = collectLockfileGraph(scanArtifact, FIXTURE);
    const cdx = toCycloneDx(scanArtifact, graph) as { components: Array<{ name: string; version: string }> };
    const byName = new Map(cdx.components.map((component) => [component.name, component.version]));
    expect(byName.get('com.acme.demo:shared')).toBe('1.4.0');
    expect(byName.get('com.acme.demo:core')).toBe('2.5.0');
    expect(byName.has('com.example:unresolved')).toBe(false);
  });

  it('lets an explicit property win and keeps parent coordinates distinct', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-maven-coords-'));
    fs.writeFileSync(path.join(root, 'pom.xml'), CHILD_POM);

    const projects = await scanJavaProjects(root, offlineMavenCache());
    expect(projects).toHaveLength(1);
    const project = projects[0]!;
    expect(spec(project, 'com.override:from-property')).toBe('8.8.8');
    expect(spec(project, 'com.override:alias')).toBe('8.8.8');
    expect(spec(project, 'com.acme:from-parent')).toBe('2.5.0');
    expect(project.dependencies.some((dep) => dep.package.includes('ghost') || dep.package.includes('${'))).toBe(false);

    const scanArtifact = artifact(projects, 'child');
    const cdx = toCycloneDx(scanArtifact, collectLockfileGraph(scanArtifact, root)) as {
      components: Array<{ name: string }>;
    };
    expect(cdx.components.map((component) => component.name).sort()).toEqual([
      'com.acme:from-parent',
      'com.override:alias',
      'com.override:from-property',
    ]);
  });
});
