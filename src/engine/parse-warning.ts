import { formatWarningLine, stampWarning, WARNING_CODES, warningPathLabel, type CodedWarning } from '../core-open/warnings.js';
import { langById } from './languages.js';

/**
 * Deterministic warning when a supported-language file cannot be parsed.
 *
 * The sentence is the whole operator-facing message: repo-relative path,
 * language, and what to do next. It never includes a stack, a parser
 * exception, or file contents — those can leak internals or source.
 * Same path and language always produce the same string.
 */
export function parseFailureWarning(rel: string, langId: string): string {
  const language = langById(langId)?.label ?? langId;
  const file = warningPathLabel(rel);
  return stampWarning(
    WARNING_CODES.PARSE_FAILED,
    `${file} (${language}): parse failed. The map continues without this file's symbols. Correct the file or exclude the path with --exclude.`,
  );
}

/** True for a stamped parse-failure warning, including the older `parse failed:` prefix. */
export function isParseFailureWarning(warning: string): boolean {
  return warning.includes(`[${WARNING_CODES.PARSE_FAILED}]`) || warning.startsWith('parse failed:');
}

/** Stderr lines for parse failures, in the order `warnings` already has. */
export function parseFailureWarningLines(warnings: readonly CodedWarning[]): string[] {
  const lines: string[] = [];
  for (const warning of warnings) {
    if (warning.code !== WARNING_CODES.PARSE_FAILED) continue;
    lines.push(formatWarningLine(warning));
  }
  return lines;
}
