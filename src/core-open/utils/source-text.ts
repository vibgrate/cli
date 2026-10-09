import * as fs from 'node:fs';

/**
 * Decide whether bytes are safe to open as source text, and format the one
 * notice a walk prints when they are not.
 *
 * A NUL, a UTF-16 BOM, or any byte sequence that is not UTF-8 means the file
 * is binary or another encoding. Callers skip it. The notice names paths
 * only — never file bytes — and tells the operator how to ignore the file.
 */

/** How many leading bytes a large file is judged on before a full read. */
export const NON_UTF8_PREFIX_BYTES = 8192;

/**
 * Marker on a parse row that was refused because the file is not UTF-8 text.
 * The build drops the row. It is not a graph warning and not file contents.
 */
export const NON_UTF8_SKIP_MARK = 'vg-skip-non-utf8';

/** How many root-relative paths one notice lists. Further files are a count. */
export const SKIPPED_NON_UTF8_NOTICE_CAP = 5;

const HARD_FULL_READ_CAP = 32 * 1024 * 1024;

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * True when `bytes` must not be decoded as source text.
 * `complete` means `bytes` is the whole file. A prefix may end on a cut
 * multibyte character; that tail is not, by itself, a reason to skip.
 */
export function isNonUtf8Source(bytes: Uint8Array, complete: boolean): boolean {
  if (bytes.length === 0) return false;
  if (hasUtf16Bom(bytes)) return true;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
  }
  const sample = complete ? bytes : trimIncompleteUtf8Tail(bytes);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return false;
  } catch {
    return true;
  }
}

/** True when the whole buffer is UTF-8 text with no NUL and no UTF-16 BOM. */
export function isUtf8SourceText(bytes: Uint8Array): boolean {
  return !isNonUtf8Source(bytes, true);
}

/**
 * Read `abs` and return its text, or `null` when the bytes are not UTF-8
 * source text. Throws when the file cannot be read.
 */
export function readUtf8SourceSync(abs: string): string | null {
  const buf = fs.readFileSync(abs);
  if (!isUtf8SourceText(buf)) return null;
  return buf.toString('utf8');
}

/**
 * True when a walked file should be left out of source-text handling.
 * Files up to `fullReadCap` are checked in full. Larger files are judged
 * on a prefix so a blob is never slurped just to be refused. `0` means
 * prefix-only. Unreadable files return false; the caller already has a
 * path for those.
 */
export function shouldSkipNonUtf8File(abs: string, fullReadCap: number): boolean {
  let size: number;
  try {
    size = fs.statSync(abs).size;
  } catch {
    return false;
  }
  if (size === 0) return false;
  const cap = fullReadCap > 0 ? Math.min(fullReadCap, HARD_FULL_READ_CAP) : 0;
  try {
    if (cap > 0 && size <= cap) {
      return !isUtf8SourceText(fs.readFileSync(abs));
    }
    const n = Math.min(size, NON_UTF8_PREFIX_BYTES);
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(abs, 'r');
    try {
      const got = fs.readSync(fd, buf, 0, n, 0);
      return isNonUtf8Source(buf.subarray(0, got), got === size);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * One stderr line when a walk skips binary or non-UTF-8 files. `null` when
 * `relPaths` is empty. Paths are de-duplicated, sorted, and capped. Absolute
 * paths and control characters are omitted. File bytes are never included.
 */
export function formatSkippedNonUtf8Notice(relPaths: readonly string[]): string | null {
  const seen = new Set<string>();
  const unique: string[] = [];
  let hidden = 0;
  for (const raw of relPaths) {
    const key = raw.split('\\').join('/');
    if (!key || key === '.' || seen.has(key)) continue;
    seen.add(key);
    const rel = displayRel(key);
    if (!rel) hidden++;
    else unique.push(rel);
  }
  unique.sort(comparePath);
  const total = unique.length + hidden;
  if (total === 0) return null;
  const shown = unique.slice(0, SKIPPED_NON_UTF8_NOTICE_CAP);
  const extra = unique.length - shown.length;
  const list = extra > 0 ? `${shown.join(', ')}, +${extra} more` : shown.join(', ');
  const noun = total === 1 ? 'file that is not UTF-8 text' : 'files that are not UTF-8 text';
  const names = list.length > 0 ? ` (${list})` : '';
  const example = shown[0] ? shellQuote(shown[0]) : "'*.bin'";
  return (
    `notice: skipped ${total} ${noun}${names}. ` +
    'vg does not read binary or non-UTF-8 files as source. ' +
    `Ignore them with --exclude or a .gitignore rule. Example: vg build --exclude ${example}`
  );
}

/** Write {@link formatSkippedNonUtf8Notice} to stderr. No-op when there is nothing to say. */
export function emitSkippedNonUtf8Notice(relPaths: readonly string[]): void {
  const line = formatSkippedNonUtf8Notice(relPaths);
  if (!line) return;
  process.stderr.write(`${line}\n`);
}

function hasUtf16Bom(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const b0 = bytes[0]!;
  const b1 = bytes[1]!;
  return (b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff);
}

/** Drop a trailing partial UTF-8 sequence so a prefix is not refused for being cut. */
function trimIncompleteUtf8Tail(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  if (n === 0) return bytes;
  let i = n - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && (bytes[i]! & 0xc0) === 0x80) {
    cont++;
    i--;
  }
  if (i < 0) return bytes;
  const lead = bytes[i]!;
  let need = 0;
  if ((lead & 0x80) === 0) need = 1;
  else if ((lead & 0xe0) === 0xc0) need = 2;
  else if ((lead & 0xf0) === 0xe0) need = 3;
  else if ((lead & 0xf8) === 0xf0) need = 4;
  else return bytes;
  const have = n - i;
  if (have < need) return bytes.subarray(0, i);
  return bytes;
}

/** A path safe to print. `null` when it must not appear in the notice. */
function displayRel(rel: string): string | null {
  if (!rel || rel === '.' || rel.startsWith('../') || rel === '..' || rel.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(rel)) return null;
  for (let i = 0; i < rel.length; i++) {
    const c = rel.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  return rel;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
