/**
 * Gradle version-catalog aliases (`libs…`) become scan rows.
 * Groovy and Kotlin DSL forms read `gradle/libs.versions.toml`.
 * `gradle.lockfile` still supplies `resolvedVersion` when both exist.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseGradleVersionCatalog } from '../src/core-open/scanners/gradle-version-catalog.js';
import { parseGradleBuild, scanJavaProjects } from '../src/core-open/scanners/java-scanner.js';
import { MavenCache } from '../src/core-open/scanners/maven-cache.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/gradle-version-catalog/', import.meta.url));

const ROWS: Array<[string, string, string, string]> = [
  ['com.example:direct', '1.2.3', 'implementation', 'dependencies'],
  ['com.fasterxml.jackson.core:jackson-databind', '2.17.0', 'implementation', 'dependencies'],
  ['com.fasterxml.jackson:jackson-bom', '2.17.0', 'platform', 'dependencies'],
  ['com.google.guava:guava', '32.1.0', 'implementation', 'dependencies'],
  ['org.apache.commons:commons-lang3', '3.14.0', 'api', 'dependencies'],
  ['org.assertj:assertj-core', '3.25.3', 'testImplementation', 'devDependencies'],
  ['org.junit.jupiter:junit-jupiter', '5.10.0', 'implementation', 'dependencies'],
  ['org.projectlombok:lombok', '1.18.32', 'annotationProcessor', 'dependencies'],
];

function offlineMavenCache(): MavenCache {
  const cache = new MavenCache(new Semaphore(1));
  vi.spyOn(cache, 'get').mockImplementation(async () => ({
    latest: null,
    stableVersions: [],
    latestStableOverall: null,
  }));
  return cache;
}

function copyProject(buildFile: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gradle-catalog-'));
  fs.mkdirSync(path.join(root, 'gradle'));
  fs.copyFileSync(path.join(FIXTURE_DIR, 'libs.versions.toml'), path.join(root, 'gradle', 'libs.versions.toml'));
  fs.copyFileSync(path.join(FIXTURE_DIR, buildFile), path.join(root, buildFile));
  return root;
}

describe('Gradle version catalog', () => {
  let root: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('parses the fixture catalog', () => {
    const text = fs.readFileSync(path.join(FIXTURE_DIR, 'libs.versions.toml'), 'utf8');
    const catalog = parseGradleVersionCatalog(text);
    expect(catalog?.libraries.get('jackson.databind')?.version).toBe('2.17.0');
    expect(catalog?.libraries.get('commons.lang3')?.version).toBe('3.14.0');
    expect(catalog?.libraries.has('missing.pin')).toBe(false);
    expect(catalog?.bundles.get('test.stack')).toEqual(['junit.jupiter', 'assertj.core']);
  });

  it.each([
    ['build.gradle', 'annotationProcessor'],
    ['build.gradle.kts', 'kapt'],
  ])('resolves libs aliases in %s', async (buildFile, lombokConfig) => {
    const catalog = parseGradleVersionCatalog(fs.readFileSync(path.join(FIXTURE_DIR, 'libs.versions.toml'), 'utf8'));
    const source = fs.readFileSync(path.join(FIXTURE_DIR, buildFile), 'utf8');
    const parsed = parseGradleBuild(source, path.join('proj', buildFile), catalog);
    const stored = new Map(parsed.dependencies.map((dep) => [`${dep.groupId}:${dep.artifactId}`, dep]));
    expect([...stored.keys()].sort()).toEqual(ROWS.map(([name]) => name).sort());
    for (const [name, version, configuration] of ROWS) {
      const expectedConfig = name.endsWith(':lombok') ? lombokConfig : configuration;
      expect(stored.get(name)?.version).toBe(version);
      expect(stored.get(name)?.configuration).toBe(expectedConfig);
    }

    root = copyProject(buildFile);
    const projects = await scanJavaProjects(root, offlineMavenCache());
    expect(projects).toHaveLength(1);
    const deps = projects[0]!.dependencies;
    expect(deps.map((dep) => [dep.package, dep.currentSpec, dep.section])).toEqual(
      ROWS.map(([name, version, , section]) => [name, version, section]),
    );
    for (const dep of deps) expect(dep.resolvedVersion).toBe(dep.currentSpec);
  });

  it('prefers gradle.lockfile over the catalog version', async () => {
    root = copyProject('build.gradle');
    fs.writeFileSync(path.join(root, 'gradle.lockfile'), [
      '# Gradle dependency lock',
      'com.fasterxml.jackson.core:jackson-databind:2.18.2=runtimeClasspath',
      'com.google.guava:guava:33.0.0=compileClasspath,runtimeClasspath',
      'empty=',
    ].join('\n'));

    const [project] = await scanJavaProjects(root, offlineMavenCache());
    const jackson = project!.dependencies.find((dep) => dep.package === 'com.fasterxml.jackson.core:jackson-databind');
    const guava = project!.dependencies.find((dep) => dep.package === 'com.google.guava:guava');
    const direct = project!.dependencies.find((dep) => dep.package === 'com.example:direct');
    expect(jackson?.currentSpec).toBe('2.17.0');
    expect(jackson?.resolvedVersion).toBe('2.18.2');
    expect(guava?.currentSpec).toBe('32.1.0');
    expect(guava?.resolvedVersion).toBe('33.0.0');
    expect(direct?.currentSpec).toBe('1.2.3');
    expect(direct?.resolvedVersion).toBe('1.2.3');
  });
});
