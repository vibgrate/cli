import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LockfileParseError } from '../core-open/utils/lockfile-parse.js';
import { fullDependencyGraph } from './lockfile.js';

/**
 * `composer.lock` is an SBOM lockfile. `packages` are production components,
 * `packages-dev` are development components, and `dist.shasum` is a SHA-1
 * digest only when Composer recorded one.
 */

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-composer-lock-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (name: string, body: string): void => fs.writeFileSync(path.join(root, name), body);

const SHA1 = 'a'.repeat(40);

describe('composer.lock SBOM graph', () => {
  it('reads packages and packages-dev, strips a leading v, and keeps a missing dist off the component', () => {
    write(
      'composer.lock',
      JSON.stringify({
        packages: [
          {
            name: 'psr/log',
            version: '3.0.0',
            require: { php: '>=8.0' },
          },
          {
            name: 'monolog/monolog',
            version: 'v3.5.0',
            dist: { type: 'zip', url: 'https://example.invalid/monolog.zip', shasum: SHA1 },
            require: { 'psr/log': '^3.0' },
          },
          {
            name: 'vendor/no-shasum',
            version: '1.2.3',
            dist: { type: 'zip', url: 'https://example.invalid/no-shasum.zip', shasum: '' },
          },
        ],
        'packages-dev': [
          {
            name: 'phpunit/phpunit',
            version: 'v10.5.0',
            dist: { type: 'zip', shasum: 'b'.repeat(40) },
            require: { php: '>=8.1' },
          },
          { name: 'acme/local', version: 'dev-main' },
          {
            name: 'monolog/monolog',
            version: 'v3.5.0',
            dist: { shasum: 'c'.repeat(40) },
          },
        ],
      }),
    );

    const graph = fullDependencyGraph(root);
    expect(graph?.ecosystem).toBe('php');
    expect(graph?.edges).toBeUndefined();
    expect(graph?.rootDependsOn).toEqual([]);
    expect(graph?.components).toEqual([
      { package: 'acme/local', version: 'dev-main', development: true },
      {
        package: 'monolog/monolog',
        version: '3.5.0',
        digests: [
          { alg: 'SHA-1', content: SHA1 },
          { alg: 'SHA-1', content: 'c'.repeat(40) },
        ],
      },
      {
        package: 'phpunit/phpunit',
        version: '10.5.0',
        digests: [{ alg: 'SHA-1', content: 'b'.repeat(40) }],
        development: true,
      },
      { package: 'psr/log', version: '3.0.0' },
      { package: 'vendor/no-shasum', version: '1.2.3' },
    ]);
  });

  it('keeps a packages-dev-only lockfile and ignores a shasum that is not SHA-1', () => {
    write(
      'composer.lock',
      JSON.stringify({
        'packages-dev': [
          { name: 'phpunit/phpunit', version: '10.5.0', dist: { shasum: 'not-a-digest' } },
          { name: 'vendor/sha256', version: '1.0.0', dist: { shasum: 'd'.repeat(64) } },
        ],
      }),
    );
    expect(fullDependencyGraph(root)?.components).toEqual([
      { package: 'phpunit/phpunit', version: '10.5.0', development: true },
      { package: 'vendor/sha256', version: '1.0.0', development: true },
    ]);
  });

  it('rejects a truncated composer.lock instead of an empty graph', () => {
    const secret = 'composer_CCCCCCCCCCCCCCCCCCCC';
    write('composer.lock', `{"packages":[{"name":"monolog/monolog","version":"3.5.0","dist":{"url":"https://user:${secret}@example.invalid/m.zip"`);
    expect(() => fullDependencyGraph(root)).toThrow(LockfileParseError);
    try {
      fullDependencyGraph(root);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(path.join(root, 'composer.lock'));
      expect(message).toContain('truncated or invalid JSON');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('monolog');
    }
  });

  it('rejects invalid JSON the same way', () => {
    write('composer.lock', '{not json');
    expect(() => fullDependencyGraph(root)).toThrow(/composer\.lock/);
    expect(() => fullDependencyGraph(root)).toThrow(/truncated or invalid JSON/);
  });
});
