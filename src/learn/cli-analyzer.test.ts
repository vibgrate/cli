import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { cliCommand, extractStreamResult, runCliAnalyzer, type ChildLike, type SpawnFn } from './cli-analyzer.js';

interface FakeOpts {
  stdout?: string[];
  stderr?: string[];
  exit?: number | null;
  /** Delay (ms) before each stdout chunk; the exit follows the last chunk. */
  delayMs?: number;
  neverExit?: boolean;
  startError?: string;
}

function fakeSpawn(opts: FakeOpts, seen: { command?: string; args?: string[]; stdin?: string; killed?: boolean } = {}): SpawnFn {
  return (command, args) => {
    seen.command = command;
    seen.args = args;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = new EventEmitter();
    const child: ChildLike = {
      stdin: {
        write: (chunk: string) => {
          seen.stdin = (seen.stdin ?? '') + chunk;
        },
        end: () => undefined,
        on: () => undefined,
      },
      stdout,
      stderr,
      on: (event: 'exit' | 'error', fn: (arg: never) => void) => proc.on(event, fn as (...a: unknown[]) => void),
      kill: () => {
        seen.killed = true;
      },
    };
    setTimeout(() => {
      if (opts.startError) {
        proc.emit('error', new Error(opts.startError));
        return;
      }
      const delay = opts.delayMs ?? 0;
      let t = 0;
      for (const chunk of opts.stdout ?? []) {
        t += delay;
        setTimeout(() => stdout.emit('data', chunk), t);
      }
      for (const chunk of opts.stderr ?? []) setTimeout(() => stderr.emit('data', chunk), t);
      if (!opts.neverExit) setTimeout(() => proc.emit('exit', opts.exit ?? 0), t + 1);
    }, 0);
    return child;
  };
}

const GOOD = JSON.stringify({ context_file_rules: [{ section: 'Environment', content: '- use uv run', estimated_tokens_saved: 40, evidence_count: 2 }] });

describe('cliCommand', () => {
  it('maps known agents and splits custom commands', () => {
    expect(cliCommand('claude')).toEqual(['claude', '-p', '--output-format', 'stream-json', '--verbose']);
    expect(cliCommand('gemini')).toEqual(['gemini', '-p']);
    expect(cliCommand('codex')).toEqual(['codex', 'exec', '--skip-git-repo-check']);
    expect(cliCommand('my-llm --json')).toEqual(['my-llm', '--json']);
    expect(cliCommand('  ')).toEqual([]);
  });

  it('extractStreamResult takes the last result event', () => {
    const out = ['{"type":"system"}', 'junk', '{"type":"result","result":"first"}', '{"type":"result","result":"{\\"a\\":1}"}'].join('\n');
    expect(extractStreamResult(out)).toBe('{"a":1}');
    expect(extractStreamResult('')).toBeNull();
  });
});

describe('runCliAnalyzer', () => {
  it('pipes the prompt over stdin and parses plain JSON output', async () => {
    const seen: { stdin?: string; command?: string; args?: string[] } = {};
    const res = await runCliAnalyzer('PROMPT', { cli: 'gemini', spawn: fakeSpawn({ stdout: ['```json\n', GOOD, '\n```'] }, seen) });
    expect(seen.command).toBe('gemini');
    expect(seen.args).toEqual(['-p']);
    expect(seen.stdin).toBe('PROMPT');
    expect(res.rules).toHaveLength(1);
    expect(res.rules[0]).toMatchObject({ section: 'Environment', estimatedTokensSaved: 40 });
    expect(res.command).toEqual(['gemini', '-p']);
  });

  it('reads the final result event for the streaming claude CLI', async () => {
    const stream = ['{"type":"system","subtype":"init"}\n', '{"type":"assistant"}\n', `{"type":"result","result":${JSON.stringify(GOOD)}}\n`];
    const res = await runCliAnalyzer('p', { cli: 'claude', spawn: fakeSpawn({ stdout: stream }) });
    expect(res.rules[0].section).toBe('Environment');
    expect(res.raw).toBe(GOOD);
    await expect(runCliAnalyzer('p', { cli: 'claude', spawn: fakeSpawn({ stdout: ['{"type":"system"}\n'] }) })).rejects.toThrow(/did not emit a final result event/);
  });

  it('reports non-zero exits with stderr and the stdout tail, and unusable output', async () => {
    await expect(runCliAnalyzer('p', { cli: 'codex', spawn: fakeSpawn({ stdout: ['partial'], stderr: ['Not logged in'], exit: 1 }) })).rejects.toThrow(/failed \(exit 1\):\nNot logged in\npartial/);
    await expect(runCliAnalyzer('p', { cli: 'codex', spawn: fakeSpawn({ stdout: ['not json at all'] }) })).rejects.toThrow(/returned unusable output/);
    await expect(runCliAnalyzer('p', { cli: 'codex', spawn: fakeSpawn({ startError: 'ENOENT' }) })).rejects.toThrow(/not found in PATH/);
    await expect(runCliAnalyzer('p', { cli: '   ' })).rejects.toThrow(/VG_LEARN_CLI is empty/);
  });

  it('kills the process on the idle and hard timeouts', async () => {
    const seen: { killed?: boolean } = {};
    await expect(runCliAnalyzer('p', { cli: 'codex', spawn: fakeSpawn({ neverExit: true }, seen), idleTimeoutMs: 20, timeoutMs: 5000 })).rejects.toThrow(/produced no output for 0s/);
    expect(seen.killed).toBe(true);
    const seen2: { killed?: boolean } = {};
    await expect(runCliAnalyzer('p', { cli: 'codex', spawn: fakeSpawn({ stdout: ['a', 'b', 'c', 'd'], delayMs: 15, neverExit: true }, seen2), idleTimeoutMs: 1000, timeoutMs: 30 })).rejects.toThrow(/exceeded the 0s hard cap/);
    expect(seen2.killed).toBe(true);
  });
});
