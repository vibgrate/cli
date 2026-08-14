import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { registerHcs } from './hcs.js';
import { resetHcsEngineCache } from '../engine/hcs-provider.js';
import { CliError, ExitCode } from '../util/exit.js';

/**
 * Shim-only tests (per the HCS layering rule): wiring, option validation, and
 * exit codes. Engine behaviour is faked through VIBGRATE_HCS_PATH — logic is
 * tested in the engine's own (Rust) test suite, never here.
 */

let tmp: string;
let savedEnv: Record<string, string | undefined>;
let savedExitCode: typeof process.exitCode;
const ENV = ['XDG_CACHE_HOME', 'VIBGRATE_NO_KERNEL', 'VIBGRATE_MODULE_REGISTRY', 'VIBGRATE_HCS_PATH'] as const;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  savedExitCode = process.exitCode;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-hcs-cmd-'));
  process.env.XDG_CACHE_HOME = tmp; // no real module dir, no real consent state
  delete process.env.VIBGRATE_NO_KERNEL;
  delete process.env.VIBGRATE_MODULE_REGISTRY;
  delete process.env.VIBGRATE_HCS_PATH;
  resetHcsEngineCache();
});

afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  process.exitCode = savedExitCode;
  fs.rmSync(tmp, { recursive: true, force: true });
  resetHcsEngineCache();
  vi.restoreAllMocks();
});

/** A well-behaved fake engine covering the full contract. */
const FAKE_ENGINE = `export function createHcsEngine() {
  return {
    version: () => 'fake-hcs@1',
    supportedLanguages: () => 'rust,ruby',
    extractFacts: (req) => {
      const r = JSON.parse(req);
      return r.files.map((f) => JSON.stringify({ factId: 'f', m: r.language, path: f.path })).join('\\n');
    },
    renderDigest: (ndjson, opts) => 'digest[' + JSON.parse(opts).format + ']:' + ndjson.trim(),
    buildMap: (ndjson, opts) => 'map[' + (JSON.parse(opts).profile ?? 'none') + ']',
    evaluateGate: (before, after, opts) => {
      const pass = before.trim() === after.trim();
      const format = JSON.parse(opts).format;
      return format === 'json' ? JSON.stringify({ pass }) : 'gate ' + (pass ? 'ok' : 'regressions');
    },
    validateLines: (linesJson) => {
      const lines = JSON.parse(linesJson);
      const ok = lines.every((l) => l.startsWith('{'));
      return JSON.stringify({ ok, exitCode: ok ? 0 : 1, errors: ok ? [] : [{ code: 'E', message: 'not json' }] });
    },
  };
}`;

function useFakeEngine(source: string = FAKE_ENGINE): void {
  const dir = fs.mkdtempSync(path.join(tmp, 'engine-'));
  fs.writeFileSync(path.join(dir, 'index.js'), source);
  process.env.VIBGRATE_HCS_PATH = dir;
  resetHcsEngineCache();
}

/** Run `vg hcs <args…>` against a fresh program, capturing stdout. */
async function run(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerHcs(program);
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    chunks.push(String(s));
    return true;
  });
  try {
    await program.parseAsync(['hcs', ...args], { from: 'user' });
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

async function runExpectingError(args: string[]): Promise<CliError> {
  try {
    await run(args);
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error('expected a CliError');
}

function writeNdjson(name: string, content: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('vg hcs — engine unavailable is loud and distinct', () => {
  it('exits ENGINE_UNAVAILABLE (6) when the module is absent and cannot be fetched', async () => {
    // Point the registry at a closed port so auto-provision fails fast offline.
    process.env.VIBGRATE_MODULE_REGISTRY = 'http://127.0.0.1:9';
    const facts = writeNdjson('facts.ndjson', '{"factId":"a"}');
    const err = await runExpectingError(['gate', '--baseline', facts, '--facts', facts]);
    expect(err.code).toBe(ExitCode.ENGINE_UNAVAILABLE);
    expect(err.code).not.toBe(ExitCode.GATE_FAILED);
    expect(err.message).toMatch(/vg module install hcs/);
  });

  it('exits ENGINE_UNAVAILABLE (6) when VIBGRATE_NO_KERNEL is set', async () => {
    process.env.VIBGRATE_NO_KERNEL = '1';
    const err = await runExpectingError(['digest', '--in', writeNdjson('f.ndjson', '{}')]);
    expect(err.code).toBe(ExitCode.ENGINE_UNAVAILABLE);
    expect(err.message).toMatch(/VIBGRATE_NO_KERNEL/);
  });

  it('exits ENGINE_UNAVAILABLE (6) when a recorded decline blocks auto-install', async () => {
    fs.mkdirSync(path.join(tmp, 'vibgrate', 'modules'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'vibgrate', 'modules', 'consent.json'), JSON.stringify({ hcs: 'denied' }));
    const err = await runExpectingError(['digest', '--in', writeNdjson('f.ndjson', '{}')]);
    expect(err.code).toBe(ExitCode.ENGINE_UNAVAILABLE);
    expect(err.message).toMatch(/declined/);
  });
});

describe('vg hcs digest / map (shim wiring)', () => {
  it('renders a digest through the engine and validates --format/--level', async () => {
    useFakeEngine();
    const facts = writeNdjson('facts.ndjson', '{"factId":"a"}');
    const out = await run(['digest', '--in', facts, '--format', 'html']);
    expect(out.trim()).toBe('digest[html]:{"factId":"a"}');

    const err = await runExpectingError(['digest', '--in', facts, '--format', 'pdf']);
    expect(err.code).toBe(ExitCode.USAGE_ERROR);
    const err2 = await runExpectingError(['digest', '--in', facts, '--level', 'verbose']);
    expect(err2.code).toBe(ExitCode.USAGE_ERROR);
  });

  it('builds the map, passes the profile through, and writes -o files', async () => {
    useFakeEngine();
    const facts = writeNdjson('facts.ndjson', '{"factId":"a"}');
    const outFile = path.join(tmp, 'map.json');
    await run(['map', '--facts', facts, '--profile', 'governance', '-o', outFile]);
    expect(fs.readFileSync(outFile, 'utf8').trim()).toBe('map[governance]');

    const err = await runExpectingError(['map', '--facts', facts, '--profile', 'nope']);
    expect(err.code).toBe(ExitCode.USAGE_ERROR);
  });

  it('reports a missing input file as a usage error', async () => {
    useFakeEngine();
    const err = await runExpectingError(['digest', '--in', path.join(tmp, 'missing.ndjson')]);
    expect(err.code).toBe(ExitCode.USAGE_ERROR);
  });
});

describe('vg hcs gate (exit-code contract)', () => {
  it('exits 0 on pass and GATE_FAILED (2) on a regression', async () => {
    useFakeEngine();
    const a = writeNdjson('a.ndjson', '{"factId":"a"}');
    const b = writeNdjson('b.ndjson', '{"factId":"b"}');

    process.exitCode = undefined;
    const passOut = await run(['gate', '--baseline', a, '--facts', a, '--format', 'json']);
    expect(JSON.parse(passOut)).toEqual({ pass: true });
    expect(process.exitCode).toBeUndefined();

    const failOut = await run(['gate', '--baseline', a, '--facts', b]);
    expect(failOut.trim()).toBe('gate regressions');
    expect(process.exitCode).toBe(ExitCode.GATE_FAILED);
  });
});

describe('vg hcs validate / extract (shim wiring)', () => {
  it('maps the ValidationReport exit code and honors --json', async () => {
    useFakeEngine();
    process.exitCode = undefined;
    const ok = await run(['validate', writeNdjson('ok.ndjson', '{"a":1}'), '--json']);
    expect(JSON.parse(ok).ok).toBe(true);
    expect(process.exitCode).toBe(0);

    await run(['validate', writeNdjson('bad.ndjson', 'not-json'), '--json']);
    expect(process.exitCode).toBe(1);
  });

  it('extracts facts for supported languages only, deterministically ordered', async () => {
    useFakeEngine();
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'b.rs'), 'fn main() {}');
    fs.writeFileSync(path.join(repo, 'src', 'a.rb'), 'puts 1');
    fs.writeFileSync(path.join(repo, 'src', 'ignored.py'), 'pass'); // not in the fake engine's languages
    const out = await run(['extract', repo]);
    const lines = out.trim().split('\n').map((l) => JSON.parse(l) as { m: string; path: string });
    expect(lines).toEqual([
      { factId: 'f', m: 'ruby', path: 'src/a.rb' },
      { factId: 'f', m: 'rust', path: 'src/b.rs' },
    ]);

    const err = await runExpectingError(['extract', repo, '--language', 'python']);
    expect(err.code).toBe(ExitCode.USAGE_ERROR);
  });

  it('fails loudly when the installed engine lacks a capability', async () => {
    useFakeEngine(`export function createHcsEngine() {
      return { version: () => 'old@0', renderDigest: () => '', buildMap: () => '', evaluateGate: () => '{"pass":true}' };
    }`);
    const err = await runExpectingError(['extract', tmp]);
    expect(err.code).toBe(ExitCode.ENGINE_UNAVAILABLE);
    expect(err.message).toMatch(/--force/);
  });
});
