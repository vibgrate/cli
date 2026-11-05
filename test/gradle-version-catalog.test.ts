/**
 * Gradle `libs` version-catalog aliases resolve to Maven coordinates.
 * `version.ref` is followed, bundles expand, and `gradle.lockfile` still
 * supplies `resolvedVersion` when both exist.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MavenCache } from '../src/core-open/scanners/maven-cache.js';
import { parseGradleBuild, scanJavaProjects } from '../src/core-open/scanners/java-scanner.js';
import {
  librariesForAccessor,
  libsCatalogPathsFromSettings,
  parseGradleVersionCatalog,
} from '../src/core-open/scanners/gradle-version-catalog.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/gradle-version-catalog/', import.meta.url));
const CATALOG_TEXT = fs.readFileSync(path.join(FIXTURE_DIR, 'gradle', 'libs.versions.toml'), 'utf8');

const roots: string[] = [];

function offlineMavenCache(): MavenCache {
  const cache = new MavenCache(new Semaphore(1));
  vi.spyOn(cache, 'get').mockImplementation(async () => ({
    latest: null,
    stableVersions: [],
    latestStableOverall: null,
  }));
  return cache;
}

function writeProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gradle-catalog-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

function fixtureFile(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe('parseGradleVersionCatalog', () => {
  const catalog = parseGradleVersionCatalog(CATALOG_TEXT);

  it('follows version.ref and group/name, and keeps string notation', () => {
    expect(catalog.libraries.get('jackson.databind')).toEqual({
      groupId: 'com.fasterxml.jackson.core',
      artifactId: 'jackson-databind',
      version: '2.17.2',
    });
    expect(catalog.libraries.get('jackson.annotations')).toEqual({
      groupId: 'com.fasterxml.jackson.core',
      artifactId: 'jackson-annotations',
      version: '2.17.2',
    });
    expect(catalog.libraries.get('slf4j.api')).toEqual({
      groupId: 'org.slf4j',
      artifactId: 'slf4j-api',
      version: '2.0.16',
    });
  });

  it('expands bundles to member libraries in catalog order', () => {
    expect(catalog.bundles.get('jackson')).toEqual(['jackson.core', 'jackson.databind']);
    expect(librariesForAccessor(catalog, 'libs.bundles.jackson').map((lib) => lib.artifactId)).toEqual([
      'jackson-core',
      'jackson-databind',
    ]);
  });

  it('reads rich versions, inline version tables, and table-header libraries', () => {
    const parsed = parseGradleVersionCatalog(`
[versions]
slf4j = { require = "2.0.16" }
missing = { reject = "1.0" }

[libraries]
inline = { module = "com.acme:inline", version = { strictly = "1.2.3" } }
fallback = { module = "com.acme:fallback:9.9.9" }
unref = { module = "com.acme:unref", version.ref = "no-such" }

[libraries.jackson-core]
module = "com.fasterxml.jackson.core:jackson-core"
version.ref = "slf4j"

[bundles]
empty = ["unref"]
`);
    expect(parsed.libraries.get('inline')?.version).toBe('1.2.3');
    expect(parsed.libraries.get('fallback')).toEqual({
      groupId: 'com.acme',
      artifactId: 'fallback',
      version: '9.9.9',
    });
    expect(parsed.libraries.has('unref')).toBe(false);
    expect(parsed.libraries.get('jackson.core')?.version).toBe('2.0.16');
    expect(parsed.bundles.has('empty')).toBe(false);
    expect(parsed.libraries.has('missing')).toBe(false);
  });

  it('returns an empty catalog for malformed TOML', () => {
    const parsed = parseGradleVersionCatalog('not = [ toml');
    expect(parsed.libraries.size).toBe(0);
    expect(parsed.bundles.size).toBe(0);
  });
});

describe('libs catalog paths in settings', () => {
  it('reads from(files) on the libs catalog and ignores other catalogs and comments', () => {
    const groovy = `
dependencyResolutionManagement {
    versionCatalogs {
        create("libs") {
            from(files("catalog/libs.versions.toml", "catalog/extra.toml"))
        }
        create("other") {
            from(files("nope.toml"))
        }
        // from(files("commented.toml"))
    }
}
`;
    expect(libsCatalogPathsFromSettings(groovy)).toEqual([
      'catalog/libs.versions.toml',
      'catalog/extra.toml',
    ]);

    const kotlin = `
dependencyResolutionManagement {
    versionCatalogs {
        libs {
            from(files("gradle/libs.versions.toml"))
        }
    }
}
`;
    expect(libsCatalogPathsFromSettings(kotlin)).toEqual(['gradle/libs.versions.toml']);
    expect(libsCatalogPathsFromSettings('rootProject.name = "demo"\n')).toBeNull();
  });
});

describe('parseGradleBuild catalog aliases', () => {
  const catalog = parseGradleVersionCatalog(CATALOG_TEXT);

  it.each([
    ['build.gradle', 'groovy bare and parenthesized aliases'],
    ['build.gradle.kts', 'kotlin dsl aliases'],
  ])('resolves %s (%s)', (fileName) => {
    const parsed = parseGradleBuild(fixtureFile(fileName), path.join('proj', fileName), catalog);
    const stored = new Map(parsed.dependencies.map((dep) => [`${dep.groupId}:${dep.artifactId}`, dep]));
    expect(stored.get('com.fasterxml.jackson.core:jackson-databind')?.version).toBe('2.17.2');
    expect(stored.get('com.fasterxml.jackson.core:jackson-core')?.version).toBe('2.17.2');
    expect(stored.get('com.fasterxml.jackson.core:jackson-core')?.configuration).toBe('implementation');
    expect(stored.get('org.slf4j:slf4j-api')?.version).toBe('2.0.16');
    expect(stored.get('org.slf4j:slf4j-api')?.configuration).toBe('testImplementation');
    expect(stored.get('com.example:plain')?.version).toBe('1.0.0');
  });

  it('keeps Groovy parenthesized annotations and expands the bundle once', () => {
    const parsed = parseGradleBuild(fixtureFile('build.gradle'), 'proj/build.gradle', catalog);
    const names = parsed.dependencies.map((dep) => `${dep.groupId}:${dep.artifactId}`);
    expect(names.filter((name) => name === 'com.fasterxml.jackson.core:jackson-databind')).toHaveLength(1);
    expect(parsed.dependencies.find((dep) => dep.artifactId === 'jackson-annotations')?.version).toBe('2.17.2');
  });

  it('accepts the Kotlin Provider get() call', () => {
    const parsed = parseGradleBuild(
      'dependencies {\n    implementation(libs.jackson.databind.get())\n}\n',
      'proj/build.gradle.kts',
      catalog,
    );
    expect(parsed.dependencies).toEqual([
      {
        groupId: 'com.fasterxml.jackson.core',
        artifactId: 'jackson-databind',
        version: '2.17.2',
        configuration: 'implementation',
      },
    ]);
  });

  it('ignores aliases when no catalog is passed', () => {
    const parsed = parseGradleBuild(fixtureFile('build.gradle'), 'proj/build.gradle');
    expect(parsed.dependencies.map((dep) => dep.artifactId)).toEqual(['plain']);
  });
});

describe('scanJavaProjects version catalog', () => {
  it.each([
    ['build.gradle', 'groovy'],
    ['build.gradle.kts', 'kotlin'],
  ])('pins jackson-databind from gradle/libs.versions.toml for %s', async (fileName) => {
    const root = writeProject({
      [fileName]: fixtureFile(fileName),
      'gradle/libs.versions.toml': CATALOG_TEXT,
    });
    const projects = await scanJavaProjects(root, offlineMavenCache());
    expect(projects).toHaveLength(1);
    const databind = projects[0]!.dependencies.find(
      (dep) => dep.package === 'com.fasterxml.jackson.core:jackson-databind',
    );
    expect(databind?.currentSpec).toBe('2.17.2');
    expect(databind?.resolvedVersion).toBe('2.17.2');
    expect(databind?.section).toBe('dependencies');
    const slf4j = projects[0]!.dependencies.find((dep) => dep.package === 'org.slf4j:slf4j-api');
    expect(slf4j?.currentSpec).toBe('2.0.16');
    expect(slf4j?.section).toBe('devDependencies');
    const core = projects[0]!.dependencies.find(
      (dep) => dep.package === 'com.fasterxml.jackson.core:jackson-core',
    );
    expect(core?.currentSpec).toBe('2.17.2');
  });

  it('prefers gradle.lockfile over the catalog version', async () => {
    const root = writeProject({
      'build.gradle.kts': 'dependencies {\n    implementation(libs.jackson.databind)\n}\n',
      'gradle/libs.versions.toml': CATALOG_TEXT,
      'gradle.lockfile':
        '# generated\ncom.fasterxml.jackson.core:jackson-databind:2.18.1=runtimeClasspath\nempty=\n',
    });
    const projects = await scanJavaProjects(root, offlineMavenCache());
    const databind = projects[0]!.dependencies.find(
      (dep) => dep.package === 'com.fasterxml.jackson.core:jackson-databind',
    );
    expect(databind?.currentSpec).toBe('2.17.2');
    expect(databind?.resolvedVersion).toBe('2.18.1');
  });

  it('leaves alias-only projects unchanged when no catalog file exists', async () => {
    const root = writeProject({
      'build.gradle':
        "dependencies {\n    implementation 'com.example:plain:1.0.0'\n    implementation libs.jackson.databind\n}\n",
    });
    const projects = await scanJavaProjects(root, offlineMavenCache());
    expect(projects[0]!.dependencies.map((dep) => dep.package)).toEqual(['com.example:plain']);
    expect(projects[0]!.dependencies[0]?.currentSpec).toBe('1.0.0');
  });

  it('uses the root catalog for a subproject build file', async () => {
    const root = writeProject({
      'settings.gradle': "rootProject.name = 'demo'\ninclude 'app'\n",
      'gradle/libs.versions.toml': CATALOG_TEXT,
      'app/build.gradle': 'dependencies {\n    implementation libs.jackson.databind\n}\n',
    });
    const projects = await scanJavaProjects(root, offlineMavenCache());
    expect(projects).toHaveLength(1);
    expect(projects[0]!.path).toBe('app');
    const databind = projects[0]!.dependencies.find(
      (dep) => dep.package === 'com.fasterxml.jackson.core:jackson-databind',
    );
    expect(databind?.currentSpec).toBe('2.17.2');
    expect(databind?.resolvedVersion).toBe('2.17.2');
  });

  it('honors settings from(files) over the conventional catalog path', async () => {
    const root = writeProject({
      'settings.gradle.kts': `
dependencyResolutionManagement {
    versionCatalogs {
        create("libs") {
            from(files("catalog/libs.versions.toml"))
        }
    }
}
`,
      'catalog/libs.versions.toml': CATALOG_TEXT,
      'gradle/libs.versions.toml': `
[versions]
jackson = "9.9.9"
[libraries]
jackson-databind = { module = "com.fasterxml.jackson.core:jackson-databind", version.ref = "jackson" }
`,
      'build.gradle': 'dependencies {\n    implementation(libs.jackson.databind)\n}\n',
    });
    const projects = await scanJavaProjects(root, offlineMavenCache());
    const databind = projects[0]!.dependencies.find(
      (dep) => dep.package === 'com.fasterxml.jackson.core:jackson-databind',
    );
    expect(databind?.currentSpec).toBe('2.17.2');
    expect(databind?.resolvedVersion).toBe('2.17.2');
  });
});
