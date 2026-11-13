/**
 * Gradle map notation is a real dependency row. Groovy `key: 'value'` and
 * Kotlin `key = "value"` are read with or without parentheses, in any key
 * order. `testImplementation` is a dev row. A map with no `version` is kept
 * on the parsed build the same way as `implementation 'g:a'`, and `vg scan`
 * omits it. A quoted coordinate on the same line stays its own row. A
 * configuration name has to start at a word boundary, so `myapi` and `xkapt`
 * are not dependencies.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseGradleBuild, scanJavaProjects } from '../src/core-open/scanners/java-scanner.js';
import { MavenCache } from '../src/core-open/scanners/maven-cache.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const GROOVY = `
dependencies {
    implementation 'com.example:string-lib:1.0.0'
    implementation 'com.example:no-version-string'
    implementation 'com.example:filled'
    implementation group: 'org.apache.commons', name: 'commons-lang3', version: '3.14.0'
    testImplementation(group: "junit", name: "junit", version: "4.13.2")
    runtimeOnly(version: '2.0.0', name: 'runtime-only-lib', group: 'com.example')
    implementation group: 'org.slf4j', name: 'slf4j-api', version: '2.0.9'
    implementation group: 'com.example', name: 'no-version'
    implementation group: 'com.example', name: 'filled', version: '5.0.0'
    implementation 'com.example:kept:1.2.3'
    implementation group: 'com.example', name: 'kept'
    testImplementation(group: "com.example", name: "both", version: "9.9.9")
    implementation group: 'com.example', name: 'both', version: '1.2.3'
    implementation(
        name: 'multiline-lib',
        version: '8.0.0',
        group: 'com.example'
    )
    implementation group: 'com.example', name: 'left', version: '1.0.0' api 'com.example:right:2.0.0'
    myapi(group: 'com.example', name: 'hidden-lib', version: '1.0.0')
    xkapt group: 'com.example', name: 'also-hidden', version: '1.0.0'
}
`;

const KOTLIN = `
dependencies {
    implementation(group = "org.apache.commons", name = "commons-lang3", version = "3.14.0")
    testImplementation(name = "junit", version = "4.13.2", group = "junit")
    compileOnly(version = "1.5.0", group = "com.example", name = "compile-only-lib")
    implementation group = "org.slf4j", name = "slf4j-api", version = "2.0.9"
    implementation(group = "com.example", name = "no-version")
    implementation("com.example:no-version-string")
    implementation("com.example:string-lib:1.0.0")
    implementation(group = "com.example", name = "open")
    implementation("com.example:open:6.0.0")
}
`;

/** package, version, configuration, manifest section. Empty version means omitted from scan. */
const GROOVY_ROWS: Array<[string, string, string, string]> = [
  ['com.example:both', '1.2.3', 'implementation', 'dependencies'],
  ['com.example:filled', '5.0.0', 'implementation', 'dependencies'],
  ['com.example:kept', '1.2.3', 'implementation', 'dependencies'],
  ['com.example:left', '1.0.0', 'implementation', 'dependencies'],
  ['com.example:multiline-lib', '8.0.0', 'implementation', 'dependencies'],
  ['com.example:no-version', '', 'implementation', ''],
  ['com.example:no-version-string', '', 'implementation', ''],
  ['com.example:right', '2.0.0', 'api', 'dependencies'],
  ['com.example:runtime-only-lib', '2.0.0', 'runtimeOnly', 'dependencies'],
  ['com.example:string-lib', '1.0.0', 'implementation', 'dependencies'],
  ['junit:junit', '4.13.2', 'testImplementation', 'devDependencies'],
  ['org.apache.commons:commons-lang3', '3.14.0', 'implementation', 'dependencies'],
  ['org.slf4j:slf4j-api', '2.0.9', 'implementation', 'dependencies'],
];

const KOTLIN_ROWS: Array<[string, string, string, string]> = [
  ['com.example:compile-only-lib', '1.5.0', 'compileOnly', 'dependencies'],
  ['com.example:no-version', '', 'implementation', ''],
  ['com.example:no-version-string', '', 'implementation', ''],
  ['com.example:open', '6.0.0', 'implementation', 'dependencies'],
  ['com.example:string-lib', '1.0.0', 'implementation', 'dependencies'],
  ['junit:junit', '4.13.2', 'testImplementation', 'devDependencies'],
  ['org.apache.commons:commons-lang3', '3.14.0', 'implementation', 'dependencies'],
  ['org.slf4j:slf4j-api', '2.0.9', 'implementation', 'dependencies'],
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

function byName(source: string, fileName: string): Map<string, { version: string; configuration: string }> {
  const parsed = parseGradleBuild(source, path.join('proj', fileName));
  expect(parsed.dependencies).toHaveLength(new Set(parsed.dependencies.map((dep) => `${dep.groupId}:${dep.artifactId}`)).size);
  return new Map(parsed.dependencies.map((dep) => [`${dep.groupId}:${dep.artifactId}`, dep]));
}

describe('Gradle map notation', () => {
  let root: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['build.gradle', GROOVY, GROOVY_ROWS],
    ['build.gradle.kts', KOTLIN, KOTLIN_ROWS],
  ] as const)('reads map notation from %s and omits a missing version', async (fileName, source, rows) => {
    const stored = byName(source, fileName);
    expect([...stored.keys()].sort()).toEqual(rows.map(([name]) => name).sort());
    for (const [name, version, configuration] of rows) {
      expect(stored.get(name)?.version).toBe(version);
      expect(stored.get(name)?.configuration).toBe(configuration);
      expect(stored.get(name)?.configuration).toMatch(/^[A-Za-z]+$/);
    }
    expect(stored.has('com.example:hidden-lib')).toBe(false);
    expect(stored.has('com.example:also-hidden')).toBe(false);

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gradle-map-'));
    fs.writeFileSync(path.join(root, fileName), source);

    const projects = await scanJavaProjects(root, offlineMavenCache());
    expect(projects).toHaveLength(1);
    const scanned = rows.filter(([, version]) => version !== '');
    const ordered = [...scanned].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(projects[0]!.dependencies.map((dep) => [dep.package, dep.currentSpec, dep.section])).toEqual(
      ordered.map(([name, version, , section]) => [name, version, section]),
    );
  });
});
