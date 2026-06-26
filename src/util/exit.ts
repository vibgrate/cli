/**
 * Exit codes (VG-CLI-SPEC §1.2). CI and agents branch on these, so they are a
 * stable contract.
 */
export const ExitCode = {
  OK: 0,
  ERROR: 1,
  GATE_FAILED: 2,
  NOT_FOUND: 3,
  NON_DETERMINISTIC: 4,
  USAGE_ERROR: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** An error carrying an explicit exit code and an actionable, internals-free message. */
export class CliError extends Error {
  readonly code: ExitCodeValue;
  constructor(message: string, code: ExitCodeValue = ExitCode.ERROR) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

export function notFound(message: string): CliError {
  return new CliError(message, ExitCode.NOT_FOUND);
}

export function usageError(message: string): CliError {
  return new CliError(message, ExitCode.USAGE_ERROR);
}
