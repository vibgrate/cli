import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { scanSwiftProjects } from '../src/core-open/scanners/swift-scanner.js';
import { SwiftCache } from '../src/core-open/scanners/swift-cache.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import type { DependencyRow } from '../src/core-open/types.js';

let root: string;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function offlineCache(): SwiftCache {
  const cache = new SwiftCache(new Semaphore(1), undefined, true);
  vi.spyOn(cache, 'get').mockResolvedValue({
    latest: null,
    stableVersions: [],
    latestStableOverall: null,
  });
  return cache;
}

function manifest(dependencies: string, targets = ''): string {
  return [
    '// swift-tools-version:5.9',
    'import PackageDescription',
    'let package = Package(',
    '  name: "app",',
    '  dependencies: [',
    dependencies,
    '  ]',
    targets,
    ')',
  ].join('\n');
}

async function scan(dependencies: string, targets = '', resolved?: string): Promise<DependencyRow[]> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-pkg-'));
  fs.writeFileSync(path.join(root, 'Package.swift'), manifest(dependencies, targets));
  if (resolved !== undefined) fs.writeFileSync(path.join(root, 'Package.resolved'), resolved);
  const projects = await scanSwiftProjects(root, offlineCache());
  expect(projects).toHaveLength(1);
  return projects[0]!.dependencies;
}

function row(deps: DependencyRow[], name: string): DependencyRow {
  const found = deps.find((d) => d.package === name);
  expect(found, name).toBeDefined();
  return found!;
}

describe('Package.swift dependency forms', () => {
  it.each([
    [
      'half-open range',
      '.package(url: "https://github.com/apple/swift-argument-parser", "1.2.0"..<"2.0.0"),',
      'swift-argument-parser',
      '1.2.0',
    ],
    [
      'half-open range with spaces',
      '.package(url: "https://github.com/apple/swift-argument-parser", "1.2.0" ..< "2.0.0"),',
      'swift-argument-parser',
      '1.2.0',
    ],
    [
      'closed range',
      '.package(url: "https://github.com/pointfreeco/swift-snapshot-testing", "1.10.0"..."1.17.0"),',
      'swift-snapshot-testing',
      '1.10.0',
    ],
    [
      'closed range with spaces',
      '.package(url: "https://github.com/pointfreeco/swift-snapshot-testing", "1.10.0" ... "1.17.0"),',
      'swift-snapshot-testing',
      '1.10.0',
    ],
    [
      'name before url',
      '.package(name: "Kingfisher", url: "https://github.com/onevcat/Kingfisher.git", from: "7.0.0"),',
      'Kingfisher',
      '7.0.0',
    ],
    [
      'registry id',
      '.package(id: "mona.LinkedList", from: "1.0.0"),',
      'mona.LinkedList',
      '1.0.0',
    ],
    [
      'registry id exact',
      '.package(id: "mona.LinkedList", exact: "1.1.1"),',
      'mona.LinkedList',
      '1.1.1',
    ],
    [
      'registry id range',
      '.package(id: "mona.LinkedList", "1.0.0"..<"2.0.0"),',
      'mona.LinkedList',
      '1.0.0',
    ],
    [
      'from',
      '.package(url: "https://github.com/vapor/vapor.git", from: "4.0.0"),',
      'vapor',
      '4.0.0',
    ],
    [
      'exact',
      '.package(url: "https://github.com/realm/realm-swift.git", exact: "10.0.0"),',
      'realm-swift',
      '10.0.0',
    ],
    [
      'exact with build metadata',
      '.package(url: "https://github.com/example/build-meta.git", exact: "1.2.3+build.7"),',
      'build-meta',
      '1.2.3+build.7',
    ],
    [
      'upToNextMajor',
      '.package(url: "https://github.com/apple/swift-nio.git", .upToNextMajor(from: "2.0.0")),',
      'swift-nio',
      '2.0.0',
    ],
    [
      'upToNextMinor',
      '.package(url: "https://github.com/apple/swift-log.git", .upToNextMinor(from: "1.5.0")),',
      'swift-log',
      '1.5.0',
    ],
    [
      'branch',
      '.package(url: "https://github.com/apple/swift-collections.git", branch: "main"),',
      'swift-collections',
      'main',
    ],
    [
      'revision',
      '.package(url: "https://github.com/apple/swift-atomics.git", revision: "abcdef"),',
      'swift-atomics',
      'abcdef',
    ],
  ])('%s yields one row', async (_label, call, name, spec) => {
    const deps = await scan(call);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.package).toBe(name);
    expect(deps[0]!.currentSpec).toBe(spec);
  });

  it('reads every form from one manifest and skips local path packages', async () => {
    const deps = await scan([
      '.package(url: "https://github.com/apple/swift-argument-parser", "1.2.0"..<"2.0.0"),',
      '.package(url: "https://github.com/pointfreeco/swift-snapshot-testing", "1.10.0"..."1.17.0"),',
      '.package(name: "Kingfisher", url: "https://github.com/onevcat/Kingfisher.git", from: "7.0.0"),',
      '.package(id: "mona.LinkedList", from: "1.0.0"),',
      '.package(url: "https://github.com/vapor/vapor.git", from: "4.0.0"),',
      '.package(url: "https://github.com/apple/swift-nio.git", .upToNextMajor(from: "2.0.0")),',
      '.package(url: "https://github.com/realm/realm-swift.git", exact: "10.0.0"),',
      '.package(url: "https://github.com/apple/swift-collections.git", branch: "main"),',
      '.package(url: "https://github.com/apple/swift-atomics.git", revision: "abcdef"),',
      '.package(path: "../LocalLib"),',
      '.package(name: "AnotherLocal", path: "../AnotherLocal"),',
    ].join('\n'), [
      ',',
      '  targets: [',
      '    .target(name: "App", dependencies: [',
      '      .package(name: "Kingfisher"),',
      '      .product(name: "Vapor", package: "vapor"),',
      '    ])',
      '  ]',
    ].join('\n'));

    expect(deps.map((d) => d.package).sort()).toEqual([
      'Kingfisher',
      'mona.LinkedList',
      'realm-swift',
      'swift-argument-parser',
      'swift-atomics',
      'swift-collections',
      'swift-nio',
      'swift-snapshot-testing',
      'vapor',
    ]);
    expect(row(deps, 'swift-argument-parser').currentSpec).toBe('1.2.0');
    expect(row(deps, 'swift-snapshot-testing').currentSpec).toBe('1.10.0');
    expect(row(deps, 'Kingfisher').currentSpec).toBe('7.0.0');
    expect(row(deps, 'mona.LinkedList').currentSpec).toBe('1.0.0');
    expect(row(deps, 'vapor').currentSpec).toBe('4.0.0');
    expect(row(deps, 'swift-nio').currentSpec).toBe('2.0.0');
    expect(row(deps, 'realm-swift').currentSpec).toBe('10.0.0');
    expect(row(deps, 'swift-collections').currentSpec).toBe('main');
    expect(row(deps, 'swift-atomics').currentSpec).toBe('abcdef');
    expect(deps.some((d) => d.package === 'LocalLib' || d.package === 'AnotherLocal')).toBe(false);
  });

  it('keeps a multiline name-first dependency and a comment inside the call', async () => {
    const deps = await scan([
      '.package(',
      '  name: "Kingfisher",',
      '  url: "https://github.com/onevcat/Kingfisher.git", // pinned below',
      '  from: "7.0.0"',
      '),',
    ].join('\n'));
    expect(deps).toHaveLength(1);
    expect(deps[0]!.package).toBe('Kingfisher');
    expect(deps[0]!.currentSpec).toBe('7.0.0');
  });

  it('pins resolved versions by URL identity, not the deprecated name label', async () => {
    const deps = await scan(
      '.package(name: "CustomName", url: "https://github.com/apple/swift-nio.git", from: "2.0.0"),',
      '',
      JSON.stringify({ pins: [{ identity: 'swift-nio', state: { version: '2.65.0' } }], version: 2 }),
    );
    expect(deps).toHaveLength(1);
    expect(deps[0]!.package).toBe('swift-nio');
    expect(deps[0]!.currentSpec).toBe('2.0.0');
    expect(deps[0]!.resolvedVersion).toBe('2.65.0');
  });

  it('pins a registry identity from Package.resolved', async () => {
    const deps = await scan(
      '.package(id: "mona.LinkedList", from: "1.0.0"),',
      '',
      JSON.stringify({ pins: [{ identity: 'mona.linkedlist', state: { version: '1.2.0' } }], version: 2 }),
    );
    expect(deps).toHaveLength(1);
    expect(deps[0]!.package).toBe('mona.LinkedList');
    expect(deps[0]!.currentSpec).toBe('1.0.0');
    expect(deps[0]!.resolvedVersion).toBe('1.2.0');
  });

  it('emits no dependency rows for a path-only manifest', async () => {
    const deps = await scan([
      '.package(path: "../LocalLib"),',
      '.package(name: "AnotherLocal", path: "../AnotherLocal"),',
    ].join('\n'));
    expect(deps).toEqual([]);
  });
});
