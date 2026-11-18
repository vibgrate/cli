/**
 * Map-form pubspec dependencies are real packages. A bare key at the
 * dependency indent opens one entry; deeper keys belong to it.
 *
 * Path and git dependencies have no pub version constraint. They are
 * recorded on purpose, with a source spec (`path:<path>`, `git:<url>`,
 * `git:<url>#<ref>`), so the package stays in the scan and nested keys
 * (`path`, `git`, `url`, `ref`) are not emitted as packages. A nested
 * `version:` is the constraint and wins when a path or git source is
 * also present. `sdk: flutter` is still skipped.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDartProjects } from '../src/core-open/scanners/dart-scanner.js';
import { PubCache } from '../src/core-open/scanners/pub-cache.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const BOGUS = ['version', 'path', 'url', 'ref', 'git'];

let root: string;
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function scanPubspec(
  pubspec: string,
  extra?: { lock?: string; manifest?: { pub: Record<string, { latest: string; versions: string[] }> } },
) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-dart-pubspec-'));
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), pubspec);
  if (extra?.lock !== undefined) fs.writeFileSync(path.join(root, 'pubspec.lock'), extra.lock);
  const projects = await scanDartProjects(
    root,
    new PubCache(new Semaphore(1), extra?.manifest ?? { pub: {} }, true),
  );
  return projects[0]!;
}

function specs(deps: Array<{ package: string; section: string; currentSpec: string }>) {
  return Object.fromEntries(
    [...deps]
      .sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0))
      .map((dep) => [dep.package, { section: dep.section, currentSpec: dep.currentSpec }]),
  );
}

describe('parsePubspecYaml map-form dependencies', () => {
  it('reads nested version, path, and git entries under the package name', async () => {
    const project = await scanPubspec(`name: app
environment:
  sdk: ^3.5.0
dependencies:
  flutter:
    sdk: flutter
  http:
    version: ^1.2.0
  shared:
    path: ../shared
  analyzer_plugin:
    git:
      url: https://github.com/example/plugin.git
      ref: main
`);
    expect(project.runtime).toBe('3.5.0');
    expect(specs(project.dependencies)).toEqual({
      analyzer_plugin: {
        section: 'dependencies',
        currentSpec: 'git:https://github.com/example/plugin.git#main',
      },
      http: { section: 'dependencies', currentSpec: '^1.2.0' },
      shared: { section: 'dependencies', currentSpec: 'path:../shared' },
    });
    for (const name of ['flutter', ...BOGUS]) {
      expect(project.dependencies.some((dep) => dep.package === name)).toBe(false);
    }
  });

  it('keeps one-line dependency entries unchanged', async () => {
    const project = await scanPubspec(`name: app
environment:
  sdk: '>=3.0.0 <4.0.0'
dependencies:
  flutter:
    sdk: flutter
  flutter_inline: { sdk: flutter }
  provider: ^6.1.0
  http: '^1.2.0'
dev_dependencies:
  flutter_test:
    sdk: flutter
  mockito: ^5.4.0
`);
    expect(project.runtime).toBe('3.0.0');
    expect(specs(project.dependencies)).toEqual({
      http: { section: 'dependencies', currentSpec: "'^1.2.0'" },
      mockito: { section: 'devDependencies', currentSpec: '^5.4.0' },
      provider: { section: 'dependencies', currentSpec: '^6.1.0' },
    });
    for (const name of ['flutter', 'flutter_inline', 'flutter_test', ...BOGUS]) {
      expect(project.dependencies.some((dep) => dep.package === name)).toBe(false);
    }
  });

  it('uses nested version over path, and ignores hosted urls', async () => {
    const project = await scanPubspec(`name: app
dependencies:
  pinned:
    path: ../pinned
    version: ">=1.0.0 <2.0.0"
  crypto:
    hosted:
      name: crypto
      url: https://pub.example.com
    version: ^3.0.0
  kittens:
    git: https://github.com/munificent/kittens.git
  local:
    path: "../pkgs/local"
dev_dependencies:
  lint:
    version: ^2.0.0
`);
    expect(specs(project.dependencies)).toEqual({
      crypto: { section: 'dependencies', currentSpec: '^3.0.0' },
      kittens: {
        section: 'dependencies',
        currentSpec: 'git:https://github.com/munificent/kittens.git',
      },
      lint: { section: 'devDependencies', currentSpec: '^2.0.0' },
      local: { section: 'dependencies', currentSpec: 'path:../pkgs/local' },
      pinned: { section: 'dependencies', currentSpec: '>=1.0.0 <2.0.0' },
    });
    for (const name of ['hosted', 'name', ...BOGUS]) {
      expect(project.dependencies.some((dep) => dep.package === name)).toBe(false);
    }
  });

  it.each([
    ['two spaces', '  ', '    '],
    ['four spaces', '    ', '        '],
    ['tabs', '\t', '\t\t'],
  ])('tracks %s so only dependency-level keys are packages', async (_label, depIndent, nestedIndent) => {
    const project = await scanPubspec([
      'name: app',
      'dependencies:',
      `${depIndent}http:`,
      `${nestedIndent}version: ^1.2.0`,
      `${depIndent}provider: ^6.1.0`,
      `${depIndent}shared:`,
      `${nestedIndent}path: ../shared`,
    ].join('\n'));
    expect(specs(project.dependencies)).toEqual({
      http: { section: 'dependencies', currentSpec: '^1.2.0' },
      provider: { section: 'dependencies', currentSpec: '^6.1.0' },
      shared: { section: 'dependencies', currentSpec: 'path:../shared' },
    });
    for (const name of BOGUS) {
      expect(project.dependencies.some((dep) => dep.package === name)).toBe(false);
    }
  });
});

describe('parsePubspecYaml dependency_overrides', () => {
  it('uses the override spec for a declared production package', async () => {
    const project = await scanPubspec(`name: app
environment:
  sdk: ^3.5.0
dependencies:
  http: ^0.13.0
dependency_overrides:
  http: 1.2.1
`);
    expect(project.runtime).toBe('3.5.0');
    expect(specs(project.dependencies)).toEqual({
      http: { section: 'dependencies', currentSpec: '1.2.1' },
    });
  });

  it('keeps a development flag, reports override-only packages as production, and skips SDK overrides', async () => {
    const project = await scanPubspec(`name: app
environment:
  sdk: '>=3.5.0 <4.0.0'
dependencies:
  http: ^0.13.0
dev_dependencies:
  lints: ^2.0.0
  mockito: ^5.4.0
dependency_overrides:
  http: 1.2.1
  lints: '^3.0.0'
  collection: ^1.9.0
  mockito:
    sdk: flutter
  flutter_test:
    sdk: flutter
  flutter_inline: { sdk: flutter }
  pinned:
    sdk: ">=2.19.0 <3.0.0"
`);
    expect(project.runtime).toBe('3.5.0');
    expect(specs(project.dependencies)).toEqual({
      http: { section: 'dependencies', currentSpec: '1.2.1' },
      lints: { section: 'devDependencies', currentSpec: "'^3.0.0'" },
      mockito: { section: 'devDependencies', currentSpec: '^5.4.0' },
      collection: { section: 'dependencies', currentSpec: '^1.9.0' },
    });
    for (const name of ['flutter_test', 'flutter_inline', 'pinned', ...BOGUS]) {
      expect(project.dependencies.some((dep) => dep.package === name)).toBe(false);
    }
  });

  it('applies an override written before the declaration and keeps production when both sections declare it', async () => {
    const project = await scanPubspec(`name: app
dependency_overrides:
  http: 1.2.1
  shared:
    path: ../shared
dev_dependencies:
  http: ^0.12.0
dependencies:
  http: ^0.13.0
`);
    expect(specs(project.dependencies)).toEqual({
      http: { section: 'dependencies', currentSpec: '1.2.1' },
      shared: { section: 'dependencies', currentSpec: 'path:../shared' },
    });
  });

  it('reads map, path, and git overrides in the same forms as dependencies', async () => {
    const project = await scanPubspec(`name: app
dependencies:
  http: ^0.13.0
  crypto: ^2.0.0
dependency_overrides:
  http: { version: 1.2.1 }
  crypto:
    hosted:
      name: crypto
      url: https://pub.example.com
    version: ^3.0.0
  kittens:
    git: https://github.com/munificent/kittens.git
  analyzer_plugin:
    git:
      url: https://github.com/example/plugin.git
      ref: main
  local:
    path: "../pkgs/local"
`);
    expect(specs(project.dependencies)).toEqual({
      analyzer_plugin: {
        section: 'dependencies',
        currentSpec: 'git:https://github.com/example/plugin.git#main',
      },
      crypto: { section: 'dependencies', currentSpec: '^3.0.0' },
      http: { section: 'dependencies', currentSpec: '1.2.1' },
      kittens: {
        section: 'dependencies',
        currentSpec: 'git:https://github.com/munificent/kittens.git',
      },
      local: { section: 'dependencies', currentSpec: 'path:../pkgs/local' },
    });
    for (const name of ['hosted', 'name', ...BOGUS]) {
      expect(project.dependencies.some((dep) => dep.package === name)).toBe(false);
    }
  });

  it('matches a pubspec that has no dependency_overrides section', async () => {
    const project = await scanPubspec(`name: app
environment:
  sdk: '>=3.0.0 <4.0.0'
dependencies:
  flutter:
    sdk: flutter
  provider: ^6.1.0
  http: '^1.2.0'
dev_dependencies:
  flutter_test:
    sdk: flutter
  mockito: ^5.4.0
flutter:
  uses-material-design: true
`);
    expect(project.runtime).toBe('3.0.0');
    expect(specs(project.dependencies)).toEqual({
      http: { section: 'dependencies', currentSpec: "'^1.2.0'" },
      mockito: { section: 'devDependencies', currentSpec: '^5.4.0' },
      provider: { section: 'dependencies', currentSpec: '^6.1.0' },
    });
  });

  it('keeps the pubspec.lock resolved version when an override changes the spec', async () => {
    const project = await scanPubspec(
      `name: app
dependencies:
  http: ^0.13.0
dev_dependencies:
  lints: ^2.0.0
dependency_overrides:
  http: 1.2.1
  lints: ^3.0.0
  collection: 1.9.0
`,
      {
        lock: `packages:
  http:
    dependency: "direct main"
    version: "1.2.2"
  lints:
    dependency: "direct dev"
    version: "2.1.0"
  collection:
    dependency: "direct main"
    version: "1.9.1"
`,
        manifest: {
          pub: {
            http: { latest: '2.0.0', versions: ['1.2.2', '2.0.0'] },
            collection: { latest: '1.9.1', versions: ['1.9.0', '1.9.1'] },
            lints: { latest: '3.0.0', versions: ['2.1.0', '3.0.0'] },
          },
        },
      },
    );
    const byPackage = new Map(project.dependencies.map((dep) => [dep.package, dep]));
    expect(byPackage.get('http')).toMatchObject({
      section: 'dependencies',
      currentSpec: '1.2.1',
      resolvedVersion: '1.2.2',
      latestStable: '2.0.0',
      majorsBehind: 1,
      drift: 'major-behind',
    });
    expect(byPackage.get('lints')).toMatchObject({
      section: 'devDependencies',
      currentSpec: '^3.0.0',
      resolvedVersion: '2.1.0',
      latestStable: null,
      majorsBehind: null,
      drift: 'unknown',
    });
    expect(byPackage.get('collection')).toMatchObject({
      section: 'dependencies',
      currentSpec: '1.9.0',
      resolvedVersion: '1.9.1',
      latestStable: '1.9.1',
      majorsBehind: 0,
      drift: 'current',
    });
  });
});
