/**
 * Gradle Java versions keep the full compatibility token, so `1.8`, `1_8`,
 * and `JavaVersion.VERSION_1_8` all mean Java 8. The runtime lag is counted
 * from 8, not the leading 1, in both Groovy and Kotlin DSL.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestLts } from '../src/core-open/runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../src/core-open/runtimes/snapshot.js';
import { MavenCache } from '../src/core-open/scanners/maven-cache.js';
import { parseGradleBuild, scanJavaProjects } from '../src/core-open/scanners/java-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const JAVA_8 = [
  ["sourceCompatibility = '1.8'", '1.8'],
  ["sourceCompatibility = '1_8'", '1.8'],
  ['sourceCompatibility = JavaVersion.VERSION_1_8', '1.8'],
] as const;

const CASES: Record<string, ReadonlyArray<readonly [string, string]>> = {
  'build.gradle': [
    ...JAVA_8,
    ['sourceCompatibility = JavaVersion.VERSION_11', '11'],
    ['sourceCompatibility = JavaVersion.VERSION_17', '17'],
    ["sourceCompatibility = '17'", '17'],
  ],
  'build.gradle.kts': [
    ['sourceCompatibility = "1.8"', '1.8'],
    ['sourceCompatibility = "1_8"', '1.8'],
    ['sourceCompatibility = JavaVersion.VERSION_1_8', '1.8'],
    ['sourceCompatibility = JavaVersion.VERSION_11', '11'],
    ['sourceCompatibility = JavaVersion.VERSION_17', '17'],
    ['sourceCompatibility = "17"', '17'],
  ],
};

function offlineMavenCache(): MavenCache {
  const cache = new MavenCache(new Semaphore(1));
  vi.spyOn(cache, 'get').mockImplementation(async () => ({
    latest: null,
    stableVersions: [],
    latestStableOverall: null,
  }));
  return cache;
}

describe.each(Object.entries(CASES))('%s Java version', (fileName, cases) => {
  it.each(cases)('reads %s as Java %s', (snippet, expected) => {
    const parsed = parseGradleBuild(snippet, path.join('proj', fileName));
    expect(parsed.javaVersion).toBe(expected);
  });
});

describe('Gradle Java runtime lag', () => {
  let root: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it.each([
    ['build.gradle', "sourceCompatibility = '1.8'"],
    ['build.gradle', 'sourceCompatibility = JavaVersion.VERSION_1_8'],
    ['build.gradle.kts', 'sourceCompatibility = JavaVersion.VERSION_1_8'],
  ])('counts %s (%s) from Java 8', async (fileName, snippet) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gradle-java-version-'));
    fs.writeFileSync(path.join(root, fileName), `${snippet}\n`);

    const [project] = await scanJavaProjects(root, offlineMavenCache());
    expect(project!.runtime).toBe('Java 1.8');
    expect(project!.runtime).not.toBe('Java 1');

    const javaLts = latestLts(BUNDLED_RUNTIME_CATALOG, 'java')!.major;
    expect(project!.runtimeLatest).toBe(String(javaLts));
    expect(project!.runtimeMajorsBehind).toBe(Math.max(0, javaLts - 8));
  });
});
