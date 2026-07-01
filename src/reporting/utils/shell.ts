/**
 * Shell-aware hints for the CLI.
 *
 * When we tell a user how to unset an environment variable, the syntax depends
 * on their shell — `unset` (POSIX sh/bash/zsh), `set -e` (fish),
 * `unsetenv` (csh/tcsh), `Remove-Item Env:` (PowerShell), `set VAR=` (cmd.exe).
 * Printing one hardcoded form is wrong for everyone else, so we pick the command
 * that matches the environment we can actually detect.
 */

export interface ShellEnv {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env.SHELL` (the user's login shell on Unix). */
  shell?: string;
}

/**
 * Return the command that unsets `varName` in the caller's shell.
 *
 * Detection is best-effort and honest about its limits:
 *  - Unix: keyed off `$SHELL` (the login shell). fish and csh/tcsh get their
 *    own syntax; everything else falls back to POSIX `unset`, which covers
 *    sh/bash/zsh/ksh. `$SHELL` is the *default* shell, not guaranteed to be the
 *    one currently running, but it is the only signal available.
 *  - Windows: PowerShell and cmd.exe can't be told apart reliably from the
 *    environment, so we show both forms rather than guess wrong.
 */
export function unsetEnvCommand(varName: string, env: ShellEnv = {}): string {
  const platform = env.platform ?? process.platform;

  if (platform === 'win32') {
    return `PowerShell: Remove-Item Env:${varName}  |  cmd.exe: set ${varName}=`;
  }

  const shell = env.shell ?? process.env.SHELL ?? '';
  const base = shell.split('/').pop() ?? '';
  if (base === 'fish') return `set -e ${varName}`;
  if (base === 'csh' || base === 'tcsh') return `unsetenv ${varName}`;
  return `unset ${varName}`;
}
