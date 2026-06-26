import { CliError, ExitCode } from '../util/exit.js';
import type { GraphNode } from '../schema.js';

/**
 * Build a NOT_FOUND error that lists ambiguous candidates with `--pick` hints,
 * so the message is actionable (VG-CLI-SPEC §3.3). `pickFlag` lets multi-argument
 * commands point at the right flag (e.g. `vg path` uses `--pick-a`/`--pick-b`).
 */
export function ambiguityError(summary: string, candidates: GraphNode[], pickFlag = '--pick'): CliError {
  if (candidates.length === 0) {
    return new CliError(`${summary} — try \`vg hubs\` or a broader name/glob`, ExitCode.NOT_FOUND);
  }
  const lines = candidates
    .slice(0, 10)
    .map((n, i) => `  ${i + 1}. ${n.qualifiedName} (${n.kind}, ${n.file}:${n.span.start})`);
  const more = candidates.length > 10 ? `\n  …and ${candidates.length - 10} more` : '';
  return new CliError(
    `${summary} — pick one with ${pickFlag} <n>:\n${lines.join('\n')}${more}`,
    ExitCode.NOT_FOUND,
  );
}
