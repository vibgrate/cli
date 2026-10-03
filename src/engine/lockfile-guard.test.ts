import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGraph } from './build.js';
import { serializeGraph } from './serialize.js';
import { assertLockfilesValid, LockfileSyntaxError } from './lockfile-guard.js';

const parseState = vi.hoisted(() => ({ n: 0 }));

vi.mock('./pool.js', async () => {
  const actual = await vi.importActual<typeof import('./pool.js')>('./pool.js');
  return {
    ...actual,
    async parseFiles(...args: Parameters<typeof actual.parseFiles>): Promise<Awaited<ReturnType<typeof actual.parseFiles>>> {
      parseState.n++;
      return actual.parseFiles(...args);
    },
  };
});

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));
const PIN = '2020-01-01T00:00:00.000Z';
const SENTINEL = 'SENTINEL_LOCKFILE_BODY_9f3a2c';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function project(files: Record<string, string | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-lockguard-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const VALID_PACKAGE_LOCK = JSON.stringify({
  name: 'ok',
  lockfileVersion: 3,
  requires: true,
  packages: { '': { name: 'ok', version: '1.0.0' } },
});

const TRUNCATED_PACKAGE_LOCK = `{"name":"${SENTINEL}","lockfileVersion":3,"packages":{`;

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      timeout: 25_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    const text = (value: string | Buffer | undefined): string =>
      typeof value === 'string' ? value : value ? value.toString('utf8') : '';
    return { code: e.status ?? 1, stdout: text(e.stdout), stderr: text(e.stderr) };
  }
}

describe('assertLockfilesValid', () => {
  it('accepts this package\'s own lockfiles', () => {
    expect(() => assertLockfilesValid(REPO)).not.toThrow();
  });

  it('names a truncated package-lock.json and omits its contents', () => {
    const root = project({ 'package-lock.json': TRUNCATED_PACKAGE_LOCK });
    expect(() => assertLockfilesValid(root)).toThrow(LockfileSyntaxError);
    try {
      assertLockfilesValid(root);
    } catch (err) {
      expect(err).toBeInstanceOf(LockfileSyntaxError);
      const message = (err as Error).message;
      expect(message).toBe(
        'invalid lockfile package-lock.json: truncated or not valid syntax. Regenerate it with your package manager.',
      );
      expect(message).not.toContain(SENTINEL);
      expect(message).not.toContain('lockfileVersion');
    }
  });

  it('rejects a truncated pnpm-lock.yaml, yarn.lock, and Cargo.lock', () => {
    const pnpm = project({
      'pnpm-lock.yaml': `lockfileVersion: '9.0'\npackages:\n  ${SENTINEL}@1.0.0:\n    resolution: {integrity: sha512-dead\n`,
    });
    expect(() => assertLockfilesValid(pnpm)).toThrow(/pnpm-lock\.yaml/);

    const yarn = project({
      'yarn.lock': `# yarn lockfile v1\n${SENTINEL}@^1.0.0:\n  version "1.0.0\n`,
    });
    expect(() => assertLockfilesValid(yarn)).toThrow(/yarn\.lock/);

    const cargo = project({
      'Cargo.lock': `[[package]]\nname = "${SENTINEL}"\nversion = "1.0.0\n`,
    });
    expect(() => assertLockfilesValid(cargo)).toThrow(/Cargo\.lock/);
  });

  it('rejects garbage that is not a lockfile document', () => {
    const root = project({ 'pnpm-lock.yaml': `  not yaml at all ${SENTINEL}` });
    let message = '';
    try {
      assertLockfilesValid(root);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('pnpm-lock.yaml');
    expect(message).not.toContain(SENTINEL);
  });

  it('lists every bad lockfile in sorted path order', () => {
    const root = project({
      'b/pnpm-lock.yaml': '  not yaml at all',
      'a/package-lock.json': TRUNCATED_PACKAGE_LOCK,
    });
    expect(() => assertLockfilesValid(root)).toThrow(
      'invalid lockfile a/package-lock.json, b/pnpm-lock.yaml: truncated or not valid syntax. Regenerate it with your package manager.',
    );
  });

  it('accepts valid lockfiles and an empty go.sum', () => {
    const root = project({
      'package-lock.json': VALID_PACKAGE_LOCK,
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'yarn.lock': '# yarn lockfile v1\nleft-pad@^1.3.0:\n  version "1.3.0"\n',
      'Cargo.lock': 'version = 3\n\n[[package]]\nname = "memchr"\nversion = "2.7.4"\n',
      'go.sum': '',
      'gradle.lockfile': '# generated\nempty=\n',
      'Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rake (13.0.6)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  rake\n\nBUNDLED WITH\n   2.4.0\n',
      'bun.lockb': Buffer.from([0, 1, 2, 3]),
    });
    expect(() => assertLockfilesValid(root)).not.toThrow();
  });

  it('ignores a truncated lockfile that gitignore excludes', () => {
    const root = project({
      '.gitignore': 'scratch/\n',
      'scratch/package-lock.json': TRUNCATED_PACKAGE_LOCK,
      'package-lock.json': VALID_PACKAGE_LOCK,
    });
    expect(() => assertLockfilesValid(root)).not.toThrow();
  });
});

describe('vg scan / vg build', () => {
  it('stops buildGraph before source parse workers run', async () => {
    const root = project({
      'package-lock.json': TRUNCATED_PACKAGE_LOCK,
      'src/a.ts': 'export const a = 1;\n',
    });
    const before = parseState.n;
    await expect(buildGraph({ root, generatedAt: PIN, inline: true, noCache: true, noIndex: true })).rejects.toBeInstanceOf(
      LockfileSyntaxError,
    );
    expect(parseState.n).toBe(before);
    expect(fs.existsSync(path.join(root, '.vibgrate', 'graph.json'))).toBe(false);
  });

  it('builds the same graph when a valid lockfile is present', async () => {
    const files = {
      'package.json': '{"name":"ok","version":"1.0.0"}\n',
      'src/a.ts': 'export const a = 1;\n',
    };
    const plain = project(files);
    const locked = project({ ...files, 'package-lock.json': VALID_PACKAGE_LOCK });
    const opts = { generatedAt: PIN, inline: true, noCache: true, noIndex: true } as const;
    const before = parseState.n;
    const a = serializeGraph((await buildGraph({ root: plain, ...opts })).graph);
    const b = serializeGraph((await buildGraph({ root: locked, ...opts })).graph);
    expect(parseState.n).toBeGreaterThan(before);
    expect(b).toBe(a);
  });

  it('exits non-zero from vg scan and vg build without echoing the lockfile', () => {
    const root = project({
      'package.json': '{"name":"broken","version":"1.0.0"}\n',
      'package-lock.json': TRUNCATED_PACKAGE_LOCK,
      'src/a.ts': 'export const a = 1;\n',
    });
    const expected =
      'invalid lockfile package-lock.json: truncated or not valid syntax. Regenerate it with your package manager.';

    const scan = runCli(['--offline', 'scan', root, '--offline', '--quiet', '--no-daemon']);
    expect(scan.code).not.toBe(0);
    expect(scan.stderr).toContain(expected);
    expect(`${scan.stdout}\n${scan.stderr}`).not.toContain(SENTINEL);
    expect(fs.existsSync(path.join(root, '.vibgrate', 'scan_result.json'))).toBe(false);

    const build = runCli([
      '--offline',
      'build',
      '-C',
      root,
      '--offline',
      '--quiet',
      '--no-daemon',
      '--no-warm',
      '--no-html',
      '--no-report',
    ]);
    expect(build.code).not.toBe(0);
    expect(build.stderr).toContain(expected);
    expect(`${build.stdout}\n${build.stderr}`).not.toContain(SENTINEL);
    expect(fs.existsSync(path.join(root, '.vibgrate', 'graph.json'))).toBe(false);
  });

  it('still scans a project with a valid lockfile', () => {
    const root = project({
      'package.json': '{"name":"ok","version":"1.0.0"}\n',
      'package-lock.json': VALID_PACKAGE_LOCK,
      'index.js': 'module.exports = 1;\n',
    });
    const scan = runCli(['--offline', 'scan', root, '--offline', '--no-graph', '--quiet', '--no-daemon']);
    expect(scan.code).toBe(0);
    expect(`${scan.stdout}\n${scan.stderr}`).not.toContain('truncated or not valid syntax');
    expect(fs.existsSync(path.join(root, '.vibgrate', 'scan_result.json'))).toBe(true);
  });
});
