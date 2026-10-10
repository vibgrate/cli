import { splitStampedWarning, stampWarning, warningPathLabel, WARNING_CODES } from '../warnings.js';

/**
 * Decide whether bytes can be treated as source text.
 *
 * A NUL byte is binary (the same rule ripgrep uses). Any other byte sequence
 * that is not valid UTF-8 is non-UTF-8, including UTF-16. Callers skip those
 * files. The decoded string is returned only for valid UTF-8, so a later
 * parser error cannot echo the original bytes.
 */

export type NonTextReason = 'binary' | 'non-utf8';

export type Utf8Inspect =
  | { ok: true; text: string }
  | { ok: false; reason: NonTextReason };

// `ignoreBOM` keeps a leading U+FEFF in the string. Callers that already
// strip a BOM (JSON, lockfiles) keep doing that; a decoder that ate it
// would hide the mark from them.
const decoder = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function containsNul(bytes: Uint8Array): boolean {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return buf.includes(0);
}

export function inspectUtf8(bytes: Uint8Array): Utf8Inspect {
  if (containsNul(bytes)) return { ok: false, reason: 'binary' };
  try {
    return { ok: true, text: decoder().decode(bytes) };
  } catch {
    return { ok: false, reason: 'non-utf8' };
  }
}

/**
 * A file that was opened as text is binary or not UTF-8.
 * The message names the file and how to leave it out. It never includes bytes.
 */
export class NonTextFileError extends Error {
  readonly code = 'ENONTEXT' as const;
  readonly filePath: string;

  constructor(filePath: string) {
    const posix = String(filePath).split('\\').join('/');
    const label = warningPathLabel(posix);
    const name = label && !(label === 'path' && !/(^|\/)path$/.test(posix)) ? label : 'file';
    super(`${name} is binary or not UTF-8. Leave it out with a .gitignore entry, or pass --exclude.`);
    this.name = 'NonTextFileError';
    this.filePath = filePath;
  }
}

/** How many paths one warning lists. Further files are a count. */
export const NON_TEXT_NOTICE_CAP = 5;

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One warning for every binary or non-UTF-8 file skipped in a run.
 * `null` when `relPaths` is empty. Paths are de-duplicated, sorted, and
 * capped. The text is paths and the ignore hint only — never file bytes.
 */
export function formatNonTextWarning(relPaths: readonly string[]): string | null {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of relPaths) {
    const posix = String(raw).split('\\').join('/');
    const label = warningPathLabel(posix);
    if (!label) continue;
    // `warningPathLabel` uses "path" when the input is empty or escapes the
    // root. A file whose name is actually `path` still has that basename.
    if (label === 'path' && !/(^|\/)path$/.test(posix)) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    unique.push(label);
  }
  unique.sort(comparePath);
  if (unique.length === 0) return null;
  const shown = unique.slice(0, NON_TEXT_NOTICE_CAP);
  const extra = unique.length - shown.length;
  const list = extra > 0 ? `${shown.join(', ')}, +${extra} more` : shown.join(', ');
  const noun = unique.length === 1 ? 'file that is' : 'files that are';
  const leave = unique.length === 1 ? 'Leave it out' : 'Leave them out';
  return (
    `skipped ${unique.length} ${noun} binary or not UTF-8 (${list}). ` +
    `${leave} with a .gitignore entry, or pass --exclude.`
  );
}

/**
 * Replace per-file `VG_WARN_NON_TEXT_FILE` stamps (the message is a path)
 * with one aggregated warning. Other warnings are unchanged.
 */
export function collapseNonTextWarnings(stored: readonly string[]): string[] {
  const rels: string[] = [];
  const rest: string[] = [];
  for (const line of stored) {
    const split = splitStampedWarning(line);
    if (split?.code === WARNING_CODES.NON_TEXT_FILE) rels.push(split.message);
    else rest.push(line);
  }
  const message = formatNonTextWarning(rels);
  if (message) rest.push(stampWarning(WARNING_CODES.NON_TEXT_FILE, message));
  return rest;
}
