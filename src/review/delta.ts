/**
 * Change-set edge delta — occupancy vs introduction.
 *
 * The current code map describes the tree as it is *now*. An import that was
 * already in a handler before this edit is occupancy, not a bypass the change
 * introduced. Review must only put *new* file-to-file dependencies in
 * `added_edges`, otherwise a typo in a file that already called a repository
 * is reported as architecture regression.
 *
 * Base-side text comes from `git show <base>:path` (cheap: changed files only).
 * No second graph build.
 */

const SPEC_PATTERNS: readonly RegExp[] = [
  /(?:import|export)\s+(?:type\s+)?(?:[^'"\n;]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /from\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:^|\n)\s*import\s+"([^"]+)"/g,
  /(?:^|\n)\s*using\s+([A-Za-z0-9_.]+)\s*;/g,
];

const TRY_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.cs',
  '.py',
  '.go',
  '.java',
  '.kt',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function dirname(p: string): string {
  const n = normalize(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '' : n.slice(0, i);
}

function resolveRelative(fromFile: string, spec: string): string {
  const dir = dirname(fromFile);
  const parts = `${dir ? `${dir}/` : ''}${spec}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function stripExt(p: string): string {
  return p.replace(/\.[^.]+$/, '');
}

function basenameNoExt(p: string): string {
  const base = normalize(p).split('/').pop() ?? p;
  return stripExt(base).toLowerCase();
}

/** Import/require/using specifiers in `text`, plus resolved relatives for `fromFile`. */
export function dependencyHints(text: string, fromFile: string): Set<string> {
  const hints = new Set<string>();
  for (const pattern of SPEC_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const spec = m[1]?.trim();
      if (!spec) continue;
      const cleaned = spec.replace(/\\/g, '/').replace(/\?.*$/, '').replace(/#.*$/, '');
      hints.add(cleaned.toLowerCase());
      hints.add(basenameNoExt(cleaned));
      if (cleaned.startsWith('.')) {
        const resolved = resolveRelative(fromFile, cleaned);
        hints.add(resolved.toLowerCase());
        hints.add(stripExt(resolved).toLowerCase());
      }
    }
  }
  return hints;
}

function destKeys(toPath: string): string[] {
  const n = normalize(toPath);
  const noExt = stripExt(n);
  return [n, noExt, n.toLowerCase(), noExt.toLowerCase(), basenameNoExt(n)];
}

/** Whether `hints` (from {@link dependencyHints}) already name `toPath`. */
export function hintsCoverDest(hints: Set<string>, toPath: string): boolean {
  for (const key of destKeys(toPath)) {
    if (hints.has(key)) return true;
  }
  const n = normalize(toPath).toLowerCase();
  for (const hint of hints) {
    for (const suffix of TRY_SUFFIXES) {
      if (hint + suffix === n || hint === n + suffix) return true;
    }
  }
  return false;
}

/**
 * Does `text` already couple `fromFile` to `toPath`?
 *
 * True when an import/require/using in the text resolves to the destination
 * (with or without extension) or names its basename. Used to filter occupancy.
 */
export function fileReferencesDest(text: string, fromFile: string, toPath: string): boolean {
  return hintsCoverDest(dependencyHints(text, fromFile), toPath);
}

export type ChangeOp = 'added' | 'modified' | 'removed' | 'renamed';

/**
 * Is this file-to-file edge new in the change?
 *
 * - Newly added file: every current edge is introduced.
 * - Modified file with a readable base: new only if the destination was not
 *   referenced before.
 * - Modified file with no base text: we cannot tell — treat as *not* new so a
 *   missing `git show` cannot manufacture bypasses.
 */
export function isIntroducedEdge(
  op: ChangeOp,
  fromFile: string,
  toPath: string,
  baseText: string | undefined,
): boolean {
  if (op === 'added') return true;
  if (op === 'removed') return false;
  if (baseText === undefined) return false;
  return !fileReferencesDest(baseText, fromFile, toPath);
}

/**
 * Destinations `fromFile` referenced in `baseText` but not in `headText`.
 * `knownFiles` is the graph's file set so we only emit paths we can layer.
 */
function pathShapedCover(hints: Set<string>, toPath: string): boolean {
  const n = normalize(toPath).toLowerCase();
  const noExt = stripExt(n);
  if (hints.has(n) || hints.has(noExt)) return true;
  for (const hint of hints) {
    if (!hint.includes('/')) continue;
    for (const suffix of TRY_SUFFIXES) {
      if (hint + suffix === n || hint === n + suffix) return true;
    }
  }
  return false;
}

export function removedDestinations(
  fromFile: string,
  baseText: string,
  headText: string,
  knownFiles: readonly string[],
): string[] {
  const oldHints = dependencyHints(baseText, fromFile);
  const newHints = dependencyHints(headText, fromFile);
  const out: string[] = [];
  for (const dest of knownFiles) {
    const n = normalize(dest);
    // Path-shaped only: a bare basename would match every `index.ts` in the map.
    if (!pathShapedCover(oldHints, n)) continue;
    if (pathShapedCover(newHints, n)) continue;
    out.push(n);
  }
  return out.sort();
}
