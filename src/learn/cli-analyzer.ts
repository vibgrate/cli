/**
 * Optional external analyzer: pipe the prompt into a local coding-agent CLI
 * (`VG_LEARN_CLI=claude|gemini|codex|<command>`) and validate its JSON.
 *
 * The prompt travels over stdin (no ARG_MAX, no argument injection). Two
 * timeouts guard the run: a hard wall-clock cap and an idle cap (no output
 * for N seconds). `spawn` is injectable so tests never start a process.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parseAnalyzerOutput } from './analyzer.js';
import type { Loop, Rule } from './types.js';

export interface ChildLike {
  stdin: { write(chunk: string): unknown; end(): unknown; on?(event: 'error', fn: (e: Error) => void): unknown };
  stdout: EventEmitter;
  stderr: EventEmitter;
  on(event: 'exit', fn: (code: number | null) => void): unknown;
  on(event: 'error', fn: (e: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnFn = (command: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => ChildLike;

export const defaultSpawn: SpawnFn = (command, args, opts) => nodeSpawn(command, args, { env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as unknown as ChildLike;

export const DEFAULT_CLI_TIMEOUT_MS = 120_000;
export const DEFAULT_CLI_IDLE_TIMEOUT_MS = 30_000;
const SNIPPET = 2000;

/** Command line for a known agent CLI, or the value split on whitespace. */
export function cliCommand(cli: string): string[] {
  const t = cli.trim();
  switch (t) {
    case 'claude':
      return ['claude', '-p', '--output-format', 'stream-json', '--verbose'];
    case 'gemini':
      return ['gemini', '-p'];
    case 'codex':
      return ['codex', 'exec', '--skip-git-repo-check'];
    default:
      return t.split(/\s+/).filter(Boolean);
  }
}

/** Final `result` text from a claude-cli stream-json transcript, or null. */
export function extractStreamResult(stdout: string): string | null {
  let result: string | null = null;
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t) as Record<string, unknown>;
      if (ev && ev.type === 'result' && typeof ev.result === 'string') result = ev.result;
    } catch {
      /* not an event */
    }
  }
  return result;
}

export interface CliAnalyzerOptions {
  cli: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  loops?: readonly Loop[];
  now?: () => number;
}

export interface CliAnalyzerResult {
  rules: Rule[];
  raw: string;
  command: string[];
}

/** Run the analyzer CLI on `prompt`; resolves with validated rules or rejects with an actionable error. */
export function runCliAnalyzer(prompt: string, opts: CliAnalyzerOptions): Promise<CliAnalyzerResult> {
  const command = cliCommand(opts.cli);
  if (command.length === 0) return Promise.reject(new Error('VG_LEARN_CLI is empty'));
  const spawn = opts.spawn ?? defaultSpawn;
  const hardCap = opts.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const idleCap = opts.idleTimeoutMs ?? DEFAULT_CLI_IDLE_TIMEOUT_MS;
  const streaming = command[0] === 'claude' && command.includes('stream-json');
  const shown = command.join(' ');

  return new Promise<CliAnalyzerResult>((resolve, reject) => {
    let child: ChildLike;
    try {
      child = spawn(command[0], command.slice(1), { env: opts.env ?? process.env });
    } catch (e) {
      reject(new Error(`\`${command[0]}\` could not be started: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let idleTimer: NodeJS.Timeout | null = null;
    const hardTimer = setTimeout(() => fail(`\`${shown}\` exceeded the ${Math.round(hardCap / 1000)}s hard cap. Raise VG_LEARN_CLI_TIMEOUT_SECS for slower networks or larger digests.`), hardCap);
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(`\`${shown}\` produced no output for ${Math.round(idleCap / 1000)}s. Check connectivity or raise VG_LEARN_CLI_IDLE_TIMEOUT_SECS.`), idleCap);
    };
    const cleanup = (): void => {
      clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      reject(new Error(message));
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const resultText = streaming ? extractStreamResult(stdout) : null;
      if (code !== 0) {
        const parts: string[] = [];
        if (stderr.trim()) parts.push(stderr.trim().slice(0, SNIPPET));
        const tail = resultText && resultText.trim() ? resultText : stdout;
        if (tail.trim()) parts.push(tail.trim().slice(-SNIPPET));
        reject(new Error(`\`${shown}\` failed (exit ${code ?? 'signal'}):\n${parts.length ? parts.join('\n') : '(no output captured)'}`));
        return;
      }
      const body = streaming ? resultText : stdout;
      if (streaming && body === null) {
        reject(new Error(`\`${shown}\` did not emit a final result event. First ${SNIPPET} chars of stdout:\n${stdout.slice(0, SNIPPET)}`));
        return;
      }
      try {
        resolve({ rules: parseAnalyzerOutput(body ?? '', opts.loops ?? []), raw: body ?? '', command });
      } catch (e) {
        reject(new Error(`\`${shown}\` returned unusable output (${e instanceof Error ? e.message : String(e)}). First ${SNIPPET} chars:\n${(body ?? '').slice(0, SNIPPET)}`));
      }
    };

    child.on('error', (e) => fail(`\`${command[0]}\` not found in PATH or failed to start: ${e.message}. Install it or unset VG_LEARN_CLI to use the built-in analyzer.`));
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
      armIdle();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
      armIdle();
    });
    child.on('exit', (code) => finish(code));
    armIdle();
    try {
      child.stdin.on?.('error', () => undefined);
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      /* the CLI may exit before draining stdin */
    }
  });
}
