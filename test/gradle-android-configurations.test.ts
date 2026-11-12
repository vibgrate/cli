/**
 * Android and Kotlin Gradle configurations are real dependency rows.
 * `androidTest*`, `test*`, `testFixtures*`, `kaptTest`, `kaptAndroidTest`, and
 * `kspTest` are dev rows. Variant names such as `debugImplementation`, plus
 * `ksp`, `developmentOnly`, and `compileOnlyApi`, stay production. A coordinate
 * declared on both `implementation` and `androidTestImplementation` stays
 * production, and the production declaration supplies the version. A
 * configuration name has to start at a word boundary, so `xkapt` and `myapi`
 * are not dependencies.
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

const FIXTURE = fileURLToPath(new URL('./fixtures/gradle-android-app/app/build.gradle.kts', import.meta.url));

/** package, version, configuration, manifest section. */
const ROWS: Array<[string, string, string, string]> = [
  ['androidx.test.espresso:espresso-core', '3.5.1', 'androidTestRuntimeOnly', 'devDependencies'],
  ['androidx.test.ext:junit', '1.1.5', 'androidTestImplementation', 'devDependencies'],
  ['androidx.test:rules', '1.5.0', 'androidTestCompileOnly', 'devDependencies'],
  ['androidx.test:runner', '1.5.2', 'androidTestApi', 'devDependencies'],
  ['com.example:compile-only-api', '1.0.0', 'compileOnlyApi', 'dependencies'],
  ['com.example:debug-api', '1.0.0', 'debugApi', 'dependencies'],
  ['com.example:debug-compile-only', '1.0.0', 'debugCompileOnly', 'dependencies'],
  ['com.example:debug-impl', '1.0.0', 'debugImplementation', 'dependencies'],
  ['com.example:development-only', '1.0.0', 'developmentOnly', 'dependencies'],
  ['com.example:fixtures-api', '1.0.0', 'testFixturesApi', 'devDependencies'],
  ['com.example:fixtures-impl', '1.0.0', 'testFixturesImplementation', 'devDependencies'],
  ['com.example:free-debug-impl', '1.0.0', 'freeDebugImplementation', 'dependencies'],
  ['com.example:kapt-android-test', '1.0.0', 'kaptAndroidTest', 'devDependencies'],
  ['com.example:kapt-test', '1.0.0', 'kaptTest', 'devDependencies'],
  ['com.example:ksp-test', '1.0.0', 'kspTest', 'devDependencies'],
  ['com.example:paid-release-api', '1.0.0', 'paidReleaseApi', 'dependencies'],
  ['com.example:release-impl', '1.0.0', 'releaseImplementation', 'dependencies'],
  ['com.example:release-runtime-only', '1.0.0', 'releaseRuntimeOnly', 'dependencies'],
  ['com.example:shared-kept', '4.5.6', 'implementation', 'dependencies'],
  ['com.example:shared-replaced', '1.2.3', 'implementation', 'dependencies'],
  ['com.google.devtools.ksp:symbol-processing-api', '1.0.17', 'ksp', 'dependencies'],
  ['junit:junit', '4.13.2', 'testImplementation', 'devDependencies'],
];

const HIDDEN = ['com.example:hidden-kapt', 'com.example:hidden-api', 'com.example:hidden-kapt-test'];

function offlineMavenCache(): MavenCache {
  const cache = new MavenCache(new Semaphore(1));
  vi.spyOn(cache, 'get').mockImplementation(async () => ({
    latest: null,
    stableVersions: [],
    latestStableOverall: null,
  }));
  return cache;
}

describe('Gradle Android and Kotlin configurations', () => {
  let root: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('scans an Android app module and keeps production over androidTest', async () => {
    const source = fs.readFileSync(FIXTURE, 'utf8');
    const parsed = parseGradleBuild(source, path.join('app', 'build.gradle.kts'));
    const stored = new Map(parsed.dependencies.map((dep) => [`${dep.groupId}:${dep.artifactId}`, dep]));
    expect([...stored.keys()].sort()).toEqual(ROWS.map(([name]) => name).sort());
    for (const [name, version, configuration] of ROWS) {
      expect(stored.get(name)?.version).toBe(version);
      expect(stored.get(name)?.configuration).toBe(configuration);
      expect(stored.get(name)?.configuration).toMatch(/^[A-Za-z]+$/);
    }
    for (const name of HIDDEN) expect(stored.has(name)).toBe(false);

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gradle-android-'));
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app', 'build.gradle.kts'), source);

    const projects = await scanJavaProjects(root, offlineMavenCache());
    expect(projects).toHaveLength(1);
    const project = projects[0]!;
    expect(project.name).toBe('app');
    expect(project.runtime).toBe('Java 17');
    const ordered = [...ROWS].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(project.dependencies.map((dep) => [dep.package, dep.currentSpec, dep.section])).toEqual(
      ordered.map(([name, version, , section]) => [name, version, section]),
    );
  });

  it('reads the same configurations from a version catalog and ignores embedded names', () => {
    const catalog = parseGradleVersionCatalog(`
[versions]
rich = { strictly = "9.1.0" }
shared = "1.4.0"

[libraries]
rich-lib = { module = "com.example:rich-lib", version.ref = "rich" }
aliased = { module = "com.example:aliased", version.ref = "shared" }
strict-lib = { group = "com.example", name = "strict-lib", version.strictly = "2.0.0" }
junit-jupiter = { group = "org.junit.jupiter", name = "junit-jupiter", version = "5.10.0" }
assertj-core = { module = "org.assertj:assertj-core", version = "3.25.3" }
guava = "com.google.guava:guava:32.1.0"
commons-lang3 = { module = "org.apache.commons:commons-lang3", version = "3.14.0" }
`);
    expect(catalog).not.toBeNull();
    const parsed = parseGradleBuild(
      [
        'androidTestImplementation(libs.rich.lib)',
        'debugImplementation(libs.aliased)',
        'ksp(libs.strict.lib)',
        'kaptTest(libs.junit.jupiter)',
        'testFixturesApi(libs.assertj.core)',
        'xkapt(libs.guava)',
        'myapi(libs.commons.lang3)',
      ].join('\n'),
      'app/build.gradle.kts',
      catalog,
    );
    const byArtifact = new Map(parsed.dependencies.map((dep) => [dep.artifactId, dep]));
    expect(byArtifact.get('rich-lib')).toMatchObject({
      groupId: 'com.example', version: '9.1.0', configuration: 'androidTestImplementation',
    });
    expect(byArtifact.get('aliased')?.configuration).toBe('debugImplementation');
    expect(byArtifact.get('strict-lib')?.configuration).toBe('ksp');
    expect(byArtifact.get('junit-jupiter')?.configuration).toBe('kaptTest');
    expect(byArtifact.get('assertj-core')?.configuration).toBe('testFixturesApi');
    expect(byArtifact.has('guava')).toBe(false);
    expect(byArtifact.has('commons-lang3')).toBe(false);
  });
});
