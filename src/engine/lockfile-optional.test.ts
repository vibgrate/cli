import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LockfileParseError } from '../core-open/utils/lockfile-parse.js';
import { parseCargoLock } from '../core-open/scanners/cargo-lockfile.js';
import { parseGemfileLock } from '../core-open/scanners/gemfile-lock.js';
import { parseGradleLockfile } from '../core-open/scanners/gradle-lockfile.js';
import { parsePackageLock, parsePnpmLock, parseYarnLock } from '../core-open/scanners/npm-lockfile.js';
import { parsePipfileLock, parsePyTomlLock } from '../core-open/scanners/python-lockfile.js';
import {
  parseComposerLock,
  parseMixLock,
  parseNpmLockfile,
  parseNugetLock,
  parsePipfileLock as parseTimelinePipfile,
  parsePnpmLockfile,
  parsePubspecLock,
  parseTomlPackages,
  parseYarnLockfile,
} from '../core-open/utils/version-timeline.js';
import { discover } from './discover.js';
import { fullDependencyGraph, lockfileVersion } from './lockfile.js';
import {
  formatUnknownOptionalFieldWarnings,
  unknownOptionalFieldWarning,
  unknownOptionalLockfileKeys,
} from './lockfile-optional.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'Bearer npm_AAAAAAAAAAAAAAAAAAAA';

function captureStderr(run: () => void): { stderr: string; error?: unknown } {
  let stderr = '';
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
    return { stderr };
  } catch (error) {
    return { stderr, error };
  } finally {
    process.stderr.write = write;
  }
}

describe('unknown optional lockfile fields', () => {
  let root: string;
  const token = 'super-secret-token';
  const previousToken = process.env.NPM_TOKEN;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-lock-optional-'));
    process.env.NPM_TOKEN = token;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previousToken;
  });

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };

  it('formats one sorted warning per key and leaves values out of the line', () => {
    const line = unknownOptionalFieldWarning('pnpm-lock.yaml', 'catalogs');
    expect(line).toBe(
      'warning: pnpm-lock.yaml: unknown optional lockfile field "catalogs"; kept the dependencies this file already resolved',
    );
    expect(formatUnknownOptionalFieldWarnings('package-lock.json', ['zebraOptional', 'alphaOptional', 'alphaOptional'])).toEqual([
      unknownOptionalFieldWarning('package-lock.json', 'alphaOptional'),
      unknownOptionalFieldWarning('package-lock.json', 'zebraOptional'),
    ]);
    expect(formatUnknownOptionalFieldWarnings('package-lock.json', ['ok', 'Bearer secret', 'a b'])).toEqual([
      unknownOptionalFieldWarning('package-lock.json', 'ok'),
    ]);
  });

  it('keeps an npm dependency set and warns once for a repeated unknown key', () => {
    write(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        futureOptional: SECRET,
        packages: {
          '': { name: 'app' },
          'node_modules/left-pad': { version: '1.3.0', devEngines: { runtime: { name: 'node' } }, integrity: SECRET },
          'node_modules/chalk': { version: '5.3.0', devEngines: { cpu: 'x64' } },
        },
      }),
    );
    const first = captureStderr(() => {
      expect(fullDependencyGraph(root)?.components).toEqual([
        { package: 'chalk', version: '5.3.0' },
        { package: 'left-pad', version: '1.3.0' },
      ]);
    });
    expect(first.error).toBeUndefined();
    expect(first.stderr).toBe(
      [
        unknownOptionalFieldWarning('package-lock.json', 'devEngines'),
        unknownOptionalFieldWarning('package-lock.json', 'futureOptional'),
        '',
      ].join('\n'),
    );
    expect(first.stderr).not.toContain(SECRET);
    expect(first.stderr).not.toContain(token);
    expect(first.stderr).not.toContain(root);
    expect(first.stderr).not.toContain('left-pad');
    const second = captureStderr(() => fullDependencyGraph(root));
    expect(second.stderr).toBe('');
  });

  it('keeps a pnpm catalog lockfile and warns for the unknown catalogs key', () => {
    const body = [
      "lockfileVersion: '9.0'",
      'catalogs:',
      '  default:',
      '    left-pad:',
      "      specifier: '^1.3.0'",
      '      version: 1.3.0',
      'importers:',
      '  .:',
      '    dependencies:',
      '      left-pad:',
      "        specifier: 'catalog:'",
      '        version: 1.3.0',
      'packages:',
      '  left-pad@1.3.0:',
      '    resolution: {integrity: sha512-abc}',
      '',
    ].join('\n');
    write('pnpm-lock.yaml', body);
    const captured = captureStderr(() => {
      expect(fullDependencyGraph(root)?.components).toEqual([{ package: 'left-pad', version: '1.3.0' }]);
      expect(lockfileVersion(root, 'npm', 'left-pad')).toBe('1.3.0');
    });
    expect(captured.error).toBeUndefined();
    expect(captured.stderr).toBe(`${unknownOptionalFieldWarning('pnpm-lock.yaml', 'catalogs')}\n`);
    expect(captured.stderr).not.toContain(SECRET);
  });

  it('keeps yarn, cargo, and poetry rows when one optional key is unknown', () => {
    write('yarn.lock', ['left-pad@^1.3.0:', '  version "1.3.0"', '  futureOptional true', ''].join('\n'));
    const yarn = captureStderr(() => {
      expect(fullDependencyGraph(root)?.components).toEqual([{ package: 'left-pad', version: '1.3.0' }]);
    });
    expect(yarn.stderr).toBe(`${unknownOptionalFieldWarning('yarn.lock', 'futureOptional')}\n`);

    fs.rmSync(path.join(root, 'yarn.lock'));
    write('Cargo.lock', ['[[package]]', 'name = "memchr"', 'version = "2.7.4"', 'futureOptional = "kept"', ''].join('\n'));
    const cargo = captureStderr(() => {
      expect(fullDependencyGraph(root)?.components).toEqual([{ package: 'memchr', version: '2.7.4' }]);
    });
    expect(cargo.stderr).toBe(`${unknownOptionalFieldWarning('Cargo.lock', 'futureOptional')}\n`);

    fs.rmSync(path.join(root, 'Cargo.lock'));
    write('poetry.lock', ['[[package]]', 'name = "click"', 'version = "8.1.3"', 'futureOptional = "kept"', ''].join('\n'));
    const poetry = captureStderr(() => {
      expect(fullDependencyGraph(root)?.components).toEqual([{ package: 'click', version: '8.1.3' }]);
    });
    expect(poetry.stderr).toBe(`${unknownOptionalFieldWarning('poetry.lock', 'futureOptional')}\n`);
    expect(poetry.stderr).not.toContain('click');
  });

  it('warns for other ecosystems and still returns the locked version', () => {
    const cases: Array<{ file: string; body: string; ecosystem: 'php' | 'pypi' | 'dart' | 'dotnet' | 'swift' | 'ruby'; name: string; version: string }> = [
      {
        file: 'composer.lock',
        ecosystem: 'php',
        name: 'monolog/monolog',
        version: '3.5.0',
        body: JSON.stringify({
          futureOptional: SECRET,
          packages: [{ name: 'monolog/monolog', version: '3.5.0' }],
        }),
      },
      {
        file: 'Pipfile.lock',
        ecosystem: 'pypi',
        name: 'requests',
        version: '2.31.0',
        body: JSON.stringify({
          futureOptional: true,
          default: { requests: { version: '==2.31.0' } },
        }),
      },
      {
        file: 'pubspec.lock',
        ecosystem: 'dart',
        name: 'http',
        version: '1.2.0',
        body: ['packages:', '  http:', '    version: "1.2.0"', '    futureOptional: true', ''].join('\n'),
      },
      {
        file: 'packages.lock.json',
        ecosystem: 'dotnet',
        name: 'Newtonsoft.Json',
        version: '13.0.3',
        body: JSON.stringify({
          version: 1,
          futureOptional: true,
          dependencies: { 'net8.0': { 'Newtonsoft.Json': { resolved: '13.0.3' } } },
        }),
      },
      {
        file: 'Package.resolved',
        ecosystem: 'swift',
        name: 'vapor',
        version: '4.89.0',
        body: JSON.stringify({
          version: 3,
          futureOptional: true,
          pins: [{ identity: 'vapor', state: { version: '4.89.0' } }],
        }),
      },
      {
        file: 'Gemfile.lock',
        ecosystem: 'ruby',
        name: 'rake',
        version: '13.0.6',
        body: ['GEM', '  remote: https://rubygems.org/', '  specs:', '    rake (13.0.6)', 'FUTURE', ''].join('\n'),
      },
    ];
    for (const item of cases) {
      write(item.file, item.body);
      const captured = captureStderr(() => {
        expect(lockfileVersion(root, item.ecosystem, item.name)).toBe(item.version);
      });
      const key = item.file === 'Gemfile.lock' ? 'FUTURE' : 'futureOptional';
      expect(captured.stderr, item.file).toBe(`${unknownOptionalFieldWarning(item.file, key)}\n`);
      expect(captured.stderr, item.file).not.toContain(SECRET);
      expect(captured.stderr, item.file).not.toContain(token);
      fs.rmSync(path.join(root, item.file));
    }
  });

  it('does not warn when the lockfile has no resolved package', () => {
    write('package-lock.json', JSON.stringify({ lockfileVersion: 3, futureOptional: true, packages: {} }));
    const captured = captureStderr(() => {
      expect(fullDependencyGraph(root)).toBeUndefined();
    });
    expect(captured.stderr).toBe('');
    expect(unknownOptionalLockfileKeys('package-lock.json', fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))).toEqual([]);
  });

  it('fails closed on broken required structure and does not warn', () => {
    write('package-lock.json', `{"lockfileVersion":3,"futureOptional":true,"packages":{"node_modules/left-pad":{"version":"1.0.0","integrity":"${SECRET}"`);
    const npm = captureStderr(() => {
      fullDependencyGraph(root);
    });
    expect(npm.error).toBeInstanceOf(LockfileParseError);
    expect((npm.error as Error).message).toContain('truncated or invalid JSON');
    expect(npm.stderr).toBe('');
    expect(npm.stderr).not.toContain(SECRET);

    fs.rmSync(path.join(root, 'package-lock.json'));
    write('gradle.lockfile', 'com.example:lib:1.2.3=runtimeClasspath\nthis is not a lock line\n');
    const gradle = captureStderr(() => {
      lockfileVersion(root, 'java', 'com.example:lib');
    });
    expect(gradle.error).toBeInstanceOf(LockfileParseError);
    expect((gradle.error as Error).message).toContain('truncated or invalid gradle.lockfile');
    expect(gradle.stderr).not.toContain('unknown optional');

    fs.rmSync(path.join(root, 'gradle.lockfile'));
    write('go.sum', 'github.com/gin-gonic/gin v1.9.0 h1:abc=\nnot-a-sum-line\n');
    const go = captureStderr(() => {
      fullDependencyGraph(root);
    });
    expect(go.error).toBeInstanceOf(LockfileParseError);
    expect((go.error as Error).message).toContain('truncated or invalid go.sum');
    expect(go.stderr).not.toContain('unknown optional');
  });

  it('keeps a valid gradle pin with no optional-key warning', () => {
    write('gradle.lockfile', '# generated\ncom.example:lib:1.2.3=runtimeClasspath\nempty=\n');
    const captured = captureStderr(() => {
      expect(lockfileVersion(root, 'java', 'com.example:lib')).toBe('1.2.3');
    });
    expect(captured.stderr).toBe('');
  });

  it('discover keeps source files, warns in path order, and still rejects a truncated lockfile', () => {
    write('app.ts', 'export const n = 1;\n');
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/left-pad': { version: '1.3.0' } },
      futureOptional: true,
    });
    write('a/package-lock.json', lock);
    write('b/package-lock.json', lock);
    const ok = captureStderr(() => {
      const files = discover({ root });
      expect(files.map((file) => file.rel)).toEqual(['app.ts']);
    });
    expect(ok.stderr).toBe(
      [
        unknownOptionalFieldWarning('a/package-lock.json', 'futureOptional'),
        unknownOptionalFieldWarning('b/package-lock.json', 'futureOptional'),
        '',
      ].join('\n'),
    );

    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-lock-optional-'));
    try {
      fs.writeFileSync(path.join(broken, 'package-lock.json'), '{"packages":{');
      fs.writeFileSync(path.join(broken, 'app.ts'), 'export const n = 1;\n');
      const failed = captureStderr(() => {
        discover({ root: broken });
      });
      expect(failed.error).toBeInstanceOf(LockfileParseError);
      expect(failed.stderr).toBe('');
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }
  });

  it('does not treat current lockfiles in this repository as unknown', () => {
    const pnpm = fs.readFileSync(path.join(pkgRoot, 'pnpm-lock.yaml'), 'utf8');
    expect(unknownOptionalLockfileKeys('pnpm-lock.yaml', pnpm)).toEqual([]);
    const npmLock = fs.readFileSync(path.join(pkgRoot, 'packages/test-solutions/package-lock.json'), 'utf8');
    expect(unknownOptionalLockfileKeys('package-lock.json', npmLock)).toEqual([]);
  });

  it('scanner readers keep the resolved row when an optional key is unknown', () => {
    const npm = JSON.stringify({
      lockfileVersion: 3,
      futureOptional: true,
      packages: { 'node_modules/left-pad': { version: '1.3.0', devEngines: { runtime: 'node' } } },
    });
    expect(parsePackageLock(JSON.parse(npm)).get('left-pad')).toBe('1.3.0');
    expect(parseNpmLockfile(npm).get('left-pad')).toBe('1.3.0');

    const pnpmDoc = {
      lockfileVersion: '9.0',
      catalogs: { default: { 'left-pad': { version: '1.3.0' } } },
      importers: { '.': { dependencies: { 'left-pad': { specifier: 'catalog:', version: '1.3.0' } } } },
    };
    expect(parsePnpmLock(pnpmDoc).get('left-pad')).toBe('1.3.0');
    const pnpmText = [
      "lockfileVersion: '9.0'",
      'catalogs:',
      '  default:',
      '    left-pad:',
      '      version: 1.3.0',
      'packages:',
      '  left-pad@1.3.0:',
      '    resolution: {integrity: sha512-abc}',
      '',
    ].join('\n');
    expect(parsePnpmLockfile(pnpmText).get('left-pad')).toBe('1.3.0');

    const yarn = ['left-pad@^1.3.0:', '  version "1.3.0"', '  futureOptional true', ''].join('\n');
    expect(parseYarnLock(yarn).byName.get('left-pad')).toBe('1.3.0');
    expect(parseYarnLockfile(yarn).get('left-pad')).toBe('1.3.0');

    const cargo = ['[[package]]', 'name = "memchr"', 'version = "2.7.4"', 'futureOptional = "kept"', ''].join('\n');
    expect(parseCargoLock(cargo).get('memchr')).toEqual(['2.7.4']);
    expect(parseTomlPackages(cargo).get('memchr')).toBe('2.7.4');
    expect(parsePyTomlLock(cargo).get('memchr')).toBe('2.7.4');

    const pip = JSON.stringify({ futureOptional: true, default: { requests: { version: '==2.31.0', hashes: ['abc'] } } });
    expect(parsePipfileLock(JSON.parse(pip)).get('requests')).toBe('2.31.0');
    expect(parseTimelinePipfile(pip).get('requests')).toBe('2.31.0');

    expect(parseGradleLockfile('# comment\ncom.example:lib:1.2.3=runtimeClasspath\nempty=\n').get('com.example:lib')).toBe('1.2.3');
    const gem = ['GEM', '  specs:', '    rake (13.0.6)', 'FUTURE', '  extra: 1', ''].join('\n');
    expect(parseGemfileLock(gem).get('rake')).toBe('13.0.6');

    const composer = JSON.stringify({ futureOptional: true, packages: [{ name: 'monolog/monolog', version: 'v3.5.0', extra: {} }] });
    expect(parseComposerLock(composer).get('monolog/monolog')).toBe('3.5.0');

    const pub = ['packages:', '  http:', '    futureOptional: true', '    version: "1.2.0"', ''].join('\n');
    expect(parsePubspecLock(pub).get('http')).toBe('1.2.0');

    const nuget = JSON.stringify({
      version: 2,
      futureOptional: true,
      dependencies: { 'net8.0': { 'Newtonsoft.Json': { resolved: '13.0.3', contentHash: 'abc' } } },
    });
    expect(parseNugetLock(nuget).get('Newtonsoft.Json')).toBe('13.0.3');

    const mix = '"decimal" => {:hex, :decimal, "2.1.1", "extra-field", [:mix], "hexpm", "abc"},\n';
    expect(parseMixLock(mix).get('decimal')).toBe('2.1.1');
  });
});
