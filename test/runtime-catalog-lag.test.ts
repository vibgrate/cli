/**
 * Swift, Dart, and PHP runtime lag comes from the release catalog
 * (`latestStable`), the same way Python and Go do. A stubbed catalog decides
 * the baseline: the newest released cycle is zero lag, an older cycle is the
 * minor gap, and a catalog with no entry leaves lag unset.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDartProjects } from '../src/core-open/scanners/dart-scanner.js';
import { scanPhpProjects } from '../src/core-open/scanners/php-scanner.js';
import { scanSwiftProjects } from '../src/core-open/scanners/swift-scanner.js';
import { ComposerCache } from '../src/core-open/scanners/composer-cache.js';
import { PubCache } from '../src/core-open/scanners/pub-cache.js';
import { SwiftCache } from '../src/core-open/scanners/swift-cache.js';
import type { RuntimeCatalog } from '../src/core-open/runtimes/types.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const RELEASED = '2019-01-01';
const UNRELEASED = '2999-01-01';

function stubCatalog(product: string, released: string[], unreleased: string[] = []): RuntimeCatalog {
  const cycles = [
    ...released.map((cycle) => ({ cycle, releaseDate: RELEASED, eol: false as const })),
    ...unreleased.map((cycle) => ({ cycle, releaseDate: UNRELEASED, eol: false as const })),
  ];
  return {
    generatedAt: '2020-01-01T00:00:00.000Z',
    source: 'endoflife.date',
    products: { [product]: { product, cycles } },
  };
}

const missingCatalog: RuntimeCatalog = {
  generatedAt: '2020-01-01T00:00:00.000Z',
  source: 'endoflife.date',
  products: {},
};

let root: string | undefined;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function writeProject(fileName: string, contents: string): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-lag-'));
  fs.writeFileSync(path.join(root, fileName), contents);
  return root;
}

describe('runtime lag from the release catalog', () => {
  describe('swift', () => {
    const catalog = stubCatalog('swift', ['6.0', '6.2'], ['6.3']);
    const cache = () => new SwiftCache(new Semaphore(1), undefined, true);

    async function lag(toolsVersion: string, cat: RuntimeCatalog) {
      const dir = writeProject(
        'Package.swift',
        `// swift-tools-version:${toolsVersion}\nimport PackageDescription\nlet package = Package(name: "app")\n`,
      );
      const [project] = await scanSwiftProjects(dir, cache(), undefined, undefined, cat);
      return { runtimeLatest: project?.runtimeLatest, runtimeMajorsBehind: project?.runtimeMajorsBehind };
    }

    it('shows zero lag on the newest released cycle', async () => {
      await expect(lag('6.2', catalog)).resolves.toEqual({ runtimeLatest: '6.2', runtimeMajorsBehind: 0 });
    });

    it('shows the minor gap for an older cycle', async () => {
      await expect(lag('6.0', catalog)).resolves.toEqual({ runtimeLatest: '6.2', runtimeMajorsBehind: 2 });
    });

    it('leaves lag unset when the catalog has no swift entry', async () => {
      await expect(lag('6.0', missingCatalog)).resolves.toEqual({
        runtimeLatest: undefined,
        runtimeMajorsBehind: undefined,
      });
    });
  });

  describe('dart', () => {
    const catalog = stubCatalog('dart', ['3.6', '3.10'], ['3.11']);
    const cache = () => new PubCache(new Semaphore(1), undefined, true);

    async function lag(sdk: string, cat: RuntimeCatalog) {
      const dir = writeProject(
        'pubspec.yaml',
        `name: app\nenvironment:\n  sdk: '>=${sdk} <4.0.0'\n`,
      );
      const [project] = await scanDartProjects(dir, cache(), undefined, undefined, cat);
      return { runtimeLatest: project?.runtimeLatest, runtimeMajorsBehind: project?.runtimeMajorsBehind };
    }

    it('shows zero lag on the newest released cycle', async () => {
      await expect(lag('3.10.0', catalog)).resolves.toEqual({ runtimeLatest: '3.10', runtimeMajorsBehind: 0 });
    });

    it('shows the minor gap for an older cycle', async () => {
      await expect(lag('3.6.0', catalog)).resolves.toEqual({ runtimeLatest: '3.10', runtimeMajorsBehind: 4 });
    });

    it('leaves lag unset when the catalog has no dart entry', async () => {
      await expect(lag('3.6.0', missingCatalog)).resolves.toEqual({
        runtimeLatest: undefined,
        runtimeMajorsBehind: undefined,
      });
    });
  });

  describe('php', () => {
    const catalog = stubCatalog('php', ['8.2', '8.5'], ['8.6']);
    const cache = () => new ComposerCache(new Semaphore(1), undefined, true);

    async function lag(php: string, cat: RuntimeCatalog) {
      const dir = writeProject(
        'composer.json',
        JSON.stringify({ name: 'acme/app', require: { php } }),
      );
      const [project] = await scanPhpProjects(dir, cache(), undefined, undefined, cat);
      return { runtimeLatest: project?.runtimeLatest, runtimeMajorsBehind: project?.runtimeMajorsBehind };
    }

    it('shows zero lag on the newest released cycle', async () => {
      await expect(lag('>=8.5', catalog)).resolves.toEqual({ runtimeLatest: '8.5', runtimeMajorsBehind: 0 });
    });

    it('shows the minor gap for an older cycle', async () => {
      await expect(lag('>=8.2', catalog)).resolves.toEqual({ runtimeLatest: '8.5', runtimeMajorsBehind: 3 });
    });

    it('leaves lag unset when the catalog has no php entry', async () => {
      await expect(lag('>=8.2', missingCatalog)).resolves.toEqual({
        runtimeLatest: undefined,
        runtimeMajorsBehind: undefined,
      });
    });
  });
});
