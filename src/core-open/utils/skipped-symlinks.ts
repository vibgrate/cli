// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import {
  codedWarning,
  formatWarningLine,
  warningPathLabel,
  WARNING_CODES,
  type CodedWarning,
} from '../warnings.js';

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
 * Root-relative label safe to print. Absolute paths, drive paths, and paths
 * that leave the root are dropped so a home directory or a link target never
 * appears. {@link warningPathLabel} is the only path text that can remain.
 */
function labelSkippedSymlink(raw: string): string | null {
  const rel = raw.split('\\').join('/');
  if (!rel || rel === '.' || rel === '..') return null;
  const label = warningPathLabel(rel);
  if (rel.startsWith('/') || rel.startsWith('../') || /^[A-Za-z]:/.test(rel)) return null;
  if (!label || label === 'path' || label.startsWith('/') || label.startsWith('..') || /^[A-Za-z]:/.test(label)) {
    return null;
  }
  return label;
}

/**
 * One coalesced warning when a walk skips symlinks. `null` when nothing
 * qualifies. Paths are de-duplicated, sorted, and capped. The message names
 * the link path, never the target and never file contents.
 */
export function skippedSymlinkWarning(relPaths: readonly string[]): CodedWarning | null {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of relPaths) {
    const label = labelSkippedSymlink(raw);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    unique.push(label);
  }
  unique.sort(comparePath);
  if (unique.length === 0) return null;
  const shown = unique.slice(0, SKIPPED_SYMLINK_NOTICE_CAP);
  const extra = unique.length - shown.length;
  const list = extra > 0 ? `${shown.join(', ')}, +${extra} more` : shown.join(', ');
  const noun = unique.length === 1 ? 'symlink' : 'symlinks';
  return codedWarning(
    WARNING_CODES.SYMLINK_SKIPPED,
    `skipped ${unique.length} ${noun} (${list}). ` +
      'vg does not follow symlinks. Point the root at the link target, or pass --exclude or a narrower root.',
  );
}

/**
 * Stderr line for {@link skippedSymlinkWarning}. `null` when there is nothing
 * to say. The code is the stable token; the sentence after it is the prose.
 */
export function formatSkippedSymlinkNotice(relPaths: readonly string[]): string | null {
  const warning = skippedSymlinkWarning(relPaths);
  return warning ? formatWarningLine(warning) : null;
}

/**
 * Write {@link formatSkippedSymlinkNotice} to stderr.
 * Returns the warning so a caller can record the same row without a second line.
 * No-op when there is nothing to say.
 */
export function emitSkippedSymlinkNotice(relPaths: readonly string[]): CodedWarning | null {
  const warning = skippedSymlinkWarning(relPaths);
  if (!warning) return null;
  process.stderr.write(`${formatWarningLine(warning)}\n`);
  return warning;
}
