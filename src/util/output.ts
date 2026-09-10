import chalk from 'chalk';

/**
 * Output conventions (VG-CLI-SPEC §1.1): human output + progress → stderr;
 * machine output (JSON/exports) → stdout. So `vg "…" --json | jq` and
 * `vg export - …` pipe cleanly.
 */

export function info(message = ''): void {
  process.stderr.write(`${message}\n`);
}

export function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export const c = chalk;

/** Honor NO_COLOR / --no-color via chalk's level (set by the CLI bootstrap). */
export function disableColor(): void {
  chalk.level = 0;
}

/**
 * process.exit() terminates immediately even if a just-queued write to
 * stdout/stderr has not yet reached its destination — when that destination
 * is a pipe (a CI runner, a parent process capturing output, `| jq`, …)
 * rather than a TTY, the write is asynchronous and exiting right after it
 * can silently truncate the very message being reported. Queue a no-op
 * write behind whatever is already pending on both streams and exit only
 * once they confirm they are caught up.
 */
export function exitAfterFlush(code: number): never {
  let pending = 2;
  const done = (): void => {
    if (--pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
  return undefined as never;
}
