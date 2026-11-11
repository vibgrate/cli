/**
 * Composer platform packages (`php` variants, `hhvm`, `ext-*`, `lib-*`,
 * `composer`, `composer-plugin-api`, `composer-runtime-api`) are not on
 * Packagist, so they are not dependency rows. `require.php` still sets the
 * PHP runtime.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposerCache, type PackagistMeta } from '../src/core-open/scanners/composer-cache.js';
import { isComposerPlatformPackage, scanPhpProjects } from '../src/core-open/scanners/php-scanner.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const MANIFEST: PackageVersionManifest = {
  composer: {
    'php-http/client-common': { latest: '2.7.2', versions: ['2.7.2'] },
    'phpunit/phpunit': { latest: '11.5.0', versions: ['11.5.0'] },
  },
};

const PLATFORM = [
  'php',
  'php-64bit',
  'php-ipv6',
  'php-zts',
  'php-debug',
  'hhvm',
  'ext-json',
  'ext-pdo_mysql',
  'lib-icu',
  'lib-curl',
  'lib-openssl',
  'composer',
  'composer-plugin-api',
  'composer-runtime-api',
];

class RecordingComposerCache extends ComposerCache {
  readonly lookedUp: string[] = [];

  override get(packageName: string): Promise<PackagistMeta> {
    this.lookedUp.push(packageName);
    return super.get(packageName);
  }
}

describe('Composer platform packages', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it('matches every platform package form and no Packagist name', () => {
    for (const name of PLATFORM) expect(isComposerPlatformPackage(name), name).toBe(true);
    for (const name of [
      'php-http/client-common',
      'phpunit/phpunit',
      'phpstan/phpstan',
      'composer/semver',
      'composer/installers',
      'php-di',
      'library-x',
      'ext-',
    ]) {
      expect(isComposerPlatformPackage(name), name).toBe(false);
    }
  });

  it('rejects a long name that almost matches in linear time', () => {
    const started = performance.now();
    expect(isComposerPlatformPackage(`ext-${'a'.repeat(50_000)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('reports only the real packages of a composer.json that mixes them with platform packages', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-composer-platform-'));
    roots.push(root);
    const prodPlatform = Object.fromEntries(PLATFORM.map((name) => [name, '*']));
    fs.writeFileSync(
      path.join(root, 'composer.json'),
      `${JSON.stringify(
        {
          require: { ...prodPlatform, php: '>=8.2', 'php-http/client-common': '^2.7' },
          'require-dev': { 'lib-icu': '>=60', 'composer-runtime-api': '^2.2', 'phpunit/phpunit': '^11.5' },
        },
        null,
        2,
      )}\n`,
    );
    const cache = new RecordingComposerCache(new Semaphore(1), MANIFEST, true);

    const projects = await scanPhpProjects(root, cache);

    expect(projects).toHaveLength(1);
    const project = projects[0]!;
    expect(project.dependencies.map((dep) => [dep.package, dep.section])).toEqual([
      ['php-http/client-common', 'dependencies'],
      ['phpunit/phpunit', 'devDependencies'],
    ]);
    expect(cache.lookedUp).toEqual(['php-http/client-common']);
    expect(project.runtime).toBe('8.2');
  });
});
