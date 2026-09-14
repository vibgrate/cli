import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lockfileVersion, fullDependencyTree } from './lockfile.js';

/**
 * The point of reading lockfiles at all is that `node_modules` is empty in CI
 * and on a fresh clone, so "what is installed" is not an answer. A lockfile we
 * cannot parse is therefore not a small gap — it silently drops the resolution
 * back to the declared *range*.
 */

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-lockfile-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (name: string, body: string): void => fs.writeFileSync(path.join(root, name), body);

const V9 = [
  "lockfileVersion: '9.0'",
  '',
  'settings:',
  '  autoInstallPeers: true',
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      commander:',
  '        specifier: ^15.0.0',
  '        version: 15.0.0',
  "      '@modelcontextprotocol/sdk':",
  '        specifier: ^1.26.0',
  '        version: 1.29.0(zod@4.4.3)',
  '    devDependencies:',
  '      typescript:',
  '        specifier: ^6.0.0',
  '        version: 6.0.3',
  '',
  'packages:',
  '',
  '  commander@99.0.0:',
  '    resolution: {integrity: sha512-deadbeef==}',
  '',
].join('\n');

describe('lockfileVersion — pnpm', () => {
  it('reads a direct dependency pin', () => {
    write('pnpm-lock.yaml', V9);
    expect(lockfileVersion(root, 'npm', 'commander')).toBe('15.0.0');
  });

  it('reads a quoted scoped name and strips the peer suffix', () => {
    write('pnpm-lock.yaml', V9);
    expect(lockfileVersion(root, 'npm', '@modelcontextprotocol/sdk')).toBe('1.29.0');
  });

  it('reads devDependencies too', () => {
    write('pnpm-lock.yaml', V9);
    expect(lockfileVersion(root, 'npm', 'typescript')).toBe('6.0.3');
  });

  it('prefers the importer pin over the transitive packages graph', () => {
    write('pnpm-lock.yaml', V9);
    // `packages:` lists commander@99.0.0; the importer says 15.0.0 and wins.
    expect(lockfileVersion(root, 'npm', 'commander')).toBe('15.0.0');
  });

  it('returns undefined for a package the project does not depend on', () => {
    write('pnpm-lock.yaml', V9);
    expect(lockfileVersion(root, 'npm', 'not-a-dependency')).toBeUndefined();
  });

  it('never throws on a truncated or non-YAML lockfile', () => {
    write('pnpm-lock.yaml', ['importers:', '  .:', '    dependencies:', '      commander:', ''].join('\n'));
    expect(lockfileVersion(root, 'npm', 'commander')).toBeUndefined();
    write('pnpm-lock.yaml', '  not yaml at all');
    expect(lockfileVersion(root, 'npm', 'commander')).toBeUndefined();
  });

  it('does not confuse a name that is a prefix of another', () => {
    write(
      'pnpm-lock.yaml',
      [
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      chalk:',
        '        specifier: ^6.0.0',
        '        version: 6.0.0',
        '      chalk-template:',
        '        specifier: ^1.0.0',
        '        version: 1.1.0',
        '',
      ].join('\n'),
    );
    expect(lockfileVersion(root, 'npm', 'chalk')).toBe('6.0.0');
    expect(lockfileVersion(root, 'npm', 'chalk-template')).toBe('1.1.0');
  });
});

describe('lockfileVersion — npm precedence', () => {
  it('prefers package-lock.json over pnpm-lock.yaml when both exist', () => {
    write('package-lock.json', JSON.stringify({ packages: { 'node_modules/commander': { version: '11.0.0' } } }));
    write(
      'pnpm-lock.yaml',
      [
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      commander:',
        '        specifier: ^15.0.0',
        '        version: 15.0.0',
        '',
      ].join('\n'),
    );
    expect(lockfileVersion(root, 'npm', 'commander')).toBe('11.0.0');
  });

  it('falls through to yarn.lock when neither of the others has the name', () => {
    write('yarn.lock', ['commander@^15.0.0:', '  version "15.2.1"', ''].join('\n'));
    expect(lockfileVersion(root, 'npm', 'commander')).toBe('15.2.1');
  });

  it('returns undefined when there is no lockfile at all', () => {
    expect(lockfileVersion(root, 'npm', 'commander')).toBeUndefined();
  });
});

describe('fullDependencyTree', () => {
  it('reads the full transitive graph from an npm v2/v3 package-lock.json, not just direct deps', () => {
    write(
      'package-lock.json',
      JSON.stringify({
        packages: {
          '': { name: 'app' },
          'node_modules/commander': { version: '15.0.0' },
          'node_modules/commander/node_modules/ansi-styles': { version: '4.3.0' },
          'node_modules/chalk': { version: '5.3.0' },
        },
      }),
    );
    const tree = fullDependencyTree(root);
    expect(tree).toEqual([
      { package: 'ansi-styles', version: '4.3.0' },
      { package: 'chalk', version: '5.3.0' },
      { package: 'commander', version: '15.0.0' },
    ]);
  });

  it('reads npm v1 nested dependencies recursively', () => {
    write(
      'package-lock.json',
      JSON.stringify({
        dependencies: {
          commander: {
            version: '15.0.0',
            dependencies: { 'ansi-styles': { version: '4.3.0' } },
          },
        },
      }),
    );
    expect(fullDependencyTree(root)).toEqual([
      { package: 'ansi-styles', version: '4.3.0' },
      { package: 'commander', version: '15.0.0' },
    ]);
  });

  it('reads every resolved package from a pnpm v9 lockfile, including scoped and peer-suffixed names', () => {
    write('pnpm-lock.yaml', V9);
    const tree = fullDependencyTree(root);
    expect(tree).toContainEqual({ package: 'commander', version: '99.0.0' });
  });

  it('reads every resolved package from a yarn.lock', () => {
    write(
      'yarn.lock',
      ['commander@^15.0.0:', '  version "15.2.1"', '', 'chalk@^5.0.0, chalk@^5.3.0:', '  version "5.3.0"', ''].join('\n'),
    );
    expect(fullDependencyTree(root)).toEqual([
      { package: 'chalk', version: '5.3.0' },
      { package: 'commander', version: '15.2.1' },
    ]);
  });

  it('returns undefined when there is no lockfile at all', () => {
    expect(fullDependencyTree(root)).toBeUndefined();
  });

  it('never throws on a malformed package-lock.json', () => {
    write('package-lock.json', '{ not valid json');
    expect(fullDependencyTree(root)).toBeUndefined();
  });
});
