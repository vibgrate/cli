import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discover } from '../src/engine/discover.js';
import { FileCache } from '../src/core-open/utils/fs.js';
import { runCoreScan } from '../src/core-open/index.js';

const NOTICE =
  'notice: skipped 3 symlinks (alias.ts, nested/cycle, via). vg does not follow symlinks. Point the root at the link target, or pass --exclude or a narrower root.';

function symlinksSupported(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 't'), 'x');
    try {
      fs.symlinkSync('t', path.join(dir, 'l'));
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EACCES' || code === 'EINVAL') return false;
      throw err;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SYMLINKS = symlinksSupported();

/**
 * Real files, a directory symlink to its parent, a directory symlink to a
 * sibling, and a file symlink. Following `nested/cycle` would walk the parent
 * again and not terminate.
 */
function symlinkFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-symlink-'));
  fs.writeFileSync(path.join(root, 'keep.ts'), 'export const keep = 1;\n');
  fs.mkdirSync(path.join(root, 'hidden'));
  fs.writeFileSync(path.join(root, 'hidden', 'secret.ts'), 'export const secret = 1;\n');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.symlinkSync('..', path.join(root, 'nested', 'cycle'));
  fs.symlinkSync('hidden', path.join(root, 'via'));
  fs.symlinkSync('keep.ts', path.join(root, 'alias.ts'));
  return root;
}

function captureStderr(run: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  return Promise.resolve(run()).finally(() => spy.mockRestore()).then(() => chunks.join(''));
}

describe.skipIf(!SYMLINKS)('vg build discovery and vg scan walk skip symlinks', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('discover finishes, does not descend, and prints one stable stderr notice', async () => {
    const root = symlinkFixture();
    dirs.push(root);
    const stdout: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });

    let first: string[] = [];
    let second: string[] = [];
    const stderr1 = await captureStderr(() => {
      first = discover({ root }).map((f) => f.rel);
    });
    const stderr2 = await captureStderr(() => {
      second = discover({ root }).map((f) => f.rel);
    });
    outSpy.mockRestore();

    expect(first).toEqual(['hidden/secret.ts', 'keep.ts']);
    expect(second).toEqual(first);
    expect(first.some((rel) => rel.startsWith('via/') || rel.includes('cycle/'))).toBe(false);
    expect(first).not.toContain('alias.ts');
    expect(stderr1).toBe(`${NOTICE}\n`);
    expect(stderr2).toBe(stderr1);
    expect(stderr1).not.toContain(root);
    expect(stdout.join('')).not.toContain('symlink');
  }, 5_000);

  it('does not mention a symlink the operator already excluded', async () => {
    const root = symlinkFixture();
    dirs.push(root);
    const stderr = await captureStderr(() => {
      const rels = discover({ root, exclude: ['alias.ts'] }).map((f) => f.rel);
      expect(rels).toEqual(['hidden/secret.ts', 'keep.ts']);
    });
    expect(stderr).toBe(
      'notice: skipped 2 symlinks (nested/cycle, via). vg does not follow symlinks. Point the root at the link target, or pass --exclude or a narrower root.\n',
    );
    expect(stderr).not.toContain('alias.ts');
  });

  it('the scan walk finishes with the same files and the same notice', async () => {
    const root = symlinkFixture();
    dirs.push(root);

    const read = async (): Promise<{ files: string[]; dirs: string[] }> => {
      const entries = await new FileCache().walkDir(root);
      const files = entries.filter((e) => e.isFile).map((e) => e.relPath.split(path.sep).join('/')).sort();
      const directories = entries.filter((e) => e.isDirectory).map((e) => e.relPath.split(path.sep).join('/')).sort();
      return { files, dirs: directories };
    };

    let first: { files: string[]; dirs: string[] } | undefined;
    let second: { files: string[]; dirs: string[] } | undefined;
    const stderr1 = await captureStderr(async () => {
      first = await read();
    });
    const stderr2 = await captureStderr(async () => {
      second = await read();
    });

    expect(first).toEqual({ files: ['hidden/secret.ts', 'keep.ts'], dirs: ['hidden', 'nested'] });
    expect(second).toEqual(first);
    expect(stderr1).toBe(`${NOTICE}\n`);
    expect(stderr2).toBe(stderr1);
    expect(stderr1).not.toContain(root);
  }, 5_000);

  it('prints nothing when the tree has no symlinks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-nosym-'));
    dirs.push(root);
    fs.writeFileSync(path.join(root, 'keep.ts'), 'export const keep = 1;\n');
    const stderr = await captureStderr(() => {
      expect(discover({ root }).map((f) => f.rel)).toEqual(['keep.ts']);
    });
    expect(stderr).toBe('');
  });

  it('vg scan keeps JSON on stdout and writes no extra files', async () => {
    const root = symlinkFixture();
    dirs.push(root);
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'symlink-fixture', version: '1.0.0' }),
    );
    const before = fs.readdirSync(root).sort();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });
    const stderrChunks: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });

    const artifact = await runCoreScan(root, {
      format: 'json',
      concurrency: 1,
      offline: true,
      noLocalArtifacts: true,
      quiet: true,
    });
    logSpy.mockRestore();
    errSpy.mockRestore();

    const stdout = logs.join('\n');
    const stderr = stderrChunks.join('');
    expect(artifact).toBeTruthy();
    expect(stdout).not.toContain('notice: skipped');
    expect(stdout).not.toContain(root);
    const jsonText = logs.find((line) => line.trim().startsWith('{'));
    expect(jsonText).toBeTruthy();
    const parsed = JSON.parse(jsonText!) as { schemaVersion?: string };
    expect(parsed.schemaVersion).toBe('1.0');
    expect(JSON.stringify(parsed)).not.toContain('via/secret.ts');
    expect(JSON.stringify(parsed)).not.toContain('nested/cycle');
    expect(JSON.stringify(parsed)).not.toContain('alias.ts');
    const notices = stderr.match(/notice: skipped \d+ symlinks/g) ?? [];
    expect(notices).toEqual(['notice: skipped 3 symlinks']);
    expect(stderr).toContain('alias.ts, nested/cycle, via');
    expect(stderr).not.toContain(root);
    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(fs.existsSync(path.join(root, '.vibgrate'))).toBe(false);
  }, 60_000);
});
