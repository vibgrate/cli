import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { compileGlobs, gitignoreWithoutBlankLines } from '../core-open/utils/glob.js';
import { info } from './output.js';

/**
 * How many root-relative symlink paths a single notice lists.
 * The rest are a count only, so a link farm cannot flood stderr.
 */
export const SKIPPED_SYMLINK_NOTICE_CAP = 5;

const REMEDY =
  'Point the root at the link target, or pass --exclude, or use a narrower root.';

interface GitignoreLevel {
  dir: string;
  ig: Ignore;
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Root-relative POSIX path. Absolute paths and `..` escapes are dropped. */
export function rootRelativePosix(p: string): string | null {
  const posix = p.split(path.sep).join('/').split('\\').join('/');
  if (!posix || posix === '.' || posix === '..' || posix.startsWith('../')) return null;
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) return null;
  return posix;
}

/**
 * One stderr line for symlinks a walk did not follow.
 * Paths are sorted, de-duplicated, and capped. `null` when there is nothing to say.
 */
export function formatSkippedSymlinkNotice(relPaths: readonly string[]): string | null {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of relPaths) {
    const rel = rootRelativePosix(raw);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    unique.push(rel);
  }
  unique.sort(comparePath);
  if (unique.length === 0) return null;
  const shown = unique.slice(0, SKIPPED_SYMLINK_NOTICE_CAP);
  const extra = unique.length - shown.length;
  const list = extra > 0 ? `${shown.join(', ')} (+${extra} more)` : shown.join(', ');
  const noun = unique.length === 1 ? 'symlink' : 'symlinks';
  return `skipped ${unique.length} ${noun} (vg does not follow links): ${list}. ${REMEDY}`;
}

/** Print {@link formatSkippedSymlinkNotice} on stderr. No-op when there are none. */
export function emitSkippedSymlinkNotice(relPaths: readonly string[]): void {
  const text = formatSkippedSymlinkNotice(relPaths);
  if (!text) return;
  info(text);
}

function extendGitignoreLevels(dir: string, levels: GitignoreLevel[]): GitignoreLevel[] {
  try {
    const txt = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    const rules = gitignoreWithoutBlankLines(txt);
    if (!rules) return levels;
    return [...levels, { dir, ig: ignore().add(rules) }];
  } catch {
    return levels;
  }
}

/**
 * Same root-to-leaf `.gitignore` precedence as the scan walk: a deeper
 * match wins, including a negation that un-ignores an ancestor rule.
 */
function isGitignored(levels: GitignoreLevel[], absPath: string, isDir: boolean): boolean {
  if (levels.length === 0) return false;
  let ignored = false;
  for (const { dir, ig } of levels) {
    const rel = path.relative(dir, absPath);
    if (!rel || rel.startsWith('..')) continue;
    const relPosix = rel.split(path.sep).join('/');
    const testPath = isDir ? `${relPosix}/` : relPosix;
    const result = ig.test(testPath);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

/**
 * Symlinks the scan walk will not follow.
 *
 * Mirrors the scan walker's directory pruning (skip-dir names, nested
 * `.gitignore`, config/`--exclude` globs) and reads each directory with
 * `readdir({ withFileTypes: true })`. A symlink is not a directory and not
 * a file under that API, so the real walk never enters it. This census
 * does not either: it only records the link path. Lives outside
 * `src/core-open` so a vendor sync that replaces that tree cannot drop the
 * notice.
 */
export function collectScanSkippedSymlinks(
  root: string,
  exclude: readonly string[] | undefined,
  isSkippedDirName: (name: string) => boolean,
): string[] {
  const rootDir = path.resolve(root);
  const excluded = compileGlobs([...(exclude ?? [])]);
  const found: string[] = [];

  const walk = (dir: string, parentLevels: GitignoreLevel[]): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const levels = extendGitignoreLevels(dir, parentLevels);
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootDir, abs);
      if (!rel || rel.startsWith('..')) continue;
      const relPosix = rel.split(path.sep).join('/');
      if (excluded?.(relPosix)) continue;
      if (entry.isDirectory()) {
        if (isSkippedDirName(entry.name)) continue;
        if (isGitignored(levels, abs, true)) continue;
        walk(abs, levels);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      // A link the operator already ignored is not news. Check both shapes:
      // gitignore treats `name` and `name/` differently.
      if (isGitignored(levels, abs, false) || isGitignored(levels, abs, true)) continue;
      found.push(relPosix);
    }
  };

  walk(rootDir, []);
  return found;
}
