/**
 * When require.php is missing, the PHP runtime comes from config.platform.php.
 * require.php still wins when both are set (#647).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposerCache } from '../src/core-open/scanners/composer-cache.js';
import { scanPhpProjects } from '../src/core-open/scanners/php-scanner.js';
import type { RuntimeCatalog } from '../src/core-open/runtimes/types.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const catalog: RuntimeCatalog = {
  generatedAt: '2020-01-01T00:00:00.000Z',
  source: 'endoflife.date',
  products: {
    php: {
      product: 'php',
      cycles: [
        { cycle: '8.2', releaseDate: '2019-01-01', eol: false },
        { cycle: '8.5', releaseDate: '2019-01-01', eol: false },
      ],
    },
  },
};

describe('PHP runtime from config.platform.php (#647)', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function writeComposer(body: unknown): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-php-platform-runtime-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'composer.json'), `${JSON.stringify(body, null, 2)}\n`);
    return root;
  }

  async function scan(root: string) {
    const cache = new ComposerCache(new Semaphore(1), undefined, true);
    const [project] = await scanPhpProjects(root, cache, undefined, undefined, catalog);
    return project;
  }

  it('reports require.php when that is the only runtime signal', async () => {
    const project = await scan(
      writeComposer({ name: 'acme/app', require: { php: '>=8.2', 'laravel/framework': '^11.0' } }),
    );
    expect(project?.runtime).toBe('8.2');
    expect(project?.runtimeLatest).toBe('8.5');
    expect(project?.runtimeMajorsBehind).toBe(3);
  });

  it('falls back to config.platform.php when require.php is missing', async () => {
    const project = await scan(
      writeComposer({
        name: 'acme/app',
        require: { 'laravel/framework': '^11.0' },
        config: { platform: { php: '8.2.15' } },
      }),
    );
    expect(project?.runtime).toBe('8.2');
    expect(project?.runtimeLatest).toBe('8.5');
    expect(project?.runtimeMajorsBehind).toBe(3);
  });

  it('keeps require.php when both require.php and config.platform.php are set', async () => {
    const project = await scan(
      writeComposer({
        name: 'acme/app',
        require: { php: '^8.1', 'laravel/framework': '^11.0' },
        config: { platform: { php: '8.3.0' } },
      }),
    );
    expect(project?.runtime).toBe('8.1');
  });

  it('leaves runtime unset when require.php and config.platform.php are both missing', async () => {
    const project = await scan(
      writeComposer({ name: 'acme/app', require: { 'laravel/framework': '^11.0' } }),
    );
    expect(project?.runtime).toBeUndefined();
    expect(project?.runtimeLatest).toBeUndefined();
    expect(project?.runtimeMajorsBehind).toBeUndefined();
  });

  it('ignores a non-string config.platform.php without error', async () => {
    const project = await scan(
      writeComposer({
        name: 'acme/app',
        require: { 'laravel/framework': '^11.0' },
        config: { platform: { php: 80215 } },
      }),
    );
    expect(project?.runtime).toBeUndefined();
  });
});
