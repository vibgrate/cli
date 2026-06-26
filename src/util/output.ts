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
