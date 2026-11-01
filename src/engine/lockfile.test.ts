import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discover } from './discover.js';
import { LockfileParseError } from '../core-open/utils/lockfile-parse.js';
import { lockfileVersion, fullDependencyTree, fullDependencyGraph, gemfileSpecPattern } from './lockfile.js';

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
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        '',
        '[[package]]',
        'name = "aho-corasick"',
        'version = "1.1.5"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
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
});

describe('lockfile package digests', () => {
  const sha256 = createHash('sha256').update('alpha').digest('base64');
  const sha512 = createHash('sha512').update('alpha').digest('base64');
  const other256 = createHash('sha256').update('beta').digest('base64');
  const cargo = 'a'.repeat(64);
  const wheel = 'b'.repeat(64);
  const goZip = createHash('sha256').update('module').digest('base64');
  const goMod = createHash('sha256').update('gomod').digest('base64');
  const token = 'super-secret-token';

  it('keeps one npm component when two paths record different digests, sorted by algorithm', () => {
    write(
      'package-lock.json',
      JSON.stringify({
        packages: {
          '': { name: 'app' },
          'node_modules/left-pad': {
            version: '1.3.0',
            resolved: `https://user:${token}@registry.example/left-pad.tgz`,
            integrity: `sha512-${sha512} sha256-${sha256}`,
          },
          'node_modules/widget/node_modules/left-pad': {
            version: '1.3.0',
            integrity: `sha256-${other256}`,
          },
        },
      }),
    );
    const sha256Values = [other256, sha256].sort();
    const component = fullDependencyGraph(root)?.components.find((row) => row.package === 'left-pad');
    expect(component).toEqual({
      package: 'left-pad',
      version: '1.3.0',
      digests: [
        { alg: 'SHA-256', content: sha256Values[0] },
        { alg: 'SHA-256', content: sha256Values[1] },
        { alg: 'SHA-512', content: sha512 },
      ],
    });
    expect(JSON.stringify(component)).not.toContain(token);
  });

  it('reads pnpm, yarn, Cargo, go.sum, and uv digests without a second row per hash', () => {
    write(
      'pnpm-lock.yaml',
      [
        "lockfileVersion: '9.0'",
        'packages:',
        '  left-pad@1.3.0:',
        `    resolution: {integrity: sha512-${sha512}, tarball: https://example.invalid/left-pad.tgz}`,
        '',
      ].join('\n'),
    );
    expect(fullDependencyGraph(root)?.components).toEqual([
      { package: 'left-pad', version: '1.3.0', digests: [{ alg: 'SHA-512', content: sha512 }] },
    ]);

    fs.rmSync(path.join(root, 'pnpm-lock.yaml'));
    write(
      'yarn.lock',
      ['left-pad@^1.3.0:', '  version "1.3.0"', `  integrity sha256-${sha256}`, ''].join('\n'),
    );
    expect(fullDependencyGraph(root)?.components).toEqual([
      { package: 'left-pad', version: '1.3.0', digests: [{ alg: 'SHA-256', content: sha256 }] },
    ]);

    fs.rmSync(path.join(root, 'yarn.lock'));
    write(
      'Cargo.lock',
      [
        '[[package]]',
        'name = "memchr"',
        'version = "2.7.4"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        `checksum = "${cargo}"`,
        '',
      ].join('\n'),
    );
    expect(fullDependencyGraph(root)?.components).toEqual([
      { package: 'memchr', version: '2.7.4', digests: [{ alg: 'SHA-256', content: cargo }] },
    ]);

    fs.rmSync(path.join(root, 'Cargo.lock'));
    write(
      'go.sum',
      [
        `github.com/gin-contrib/sse v1.1.0 h1:${goZip}`,
        `github.com/gin-contrib/sse v1.1.0/go.mod h1:${goMod}`,
      ].join('\n'),
    );
    expect(fullDependencyGraph(root)?.components).toEqual([
      { package: 'github.com/gin-contrib/sse', version: 'v1.1.0', digests: [{ alg: 'SHA-256', content: goZip }] },
    ]);

    fs.rmSync(path.join(root, 'go.sum'));
    write(
      'uv.lock',
      [
        '[[package]]',
        'name = "click"',
        'version = "8.1.3"',
        `wheels = [{ hash = "sha256:${wheel}" }]`,
        `sdist = { hash = "sha256:${cargo}" }`,
        '',
      ].join('\n'),
    );
    expect(fullDependencyGraph(root)?.components).toEqual([
      {
        package: 'click',
        version: '8.1.3',
        digests: [
          { alg: 'SHA-256', content: cargo },
          { alg: 'SHA-256', content: wheel },
        ],
      },
    ]);
  });
});

describe('Python lockfiles', () => {
  it('drops the uv editable project from the SBOM and keeps only registry packages', () => {
    write(
      'uv.lock',
      [
        'version = 1',
        'requires-python = ">=3.11"',
        '',
        '[[package]]',
        'name = "app"',
        'version = "0.1.0"',
        'source = { editable = "." }',
        '',
        '[[package]]',
        'name = "click"',
        'version = "8.1.7"',
        'source = { registry = "https://pypi.org/simple" }',
        '',
      ].join('\n'),
    );
    expect(fullDependencyGraph(root)?.ecosystem).toBe('pypi');
    expect(fullDependencyGraph(root)?.components).toEqual([{ package: 'click', version: '8.1.7' }]);
  });

  it('drops virtual / workspace members from a uv lockfile', () => {
    write(
      'uv.lock',
      [
        '[[package]]',
        'name = "shared-core"',
        'version = "0.1.0"',
        'source = { virtual = "packages/core" }',
        '',
        '[[package]]',
        'name = "pydantic"',
        'version = "2.9.2"',
        'source = { registry = "https://pypi.org/simple" }',
        '',
      ].join('\n'),
    );
    expect(fullDependencyGraph(root)?.components).toEqual([{ package: 'pydantic', version: '2.9.2' }]);
  });

  it('keeps poetry.lock, then uv.lock, then Pipfile.lock precedence', () => {
    write('poetry.lock', ['[[package]]', 'name = "click"', 'version = "8.1.3"'].join('\n'));
    write(
      'uv.lock',
      ['[[package]]', 'name = "click"', 'version = "8.1.7"', 'source = { registry = "https://pypi.org/simple" }'].join('\n'),
    );
    write('Pipfile.lock', JSON.stringify({ default: { click: { version: '==8.0.0' } } }));
    expect(lockfileVersion(root, 'pypi', 'click')).toBe('8.1.3');

    fs.rmSync(path.join(root, 'poetry.lock'));
    expect(lockfileVersion(root, 'pypi', 'click')).toBe('8.1.7');

    fs.rmSync(path.join(root, 'uv.lock'));
    expect(lockfileVersion(root, 'pypi', 'click')).toBe('8.0.0');
  });

  it('matches PEP 503 normalised names across separators and case', () => {
    write(
      'uv.lock',
      ['[[package]]', 'name = "Flask_Cors"', 'version = "4.0.1"', 'source = { registry = "https://pypi.org/simple" }'].join('\n'),
    );
    expect(lockfileVersion(root, 'pypi', 'flask-cors')).toBe('4.0.1');
    expect(lockfileVersion(root, 'pypi', 'Flask.Cors')).toBe('4.0.1');
    expect(lockfileVersion(root, 'pypi', 'flask_cors')).toBe('4.0.1');
  });

  it('resolves Pipfile develop entries and strips the == prefix', () => {
    write(
      'Pipfile.lock',
      JSON.stringify({
        default: { requests: { version: '==2.31.0' } },
        develop: { pytest: { version: '==8.0.0' } },
      }),
    );
    expect(lockfileVersion(root, 'pypi', 'pytest')).toBe('8.0.0');
  });

  it('returns undefined for Pipfile path and git entries', () => {
    write(
      'Pipfile.lock',
      JSON.stringify({
        default: {
          localpkg: { path: '.', editable: true },
          gitpkg: { git: 'https://example.invalid/repo.git', ref: 'main' },
        },
      }),
    );
    expect(lockfileVersion(root, 'pypi', 'localpkg')).toBeUndefined();
    expect(lockfileVersion(root, 'pypi', 'gitpkg')).toBeUndefined();
  });
});

describe('Gemfile.lock and composer.lock edge cases', () => {
  // One fixture covering every pinned case: a platform-specific gem, a
  // dot-separated prerelease, a 6-space nested constraint, a name prefix
  // (`rails` vs `rails-html-sanitizer`), and PATH/GIT sources.
  const GEMFILE_LOCK = [
    'GEM',
    '  remote: https://rubygems.org/',
    '  specs:',
    '    nokogiri (1.16.2-x86_64-linux)',
    '    rails (7.1.3)',
    '      rack (>= 2.2)',
    '    rack (3.0.9)',
    '    rails-html-sanitizer (1.6.0)',
    '    rspec (1.0.0.pre)',
    '',
    'PATH',
    '  remote: vendor/gems',
    '  specs:',
    '    billing (0.1.0)',
    '',
    'GIT',
    '  remote: https://github.com/example/inline-tool.git',
    '  revision: 0123456789abcdef0123456789abcdef01234567',
    '  branch: main',
    '  specs:',
    '    inline-tool (0.2.0)',
    '',
    'PLATFORMS',
    '  x86_64-linux',
    '',
    'DEPENDENCIES',
    '  billing!',
    '  inline-tool!',
    '  nokogiri',
    '  rails (~> 7.1)',
    '',
  ].join('\n');

  it('ruby: strips the platform suffix from a platform-specific gem pin', () => {
    write('Gemfile.lock', GEMFILE_LOCK);
    expect(lockfileVersion(root, 'ruby', 'nokogiri')).toBe('1.16.2');
  });

  it('ruby: keeps a dot-separated prerelease version intact', () => {
    write('Gemfile.lock', GEMFILE_LOCK);
    expect(lockfileVersion(root, 'ruby', 'rspec')).toBe('1.0.0.pre');
  });

  it('ruby: PATH and GIT sections resolve like GEM specs', () => {
    write('Gemfile.lock', GEMFILE_LOCK);
    expect(lockfileVersion(root, 'ruby', 'billing')).toBe('0.1.0');
    expect(lockfileVersion(root, 'ruby', 'inline-tool')).toBe('0.2.0');
  });

  it('ruby: a 6-space nested constraint is not the version, and a name prefix does not match', () => {
    write('Gemfile.lock', GEMFILE_LOCK);
    expect(lockfileVersion(root, 'ruby', 'rack')).toBe('3.0.9');
    expect(lockfileVersion(root, 'ruby', 'rails')).toBe('7.1.3');
    expect(lockfileVersion(root, 'ruby', 'rails-html-sanitizer')).toBe('1.6.0');
  });

  it('ruby: a hostile spec line does not backtrack quadratically', () => {
    // No closing paren: the old pattern had to try every split between the
    // version and the optional platform group, which is quadratic.
    const hostile = `    nokogiri (1${'-a'.repeat(100_000)}`;
    const started = Date.now();
    expect(gemfileSpecPattern('nokogiri').test(hostile)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('php: packages-dev entries resolve', () => {
    write(
      'composer.lock',
      JSON.stringify({
        packages: [{ name: 'monolog/monolog', version: '3.5.0' }],
        'packages-dev': [{ name: 'phpunit/phpunit', version: 'v10.5.0' }],
      }),
    );
    expect(lockfileVersion(root, 'php', 'phpunit/phpunit')).toBe('10.5.0');
  });

  it('php: strips a leading v, and a path-repository dev version is returned as written', () => {
    write(
      'composer.lock',
      JSON.stringify({
        packages: [{ name: 'acme/tool', version: 'v3.5.0' }],
        'packages-dev': [{ name: 'acme/local', version: 'dev-main' }],
      }),
    );
    expect(lockfileVersion(root, 'php', 'acme/tool')).toBe('3.5.0');
    expect(lockfileVersion(root, 'php', 'acme/local')).toBe('dev-main');
  });
});

describe('lockfileVersion — dotnet (packages.lock.json)', () => {
  it('matches ids case-insensitively (newtonsoft.json finds Newtonsoft.Json)', () => {
    write(
      'packages.lock.json',
      JSON.stringify({
        dependencies: {
          'net8.0': { 'Newtonsoft.Json': { type: 'Direct', requested: '13.0.3', resolved: '13.0.3' } },
        },
      }),
    );
    expect(lockfileVersion(root, 'dotnet', 'newtonsoft.json')).toBe('13.0.3');
  });

  it('returns undefined for "type": "Project" entries without a resolved pin', () => {
    write(
      'packages.lock.json',
      JSON.stringify({
        dependencies: {
          'net8.0': {
            ProjectX: { type: 'Project', requested: '1.0.0' },
            'Newtonsoft.Json': { type: 'Direct', requested: '13.0.3', resolved: '13.0.3' },
          },
        },
      }),
    );
    expect(lockfileVersion(root, 'dotnet', 'ProjectX')).toBeUndefined();
  });

  it('uses the first target framework that pins the package', () => {
    write(
      'packages.lock.json',
      JSON.stringify({
        dependencies: {
          'net6.0': { 'Serilog.Sinks.Console': { type: 'Direct', requested: '4.1.0', resolved: '4.1.0' } },
          'net8.0': { 'Serilog.Sinks.Console': { type: 'Direct', requested: '5.0.0', resolved: '5.0.0' } },
        },
      }),
    );
    expect(lockfileVersion(root, 'dotnet', 'Serilog.Sinks.Console')).toBe('4.1.0');
  });
});

describe('lockfileVersion — swift (Package.resolved)', () => {
  it('resolves v1 pins from the repositoryURL-derived identity', () => {
    write(
      'Package.resolved',
      JSON.stringify({
        object: {
          pins: [
            {
              package: 'ArgumentParser',
              repositoryURL: 'https://github.com/apple/swift-argument-parser',
              state: { revision: 'abc123', version: '1.2.0' },
            },
          ],
        },
        version: 1,
      }),
    );
    expect(lockfileVersion(root, 'swift', 'swift-argument-parser')).toBe('1.2.0');
  });

  it('strips a trailing .git suffix when deriving the v1 identity', () => {
    write(
      'Package.resolved',
      JSON.stringify({
        object: {
          pins: [
            {
              package: 'NIO',
              repositoryURL: 'https://github.com/apple/swift-nio.git',
              state: { revision: 'abc123', version: '2.65.0' },
            },
          ],
        },
        version: 1,
      }),
    );
    expect(lockfileVersion(root, 'swift', 'swift-nio')).toBe('2.65.0');
  });

  it('matches v2 identities case-insensitively', () => {
    write(
      'Package.resolved',
      JSON.stringify({
        pins: [{ identity: 'Swift-NIO', state: { revision: 'abc123', version: '2.65.0' } }],
        version: 2,
      }),
    );
    expect(lockfileVersion(root, 'swift', 'swift-nio')).toBe('2.65.0');
  });

  it('returns undefined for branch pins without a version', () => {
    write(
      'Package.resolved',
      JSON.stringify({
        pins: [{ identity: 'swift-nio', state: { branch: 'main', revision: 'abc123' } }],
        version: 2,
      }),
    );
    expect(lockfileVersion(root, 'swift', 'swift-nio')).toBeUndefined();
  });
});

describe('lockfileVersion — dart (pubspec.lock)', () => {
  const SDK_LOCK = [
    'packages:',
    '  flutter:',
    '    dependency: "direct main"',
    '    description: flutter',
    '    source: sdk',
    '    version: "0.0.0"',
    '  http:',
    '    dependency: "direct main"',
    '    description:',
    '      name: http',
    '      sha256: deadbeef',
    '      url: "https://pub.dev"',
    '    source: hosted',
    '    version: "1.2.2"',
    '',
  ].join('\n');

  it('returns undefined for SDK packages (source: sdk) instead of the fake 0.0.0 pin', () => {
    write('pubspec.lock', SDK_LOCK);
    expect(lockfileVersion(root, 'dart', 'flutter')).toBeUndefined();
  });

  it('still resolves hosted packages', () => {
    write('pubspec.lock', SDK_LOCK);
    expect(lockfileVersion(root, 'dart', 'http')).toBe('1.2.2');
  });

  it('returns the version as written for path packages', () => {
    write(
      'pubspec.lock',
      [
        'packages:',
        '  my_pkg:',
        '    dependency: "direct main"',
        '    description:',
        '      path: "../my_pkg"',
        '      relative: true',
        '    source: path',
        '    version: "0.4.1"',
        '',
      ].join('\n'),
    );
    expect(lockfileVersion(root, 'dart', 'my_pkg')).toBe('0.4.1');
  });
});

describe('lockfileVersion — java (gradle.lockfile)', () => {
  const LOCKFILE = [
    '# This is a comment, never a match',
    '# com.fake:fake:9.9.9=compileClasspath,runtimeClasspath',
    'com.google.guava:guava:33.0.0-jre=compileClasspath',
    '',
  ].join('\n');

  it('requires the group:artifact form (guava alone returns undefined)', () => {
    write('gradle.lockfile', LOCKFILE);
    expect(lockfileVersion(root, 'java', 'guava')).toBeUndefined();
  });

  it('resolves the full group:artifact pin', () => {
    write('gradle.lockfile', LOCKFILE);
    expect(lockfileVersion(root, 'java', 'com.google.guava:guava')).toBe('33.0.0-jre');
  });

  it('never matches a commented pin line', () => {
    write('gradle.lockfile', LOCKFILE);
    expect(lockfileVersion(root, 'java', 'com.fake:fake')).toBeUndefined();
  });
});

describe('SBOM components from Cargo.lock and Go workspaces', () => {
  const REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index';

  it('drops root and path crates from Cargo.lock and keeps registry crates, one component per version', () => {
    write(
      'Cargo.lock',
      [
        'version = 3',
        '',
        '[[package]]',
        'name = "app"',
        'version = "0.1.0"',
        'dependencies = [',
        ' "core-lib",',
        ' "serde",',
        ' "syn",',
        ']',
        '',
        '[[package]]',
        'name = "core-lib"',
        'version = "0.2.0"',
        '',
        '[[package]]',
        'name = "serde"',
        'version = "1.0.197"',
        `source = "${REGISTRY}"`,
        '',
        '[[package]]',
        'name = "syn"',
        'version = "1.0.109"',
        `source = "${REGISTRY}"`,
        '',
        '[[package]]',
        'name = "syn"',
        'version = "2.0.52"',
        `source = "${REGISTRY}"`,
        '',
      ].join('\n'),
    );
    // The scanned project itself and the local path crate have no `source`,
    // so they must not appear as crates.io components (see #512).
    expect(fullDependencyGraph(root)?.components).toEqual([
      { package: 'serde', version: '1.0.197' },
      { package: 'syn', version: '1.0.109' },
      { package: 'syn', version: '2.0.52' },
    ]);
  });

  it('resolves a go.work module through its own go.sum and treats a go.work-only root as undefined', () => {
    fs.mkdirSync(path.join(root, 'api'), { recursive: true });
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    write(
      'go.work',
      ['go 1.22', '', 'use (', '\t./api', '\t./lib', ')', ''].join('\n'),
    );
    write(
      path.join('api', 'go.sum'),
      [
        'github.com/gin-contrib/sse v1.1.0 h1:abc=',
        'github.com/gin-contrib/sse v1.1.0/go.mod h1:def=',
        'golang.org/x/net v0.27.0 h1:xyz=',
        'golang.org/x/net v0.27.0/go.mod h1:xyz=',
      ].join('\n'),
    );
    write(
      path.join('lib', 'go.sum'),
      ['golang.org/x/text v0.16.0 h1:abc=', 'golang.org/x/text v0.16.0/go.mod h1:def='].join('\n'),
    );
    // `go.work` is not read: each module's go.sum is the resolution unit.
    // Scanning the module directory lists that module's rows...
    expect(fullDependencyGraph(path.join(root, 'api'))?.components).toEqual([
      { package: 'github.com/gin-contrib/sse', version: 'v1.1.0' },
      { package: 'golang.org/x/net', version: 'v0.27.0' },
    ]);
    // ...and a tree with only go.work (no go.sum) resolves to nothing.
    expect(fullDependencyGraph(root)).toBeUndefined();
  });
});
