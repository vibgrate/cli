import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileCache, findFiles, isSkippedDirName, quickTreeCount } from '../src/core-open/utils/fs.js';
import { discover } from '../src/engine/discover.js';
import {
  collectScanSkippedSymlinks,
  emitSkippedSymlinkNotice,
  formatSkippedSymlinkNotice,
  SKIPPED_SYMLINK_NOTICE_CAP,
} from '../src/util/skipped-symlinks.js';

const NOTICE =
  'skipped 2 symlinks (vg does not follow links): alias.ts, nested/up. Point the root at the link target, or pass --exclude, or use a narrower root.';

function symlinksSupported(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-symlink-probe-'));
  try {
    fs.symlinkSync('nowhere', path.join(dir, 'link'), 'file');
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EACCES') return false;
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SUPPORTED = symlinksSupported();

function norm(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Directory symlink `nested/up` -> parent, plus a file symlink `alias.ts`.
 * A link inside `node_modules` must stay out of the notice (that directory
 * is pruned before its children are read).
 */
function makeCycleFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-symlink-'));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'symlink-fixture', version: '1.0.0' }));
  fs.writeFileSync(path.join(root, 'keep.ts'), 'export const n = 1;\n');
  fs.writeFileSync(path.join(root, 'nested', 'inside.ts'), 'export const n = 2;\n');
  fs.symlinkSync('..', path.join(root, 'nested', 'up'), 'dir');
  fs.symlinkSync('keep.ts', path.join(root, 'alias.ts'), 'file');
  fs.symlinkSync('keep.ts', path.join(root, 'node_modules', 'pkg', 'link.ts'), 'file');
  return root;
}

function captureStderr(run: () => void): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

describe('skipped symlink notice', () => {
  it('formats one stable line: sorted, capped, root-relative, silent when empty', () => {
    expect(formatSkippedSymlinkNotice([])).toBeNull();
    expect(formatSkippedSymlinkNotice(['/tmp/abs', 'C:/abs', '../out'])).toBeNull();
    const once = formatSkippedSymlinkNotice(['nested/up', 'alias.ts', '/var/abs']);
    const twice = formatSkippedSymlinkNotice(['alias.ts', 'nested/up']);
    expect(once).toBe(NOTICE);
    expect(twice).toBe(once);

    const many = Array.from({ length: SKIPPED_SYMLINK_NOTICE_CAP + 2 }, (_, i) => `s${i}.ts`);
    const capped = formatSkippedSymlinkNotice([...many].reverse());
    expect(capped).toBe(
      'skipped 7 symlinks (vg does not follow links): s0.ts, s1.ts, s2.ts, s3.ts, s4.ts (+2 more). Point the root at the link target, or pass --exclude, or use a narrower root.',
    );
    expect(formatSkippedSymlinkNotice(['only.ts'])).toBe(
      'skipped 1 symlink (vg does not follow links): only.ts. Point the root at the link target, or pass --exclude, or use a narrower root.',
    );
  });

  it('prints nothing when there are no symlinks', () => {
    const text = captureStderr(() => emitSkippedSymlinkNotice([]));
    expect(text).toBe('');
  });
});

describe.skipIf(!SUPPORTED)('symlink cycles are not followed', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function fixture(): string {
    const root = makeCycleFixture();
    dirs.push(root);
    return root;
  }

  it('vg build discovery finishes, stays deterministic, and does not descend', () => {
    const root = fixture();
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    let first: string[] = [];
    let second: string[] = [];
    try {
      first = discover({ root }).map((f) => f.rel);
      second = discover({ root }).map((f) => f.rel);
    } finally {
      spy.mockRestore();
    }
    expect(first).toEqual(['keep.ts', 'nested/inside.ts']);
    expect(second).toEqual(first);
    expect(first.some((rel) => rel === 'alias.ts' || rel.includes('nested/up') || rel.includes('node_modules'))).toBe(false);
    const noticeLines = stderr.join('').split('\n').filter((line) => line.includes('does not follow links'));
    expect(noticeLines).toEqual([NOTICE, NOTICE]);
    expect(noticeLines.join('')).not.toContain(root);
  });

  it('does not print a notice when every symlink is excluded or gitignored', () => {
    const root = fixture();
    const excluded = captureStderr(() => {
      discover({ root, exclude: ['alias.ts', 'nested/up'] });
    });
    expect(excluded).not.toContain('does not follow links');

    fs.writeFileSync(path.join(root, '.gitignore'), 'alias.ts\nnested/up\n');
    const ignored = captureStderr(() => {
      discover({ root });
    });
    expect(ignored).not.toContain('does not follow links');
  });

  it('can silence the notice without following the link', () => {
    const root = fixture();
    const text = captureStderr(() => {
      const rels = discover({ root, symlinkNotice: false }).map((f) => f.rel);
      expect(rels).toEqual(['keep.ts', 'nested/inside.ts']);
    });
    expect(text).not.toContain('does not follow links');
  });

  it('the scan walk finishes, stays deterministic, and does not descend', async () => {
    const root = fixture();
    const listed = (entries: { relPath: string }[]) =>
      entries.map((e) => norm(e.relPath)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const first = listed(await new FileCache().walkDir(root));
    const second = listed(await new FileCache().walkDir(root));
    expect(second).toEqual(first);
    expect(first).toEqual(['keep.ts', 'nested', 'nested/inside.ts', 'package.json']);
    expect(first.some((rel) => rel === 'alias.ts' || rel === 'nested/up' || rel.startsWith('nested/up/'))).toBe(false);

    const found = (await findFiles(root, (name) => name.endsWith('.ts')))
      .map((abs) => norm(path.relative(root, abs)))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(found).toEqual(['keep.ts', 'nested/inside.ts']);

    const again = (await findFiles(root, (name) => name.endsWith('.ts')))
      .map((abs) => norm(path.relative(root, abs)))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(again).toEqual(found);

    expect(await quickTreeCount(root)).toEqual({ totalFiles: 3, totalDirs: 1 });

    const skipped = collectScanSkippedSymlinks(root, undefined, isSkippedDirName)
      .slice()
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const skippedAgain = collectScanSkippedSymlinks(root, undefined, isSkippedDirName)
      .slice()
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(skipped).toEqual(['alias.ts', 'nested/up']);
    expect(skippedAgain).toEqual(skipped);
    expect(formatSkippedSymlinkNotice(skipped)).toBe(NOTICE);
    expect(NOTICE).not.toContain(root);
  });

  it('the scan census honours nested gitignore and --exclude', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'nested', '.gitignore'), 'up\n');
    expect(collectScanSkippedSymlinks(root, undefined, isSkippedDirName).slice().sort()).toEqual(['alias.ts']);
    expect(collectScanSkippedSymlinks(root, ['alias.ts'], isSkippedDirName)).toEqual([]);
  });

  it('vg build and vg scan keep JSON on stdout and exit 0', () => {
    const root = fixture();
    const cli = path.resolve('src/cli.ts');
    const generatedAt = '2026-01-01T00:00:00.000Z';
    const run = (args: string[]) => {
      const res = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          VIBGRATE_DSN: '',
          VIBGRATE_NO_KERNEL: '1',
        },
        timeout: 90_000,
      });
      return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
    };

    const buildArgs = [
      'build', '-C', root,
      '--offline', '--json', '--quiet', '--no-publish', '--no-warm', '--no-daemon',
      '--generated-at', generatedAt,
    ];
    const first = run(buildArgs);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).not.toContain('does not follow links');
    const built = JSON.parse(first.stdout) as { ok: boolean; artifacts: { graphPath: string } };
    expect(built.ok).toBe(true);
    const graphPath = built.artifacts.graphPath;
    const bytes = fs.readFileSync(graphPath);
    const graph = JSON.parse(bytes.toString('utf8')) as { nodes: { file?: string }[] };
    const files = graph.nodes.map((n) => n.file).filter((f): f is string => typeof f === 'string');
    expect(files).toContain('keep.ts');
    expect(files).toContain('nested/inside.ts');
    expect(files.some((f) => f === 'alias.ts' || f.includes('nested/up') || f.includes('node_modules'))).toBe(false);
    const buildNotices = first.stderr.split('\n').filter((line) => line.includes('does not follow links'));
    expect(buildNotices).toEqual([NOTICE]);
    expect(buildNotices[0]).not.toContain(root);

    const second = run(buildArgs);
    expect(second.status, second.stderr).toBe(0);
    expect(fs.readFileSync(graphPath).equals(bytes)).toBe(true);

    const scan = run([
      'scan', root,
      '--offline', '--format', 'json', '--no-graph', '--no-local-artifacts', '--quiet', '--no-daemon',
    ]);
    expect(scan.status, scan.stderr).toBe(0);
    expect(scan.stdout).not.toContain('does not follow links');
    const report = JSON.parse(scan.stdout) as { projects?: unknown };
    expect(report).toBeTypeOf('object');
    const scanNotices = scan.stderr.split('\n').filter((line) => line.includes('does not follow links'));
    expect(scanNotices).toEqual([NOTICE]);
    expect(scanNotices[0]).not.toContain(root);
    expect(fs.existsSync(path.join(root, '.vibgrate', 'scan_result.json'))).toBe(false);
  }, 120_000);
});
