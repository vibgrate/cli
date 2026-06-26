import { describe, it, expect, afterEach } from 'vitest';
import { resolveVersion, localPackageDocs, extractDtsApi, localApiSurface } from '../src/engine/lib.js';
import { TOOLS } from '../src/mcp/tools.js';
import { lockfileVersion } from '../src/engine/lockfile.js';
import { countTokens, truncateToTokens } from '../src/engine/tokens.js';
import { makeProject, cleanup } from './helpers.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('lockfile-first version resolution (D13 / G2)', () => {
  it('resolves from package-lock.json with no node_modules and a looser range', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/react': { version: '18.2.0' } },
      }),
    });
    const v = resolveVersion(root, 'react');
    expect(v.served).toBe('18.2.0');
    expect(v.source).toBe('lockfile');
    expect(v.mismatch).toBeUndefined();
  });

  it('reads a v1 package-lock (dependencies map)', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { leftpad: '^1.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: { leftpad: { version: '1.3.0' } } }),
    });
    expect(lockfileVersion(root, 'npm', 'leftpad')).toBe('1.3.0');
  });

  it('reads yarn.lock for scoped and unscoped names', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { react: '^18.0.0', '@scope/pkg': '^2.0.0' } }),
      'yarn.lock': [
        '# yarn lockfile v1',
        '',
        'react@^18.0.0:',
        '  version "18.3.1"',
        '  resolved "https://registry.yarnpkg.com/react/-/react-18.3.1.tgz"',
        '',
        '"@scope/pkg@^2.0.0":',
        '  version "2.4.0"',
        '',
      ].join('\n'),
    });
    expect(lockfileVersion(root, 'npm', 'react')).toBe('18.3.1');
    expect(lockfileVersion(root, 'npm', '@scope/pkg')).toBe('2.4.0');
  });

  it('falls back to installed, then declared, when no lockfile', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      'node_modules/react/package.json': JSON.stringify({ name: 'react', version: '18.3.0' }),
    });
    const v = resolveVersion(root, 'react');
    expect(v.served).toBe('18.3.0');
    expect(v.source).toBe('installed');
  });
});

describe('python lockfile resolution (poetry / pipenv / uv)', () => {
  it('reads poetry.lock and resolves served version lockfile-first (PEP 503 names)', () => {
    const root = project({
      'pyproject.toml': '[project]\nname = "app"\ndependencies = ["Flask-SQLAlchemy>=3.0"]\n',
      'poetry.lock': [
        '[[package]]',
        'name = "flask-sqlalchemy"',
        'version = "3.1.1"',
        'description = "x"',
        '',
        '[[package]]',
        'name = "other"',
        'version = "9.9.9"',
        '',
      ].join('\n'),
    });
    expect(lockfileVersion(root, 'pypi', 'Flask-SQLAlchemy')).toBe('3.1.1');
    const v = resolveVersion(root, 'Flask-SQLAlchemy');
    expect(v.served).toBe('3.1.1');
    expect(v.source).toBe('lockfile');
  });

  it('reads uv.lock (same TOML [[package]] shape)', () => {
    const root = project({
      'uv.lock': '[[package]]\nname = "httpx"\nversion = "0.27.2"\n',
    });
    expect(lockfileVersion(root, 'pypi', 'httpx')).toBe('0.27.2');
  });

  it('reads Pipfile.lock and strips the == operator', () => {
    const root = project({
      'Pipfile.lock': JSON.stringify({ default: { requests: { version: '==2.32.3' } }, develop: {} }),
    });
    expect(lockfileVersion(root, 'pypi', 'requests')).toBe('2.32.3');
  });

  it('returns undefined when the package is absent', () => {
    const root = project({ 'poetry.lock': '[[package]]\nname = "a"\nversion = "1.0.0"\n' });
    expect(lockfileVersion(root, 'pypi', 'missing')).toBeUndefined();
  });
});

describe('rust ecosystem (Cargo.toml + Cargo.lock)', () => {
  it('resolves the Cargo.lock-pinned version for a Cargo.toml dependency', () => {
    const root = project({
      'Cargo.toml': [
        '[package]',
        'name = "app"',
        '',
        '[dependencies]',
        'serde = "1.0"',
        'tokio = { version = "1.38", features = ["full"] }',
        '',
      ].join('\n'),
      'Cargo.lock': [
        '[[package]]',
        'name = "tokio"',
        'version = "1.38.1"',
        '',
        '[[package]]',
        'name = "serde"',
        'version = "1.0.210"',
        '',
      ].join('\n'),
    });
    expect(lockfileVersion(root, 'rust', 'tokio')).toBe('1.38.1');
    const v = resolveVersion(root, 'tokio');
    expect(v.served).toBe('1.38.1');
    expect(v.source).toBe('lockfile');
    // declared (range) comes from Cargo.toml; served (pin) from Cargo.lock
    expect(v.declared).toBe('1.38');
  });

  it('falls back to the Cargo.toml declared range when no Cargo.lock', () => {
    const root = project({
      'Cargo.toml': '[package]\nname = "app"\n\n[dependencies]\nserde = "1.0"\n',
    });
    const v = resolveVersion(root, 'serde');
    expect(v.served).toBe('1.0');
    expect(v.source).toBe('declared');
  });
});

describe('ruby / php / dotnet ecosystems', () => {
  it('ruby: Gemfile declared + Gemfile.lock pin', () => {
    const root = project({
      Gemfile: 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\ngem "puma"\n',
      'Gemfile.lock': [
        'GEM',
        '  remote: https://rubygems.org/',
        '  specs:',
        '    rails (7.1.3)',
        '    puma (6.4.2)',
        '      nio4r (>= 1.1)',
        '',
        'DEPENDENCIES',
        '  rails (~> 7.1)',
        '',
      ].join('\n'),
    });
    expect(lockfileVersion(root, 'ruby', 'rails')).toBe('7.1.3');
    const v = resolveVersion(root, 'rails');
    expect(v.served).toBe('7.1.3');
    expect(v.source).toBe('lockfile');
  });

  it('php: composer.json declared + composer.lock pin (strips leading v)', () => {
    const root = project({
      'composer.json': JSON.stringify({ require: { 'monolog/monolog': '^3.0', php: '>=8.1' } }),
      'composer.lock': JSON.stringify({ packages: [{ name: 'monolog/monolog', version: 'v3.5.0' }], 'packages-dev': [] }),
    });
    expect(lockfileVersion(root, 'php', 'monolog/monolog')).toBe('3.5.0');
    const v = resolveVersion(root, 'monolog/monolog');
    expect(v.served).toBe('3.5.0');
    // platform req `php` is not treated as a dependency
    expect(resolveVersion(root, 'php').source).toBe('unknown');
  });

  it('dotnet: csproj declared + packages.lock.json resolved', () => {
    const root = project({
      'app.csproj': '<Project>\n  <ItemGroup>\n    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />\n  </ItemGroup>\n</Project>\n',
      'packages.lock.json': JSON.stringify({
        version: 1,
        dependencies: { 'net8.0': { 'Newtonsoft.Json': { type: 'Direct', resolved: '13.0.3' } } },
      }),
    });
    expect(lockfileVersion(root, 'dotnet', 'Newtonsoft.Json')).toBe('13.0.3');
    const v = resolveVersion(root, 'Newtonsoft.Json');
    expect(v.served).toBe('13.0.3');
    expect(v.declared).toBe('13.0.1');
  });
});

describe('java ecosystem (Maven + Gradle)', () => {
  it('maven: pom.xml declared version (groupId:artifactId)', () => {
    const root = project({
      'pom.xml': [
        '<project>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>com.google.guava</groupId>',
        '      <artifactId>guava</artifactId>',
        '      <version>33.0.0-jre</version>',
        '    </dependency>',
        '  </dependencies>',
        '</project>',
      ].join('\n'),
    });
    const v = resolveVersion(root, 'com.google.guava:guava');
    expect(v.served).toBe('33.0.0-jre');
    expect(v.source).toBe('declared');
  });

  it('gradle: build.gradle declared + gradle.lockfile pin', () => {
    const root = project({
      'build.gradle': 'dependencies {\n  implementation "com.squareup.okhttp3:okhttp:4.11.0"\n}\n',
      'gradle.lockfile': [
        '# Gradle dependency lock',
        'com.squareup.okhttp3:okhttp:4.12.0=compileClasspath,runtimeClasspath',
        'empty=',
      ].join('\n'),
    });
    expect(lockfileVersion(root, 'java', 'com.squareup.okhttp3:okhttp')).toBe('4.12.0');
    const v = resolveVersion(root, 'com.squareup.okhttp3:okhttp');
    expect(v.served).toBe('4.12.0');
    expect(v.declared).toBe('4.11.0');
  });
});

describe('swift / dart ecosystems', () => {
  it('swift: Package.swift declared + Package.resolved pin (identity match)', () => {
    const root = project({
      'Package.swift': [
        '// swift-tools-version:5.9',
        'import PackageDescription',
        'let package = Package(',
        '  name: "app",',
        '  dependencies: [',
        '    .package(url: "https://github.com/apple/swift-nio.git", from: "2.0.0"),',
        '  ]',
        ')',
      ].join('\n'),
      'Package.resolved': JSON.stringify({ pins: [{ identity: 'swift-nio', state: { version: '2.65.0' } }], version: 2 }),
    });
    expect(lockfileVersion(root, 'swift', 'swift-nio')).toBe('2.65.0');
    const v = resolveVersion(root, 'swift-nio');
    expect(v.served).toBe('2.65.0');
    expect(v.declared).toBe('2.0.0');
  });

  it('dart: pubspec.yaml declared + pubspec.lock pin', () => {
    const root = project({
      'pubspec.yaml': [
        'name: app',
        'environment:',
        "  sdk: '>=3.0.0 <4.0.0'",
        'dependencies:',
        '  http: ^1.2.0',
        '  provider: ^6.0.0',
        'dev_dependencies:',
        '  test: ^1.24.0',
      ].join('\n'),
      'pubspec.lock': [
        'packages:',
        '  http:',
        '    dependency: "direct main"',
        '    version: "1.2.2"',
        '  provider:',
        '    version: "6.1.2"',
        'sdks:',
        '  dart: ">=3.0.0"',
      ].join('\n'),
    });
    expect(lockfileVersion(root, 'dart', 'http')).toBe('1.2.2');
    const v = resolveVersion(root, 'http');
    expect(v.served).toBe('1.2.2');
    expect(v.declared).toBe('^1.2.0');
  });
});

describe('lockfile↔installed mismatch alert (D13 / G8)', () => {
  it('flags a mismatch naming both versions and still serves the lockfile pin', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/react': { version: '18.2.0' } } }),
      'node_modules/react/package.json': JSON.stringify({ name: 'react', version: '18.3.1' }),
    });
    const v = resolveVersion(root, 'react');
    expect(v.served).toBe('18.2.0'); // lockfile-first
    expect(v.mismatch).toBeDefined();
    expect(v.mismatch?.lockfile).toBe('18.2.0');
    expect(v.mismatch?.installed).toBe('18.3.1');
    expect(v.mismatch?.note).toContain('18.2.0');
    expect(v.mismatch?.note).toContain('18.3.1');
  });

  it('does not flag a mismatch when lockfile and installed agree', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/react': { version: '18.2.0' } } }),
      'node_modules/react/package.json': JSON.stringify({ name: 'react', version: '18.2.0' }),
    });
    expect(resolveVersion(root, 'react').mismatch).toBeUndefined();
  });
});

describe('§4 MCP tool migration (resolve_library / library_docs)', () => {
  const libTool = (n: string) => TOOLS.find((t) => t.name === n)!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (n: string, args: Record<string, unknown>, root: string): any =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    libTool(n).handler(null as any, args, { root, local: true } as any);

  function fixture(): string {
    return project({
      'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/react': { version: '18.2.0' } } }),
      'node_modules/react/package.json': JSON.stringify({ name: 'react', version: '18.2.0' }),
      'node_modules/react/README.md': `# react\n${Array.from({ length: 80 }, (_, i) => `paragraph ${i}: useEffect cleanup and deps`).join('\n')}`,
    });
  }

  it('resolve_library accepts query (and name back-compat) and returns canonical fields', () => {
    const root = fixture();
    const r = call('resolve_library', { query: 'react' }, root);
    expect(r.targetId).toBe('react');
    expect(r.isInstalled).toBe(true);
    expect(r.resolvedVersion).toBe('18.2.0');
    expect(call('resolve_library', { name: 'react' }, root).resolvedVersion).toBe('18.2.0');
    expect(call('resolve_library', {}, root).error).toBe('bad_request');
  });

  it('library_docs honours verbosity budget and exposes content + docs alias', () => {
    const root = fixture();
    const r = call('library_docs', { query: 'react', verbosity: 'concise' }, root);
    expect(r.content).toBeTruthy();
    expect(r.docs).toBe(r.content);
    expect(r.metadata.verbosity).toBe('concise');
    expect(r.metadata.tokens).toBeLessThanOrEqual(1500);
  });

  it('library_docs: max_tokens overrides; tokens alias works; truncates', () => {
    const root = fixture();
    expect(call('library_docs', { name: 'react', max_tokens: 50 }, root).metadata.tokens).toBeLessThanOrEqual(50);
    expect(call('library_docs', { name: 'react', tokens: 50 }, root).metadata.tokens).toBeLessThanOrEqual(50);
  });

  it('library_docs returns not_found for an unknown, uninstalled library', () => {
    const root = project({ 'package.json': JSON.stringify({ dependencies: {} }) });
    expect(call('library_docs', { query: 'nope' }, root).error).toBe('not_found');
  });
});

describe('local-first installed-docs resolution (A.2.3)', () => {
  it('reads README from an installed npm package, version-correct', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { coollib: '^1.0.0' } }),
      'node_modules/coollib/package.json': JSON.stringify({ name: 'coollib', version: '1.2.3', description: 'd' }),
      'node_modules/coollib/README.md': '# coollib\nInstalled usage docs.',
    });
    const local = localPackageDocs(root, 'coollib');
    expect(local?.docs).toContain('Installed usage docs.');
    expect(local?.source).toBe('node_modules/coollib/README.md');
    expect(local?.version).toBe('1.2.3');
  });

  it('prefers llms.txt over README', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { x: '^1.0.0' } }),
      'node_modules/x/package.json': JSON.stringify({ name: 'x', version: '1.0.0' }),
      'node_modules/x/llms.txt': 'LLM-optimised docs',
      'node_modules/x/README.md': '# x readme',
    });
    expect(localPackageDocs(root, 'x')?.source).toBe('node_modules/x/llms.txt');
  });

  it('falls back to the package.json description when no README', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { y: '^1.0.0' } }),
      'node_modules/y/package.json': JSON.stringify({ name: 'y', version: '2.0.0', description: 'A tiny lib' }),
    });
    const local = localPackageDocs(root, 'y');
    expect(local?.docs).toContain('A tiny lib');
    expect(local?.source).toBe('node_modules/y/package.json');
  });

  it('returns undefined when the package is not installed', () => {
    const root = project({ 'package.json': JSON.stringify({ dependencies: { z: '^1.0.0' } }) });
    expect(localPackageDocs(root, 'z')).toBeUndefined();
  });

  it('resolves a scoped package', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { '@scope/pkg': '^1.0.0' } }),
      'node_modules/@scope/pkg/package.json': JSON.stringify({ name: '@scope/pkg', version: '1.0.0' }),
      'node_modules/@scope/pkg/README.md': '# scoped',
    });
    expect(localPackageDocs(root, '@scope/pkg')?.source).toBe('node_modules/@scope/pkg/README.md');
  });
});

describe('installed-tree cross-check beyond npm (D13 / G8)', () => {
  it('python: flags poetry.lock ↔ .dist-info mismatch (PEP 503 names)', () => {
    const root = project({
      'pyproject.toml': '[project]\nname = "app"\ndependencies = ["Flask-SQLAlchemy>=3.0"]\n',
      'poetry.lock': '[[package]]\nname = "flask-sqlalchemy"\nversion = "3.1.1"\n',
      // installed tree disagrees with the lock
      '.venv/lib/python3.12/site-packages/Flask_SQLAlchemy-3.0.5.dist-info/METADATA': 'Name: Flask-SQLAlchemy\n',
    });
    const v = resolveVersion(root, 'Flask-SQLAlchemy');
    expect(v.served).toBe('3.1.1'); // lockfile-first
    expect(v.installed).toBe('3.0.5'); // from .dist-info
    expect(v.mismatch?.lockfile).toBe('3.1.1');
    expect(v.mismatch?.installed).toBe('3.0.5');
  });

  it('php: flags composer.lock ↔ installed.json mismatch', () => {
    const root = project({
      'composer.json': JSON.stringify({ require: { 'monolog/monolog': '^3.0' } }),
      'composer.lock': JSON.stringify({ packages: [{ name: 'monolog/monolog', version: 'v3.5.0' }] }),
      'vendor/composer/installed.json': JSON.stringify({ packages: [{ name: 'monolog/monolog', version: 'v3.4.0' }] }),
    });
    const v = resolveVersion(root, 'monolog/monolog');
    expect(v.served).toBe('3.5.0');
    expect(v.installed).toBe('3.4.0');
    expect(v.mismatch).toBeDefined();
  });

  it('python: no mismatch when lock and .dist-info agree', () => {
    const root = project({
      'pyproject.toml': '[project]\nname = "app"\ndependencies = ["httpx>=0.27"]\n',
      'poetry.lock': '[[package]]\nname = "httpx"\nversion = "0.27.2"\n',
      '.venv/lib/python3.12/site-packages/httpx-0.27.2.dist-info/METADATA': 'Name: httpx\n',
    });
    expect(resolveVersion(root, 'httpx').mismatch).toBeUndefined();
  });
});

describe('symbol-level API extraction from .d.ts', () => {
  const dts = [
    '/** doc */',
    'export declare function add(a: number, b: number): number;',
    'export const VERSION: string;',
    'export interface Options {',
    '  retries: number;',
    '  cb: { fn: () => void };',
    '}',
    'export class Client {',
    '  constructor(opts: Options);',
    '  send(path: string): Promise<void>;',
    '}',
    'export type ID = string | number;',
    "export * from './re-export';",
    "export { foo } from './foo';",
    'export default Client;',
  ].join('\n');

  it('captures exported decls (function/const/interface/class/type) and skips re-exports', () => {
    const decls = extractDtsApi(dts);
    const joined = decls.join('\n---\n');
    expect(joined).toContain('export declare function add(a: number, b: number): number;');
    expect(joined).toContain('export const VERSION: string;');
    expect(joined).toContain('export interface Options {');
    expect(joined).toContain('send(path: string): Promise<void>;'); // class member, brace-matched
    expect(joined).toContain('export type ID = string | number;');
    // re-exports / default are excluded
    expect(joined).not.toContain("export * from");
    expect(joined).not.toContain('export { foo }');
    expect(joined).not.toContain('export default');
  });

  it('localApiSurface reads the package types entry and extracts the surface', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { coollib: '^1.0.0' } }),
      'node_modules/coollib/package.json': JSON.stringify({ name: 'coollib', version: '1.0.0', types: 'index.d.ts' }),
      'node_modules/coollib/index.d.ts': dts,
    });
    const api = localApiSurface(root, 'coollib');
    expect(api).toContain('export declare function add');
    expect(api).toContain('export class Client {');
  });

  it('returns undefined when the package ships no .d.ts', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { plain: '^1.0.0' } }),
      'node_modules/plain/package.json': JSON.stringify({ name: 'plain', version: '1.0.0' }),
      'node_modules/plain/README.md': '# plain',
    });
    expect(localApiSurface(root, 'plain')).toBeUndefined();
  });
});

describe('token-accurate truncation (D5 / G4)', () => {
  // Fine-grained short lines so line-snapping undershoots only marginally.
  const big = Array.from({ length: 400 }, (_, i) => `L${i}`).join('\n');

  it('counts tokens deterministically', () => {
    expect(countTokens('hello world')).toBe(countTokens('hello world'));
    expect(countTokens('')).toBe(0);
  });

  it('never exceeds the budget and lands close to it', () => {
    const budget = 100;
    const { text, truncated, tokens } = truncateToTokens(big, budget);
    expect(truncated).toBe(true);
    expect(tokens).toBeLessThanOrEqual(budget); // hard guarantee: never overflow
    expect(tokens).toBeGreaterThanOrEqual(Math.floor(budget * 0.9)); // close, given line snapping
    expect(countTokens(text)).toBe(tokens);
  });

  it('does not truncate when under budget', () => {
    const r = truncateToTokens('short text', 1000);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('short text');
  });

  it('snaps to a line boundary (no mid-line cut) and stays a real prefix', () => {
    const { text } = truncateToTokens(big, 50);
    const body = text.replace(/\n…\(truncated\)$/, '');
    expect(big.startsWith(body)).toBe(true);
  });

  it('is deterministic', () => {
    expect(truncateToTokens(big, 80).text).toBe(truncateToTokens(big, 80).text);
  });
});
