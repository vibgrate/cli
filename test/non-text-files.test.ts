import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCoreScan } from '../src/core-open/index.js';
import { FileCache, readJsonFile, readTextFile } from '../src/core-open/utils/fs.js';
import { LockfileParseError } from '../src/core-open/utils/lockfile-parse.js';
import {
  formatNonTextWarning,
  inspectUtf8,
  NON_TEXT_NOTICE_CAP,
  NonTextFileError,
} from '../src/core-open/utils/text-bytes.js';
import { buildGraph } from '../src/engine/build.js';
import { discover } from '../src/engine/discover.js';
import { serializeGraph } from '../src/engine/serialize.js';
import { cleanup } from './helpers.js';

const PIN = '2020-01-01T00:00:00.000Z';
const BLOB_SECRET = 'ghp_BINARYBLOBSECRET0123456789';
const NOTES_SECRET = 'sk-NONUTF8SECRETVALUE';
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(pkgRoot, 'test/fixtures/binary-non-utf8');
const cli = path.join(pkgRoot, 'src/cli.ts');

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-non-text-'));
  dirs.push(dir);
  return dir;
}

/** Project with a binary `.ts`, a non-UTF-8 `.md`, and the same blob as compose. */
function nonTextProject(): string {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/ok.ts'), 'export function kept(){ return 1 }\n');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'non-text-fixture', version: '1.0.0' }) + '\n',
  );
  fs.copyFileSync(path.join(fixtureDir, 'blob.ts'), path.join(root, 'blob.ts'));
  fs.copyFileSync(path.join(fixtureDir, 'notes.md'), path.join(root, 'notes.md'));
  fs.copyFileSync(path.join(fixtureDir, 'blob.ts'), path.join(root, 'docker-compose.yml'));
  return root;
}

function nonTextWarning(result: { codedWarnings: { code: string; message: string }[] }): string {
  const hits = result.codedWarnings.filter((warning) => warning.code === 'VG_WARN_NON_TEXT_FILE');
  expect(hits).toHaveLength(1);
  return hits[0]!.message;
}

function assertNoSecrets(text: string): void {
  expect(text).not.toContain(BLOB_SECRET);
  expect(text).not.toContain(NOTES_SECRET);
  expect(text).not.toContain('ghp_');
  expect(text).not.toContain('sk-NONUTF8');
}

describe('inspectUtf8', () => {
  it('accepts UTF-8, including empty text and a BOM', () => {
    expect(inspectUtf8(Buffer.from(''))).toEqual({ ok: true, text: '' });
    expect(inspectUtf8(Buffer.from('kept'))).toEqual({ ok: true, text: 'kept' });
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a')]);
    expect(inspectUtf8(bom)).toEqual({ ok: true, text: '\uFEFFa' });
  });

  it('rejects a NUL as binary and invalid UTF-8 that has no NUL', () => {
    const binary = inspectUtf8(Buffer.from([0x68, 0x00, 0x69]));
    expect(binary).toEqual({ ok: false, reason: 'binary' });
    const nonUtf8 = inspectUtf8(Buffer.from([0xff, 0xfe, 0x80]));
    expect(nonUtf8).toEqual({ ok: false, reason: 'non-utf8' });
  });

  it('names skipped paths in one warning and never the bytes', () => {
    expect(formatNonTextWarning([])).toBeNull();
    const paths = ['notes.md', 'blob.ts', 'notes.md', 'c.ts', 'a.ts', 'b.ts', 'd.ts', 'e.ts'];
    const message = formatNonTextWarning(paths);
    expect(NON_TEXT_NOTICE_CAP).toBe(5);
    expect(message).toBe(
      'skipped 7 files that are binary or not UTF-8 (a.ts, b.ts, blob.ts, c.ts, d.ts, +2 more). ' +
        'Leave them out with a .gitignore entry, or pass --exclude.',
    );
    expect(formatNonTextWarning(['blob.ts'])).toBe(
      'skipped 1 file that is binary or not UTF-8 (blob.ts). Leave it out with a .gitignore entry, or pass --exclude.',
    );
    assertNoSecrets(message ?? '');
  });
});

describe('binary and non-UTF-8 files', () => {
  it('vg build skips them, keeps text, and repeats the same warning', async () => {
    const root = nonTextProject();
    const build = () =>
      buildGraph({
        root,
        generatedAt: PIN,
        inline: true,
        noCache: true,
        noIndex: true,
      });
    const first = await build();
    const second = await build();
    const message = nonTextWarning(first);
    expect(message).toBe(
      'skipped 3 files that are binary or not UTF-8 (blob.ts, docker-compose.yml, notes.md). ' +
        'Leave them out with a .gitignore entry, or pass --exclude.',
    );
    expect(nonTextWarning(second)).toBe(message);
    expect(first.graph.nodes.some((node) => node.qualifiedName === 'kept')).toBe(true);
    const rendered = serializeGraph(first.graph) + '\n' + first.warnings.join('\n');
    expect(serializeGraph(second.graph)).toBe(serializeGraph(first.graph));
    assertNoSecrets(rendered);
    expect(rendered).not.toContain('\u0000');
  });

  it('a cached build still skips them and matches the cold graph', async () => {
    const root = nonTextProject();
    const cold = await buildGraph({ root, generatedAt: PIN, inline: true, noCache: true, noIndex: true });
    const warm = await buildGraph({ root, generatedAt: PIN, inline: true, noCache: false, noIndex: true });
    const again = await buildGraph({ root, generatedAt: PIN, inline: true, noCache: false, noIndex: true });
    expect(nonTextWarning(warm)).toBe(nonTextWarning(cold));
    expect(nonTextWarning(again)).toBe(nonTextWarning(cold));
    expect(serializeGraph(warm.graph)).toBe(serializeGraph(cold.graph));
    expect(serializeGraph(again.graph)).toBe(serializeGraph(cold.graph));
  });

  it('gitignore and --exclude drop the named file from the warning', async () => {
    const ignored = nonTextProject();
    fs.writeFileSync(path.join(ignored, '.gitignore'), 'blob.ts\n');
    const byIgnore = await buildGraph({
      root: ignored,
      generatedAt: PIN,
      inline: true,
      noCache: true,
      noIndex: true,
    });
    expect(nonTextWarning(byIgnore)).toBe(
      'skipped 2 files that are binary or not UTF-8 (docker-compose.yml, notes.md). ' +
        'Leave them out with a .gitignore entry, or pass --exclude.',
    );

    const excluded = nonTextProject();
    const byFlag = await buildGraph({
      root: excluded,
      generatedAt: PIN,
      inline: true,
      noCache: true,
      noIndex: true,
      exclude: ['blob.ts'],
    });
    expect(nonTextWarning(byFlag)).toBe(nonTextWarning(byIgnore));
  });

  it('a text project has no non-text warning', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'ok.ts'), 'export function kept(){ return 1 }\n');
    const result = await buildGraph({ root, generatedAt: PIN, inline: true, noCache: true, noIndex: true });
    expect(result.codedWarnings.some((warning) => warning.code === 'VG_WARN_NON_TEXT_FILE')).toBe(false);
    expect(result.graph.nodes.some((node) => node.qualifiedName === 'kept')).toBe(true);
  });

  it('a binary lockfile fails closed and does not echo its bytes', () => {
    const root = tempDir();
    fs.copyFileSync(path.join(fixtureDir, 'blob.ts'), path.join(root, 'package-lock.json'));
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const n = 1;\n');
    let caught: unknown;
    try {
      discover({ root });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockfileParseError);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain('package-lock.json');
    expect(message).toContain('binary or not UTF-8');
    expect(message).toContain('.gitignore');
    expect(message).toContain('--exclude');
    assertNoSecrets(message);
  });

  it('readers skip non-text and fail a binary lockfile without its bytes', async () => {
    const root = nonTextProject();
    const cache = new FileCache();
    await cache.walkDir(root);
    expect(await cache.readTextFile(path.join(root, 'docker-compose.yml'))).toBe('');
    expect(await readTextFile(path.join(root, 'notes.md'))).toBe('');
    expect(cache.skippedNonTextFiles).toContain('docker-compose.yml');
    await expect(cache.readJsonFile(path.join(root, 'blob.ts'))).rejects.toBeInstanceOf(NonTextFileError);
    await expect(readJsonFile(path.join(root, 'blob.ts'))).rejects.toBeInstanceOf(NonTextFileError);
    const lock = path.join(root, 'package-lock.json');
    fs.copyFileSync(path.join(fixtureDir, 'blob.ts'), lock);
    await expect(readTextFile(lock)).rejects.toBeInstanceOf(LockfileParseError);
    try {
      await cache.readTextFile(lock);
    } catch (err) {
      expect(err).toBeInstanceOf(LockfileParseError);
      assertNoSecrets(err instanceof Error ? err.message : String(err));
    }
  });

  it('vg scan records one warning and does not put the bytes in the result', async () => {
    const root = nonTextProject();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(' '));
    });
    const errLogs: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errLogs.push(args.map((part) => String(part)).join(' '));
    });
    try {
      const artifact = await runCoreScan(root, {
        format: 'json',
        concurrency: 1,
        offline: true,
        noLocalArtifacts: true,
        quiet: true,
      });
      const hits = (artifact.degradations ?? []).filter((warning) => warning.code === 'VG_WARN_NON_TEXT_FILE');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.message).toContain('docker-compose.yml');
      expect(hits[0]!.message).toContain('--exclude');
      const rendered = JSON.stringify(artifact) + '\n' + logs.join('\n') + '\n' + errLogs.join('\n');
      assertNoSecrets(rendered);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  }, 60_000);
});

describe('binary files at the CLI', () => {
  function run(dir: string, command: 'scan' | 'build'): { status: number | null; stdout: string; stderr: string } {
    const args =
      command === 'scan'
        ? [cli, 'scan', dir, '--offline', '--no-graph', '--no-daemon', '--quiet']
        : [cli, 'build', '-C', dir, '--no-warm', '--no-publish', '--offline', '--no-daemon', '--no-index'];
    const res = spawnSync(process.execPath, ['--import', 'tsx', ...args], {
      cwd: pkgRoot,
      encoding: 'utf8',
      timeout: 45_000,
      env: { ...process.env, NO_COLOR: '1', VIBGRATE_NO_KERNEL: '1', VIBGRATE_DSN: '' },
    });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  it('vg build exits 0, warns once, and writes no file bytes', () => {
    const dir = nonTextProject();
    const res = run(dir, 'build');
    expect(res.status).toBe(0);
    const output = res.stdout + res.stderr;
    expect(output).toContain('VG_WARN_NON_TEXT_FILE');
    expect(output).toContain('blob.ts');
    expect(output).toContain('notes.md');
    expect(output.match(/VG_WARN_NON_TEXT_FILE/g)).toEqual(['VG_WARN_NON_TEXT_FILE']);
    assertNoSecrets(output);
  }, 60_000);

  it('vg scan exits 0 and does not print file bytes', () => {
    const dir = nonTextProject();
    const res = run(dir, 'scan');
    expect(res.status).toBe(0);
    const output = res.stdout + res.stderr;
    expect(output).toContain('VG_WARN_NON_TEXT_FILE');
    expect(output).toContain('docker-compose.yml');
    assertNoSecrets(output);
  }, 60_000);
});
