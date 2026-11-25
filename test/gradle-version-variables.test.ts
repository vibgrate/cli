/**
 * Gradle dependency versions written as variables resolve from
 * `gradle.properties` (project then repository root) and from simple literal
 * assignments in the build file. Unknown or computed references stay unknown,
 * and `gradle.lockfile` still supplies the resolved version.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseGradleBuild, scanJavaProjects } from '../src/core-open/scanners/java-scanner.js';
import { MavenCache } from '../src/core-open/scanners/maven-cache.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const JACKSON = 'com.fasterxml.jackson.core:jackson-databind';
const KOTLIN = 'org.jetbrains.kotlin:kotlin-stdlib';

function offlineMavenCache(): MavenCache {
  const cache = new MavenCache(new Semaphore(1));
  vi.spyOn(cache, 'get').mockImplementation(async () => ({
    latest: null,
    stableVersions: [],
    latestStableOverall: null,
  }));
  return cache;
}

describe('Gradle version variables', () => {
  let root: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['ext block', 'build.gradle', "ext { jacksonVersion = '2.17.2' }"],
    ['ext property', 'build.gradle', "ext.jacksonVersion = '2.17.2'"],
    ['ext index', 'build.gradle', "ext['jacksonVersion'] = '2.17.2'"],
    ['kotlin val', 'build.gradle.kts', 'val jacksonVersion = "2.17.2"'],
  ])('resolves ${jacksonVersion} from %s', (_name, file, declaration) => {
    const notation = file.endsWith('.kts')
      ? 'implementation("com.fasterxml.jackson.core:jackson-databind:${jacksonVersion}")'
      : 'implementation "com.fasterxml.jackson.core:jackson-databind:${jacksonVersion}"';
    const parsed = parseGradleBuild([declaration, notation].join('\n'), path.join('app', file));
    const dep = parsed.dependencies.find((row) => `${row.groupId}:${row.artifactId}` === JACKSON);
    expect(dep?.version).toBe('2.17.2');
    expect(dep?.configuration).toBe('implementation');
  });

  it('stops a bare $name at a dot, the way a Groovy string reads it', () => {
    const parsed = parseGradleBuild(
      ["ext.springVersion = '5.3.39'", 'implementation "org.springframework:spring-core:$springVersion.RELEASE"'].join('\n'),
      path.join('app', 'build.gradle'),
    );
    const dep = parsed.dependencies.find((row) => row.artifactId === 'spring-core');
    expect(dep?.version).toBe('5.3.39.RELEASE');
  });

  it('resolves $kotlinVersion from the repository-root gradle.properties', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gradle-properties-'));
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'gradle.properties'), [
      '# versions',
      '! keep this comment',
      'kotlinVersion=2.0.21',
    ].join('\n'));
    fs.writeFileSync(
      path.join(root, 'app', 'build.gradle'),
      `implementation "${KOTLIN}:$kotlinVersion"\n`,
    );

    const [project] = await scanJavaProjects(root, offlineMavenCache());
    const dep = project!.dependencies.find((row) => row.package === KOTLIN);
    expect(dep?.currentSpec).toBe('2.0.21');
    expect(dep?.resolvedVersion).toBe('2.0.21');
  });

  it('lets the project gradle.properties override the repository root', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gradle-properties-'));
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'gradle.properties'), 'kotlinVersion=1.9.0\n');
    fs.writeFileSync(path.join(root, 'app', 'gradle.properties'), 'kotlinVersion=2.0.21\n');
    fs.writeFileSync(
      path.join(root, 'app', 'build.gradle'),
      `implementation "${KOTLIN}:$kotlinVersion"\n`,
    );

    const [project] = await scanJavaProjects(root, offlineMavenCache());
    const dep = project!.dependencies.find((row) => row.package === KOTLIN);
    expect(dep?.currentSpec).toBe('2.0.21');
  });

  it('resolves known references while keeping unknown and computed ones unresolved', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gradle-properties-'));
    fs.writeFileSync(path.join(root, 'gradle.properties'), 'knownVersion=1.2.3\n');
    fs.writeFileSync(path.join(root, 'build.gradle'), [
      'implementation "com.example:known:$knownVersion"',
      'implementation "com.example:missing:$missingVersion"',
      'implementation "com.example:computed:${findVersion()}"',
    ].join('\n'));

    const [project] = await scanJavaProjects(root, offlineMavenCache());
    const rows = new Map(project!.dependencies.map((dep) => [dep.package, dep]));
    expect(rows.get('com.example:known')?.currentSpec).toBe('1.2.3');
    expect(rows.get('com.example:missing')?.currentSpec).toBe('$missingVersion');
    expect(rows.get('com.example:missing')?.resolvedVersion).toBeNull();
    expect(rows.get('com.example:missing')?.drift).toBe('unknown');
    expect(rows.get('com.example:computed')?.currentSpec).toBe('${findVersion()}');
    expect(rows.get('com.example:computed')?.resolvedVersion).toBeNull();
  });

  it('still prefers gradle.lockfile over a resolved variable', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gradle-properties-'));
    fs.writeFileSync(path.join(root, 'gradle.properties'), 'jacksonVersion=2.17.2\n');
    fs.writeFileSync(
      path.join(root, 'build.gradle'),
      `implementation "${JACKSON}:$jacksonVersion"\n`,
    );
    fs.writeFileSync(
      path.join(root, 'gradle.lockfile'),
      `${JACKSON}:2.18.2=runtimeClasspath\n`,
    );

    const [project] = await scanJavaProjects(root, offlineMavenCache());
    const dep = project!.dependencies.find((row) => row.package === JACKSON);
    expect(dep?.currentSpec).toBe('2.17.2');
    expect(dep?.resolvedVersion).toBe('2.18.2');
  });
});
