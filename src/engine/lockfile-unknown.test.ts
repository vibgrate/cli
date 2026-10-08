import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCargoLock } from '../core-open/scanners/cargo-lockfile.js';
import { parseGemfileLock } from '../core-open/scanners/gemfile-lock.js';
import { parseGradleLockfile } from '../core-open/scanners/gradle-lockfile.js';
import { parsePackageLock, parsePnpmLock, parseYarnLock } from '../core-open/scanners/npm-lockfile.js';
import { parsePipfileLock, parsePyTomlLock } from '../core-open/scanners/python-lockfile.js';
import { LockfileParseError, assertLockfileText } from '../core-open/utils/lockfile-parse.js';
import {
  LockfileUnknownFields,
  notePnpmLockText,
  resetUnknownOptionalLockfileWarnings,
} from '../core-open/utils/lockfile-unknown.js';
import { fullDependencyGraph, lockfileVersion } from './lockfile.js';

const SECRET = 'super-secret-token';
const WARN = (file: string, key: string) =>
  `${file}: unknown optional lockfile field "${key}"; continuing with the fields this version understands.`;

let root: string;
let stderr: string[];

beforeEach(() => {
  resetUnknownOptionalLockfileWarnings();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-lock-unknown-'));
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetUnknownOptionalLockfileWarnings();
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (name: string, body: string): void => fs.writeFileSync(path.join(root, name), body);

function warnings(): string[] {
  return stderr.map((line) => line.replace(/\n$/, '')).filter((line) => line.includes('unknown optional lockfile field'));
}

describe('lockfile unknown optional fields', () => {
  it('keeps an npm dependency set and warns once per unknown key, sorted', () => {
    const json = {
      lockfileVersion: 3,
      futureOptional: `Bearer ${SECRET}`,
      alphaField: true,
      packages: {
        '': { name: 'app', dependencies: { 'left-pad': '^1.3.0' } },
        'node_modules/left-pad': { version: '1.3.0', integrity: 'sha512-abc', futureOptional: SECRET },
        'node_modules/left-pad/node_modules/nested': { version: '9.9.9' },
      },
    };
    expect(parsePackageLock(json).get('left-pad')).toBe('1.3.0');
    expect(warnings()).toEqual([WARN('package-lock.json', 'alphaField'), WARN('package-lock.json', 'futureOptional')]);
    expect(warnings().join('\n')).not.toContain(SECRET);
    expect(warnings().join('\n')).not.toContain('Bearer');
    expect(warnings().join('\n')).not.toContain('sha512');

    warnings().splice(0, warnings().length);
    stderr.length = 0;
    parsePackageLock(json);
    expect(warnings()).toEqual([]);
  });

  it('keeps npm graph edges when a package entry has an unknown optional key', () => {
    write(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'app', dependencies: { chalk: '^5.3.0' } },
          'node_modules/chalk': { version: '5.3.0', dependencies: { 'ansi-styles': '^6.0.0' }, futureOptional: SECRET },
          'node_modules/ansi-styles': { version: '6.2.1', integrity: 'sha512-abc' },
        },
      }),
    );
    const graph = fullDependencyGraph(root);
    expect(graph?.components).toEqual([
      { package: 'ansi-styles', version: '6.2.1' },
      { package: 'chalk', version: '5.3.0' },
    ]);
    expect(graph?.edges?.get('chalk@5.3.0')).toEqual(['ansi-styles@6.2.1']);
    expect(warnings()).toEqual([WARN('package-lock.json', 'futureOptional')]);
    expect(warnings().join('\n')).not.toContain(SECRET);
  });

  it('keeps a pnpm importer pin and warns on one unknown top-level key', () => {
    const doc = {
      lockfileVersion: '9.0',
      futureOptional: SECRET,
      importers: {
        '.': { dependencies: { 'left-pad': { specifier: '^1.3.0', version: '1.3.0' } } },
      },
    };
    expect(parsePnpmLock(doc).get('left-pad')).toBe('1.3.0');
    expect(warnings()).toEqual([WARN('pnpm-lock.yaml', 'futureOptional')]);
    expect(warnings().join('\n')).not.toContain(SECRET);

    write(
      'pnpm-lock.yaml',
      [
        "lockfileVersion: '9.0'",
        `futureOptional: ${SECRET}`,
        'importers:',
        '  .:',
        '    dependencies:',
        '      left-pad:',
        '        specifier: ^1.3.0',
        '        version: 1.3.0',
        'packages:',
        '  left-pad@1.3.0:',
        '    resolution: {integrity: sha512-abc}',
      ].join('\n'),
    );
    resetUnknownOptionalLockfileWarnings();
    stderr.length = 0;
    const graph = fullDependencyGraph(root);
    expect(graph?.components).toEqual([{ package: 'left-pad', version: '1.3.0' }]);
    expect(lockfileVersion(root, 'npm', 'left-pad')).toBe('1.3.0');
    expect(warnings()).toEqual([WARN('pnpm-lock.yaml', 'futureOptional')]);
    expect(warnings().join('\n')).not.toContain(SECRET);
  });

  it('does not warn on a real pnpm-lock.yaml', () => {
    const lockPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../pnpm-lock.yaml');
    const text = fs.readFileSync(lockPath, 'utf8');
    const notes = new LockfileUnknownFields();
    notePnpmLockText(text, 'pnpm-lock.yaml', notes);
    expect(notes.messages()).toEqual([]);
  });

  it('keeps a yarn pin and warns on one unknown field', () => {
    const text = ['left-pad@^1.3.0:', '  version "1.3.0"', `  futureOptional "${SECRET}"`, ''].join('\n');
    expect(parseYarnLock(text).byName.get('left-pad')).toBe('1.3.0');
    expect(warnings()).toEqual([WARN('yarn.lock', 'futureOptional')]);
    expect(warnings().join('\n')).not.toContain(SECRET);

    write('yarn.lock', text);
    resetUnknownOptionalLockfileWarnings();
    stderr.length = 0;
    expect(fullDependencyGraph(root)?.components).toEqual([{ package: 'left-pad', version: '1.3.0' }]);
    expect(warnings()).toEqual([WARN('yarn.lock', 'futureOptional')]);
  });

  it('keeps poetry, uv, and Pipfile pins and warns on one unknown key', () => {
    const poetry = ['[[package]]', 'name = "click"', 'version = "8.1.3"', `futureOptional = "${SECRET}"`, ''].join('\n');
    expect(parsePyTomlLock(poetry, 'poetry.lock', undefined, 'poetry').get('click')).toBe('8.1.3');
    expect(warnings()).toEqual([WARN('poetry.lock', 'futureOptional')]);
    expect(warnings().join('\n')).not.toContain(SECRET);

    write('poetry.lock', poetry);
    resetUnknownOptionalLockfileWarnings();
    stderr.length = 0;
    expect(fullDependencyGraph(root)?.components).toEqual([{ package: 'click', version: '8.1.3' }]);
    expect(warnings()).toEqual([WARN('poetry.lock', 'futureOptional')]);

    const uv = ['version = 1', '[[package]]', 'name = "httpx"', 'version = "0.27.0"', 'futureOptional = "1"', ''].join('\n');
    expect(parsePyTomlLock(uv, 'uv.lock', undefined, 'uv').get('httpx')).toBe('0.27.0');

    const pip = {
      _meta: { hash: { sha256: 'abc' } },
      default: { requests: { version: '==2.31.0', futureOptional: SECRET } },
      develop: {},
    };
    resetUnknownOptionalLockfileWarnings();
    stderr.length = 0;
    expect(parsePipfileLock(pip).get('requests')).toBe('2.31.0');
    expect(warnings()).toEqual([WARN('Pipfile.lock', 'futureOptional')]);
    expect(warnings().join('\n')).not.toContain(SECRET);
  });

  it('keeps a Cargo pin and warns on one unknown package key', () => {
    const text = ['version = 4', '[[package]]', 'name = "serde"', 'version = "1.0.203"', `futureOptional = "${SECRET}"`, ''].join('\n');
    expect(parseCargoLock(text).get('serde')).toEqual(['1.0.203']);
    expect(warnings()).toEqual([WARN('Cargo.lock', 'futureOptional')]);
    expect(warnings().join('\n')).not.toContain(SECRET);

    write('Cargo.lock', text);
    resetUnknownOptionalLockfileWarnings();
    stderr.length = 0;
    expect(fullDependencyGraph(root)?.components).toEqual([{ package: 'serde', version: '1.0.203' }]);
    expect(warnings()).toEqual([WARN('Cargo.lock', 'futureOptional')]);
  });

  it('keeps composer, NuGet, Swift, and pub pins and warns on one unknown key', () => {
    write(
      'composer.lock',
      JSON.stringify({
        'content-hash': 'abc',
        futureOptional: SECRET,
        packages: [{ name: 'symfony/console', version: 'v7.1.0', description: 'cli' }],
      }),
    );
    expect(lockfileVersion(root, 'php', 'symfony/console')).toBe('7.1.0');
    expect(warnings()).toEqual([WARN('composer.lock', 'futureOptional')]);
    expect(warnings().join('\n')).not.toContain(SECRET);

    fs.rmSync(path.join(root, 'composer.lock'));
    resetUnknownOptionalLockfileWarnings();
    stderr.length = 0;
    write(
      'packages.lock.json',
      JSON.stringify({
        version: 1,
        futureOptional: true,
        dependencies: { 'net8.0': { 'Newtonsoft.Json': { type: 'Direct', resolved: '13.0.3' } } },
      }),
    );
    expect(lockfileVersion(root, 'dotnet', 'Newtonsoft.Json')).toBe('13.0.3');
    expect(warnings()).toEqual([WARN('packages.lock.json', 'futureOptional')]);

    fs.rmSync(path.join(root, 'packages.lock.json'));
    resetUnknownOptionalLockfileWarnings();
    stderr.length = 0;
    write(
      'Package.resolved',
      JSON.stringify({
        version: 3,
        futureOptional: true,
        pins: [{ identity: 'vapor', state: { version: '4.89.0' } }],
      }),
    );
    expect(lockfileVersion(root, 'swift', 'vapor')).toBe('4.89.0');
    expect(warnings()).toEqual([WARN('Package.resolved', 'futureOptional')]);

    fs.rmSync(path.join(root, 'Package.resolved'));
    resetUnknownOptionalLockfileWarnings();
    stderr.length = 0;
    write(
      'pubspec.lock',
      [
        'packages:',
        '  provider:',
        '    dependency: "direct main"',
        '    version: "6.1.2"',
        '    futureOptional: true',
        'sdks:',
        '  dart: ">=3.0.0 <4.0.0"',
      ].join('\n'),
    );
    expect(lockfileVersion(root, 'dart', 'provider')).toBe('6.1.2');
    expect(warnings()).toEqual([WARN('pubspec.lock', 'futureOptional')]);
  });

  it('omits a field name that is not a plain identifier and does not print its text', () => {
    const notes = new LockfileUnknownFields();
    notes.note('package-lock.json', `Authorization: Bearer ${SECRET}`);
    expect(notes.messages()).toEqual([
      'package-lock.json: unknown optional lockfile field (name omitted); continuing with the fields this version understands.',
    ]);
    expect(notes.messages().join('\n')).not.toContain(SECRET);
    expect(notes.messages().join('\n')).not.toContain('Bearer');
    expect(notes.messages().join('\n')).not.toContain('Authorization');
  });

  it('keeps Gradle and Gemfile rows when optional commentary is present, without a field warning', () => {
    const gradle = '# generated\ncom.google.guava:guava:31.1-jre=compileClasspath\nempty=annotationProcessor\n';
    expect(parseGradleLockfile(gradle).get('com.google.guava:guava')).toBe('31.1-jre');
    write('gradle.lockfile', gradle);
    expect(lockfileVersion(root, 'java', 'com.google.guava:guava')).toBe('31.1-jre');

    const gem = ['GEM', '  remote: https://rubygems.org/', '  specs:', '    rails (7.1.2)', 'FUTURE_OPTIONAL', '  note: true', ''].join('\n');
    expect(parseGemfileLock(gem).get('rails')).toBe('7.1.2');
    write('Gemfile.lock', gem);
    fs.rmSync(path.join(root, 'gradle.lockfile'));
    expect(lockfileVersion(root, 'ruby', 'rails')).toBe('7.1.2');
    expect(warnings()).toEqual([]);
  });

  it('still fails closed when required lockfile structure is broken, without echoing contents', () => {
    const cases: Array<[string, string, string]> = [
      ['package-lock.json', `{"packages":{"node_modules/left-pad":{"version":"1.3.0","integrity":"${SECRET}"`, 'JSON'],
      ['pnpm-lock.yaml', `lockfileVersion: '9.0'\npackages:\n  left-pad@1.3.0:\n    resolution: {integrity: ${SECRET}`, 'YAML'],
      ['Cargo.lock', `[[package]]\nname = "serde"\nversion = "${SECRET}`, 'TOML'],
      ['yarn.lock', `"left-pad@^1.3.0":\n  futureOptional "${SECRET}"\n`, 'yarn.lock'],
      ['gradle.lockfile', `not a lock line ${SECRET}\n`, 'gradle.lockfile'],
      ['Gemfile.lock', `    rails (${SECRET}\n`, 'Gemfile.lock'],
      ['go.sum', `github.com/gin-contrib/sse v1.1.0 ${SECRET}\n`, 'go.sum'],
    ];
    for (const [file, body, kind] of cases) {
      write(file, body);
      expect(() => assertLockfileText(path.join(root, file), body, kind as 'JSON'), file).toThrow(LockfileParseError);
      try {
        assertLockfileText(path.join(root, file), body, kind as 'JSON');
      } catch (err) {
        const message = (err as Error).message;
        expect(message, file).toContain(file);
        expect(message, file).toContain('package manager');
        expect(message, file).not.toContain(SECRET);
      }
      fs.rmSync(path.join(root, file));
    }
    expect(warnings()).toEqual([]);
  });
});
