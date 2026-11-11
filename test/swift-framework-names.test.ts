import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KNOWN_SWIFT_FRAMEWORKS, scanSwiftProjects } from '../src/core-open/scanners/swift-scanner.js';
import { SwiftCache } from '../src/core-open/scanners/swift-cache.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

/**
 * Framework detection keys off the lowercased repository name taken from the
 * package URL, so every key in `KNOWN_SWIFT_FRAMEWORKS` has to be the
 * repository name as it appears in those URLs. Entries like
 * `swift-snapshot-testing` and `swift-log` used to be spelled `snapshotTesting`
 * and `swiftlog`, which could never match and silently hid those frameworks.
 */

const tempDirs: string[] = [];

async function projectWithPackageSwift(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vg-swift-'));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, 'Package.swift'), contents, 'utf8');
  return dir;
}

/** Offline cache: framework detection needs no version metadata. */
function offlineCache(): SwiftCache {
  return new SwiftCache(new Semaphore(2), undefined, true);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('KNOWN_SWIFT_FRAMEWORKS', () => {
  it('keys are the lowercased repository names used in package URLs', () => {
    for (const key of Object.keys(KNOWN_SWIFT_FRAMEWORKS)) {
      expect(key).toBe(key.toLowerCase());
    }
  });
});

describe('Swift framework detection', () => {
  it('reports SnapshotTesting and SwiftLog from their repository URLs', async () => {
    const dir = await projectWithPackageSwift(
      [
        '// swift-tools-version:6.0',
        'import PackageDescription',
        '',
        'let package = Package(',
        '    name: "app",',
        '    dependencies: [',
        '        .package(url: "https://github.com/pointfreeco/swift-snapshot-testing.git", from: "1.17.0"),',
        '        .package(url: "https://github.com/apple/swift-log.git", from: "1.6.0"),',
        '    ]',
        ')',
        '',
      ].join('\n'),
    );

    const [scan] = await scanSwiftProjects(dir, offlineCache());

    expect(scan?.frameworks.map((framework) => framework.name)).toEqual(
      expect.arrayContaining(['SnapshotTesting', 'SwiftLog']),
    );
  });
});
