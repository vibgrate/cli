import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discover } from './discover.js';
import { LockfileParseError } from '../core-open/utils/lockfile-parse.js';
import { lockfileVersion, fullDependencyTree, fullDependencyGraph } from './lockfile.js';

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

  it('returns undefined when a valid lockfile does not finish the dependency entry', () => {
    write('pnpm-lock.yaml', ['importers:', '  .:', '    dependencies:', '      commander:', ''].join('\n'));
    expect(lockfileVersion(root, 'npm', 'commander')).toBeUndefined();
  });

  it('rejects a truncated pnpm lockfile instead of a partial graph', () => {
    const secret = 'npm_AAAAAAAAAAAAAAAAAAAA';
    write(
      'pnpm-lock.yaml',
      [
        "lockfileVersion: '9.0'",
        'packages:',
        '  commander@15.0.0:',
        '    resolution: {integrity: sha512-abc}',
        '  chalk@5.0.0:',
        `    resolution: {integrity: ${secret}`,
      ].join('\n'),
    );
    expect(() => fullDependencyGraph(root)).toThrow(LockfileParseError);
    try {
      fullDependencyGraph(root);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('pnpm-lock.yaml');
      expect(message).toContain('truncated or invalid YAML');
      expect(message).toContain('package manager');
      expect(message).not.toContain(secret);
    }
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

  it('resolves a yarn.lock alias descriptor to its real registry name, not the alias or a mangled string', () => {
    write(
      'yarn.lock',
      [
        // Classic aliasing (`"foo-cjs@npm:foo@^1.0.0"`).
        '"string-width-cjs@npm:string-width@^4.2.3":',
        '  version "4.2.3"',
        '',
        // Yarn Berry writes *every* plain npm dependency as `name@npm:<range>` —
        // that is not aliasing, and must resolve to its own name, not the range.
        '"file-entry-cache@npm:11.1.5, file-entry-cache@npm:11.1.5 || >11.1.6 <12":',
        '  version: 11.1.5',
        '',
        // Berry alias of a scoped package.
        '"react-loadable@npm:@docusaurus/react-loadable@^6.0.0":',
        '  version: 6.0.0',
        '',
      ].join('\n'),
    );
    expect(fullDependencyTree(root)).toEqual([
      { package: '@docusaurus/react-loadable', version: '6.0.0' },
      { package: 'file-entry-cache', version: '11.1.5' },
      { package: 'string-width', version: '4.2.3' },
    ]);
  });

  it('returns undefined when there is no lockfile at all', () => {
    expect(fullDependencyTree(root)).toBeUndefined();
  });

  it('rejects a truncated package-lock.json instead of an empty graph', () => {
    const secret = 'npm_BBBBBBBBBBBBBBBBBBBB';
    write('package-lock.json', `{"lockfileVersion":3,"packages":{"node_modules/left-pad":{"version":"1.0.0","integrity":"${secret}"`);
    expect(() => fullDependencyTree(root)).toThrow(LockfileParseError);
    try {
      fullDependencyGraph(root);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(path.join(root, 'package-lock.json'));
      expect(message).toContain('truncated or invalid JSON');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('left-pad');
    }
  });

  it('does not fall through to another lockfile when package-lock.json is truncated', () => {
    write('package-lock.json', '{"lockfileVersion":3,"packages":{');
    write('yarn.lock', ['commander@^15.0.0:', '  version "15.2.1"', ''].join('\n'));
    expect(() => fullDependencyGraph(root)).toThrow(/package-lock\.json/);
    expect(() => fullDependencyGraph(root)).toThrow(/truncated or invalid JSON/);
  });
});

describe('fullDependencyGraph', () => {
  it('resolves real dependency edges from an npm v2/v3 lockfile, including hoisted (root-level) and nested packages', () => {
    write(
      'package-lock.json',
      JSON.stringify({
        packages: {
          '': { name: 'app', dependencies: { chalk: '^5.3.0' } },
          'node_modules/chalk': { version: '5.3.0', dependencies: { 'ansi-styles': '^6.0.0' } },
          // Hoisted to the root node_modules — chalk resolves it there, not nested under itself.
          'node_modules/ansi-styles': { version: '6.2.1' },
          // Not reachable from chalk or root — an unrelated package with its own nested dep.
          'node_modules/commander': { version: '15.0.0', dependencies: { 'ansi-styles': '^4.0.0' } },
          'node_modules/commander/node_modules/ansi-styles': { version: '4.3.0' },
        },
      }),
    );
    const graph = fullDependencyGraph(root);
    expect(graph?.rootDependsOn).toEqual(['chalk@5.3.0']);
    expect(graph?.edges?.get('chalk@5.3.0')).toEqual(['ansi-styles@6.2.1']);
    expect(graph?.edges?.get('commander@15.0.0')).toEqual(['ansi-styles@4.3.0']);
    // Two distinct resolved versions of the same name coexist, nesting keeps them apart.
    expect(graph?.components).toContainEqual({ package: 'ansi-styles', version: '6.2.1' });
    expect(graph?.components).toContainEqual({ package: 'ansi-styles', version: '4.3.0' });
  });

  it('leaves edges undefined for the npm v1 shape, pnpm, and yarn — components only, no fabricated graph', () => {
    write(
      'package-lock.json',
      JSON.stringify({ dependencies: { chalk: { version: '5.3.0' } } }),
    );
    expect(fullDependencyGraph(root)?.edges).toBeUndefined();
    expect(fullDependencyGraph(root)?.rootDependsOn).toEqual([]);

    fs.rmSync(path.join(root, 'package-lock.json'));
    write('pnpm-lock.yaml', V9);
    expect(fullDependencyGraph(root)?.edges).toBeUndefined();

    fs.rmSync(path.join(root, 'pnpm-lock.yaml'));
    write('yarn.lock', ['commander@^15.0.0:', '  version "15.2.1"', ''].join('\n'));
    expect(fullDependencyGraph(root)?.edges).toBeUndefined();
  });

  it('returns undefined when there is no lockfile at all', () => {
    expect(fullDependencyGraph(root)).toBeUndefined();
  });

  it('discover fails a truncated lockfile before returning source files', () => {
    write('package-lock.json', '{"name":"app","packages":{');
    write('app.ts', 'export const n = 1;\n');
    expect(() => discover({ root })).toThrow(LockfileParseError);
  });

  it('resolves an npm alias install (`"foo-cjs": "npm:foo@^1.0.0"`) to its real registry name, not the install-path segment', () => {
    // e.g. wrap-ansi-cjs/string-width-cjs, used by @isaacs/cliui for a dual
    // CJS/ESM install of the same package under two directory names.
    write(
      'package-lock.json',
      JSON.stringify({
        packages: {
          '': { dependencies: { 'string-width-cjs': 'npm:string-width@^4.2.3' } },
          'node_modules/string-width-cjs': { name: 'string-width', version: '4.2.3' },
        },
      }),
    );
    const graph = fullDependencyGraph(root);
    expect(graph?.components).toEqual([{ package: 'string-width', version: '4.2.3' }]);
    expect(graph?.rootDependsOn).toEqual(['string-width@4.2.3']);
  });

  it('reads the full transitive set from Cargo.lock, go.sum, poetry.lock and uv.lock, tagging the ecosystem', () => {
    write(
      'Cargo.lock',
      [
        '[[package]]',
        'name = "memchr"',
        'version = "2.7.4"',
        '',
        '[[package]]',
        'name = "aho-corasick"',
        'version = "1.1.5"',
        'dependencies = [',
        ' "memchr",',
        ']',
      ].join('\n'),
    );
    const cargo = fullDependencyGraph(root);
    expect(cargo?.ecosystem).toBe('rust');
    expect(cargo?.edges).toBeUndefined();
    expect(cargo?.components).toContainEqual({ package: 'memchr', version: '2.7.4' });
    expect(cargo?.components).toContainEqual({ package: 'aho-corasick', version: '1.1.5' });

    fs.rmSync(path.join(root, 'Cargo.lock'));
    write(
      'go.sum',
      [
        'github.com/gin-contrib/sse v1.1.0 h1:abc=',
        'github.com/gin-contrib/sse v1.1.0/go.mod h1:def=',
      ].join('\n'),
    );
    const go = fullDependencyGraph(root);
    expect(go?.ecosystem).toBe('go');
    // Only the module-hash line becomes a component; the /go.mod hash line
    // for the same module is not a second, differently-versioned package.
    expect(go?.components).toEqual([{ package: 'github.com/gin-contrib/sse', version: 'v1.1.0' }]);

    fs.rmSync(path.join(root, 'go.sum'));
    write('poetry.lock', ['[[package]]', 'name = "click"', 'version = "8.1.3"'].join('\n'));
    expect(fullDependencyGraph(root)?.ecosystem).toBe('pypi');
    expect(fullDependencyGraph(root)?.components).toEqual([{ package: 'click', version: '8.1.3' }]);

    fs.rmSync(path.join(root, 'poetry.lock'));
    write('uv.lock', ['[[package]]', 'name = "click"', 'version = "8.1.3"'].join('\n'));
    expect(fullDependencyGraph(root)?.ecosystem).toBe('pypi');
  });

  it('attaches multi-digest lists in algorithm-then-value order for the same lockfile facts', () => {
    const sha256 = createHash('sha256').update('alpha').digest();
    const sha512 = createHash('sha512').update('beta').digest();
    const other = createHash('sha256').update('gamma').digest();
    const hex256 = sha256.toString('hex');
    const hexOther = other.toString('hex');
    const smaller = hex256 < hexOther ? hex256 : hexOther;
    const larger = hex256 < hexOther ? hexOther : hex256;
    const sri = (alg: 'sha256' | 'sha512', buf: Buffer): string => `${alg}-${buf.toString('base64')}`;
    const expected = [
      { alg: 'SHA-256', content: smaller },
      { alg: 'SHA-256', content: larger },
      { alg: 'SHA-512', content: sha512.toString('hex') },
    ];

    const npmIntegrity = (first: string, second: string): string =>
      JSON.stringify({
        packages: {
          '': {},
          'node_modules/left-pad': { version: '1.3.0', integrity: `${first} ${second}` },
        },
      });
    write('package-lock.json', npmIntegrity(sri('sha512', sha512), `${sri('sha256', sha256)} ${sri('sha256', other)}`));
    const forward = fullDependencyGraph(root)?.components.find((c) => c.package === 'left-pad')?.hashes;
    fs.rmSync(path.join(root, 'package-lock.json'));
    write('package-lock.json', npmIntegrity(`${sri('sha256', other)} ${sri('sha256', sha256)}`, sri('sha512', sha512)));
    const reversed = fullDependencyGraph(root)?.components.find((c) => c.package === 'left-pad')?.hashes;
    expect(forward).toEqual(expected);
    expect(reversed).toEqual(expected);

    fs.rmSync(path.join(root, 'package-lock.json'));
    const pnpm = (integrity: string): string =>
      ['lockfileVersion: \'9.0\'', 'packages:', '  left-pad@1.3.0:', `    resolution: {integrity: ${integrity}}`].join('\n');
    write('pnpm-lock.yaml', pnpm(`"${sri('sha512', sha512)} ${sri('sha256', sha256)}"`));
    expect(fullDependencyGraph(root)?.components[0]?.hashes).toEqual([
      { alg: 'SHA-256', content: hex256 },
      { alg: 'SHA-512', content: sha512.toString('hex') },
    ]);

    fs.rmSync(path.join(root, 'pnpm-lock.yaml'));
    write(
      'yarn.lock',
      ['left-pad@^1.3.0:', '  version "1.3.0"', `  integrity ${sri('sha512', sha512)}`, ''].join('\n'),
    );
    expect(fullDependencyGraph(root)?.components).toEqual([
      { package: 'left-pad', version: '1.3.0', hashes: [{ alg: 'SHA-512', content: sha512.toString('hex') }] },
    ]);

    fs.rmSync(path.join(root, 'yarn.lock'));
    write(
      'Cargo.lock',
      ['[[package]]', 'name = "memchr"', 'version = "2.7.4"', `checksum = "${hex256.toUpperCase()}"`, ''].join('\n'),
    );
    expect(fullDependencyGraph(root)?.components[0]?.hashes).toEqual([{ alg: 'SHA-256', content: hex256 }]);

    fs.rmSync(path.join(root, 'Cargo.lock'));
    const zip = createHash('sha256').update('zip').digest();
    const gomod = createHash('sha256').update('gomod').digest();
    write(
      'go.sum',
      [
        `github.com/gin-contrib/sse v1.1.0 h1:${zip.toString('base64')}`,
        `github.com/gin-contrib/sse v1.1.0/go.mod h1:${gomod.toString('base64')}`,
      ].join('\n'),
    );
    expect(fullDependencyGraph(root)?.components).toEqual([
      {
        package: 'github.com/gin-contrib/sse',
        version: 'v1.1.0',
        hashes: [{ alg: 'SHA-256', content: zip.toString('hex') }],
      },
    ]);

    fs.rmSync(path.join(root, 'go.sum'));
    const uv = (first: string, second: string): string =>
      [
        '[[package]]',
        'name = "click"',
        'version = "8.1.3"',
        'sdist = { url = "https://example.test/click.tar.gz", hash = "sha256:' + first + '" }',
        'wheels = [',
        '  { url = "https://example.test/click.whl", hash = "sha256:' + second + '" },',
        ']',
        '',
      ].join('\n');
    write('uv.lock', uv(larger, smaller));
    const uvForward = fullDependencyGraph(root)?.components[0]?.hashes;
    fs.rmSync(path.join(root, 'uv.lock'));
    write('uv.lock', uv(smaller, larger));
    const uvReversed = fullDependencyGraph(root)?.components[0]?.hashes;
    expect(uvForward).toEqual([
      { alg: 'SHA-256', content: smaller },
      { alg: 'SHA-256', content: larger },
    ]);
    expect(uvReversed).toEqual(uvForward);
  });
});
