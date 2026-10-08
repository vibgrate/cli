// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';

/**
 * How many root-relative paths one notice lists. Further links are a count.
 * The walk sorts before capping, so the same tree always names the same paths.
 */
export const SKIPPED_SYMLINK_NOTICE_CAP = 5;

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Root-relative POSIX path, or '' when `absPath` is the root or escapes it.
 * Absolute paths are never returned.
 */
export function walkRelativePath(root: string, absPath: string): string {
  const rel = path.relative(root, absPath);
  if (!rel || rel === '.' || rel.startsWith('..')) return '';
  return rel.split(path.sep).join('/');
}

/** Record one skipped symlink. Empty and out-of-root paths are dropped. */
export function rememberSkippedSymlink(bucket: string[], relPath: string): void {
  const rel = relPath.split(path.sep).join('/');
  if (!rel || rel === '.' || rel.startsWith('..') || rel.startsWith('/')) return;
  bucket.push(rel);
}

/**
 * One stderr line when a walk skips symlinks. `null` when `relPaths` is empty.
 * Paths are de-duplicated, sorted, and capped. Absolute paths are omitted.
 */
export function formatSkippedSymlinkNotice(relPaths: readonly string[]): string | null {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of relPaths) {
    const rel = raw.split('\\').join('/');
    if (!rel || rel === '.' || rel.startsWith('../') || rel === '..' || rel.startsWith('/')) continue;
    if (/^[A-Za-z]:/.test(rel)) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    unique.push(rel);
  }
  unique.sort(comparePath);
  if (unique.length === 0) return null;
  const shown = unique.slice(0, SKIPPED_SYMLINK_NOTICE_CAP);
  const extra = unique.length - shown.length;
  const list = extra > 0 ? `${shown.join(', ')}, +${extra} more` : shown.join(', ');
  const noun = unique.length === 1 ? 'symlink' : 'symlinks';
  return (
    `notice: skipped ${unique.length} ${noun} (${list}). ` +
    'vg does not follow symlinks. Point the root at the link target, or pass --exclude or a narrower root.'
  );
}

/** Write {@link formatSkippedSymlinkNotice} to stderr. No-op when there is nothing to say. */
export function emitSkippedSymlinkNotice(relPaths: readonly string[]): void {
  const line = formatSkippedSymlinkNotice(relPaths);
  if (!line) return;
  process.stderr.write(`${line}\n`);
}
