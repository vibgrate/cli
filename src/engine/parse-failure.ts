import { stampWarning, WARNING_CODES, warningPathLabel } from '../core-open/warnings.js';
import { langById } from './languages.js';

/**
 * Recovery sentence for {@link WARNING_CODES.PARSE_FAILED}. Stable: tests and
 * CI assert this exact hint. It names no file contents and no exception text.
 */
export const PARSE_FAILURE_RECOVERY = 'Fix the syntax, or exclude the path with --exclude.';

/**
 * Deterministic warning when a registered-language file fails tree-sitter
 * parse. The path is repo-relative, the language is the registry label, and
 * the hint is {@link PARSE_FAILURE_RECOVERY}. The parser's exception text is
 * omitted — wasm failures often surface as a stack or a non-deterministic
 * message, and that must not be the primary line.
 */
export function parseFailedWarning(rel: string, langId: string): string {
  const language = langById(langId)?.label ?? langId;
  return stampWarning(
    WARNING_CODES.PARSE_FAILED,
    `${warningPathLabel(rel)} (${language}): tree-sitter parse failed. The map continues without this file's definitions. ${PARSE_FAILURE_RECOVERY}`,
  );
}

/** True for a stamped {@link WARNING_CODES.PARSE_FAILED} line, old or new. */
export function isParseFailedWarning(warning: string): boolean {
  return warning.endsWith(` [${WARNING_CODES.PARSE_FAILED}]`);
}
