/**
 * Kotlin Gradle projects declare the JVM version with `jvmToolchain(17)` or the
 * longer `jvmToolchain { languageVersion.set(JavaLanguageVersion.of(17)) }`.
 * Both are toolchains, so they win over `sourceCompatibility` /
 * `targetCompatibility`, which keep working unchanged. Groovy and Kotlin DSL
 * are both supported, with or without spaces before the parentheses.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseGradleBuild, scanJavaProjects } from '../src/core-open/scanners/java-scanner.js';
import { MavenCache } from '../src/core-open/scanners/maven-cache.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const CASES = [
  {
    label: 'Kotlin DSL short form',
    fileName: 'build.gradle.kts',
    source: 'kotlin {\n    jvmToolchain(17)\n}\n',
    expected: '17',
  },
  {
    label: 'Groovy DSL short form',
    fileName: 'build.gradle',
    source: "kotlin {\n    jvmToolchain(17)\n}\n",
    expected: '17',
  },
  {
    label: 'short form with spaces',
    fileName: 'build.gradle.kts',
    source: 'kotlin { jvmToolchain ( 21 ) }\n',
    expected: '21',
  },
  {
    label: 'Kotlin DSL block form',
    fileName: 'build.gradle.kts',
    source: [
      'kotlin {',
      '    jvmToolchain {',
      '        languageVersion.set(JavaLanguageVersion.of(17))',
      '    }',
      '}',
    ].join('\n'),
    expected: '17',
  },
  {
    label: 'sourceCompatibility',
    fileName: 'build.gradle.kts',
    source: 'sourceCompatibility = "17"\n',
    expected: '17',
  },
  {
    label: 'targetCompatibility',
    fileName: 'build.gradle',
    source: 'targetCompatibility = JavaVersion.VERSION_11\n',
    expected: '11',
  },
] as const;

const PRECEDENCE_CASES = [
  {
    label: 'toolchain after sourceCompatibility',
    fileName: 'build.gradle.kts',
    source: 'sourceCompatibility = "17"\nkotlin { jvmToolchain(21) }\n',
    expected: '21',
  },
  {
    label: 'toolchain before sourceCompatibility',
    fileName: 'build.gradle.kts',
    source: 'kotlin { jvmToolchain(21) }\nsourceCompatibility = "17"\n',
    expected: '21',
  },
  {
    label: 'Groovy toolchain over sourceCompatibility',
    fileName: 'build.gradle',
    source: "sourceCompatibility = '17'\nkotlin { jvmToolchain(21) }\n",
    expected: '21',
  },
] as const;

function offlineMavenCache(): MavenCache {
  const cache = new MavenCache(new Semaphore(1));
  vi.spyOn(cache, 'get').mockImplementation(async () => ({
    latest: null,
    stableVersions: [],
    latestStableOverall: null,
  }));
  return cache;
}

describe('Gradle Kotlin JVM toolchain', () => {
  let root: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it.each(CASES)('reads $label as Java $expected', ({ fileName, source, expected }) => {
    expect(parseGradleBuild(source, path.join('proj', fileName)).javaVersion).toBe(expected);
  });

  it.each(PRECEDENCE_CASES)('prefers $label', ({ fileName, source, expected }) => {
    expect(parseGradleBuild(source, path.join('proj', fileName)).javaVersion).toBe(expected);
  });

  it('reports the Kotlin jvmToolchain version as the project runtime', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gradle-kotlin-toolchain-'));
    fs.writeFileSync(path.join(root, 'build.gradle.kts'), 'kotlin {\n    jvmToolchain(17)\n}\n');

    const [project] = await scanJavaProjects(root, offlineMavenCache());
    expect(project).toBeDefined();
    expect(project!.runtime).toBe('Java 17');
    expect(project!.targetFramework).toBe('Java 17');
  });
});
