/**
 * Maven profile `<dependencies>` and `<dependencyManagement>` are scan rows.
 * A profile-only production coordinate is optional, because activation is not
 * evaluated. Test scope stays a dev row. A top-level coordinate wins, and the
 * same coordinate in two profiles is stored once.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MavenCache } from '../src/core-open/scanners/maven-cache.js';
import { scanJavaProjects } from '../src/core-open/scanners/java-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

/** package, section, version. Order is the scanner's code-unit sort (all drift unknown). */
const SECTIONS: Array<[string, string, string]> = [
  ['com.example:later-versioned', 'optionalDependencies', '6.0.0'],
  ['com.example:profile-managed', 'optionalDependencies', '3.1.0'],
  ['com.example:profile-optional', 'optionalDependencies', '2.0.0'],
  ['com.example:profile-optional-false', 'optionalDependencies', '2.2.0'],
  ['com.example:shared-profile', 'optionalDependencies', '1.2.3'],
  ['com.example:top-lib', 'dependencies', '1.0.0'],
  ['com.example:top-managed', 'dependencies', '4.0.0'],
  ['com.example:unversioned-top', 'optionalDependencies', '1.5.0'],
  ['com.mysql:mysql-connector-j', 'optionalDependencies', '8.3.0'],
  ['junit:junit', 'devDependencies', '4.13.2'],
  ['org.mockito:mockito-core', 'devDependencies', '5.11.0'],
  ['org.postgresql:postgresql', 'optionalDependencies', '42.7.3'],
];

const MULTI_PROFILE_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>profile-app</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>top-lib</artifactId>
      <version>1.0.0</version>
      <scope>compile</scope>
    </dependency>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>unversioned-top</artifactId>
    </dependency>
  </dependencies>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>top-managed</artifactId>
        <version>4.0.0</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <profiles>
    <profile>
      <id>postgres</id>
      <activation>
        <activeByDefault>true</activeByDefault>
      </activation>
      <dependencies>
        <dependency>
          <groupId>org.postgresql</groupId>
          <artifactId>postgresql</artifactId>
          <version>42.7.3</version>
        </dependency>
        <dependency>
          <groupId>com.example</groupId>
          <artifactId>top-lib</artifactId>
          <version>9.9.9</version>
          <scope>test</scope>
        </dependency>
        <dependency>
          <groupId>com.example</groupId>
          <artifactId>top-managed</artifactId>
          <version>5.5.5</version>
        </dependency>
        <dependency>
          <groupId>com.example</groupId>
          <artifactId>shared-profile</artifactId>
          <version>1.2.3</version>
        </dependency>
        <dependency>
          <groupId>com.example</groupId>
          <artifactId>unversioned-top</artifactId>
          <version>1.5.0</version>
          <scope>runtime</scope>
        </dependency>
        <dependency>
          <groupId>com.example</groupId>
          <artifactId>later-versioned</artifactId>
        </dependency>
        <dependency>
          <groupId>junit</groupId>
          <artifactId>junit</artifactId>
          <version>4.13.2</version>
          <scope>test</scope>
        </dependency>
        <dependency>
          <groupId>org.mockito</groupId>
          <artifactId>mockito-core</artifactId>
          <version>5.11.0</version>
          <scope>test</scope>
          <optional>true</optional>
        </dependency>
        <dependency>
          <groupId>com.example</groupId>
          <artifactId>profile-optional</artifactId>
          <version>2.0.0</version>
          <optional>true</optional>
        </dependency>
        <dependency>
          <groupId>com.example</groupId>
          <artifactId>profile-optional-false</artifactId>
          <version>2.2.0</version>
          <optional>false</optional>
        </dependency>
      </dependencies>
      <dependencyManagement>
        <dependencies>
          <dependency>
            <groupId>com.example</groupId>
            <artifactId>profile-managed</artifactId>
            <version>3.1.0</version>
          </dependency>
          <dependency>
            <groupId>com.example</groupId>
            <artifactId>shared-profile</artifactId>
            <version>7.7.7</version>
            <scope>test</scope>
          </dependency>
        </dependencies>
      </dependencyManagement>
      <build>
        <plugins>
          <plugin>
            <groupId>org.apache.maven.plugins</groupId>
            <artifactId>maven-compiler-plugin</artifactId>
            <dependencies>
              <dependency>
                <groupId>com.example</groupId>
                <artifactId>plugin-only</artifactId>
                <version>1.0.0</version>
              </dependency>
            </dependencies>
          </plugin>
        </plugins>
      </build>
    </profile>
    <profile>
      <id>mysql</id>
      <dependencies>
        <dependency>
          <groupId>com.mysql</groupId>
          <artifactId>mysql-connector-j</artifactId>
          <version>8.3.0</version>
          <scope>runtime</scope>
        </dependency>
        <dependency>
          <groupId>com.example</groupId>
          <artifactId>shared-profile</artifactId>
          <version>8.8.8</version>
          <scope>compile</scope>
        </dependency>
        <dependency>
          <groupId>com.example</groupId>
          <artifactId>later-versioned</artifactId>
          <version>6.0.0</version>
        </dependency>
      </dependencies>
    </profile>
  </profiles>
</project>
`;

/** One `<profile>` element, so the XML parser returns an object rather than an array. */
const SINGLE_PROFILE_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>one-profile</artifactId>
  <version>1.0.0</version>
  <profiles>
    <profile>
      <id>cloud</id>
      <dependencies>
        <dependency>
          <groupId>software.amazon.awssdk</groupId>
          <artifactId>s3</artifactId>
          <version>2.25.0</version>
        </dependency>
      </dependencies>
      <dependencyManagement>
        <dependencies>
          <dependency>
            <groupId>com.example</groupId>
            <artifactId>profile-bom</artifactId>
            <version>1.0.0</version>
            <type>pom</type>
            <scope>import</scope>
          </dependency>
        </dependencies>
      </dependencyManagement>
    </profile>
  </profiles>
</project>
`;

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'maven-profiles',
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

function offlineMavenCache(): MavenCache {
  const cache = new MavenCache(new Semaphore(1));
  vi.spyOn(cache, 'get').mockImplementation(async () => ({
    latest: null,
    stableVersions: [],
    latestStableOverall: null,
  }));
  return cache;
}

describe('sbom export: Maven profile dependencies', () => {
  let root: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps one row per coordinate and marks profile-only production rows optional', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-maven-profiles-'));
    fs.writeFileSync(path.join(root, 'pom.xml'), MULTI_PROFILE_POM);

    const projects = await scanJavaProjects(root, offlineMavenCache());
    expect(projects).toHaveLength(1);
    const project = projects[0]!;
    expect(project.dependencies.map((dep) => [dep.package, dep.section, dep.currentSpec])).toEqual(SECTIONS);
    expect(project.dependencies.some((dep) => dep.package === 'com.example:plugin-only')).toBe(false);

    const scanArtifact = artifact(projects);
    const graph = collectLockfileGraph(scanArtifact, root);
    const cdx = toCycloneDx(scanArtifact, graph) as {
      components: Array<{ name: string; scope?: string; properties: Array<{ name: string; value: string }> }>;
      dependencies?: unknown;
    };
    const byName = new Map(cdx.components.map((component) => [component.name, component]));
    const vibScope = (name: string): string | undefined =>
      byName.get(name)?.properties.find((property) => property.name === 'vibgrate:scope')?.value;

    expect([...cdx.components.map((component) => component.name)].sort()).toEqual(
      SECTIONS.map(([name]) => name).sort(),
    );
    for (const [name] of SECTIONS) expect(vibScope(name)).toBe('direct');
    expect(cdx.dependencies).toBeUndefined();
    expect(byName.get('com.example:top-lib')?.scope).toBeUndefined();
    expect(byName.get('com.example:top-managed')?.scope).toBeUndefined();
    expect(byName.get('org.postgresql:postgresql')?.scope).toBe('optional');
    expect(byName.get('com.example:profile-optional')?.scope).toBe('optional');
    expect(byName.get('com.example:profile-optional-false')?.scope).toBe('optional');
    expect(byName.get('com.example:shared-profile')?.scope).toBe('optional');
    expect(byName.get('junit:junit')?.scope).toBe('excluded');
    expect(byName.get('org.mockito:mockito-core')?.scope).toBe('excluded');

    const spdx = toSpdx(scanArtifact, graph) as {
      packages: Array<{ name: string; annotations: Array<{ comment: string }> }>;
      relationships: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
    };
    const id = (name: string): string => `SPDXRef-Package-${spdx.packages.findIndex((pkg) => pkg.name === name) + 1}`;
    const rel = (name: string): { relationshipType: string; relatedSpdxElementId: string } | undefined => {
      const element = id(name);
      const found = spdx.relationships.find((row) => row.spdxElementId === element);
      return found
        ? { relationshipType: found.relationshipType, relatedSpdxElementId: found.relatedSpdxElementId }
        : undefined;
    };

    expect(rel('org.postgresql:postgresql')).toEqual({
      relationshipType: 'OPTIONAL_DEPENDENCY_OF',
      relatedSpdxElementId: 'SPDXRef-DOCUMENT',
    });
    expect(rel('com.example:profile-optional')).toEqual({
      relationshipType: 'OPTIONAL_DEPENDENCY_OF',
      relatedSpdxElementId: 'SPDXRef-DOCUMENT',
    });
    expect(rel('junit:junit')).toEqual({
      relationshipType: 'DEV_DEPENDENCY_OF',
      relatedSpdxElementId: 'SPDXRef-DOCUMENT',
    });
    expect(rel('org.mockito:mockito-core')).toEqual({
      relationshipType: 'DEV_DEPENDENCY_OF',
      relatedSpdxElementId: 'SPDXRef-DOCUMENT',
    });
    expect(rel('com.example:top-lib')).toBeUndefined();
    expect(rel('com.example:top-managed')).toBeUndefined();
  });

  it('reads a single profile object, including its dependencyManagement pin', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-maven-one-profile-'));
    fs.writeFileSync(path.join(root, 'pom.xml'), SINGLE_PROFILE_POM);

    const projects = await scanJavaProjects(root, offlineMavenCache());
    expect(projects).toHaveLength(1);
    expect(projects[0]!.dependencies.map((dep) => [dep.package, dep.section, dep.currentSpec])).toEqual([
      ['com.example:profile-bom', 'optionalDependencies', '1.0.0'],
      ['software.amazon.awssdk:s3', 'optionalDependencies', '2.25.0'],
    ]);
  });
});
