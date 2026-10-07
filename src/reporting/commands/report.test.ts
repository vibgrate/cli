import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { main } from '../../cli.js';
import { ExitCode } from '../../util/exit.js';

const SENTINEL = 'report-format-sentinel';

const artifact = {
  schemaVersion: '1.0',
  timestamp: '2026-01-01T00:00:00.000Z',
  vibgrateVersion: '0.0.0',
  rootPath: '/fixture',
  projects: [
    {
      type: 'node',
      path: 'app',
      name: SENTINEL,
      frameworks: [],
      dependencies: [],
      dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    },
  ],
  drift: {
    score: 1,
    riskLevel: 'low',
    components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
  },
  findings: [],
} as const;

const roots: string[] = [];

function writeArtifact(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-report-format-'));
  roots.push(root);
  const file = path.join(root, 'scan_result.json');
  fs.writeFileSync(file, JSON.stringify(artifact));
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function runCli(args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  vi.stubEnv('NO_COLOR', '1');
  vi.stubEnv('VIBGRATE_NO_KERNEL', '1');
  const stderr: string[] = [];
  const stdout: string[] = [];
  const write = (bucket: string[]) => (chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => {
    bucket.push(String(chunk));
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (typeof callback === 'function') callback();
    return true;
  };
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(write(stderr) as never);
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(write(stdout) as never);
  // Vitest's console capture does not go through the stdout spy. Record it too,
  // so a formatter that prints cannot hide from the empty-stdout assertion.
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    stdout.push(`${parts.map((part) => String(part)).join(' ')}\n`);
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${code ?? 0}`);
  }) as never);

  const captured = (): { code: number; stderr: string; stdout: string } => ({
    code: 0,
    stderr: stderr.join(''),
    stdout: stdout.join(''),
  });

  try {
    await main(['node', 'vg', ...args]);
    return captured();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const match = /^EXIT:(\d+)$/.exec(message);
    if (!match) throw err;
    return { ...captured(), code: Number(match[1]) };
  } finally {
    errSpy.mockRestore();
    outSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe('vg report --format', () => {
  it('rejects an unknown format with exit 5, the value, the valid list, and empty stdout', async () => {
    const file = writeArtifact();
    for (const format of ['html', 'HTML', 'sarif']) {
      const result = await runCli(['report', '--in', file, '--format', format]);
      expect(result.code).toBe(ExitCode.USAGE_ERROR);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        `error: unknown --format ${JSON.stringify(format)} (expected md, text, json)\n`,
      );
      expect(result.stderr).not.toContain(SENTINEL);
    }
  });

  it('defaults to the text report', async () => {
    const file = writeArtifact();
    const result = await runCli(['report', '--in', file]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Code Intelligence Engine');
    expect(result.stdout).toContain('Vibgrate Drift Report');
    expect(result.stdout).toContain(SENTINEL);
    expect(result.stdout).not.toContain('# Vibgrate Drift Report');
  });

  it('prints markdown for md and the artifact unchanged for json', async () => {
    const file = writeArtifact();
    const md = await runCli(['report', '--in', file, '--format', 'md']);
    expect(md.code).toBe(0);
    expect(md.stdout).toContain('# Vibgrate Drift Report');
    expect(md.stdout).toContain('## Score Breakdown');
    expect(md.stdout).toContain(SENTINEL);
    expect(md.stdout).not.toContain('Code Intelligence Engine');

    const json = await runCli(['report', '--in', file, '--format', 'json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(artifact);
    expect(json.stdout).not.toContain('Code Intelligence Engine');
  });
});
