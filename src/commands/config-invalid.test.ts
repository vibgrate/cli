import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigFileError, parseDataConfig, requireDataConfig } from '../core-open/config.js';
import { readConfigExcludes } from '../engine/discover.js';
import { loadReviewConfig } from '../review/config.js';
import { configNotes } from './doctor.js';
import { main } from '../cli.js';

const TOKEN = 'example-placeholder';
const BROKEN_YAML = `token: ${TOKEN}\nexclude: [unclosed\n`;
const SCHEMA_YAML = `# note\ndriftBudget:\n  mode: enforce\n  maxScore: "${TOKEN}"\n`;

const roots: string[] = [];
function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-config-invalid-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

function expectedMessage(text: string, file: string): string {
  try {
    parseDataConfig(text, file);
  } catch (err) {
    if (err instanceof ConfigFileError) return err.message;
    throw err;
  }
  throw new Error('expected a config error');
}

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('malformed project config fails closed', () => {
  it('names the file and line, and does not echo a token or a stack', () => {
    const message = expectedMessage(BROKEN_YAML, '.vibgrate/config.yml');
    expect(message).toBe(
      '.vibgrate/config.yml is not valid YAML at line 3, column 1: Flow sequence in block collection must be sufficiently indented and end with a ]. Fix the file and run the command again.',
    );
    expect(message).not.toContain(TOKEN);
    expect(message).not.toMatch(/\n\s+at /);
  });

  it('names the key when exclude is not a list', () => {
    const text = `# note\nexclude: legacy/**\ntoken: ${TOKEN}\n`;
    const message = expectedMessage(text, '.vibgrate/config.yml');
    expect(message).toBe(
      '.vibgrate/config.yml: `exclude` must be a list of strings, for example exclude: ["legacy/**"] (line 2). Fix that key and run the command again.',
    );
    expect(message).not.toContain(TOKEN);
  });

  it('does not treat a broken file as an empty exclude list', () => {
    const root = project({ '.vibgrate/config.yml': BROKEN_YAML });
    expect(() => readConfigExcludes(root)).toThrow(ConfigFileError);
    expect(() => readConfigExcludes(root)).toThrow(/\.vibgrate\/config\.yml is not valid YAML at line 3/);
    expect(() => readConfigExcludes(root)).not.toThrow(new RegExp(TOKEN));
  });

  it('names the key and line for a schema-invalid driftBudget and does not echo the value', () => {
    const message = expectedMessage(SCHEMA_YAML, '.vibgrate/config.yml');
    expect(message).toBe(
      '.vibgrate/config.yml: `driftBudget.maxScore` must be a number from 0 to 100 (line 4). Fix that key and run the command again.',
    );
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain('[REDACTED]');
    expect(message).not.toMatch(/\n\s+at /);
    const root = project({ '.vibgrate/config.yml': SCHEMA_YAML });
    expect(() => requireDataConfig(root)).toThrow(ConfigFileError);
    try {
      requireDataConfig(root);
    } catch (err) {
      expect(err).toMatchObject({ line: 4, key: 'driftBudget.maxScore' });
    }
    expect(configNotes(root)).toEqual([message]);
  });

  it('does not fall back to review defaults when the committed config is invalid', () => {
    const run = (args: string[]) =>
      args[1] === 'HEAD:.vibgrate/config.yml'
        ? { stdout: BROKEN_YAML, status: 0 }
        : { stdout: '', status: 1 };
    expect(() => loadReviewConfig('/repo', undefined, run)).toThrow(ConfigFileError);
    expect(() => loadReviewConfig('/repo', undefined, run)).toThrow(/not valid YAML at line 3/);
    expect(() => loadReviewConfig('/repo', undefined, run)).not.toThrow(new RegExp(TOKEN));
  });
});

describe('vg exits non-zero on a malformed config file', () => {
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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code ?? 0}`);
    }) as never);

    try {
      await main(['node', 'vg', ...args]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const match = /^EXIT:(\d+)$/.exec(message);
      if (!match) throw err;
      return { code: Number(match[1]), stderr: stderr.join(''), stdout: stdout.join('') };
    } finally {
      errSpy.mockRestore();
      outSpy.mockRestore();
      exitSpy.mockRestore();
    }
    throw new Error('expected the CLI to exit');
  }

  it('vg scan, vg build, and vg review print the same actionable error', async () => {
    const root = project({ '.vibgrate/config.yml': BROKEN_YAML });
    const expected = `error: ${expectedMessage(BROKEN_YAML, '.vibgrate/config.yml')}\n`;
    const scan = await runCli(['scan', root, '--offline', '--no-graph', '--quiet', '--no-local-artifacts']);
    const build = await runCli(['build', '-C', root, '--offline', '--quiet']);
    const review = await runCli(['review', '-C', root, '--offline', '--quiet', '--no-setup']);

    expect(scan).toEqual({ code: 1, stderr: expected, stdout: '' });
    expect(build).toEqual({ code: 1, stderr: expected, stdout: '' });
    expect(review).toEqual({ code: 1, stderr: expected, stdout: '' });
  });

  it('vg scan stops on a schema-invalid config instead of scanning with defaults', async () => {
    const root = project({ '.vibgrate/config.yml': SCHEMA_YAML });
    const expected = `error: ${expectedMessage(SCHEMA_YAML, '.vibgrate/config.yml')}\n`;
    const scan = await runCli(['scan', root, '--offline', '--no-graph', '--quiet', '--no-local-artifacts']);
    expect(scan).toEqual({ code: 1, stderr: expected, stdout: '' });
    expect(scan.stderr).not.toContain(TOKEN);
  });
});
