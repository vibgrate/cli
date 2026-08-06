import { spawn } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Windows self-update support.
 *
 * `vg update` replaces the very package the running process was launched from.
 * On Linux/macOS that is fine — an open file can be unlinked and replaced. On
 * Windows a loaded native addon (`.node`) is a mapped DLL, and the OS refuses
 * to move, copy over, or delete it while any process holds it. npm's global
 * install stages the new tree by copying the old one aside, so the copy dies on
 * the first locked addon:
 *
 *   npm error code EBUSY
 *   npm error EBUSY: resource busy or locked, copyfile '…\msgpackr-extract-win32-x64\node.napi.node'
 *
 * The lock holders are vg's own processes: this one (msgpackr is loaded on
 * nearly every code path), any `vg serve` still running, and the vgd daemon.
 * Telling the user to "run it manually" cannot help — the same lock is still
 * held by whatever they run it from if vg is still up, and re-running the same
 * command reproduces the failure exactly.
 *
 * So the update is deferred instead: write a small batch script that waits for
 * this process to exit — releasing our locks — and then runs the install,
 * logging to a file the user can read.
 */

/** Matches the file-lock family of errors npm/Windows report for a busy addon. */
const LOCK_ERROR_RE =
  /\b(EBUSY|EPERM|ETXTBSY|EACCES)\b|resource busy or locked|being used by another process|access is denied/i;

/**
 * True when installer output looks like it failed because a file was locked
 * rather than for a real packaging/network reason.
 *
 * Deliberately matched against the whole output: npm prints the code on one
 * line (`npm error code EBUSY`) and the offending path on another.
 */
export function isFileLockError(output: string): boolean {
  return LOCK_ERROR_RE.test(output);
}

export interface DeferredUpdateScriptOptions {
  /** Process whose exit releases the locks — normally the running `vg update`. */
  pid: number;
  /** The install command to run once that process is gone. */
  command: string;
  /** File the script appends its transcript to. */
  logPath: string;
  /** How long to wait for the process to exit before running anyway. */
  waitSeconds?: number;
}

/**
 * Build the batch script that performs the deferred install.
 *
 * `ping` is the delay, not `timeout` — `timeout` needs a console and fails with
 * "input redirection is not supported" in the detached, stdio-less process this
 * script runs in. `call` runs the install so a batch-file installer shim
 * (npm.cmd, pnpm.cmd) returns control instead of ending the script.
 */
export function buildDeferredUpdateScript(opts: DeferredUpdateScriptOptions): string {
  const waitSeconds = opts.waitSeconds ?? 120;
  return [
    '@echo off',
    'setlocal',
    `set "VG_PID=${opts.pid}"`,
    `set "VG_LOG=${opts.logPath}"`,
    'echo Waiting for vg (pid %VG_PID%) to exit so its locked files can be replaced...> "%VG_LOG%"',
    `for /l %%i in (1,1,${waitSeconds}) do (`,
    '  tasklist /FI "PID eq %VG_PID%" /NH 2>nul | find "%VG_PID%" >nul || goto :run',
    '  ping -n 2 127.0.0.1 >nul',
    ')',
    ':run',
    `echo Running: ${opts.command}>> "%VG_LOG%"`,
    `call ${opts.command} >> "%VG_LOG%" 2>&1`,
    'if errorlevel 1 (',
    '  echo.>> "%VG_LOG%"',
    '  echo Update FAILED. See the npm output above.>> "%VG_LOG%"',
    ') else (',
    '  echo.>> "%VG_LOG%"',
    '  echo Update complete.>> "%VG_LOG%"',
    ')',
    '',
  ].join('\r\n');
}

export interface ScheduledUpdate {
  /** Path of the batch script that was spawned. */
  scriptPath: string;
  /** Path of the transcript the script writes. */
  logPath: string;
}

/**
 * Write and launch the deferred-update script, detached from this process so it
 * outlives it. Returns null when the script could not be written or spawned —
 * the caller then falls back to printing manual instructions.
 */
export function scheduleDeferredUpdate(
  command: string,
  pid: number = process.pid,
  dir: string = os.tmpdir(),
): ScheduledUpdate | null {
  const stamp = `${pid}-${process.hrtime.bigint().toString(36)}`;
  const scriptPath = path.join(dir, `vg-update-${stamp}.cmd`);
  const logPath = path.join(dir, `vg-update-${stamp}.log`);
  try {
    fsSync.writeFileSync(scriptPath, buildDeferredUpdateScript({ pid, command, logPath }), 'utf8');
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { scriptPath, logPath };
  } catch {
    return null;
  }
}
