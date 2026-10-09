import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discover } from '../src/engine/discover.js';
import { buildGraph } from '../src/engine/build.js';
import { FileCache } from '../src/core-open/utils/fs.js';
import { runCoreScan } from '../src/core-open/index.js';
import {
  formatSkippedNonUtf8Notice,
  isNonUtf8Source,
  isUtf8SourceText,
} from '../src/core-open/utils/source-text.js';
import { advancedScanHook } from '../src/reporting/advanced-analysis.js';

const SECRET = 'SECRET_TOKEN_do_not_leak';
const PIN = '2020-01-01T00:00:00.000Z';

/** Small blob: PNG-like header, a NUL, invalid UTF-8, and an ASCII secret. */
function binaryBlob(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    Buffer.from(SECRET),
    Buffer.from([0xff, 0xfe, 0x80]),
  ]);
}

function writeFixture(opts: { gitignore?: string } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-non-utf8-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'keep.ts'), 'export const keep = "café";\n');
  fs.writeFileSync(path.join(root, 'payload.js'), binaryBlob());
  fs.writeFileSync(path.join(root, 'README.md'), binaryBlob());
  fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'binary-fixture', version: '1.0.0' }),
  );
  if (opts.gitignore !== undefined) fs.writeFileSync(path.join(root, '.gitignore'), opts.gitignore);
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

const DISCOVER_NOTICE =
  "notice: skipped 1 file that is not UTF-8 text (payload.js). vg does not read binary or non-UTF-8 files as source. Ignore them with --exclude or a .gitignore rule. Example: vg build --exclude 'payload.js'\n";

const BUILD_NOTICE =
  "notice: skipped 2 files that are not UTF-8 text (README.md, payload.js). vg does not read binary or non-UTF-8 files as source. Ignore them with --exclude or a .gitignore rule. Example: vg build --exclude 'README.md'\n";

describe('binary and non-UTF-8 source text', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('classifies UTF-8 text and refuses NUL, UTF-16, and invalid bytes', () => {
    expect(isUtf8SourceText(Buffer.from(''))).toBe(true);
    expect(isUtf8SourceText(Buffer.from('export const keep = "café";\n'))).toBe(true);
    expect(isUtf8SourceText(Buffer.from([0xef, 0xbb, 0xbf, 0x41]))).toBe(true);
    expect(isUtf8SourceText(binaryBlob())).toBe(false);
    expect(isUtf8SourceText(Buffer.from([0x00]))).toBe(false);
    expect(isUtf8SourceText(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toBe(false);
    expect(isNonUtf8Source(Buffer.from([0x41, 0xc3]), false)).toBe(false);
    expect(isNonUtf8Source(Buffer.from([0x41, 0xc3]), true)).toBe(true);
    expect(isNonUtf8Source(Buffer.from([0xff]), false)).toBe(true);
  });

  it('formats one sorted notice and never prints absolute paths or control bytes', () => {
    const notice = formatSkippedNonUtf8Notice([
      'payload.js',
      'README.md',
      'payload.js',
      '/tmp/secret',
      'a\u0000b',
    ]);
    expect(notice).toBe(
      "notice: skipped 4 files that are not UTF-8 text (README.md, payload.js). vg does not read binary or non-UTF-8 files as source. Ignore them with --exclude or a .gitignore rule. Example: vg build --exclude 'README.md'",
    );
    expect(notice).not.toContain(SECRET);
    expect(notice).not.toContain('/tmp');
    expect(notice).not.toContain('\u0000');
    expect(formatSkippedNonUtf8Notice([])).toBeNull();
  });

  it('discover skips a binary source file, keeps UTF-8, and prints one stable notice', async () => {
    const root = writeFixture();
    dirs.push(root);
    let first: string[] = [];
    let second: string[] = [];
    const stderr1 = await captureStderr(() => {
      first = discover({ root }).map((f) => f.rel);
    });
    const stderr2 = await captureStderr(() => {
      second = discover({ root }).map((f) => f.rel);
    });
    expect(first).toEqual(['src/keep.ts']);
    expect(second).toEqual(first);
    expect(stderr1).toBe(DISCOVER_NOTICE);
    expect(stderr2).toBe(stderr1);
    expect(stderr1).not.toContain(SECRET);
    expect(stderr1).not.toContain(root);
    expect(stderr1).not.toContain('logo.png');
  });

  it('a gitignore or --exclude rule omits the file from the notice', async () => {
    const ignored = writeFixture({ gitignore: 'payload.js\n' });
    dirs.push(ignored);
    const fromGitignore = await captureStderr(() => {
      expect(discover({ root: ignored }).map((f) => f.rel)).toEqual(['src/keep.ts']);
    });
    expect(fromGitignore).toBe('');

    const excluded = writeFixture();
    dirs.push(excluded);
    const fromFlag = await captureStderr(() => {
      expect(discover({ root: excluded, exclude: ['payload.js'] }).map((f) => f.rel)).toEqual(['src/keep.ts']);
    });
    expect(fromFlag).toBe('');
  });

  it('vg build keeps a deterministic map and does not copy the blob into it', async () => {
    const root = writeFixture();
    dirs.push(root);
    const run = () =>
      buildGraph({
        root,
        generatedAt: PIN,
        inline: true,
        noCache: true,
        noIndex: true,
        noScip: true,
      });
    let first!: Awaited<ReturnType<typeof run>>;
    let second!: Awaited<ReturnType<typeof run>>;
    const stderr1 = await captureStderr(async () => {
      first = await run();
    });
    const stderr2 = await captureStderr(async () => {
      second = await run();
    });

    expect(stderr1).toBe(BUILD_NOTICE);
    expect(stderr2).toBe(stderr1);
    expect(stderr1).not.toContain(SECRET);
    expect(stderr1).not.toContain(root);

    const graphText = JSON.stringify(first.graph);
    expect(graphText).toBe(JSON.stringify(second.graph));
    expect(graphText).toContain('keep');
    expect(first.graph.nodes.some((n) => n.file === 'src/keep.ts')).toBe(true);
    expect(graphText).not.toContain('payload.js');
    expect(graphText).not.toContain('README.md');
    expect(graphText).not.toContain(SECRET);
    expect(graphText).not.toContain('vg-skip-non-utf8');
    expect(first.warnings.join('\n')).not.toContain(SECRET);
    expect(first.warnings.join('\n')).not.toContain('vg-skip-non-utf8');
  }, 60_000);

  it('vg scan reads past the blob without crashing or copying it', async () => {
    const root = writeFixture();
    dirs.push(root);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });
    let artifact!: Awaited<ReturnType<typeof runCoreScan>>;
    const stderr = await captureStderr(async () => {
      artifact = await runCoreScan(
        root,
        { format: 'json', concurrency: 1, offline: true, noLocalArtifacts: true, quiet: true },
        advancedScanHook,
      );
    });
    logSpy.mockRestore();

    expect(artifact.projects.length).toBeGreaterThan(0);
    const dumped = `${JSON.stringify(artifact)}\n${logs.join('\n')}`;
    expect(dumped).not.toContain(SECRET);
    expect(stderr).toContain('notice: skipped 1 file that is not UTF-8 text (payload.js)');
    expect(stderr).toContain("vg build --exclude 'payload.js'");
    expect(stderr).not.toContain(SECRET);
    expect(stderr).not.toContain(root);
    expect(stderr).not.toContain('logo.png');

    const cache = new FileCache();
    const text = await cache.readTextFile(path.join(root, 'payload.js'));
    expect(text).toBe('');
    expect(cache.skippedNonUtf8).toEqual(['payload.js']);
  }, 60_000);
});
