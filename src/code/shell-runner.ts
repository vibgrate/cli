/**
 * Async shell runner with optional streaming output for VG Code.
 *
 * Replaces blocking `spawnSync` for agent `run_command` so hosts can show
 * live IN/OUT and cancel long jobs. Policy (denylist, network, secrets) still
 * runs *before* spawn in the tool layer — this module only executes.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface ShellResult {
  stdout: string;
  exitCode: number;
  /** True when the process was killed due to timeout or signal. */
  timedOut?: boolean;
  /** True when aborted via AbortSignal. */
  cancelled?: boolean;
}

export interface ShellRunOptions {
  cwd: string;
  /** Default 120s (same as legacy spawnSync). */
  timeoutMs?: number;
  /** Cap combined stdout+stderr retained for the tool result (default 10 MiB). */
  maxBuffer?: number;
  /** Live chunks (already utf8). Hosts use this for panel streaming. */
  onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Override shell binary; default `true` uses platform shell. */
  shell?: boolean | string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Run a shell command asynchronously with optional streaming.
 * Resolves with combined stdout/stderr (stderr appended after a newline when present).
 */
export function runShellAsync(command: string, options: ShellRunOptions): Promise<ShellResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const cwd = options.cwd;

  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ stdout: '', exitCode: 130, cancelled: true });
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, {
        cwd,
        shell: options.shell ?? true,
        env: options.env ?? process.env,
        // Windows: shell:true already; stdio pipes for streaming.
      }) as ChildProcessWithoutNullStreams;
    } catch (e) {
      resolve({
        stdout: `failed to spawn shell: ${(e as Error).message}`,
        exitCode: 1,
      });
      return;
    }

    let out = '';
    let err = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let total = 0;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const combined =
        out + (err ? (out && !out.endsWith('\n') ? '\n' : '') + err : '');
      resolve({
        stdout: combined,
        exitCode,
        timedOut: timedOut || undefined,
        cancelled: cancelled || undefined,
      });
    };

    const append = (chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (!s) return;
      total += Buffer.byteLength(s, 'utf8');
      if (total <= maxBuffer) {
        if (stream === 'stdout') out += s;
        else err += s;
      } else if (total - Buffer.byteLength(s, 'utf8') < maxBuffer) {
        const note = '\n…[output truncated at maxBuffer]\n';
        if (stream === 'stdout') out += note;
        else err += note;
      }
      options.onChunk?.(s, stream);
    };

    child.stdout?.on('data', (d) => append(d, 'stdout'));
    child.stderr?.on('data', (d) => append(d, 'stderr'));

    child.on('error', (e) => {
      append(`\nspawn error: ${e.message}\n`, 'stderr');
      finish(1);
    });

    child.on('close', (code, signal) => {
      if (timedOut) finish(124);
      else if (cancelled) finish(130);
      else if (signal) finish(1);
      else finish(code ?? 1);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 1500).unref?.();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      cancelled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Sync fallback for sandboxed execution envs that still use spawnSync. */
export function shellResultFromSync(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
  status: number | null | undefined,
): ShellResult {
  const out = (stdout ?? '') + (stderr ? `\n${stderr}` : '');
  return { stdout: out, exitCode: status ?? 1 };
}
