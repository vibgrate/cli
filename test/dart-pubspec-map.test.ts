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

async function scanPubspec(pubspec: string) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-dart-pubspec-'));
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), pubspec);
  const projects = await scanDartProjects(root, new PubCache(new Semaphore(1), { pub: {} }, true));
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
