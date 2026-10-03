import type { Ignore } from 'ignore';

/**
 * True when a pattern has no non-whitespace content.
 *
 * Empty, space, tab, and carriage-return-only entries are separators. The
 * ignore matcher turns a bare carriage return into an empty expression that
 * matches every path, so `vg build` and `vg scan` would walk nothing.
 */
export function isBlankPattern(pattern: string): boolean {
  return typeof pattern !== 'string' || pattern.trim() === '';
}

/** Keep real patterns, in order. Blank entries are dropped. */
export function omitBlankPatterns(patterns: readonly string[]): string[] {
  const kept: string[] = [];
  for (const pattern of patterns) {
    if (!isBlankPattern(pattern)) kept.push(pattern);
  }
  return kept;
}

/**
 * `.gitignore` lines that name something.
 *
 * Splits on LF, CRLF, and a bare CR so a carriage-return-only line is its
 * own entry and can be dropped. Neighbouring real patterns are unchanged.
 */
export function meaningfulGitignoreLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (!isBlankPattern(line)) lines.push(line);
  }
  return lines;
}

/** Add ignore-file text, skipping blank lines. */
export function addGitignore(ig: Ignore, text: string): void {
  const lines = meaningfulGitignoreLines(text);
  if (lines.length > 0) ig.add(lines);
}

/** Add exclude globs, skipping empty and whitespace-only values. */
export function addExcludePatterns(ig: Ignore, patterns: readonly string[]): void {
  const kept = omitBlankPatterns(patterns);
  if (kept.length > 0) ig.add(kept);
}
