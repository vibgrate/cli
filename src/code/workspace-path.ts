/**
 * Weak-model path and SEARCH helpers for VG Code file tools.
 *
 * Spark (and other small local packs) invent casing (`src/gREET.ts`) and emit
 * regex SEARCH (`hi \(\w+\)`). Apply is literal / whitespace-flexible only —
 * these helpers rewrite a unique known path and reject regex-shaped SEARCH
 * with an excerpt the next step can quote. Ambiguous matches are never guessed.
 */

export type PathResolveResult =
  | { status: 'exact'; path: string }
  | { status: 'resolved'; path: string; requested: string }
  | { status: 'missing'; path: string }
  | { status: 'ambiguous'; path: string; candidates: string[] };

export function normalizeRelPath(file: string): string {
  return (file ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Secondary key: drop whitespace so `src/gre et.ts` / `src/gre et. ts` can match. */
export function squeezePathKey(file: string): string {
  return normalizeRelPath(file).replace(/\s+/g, '').toLowerCase();
}

export function pathBasename(file: string): string {
  const n = normalizeRelPath(file);
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) : n;
}

/**
 * True when SEARCH looks like a regular expression rather than a source snippet.
 * `edit_file` never interprets SEARCH as a regex — this only drives the error.
 */
export function looksLikeRegexSearch(search: string): boolean {
  const s = search ?? '';
  if (!s) return false;
  // Character classes / anchors that almost never appear as literal source.
  if (/\\[wsdWSDAbB]/.test(s)) return true;
  // Escaped metacharacters (`\(`, `\+`, …) — source would contain the raw char.
  if (/\\[()[\]{}?*+|.]/.test(s)) return true;
  // Wildcard `.*` / `.+` used as "match anything".
  if (/(?:^|[^\\])\.[*+]/.test(s)) return true;
  return false;
}

/**
 * True when REPLACE looks like a regex substitution (`Hello, $1!`, `$&`)
 * rather than source. Invent-checks must not treat TitleCase tokens there
 * as invented graph symbols.
 */
export function looksLikeRegexSubstitution(replace: string): boolean {
  const s = replace ?? '';
  if (!s) return false;
  return /\$(\d+|&|`|')/.test(s);
}

/**
 * Resolve a model-supplied path against files that exist in the workspace map.
 * Prefer the graph/known spelling over the model's casing: unique
 * case-insensitive full path, then unique basename, then unique suffix,
 * then unique space-stripped match (`src/gre et.ts`) — even when
 * `exists(requested)` is true (macOS APFS opens `src/gREET.ts` as
 * `src/greet.ts`). Leading/trailing path noise is trimmed first. Multiple
 * hits → ambiguous (do not invent). A disk hit with no known match stays
 * `exact`.
 */
export function resolveWorkspacePath(
  requested: string,
  knownExisting: Iterable<string>,
  exists: (path: string) => boolean,
): PathResolveResult {
  const path = normalizeRelPath(requested);
  if (!path) return { status: 'missing', path };

  const known = [...new Set([...knownExisting].map(normalizeRelPath).filter(Boolean))].filter(exists);
  const reqLc = path.toLowerCase();

  const pickKnown = (hits: string[]): PathResolveResult | null => {
    if (hits.length === 1) {
      const canonical = hits[0]!;
      if (canonical === path) return { status: 'exact', path };
      return { status: 'resolved', path: canonical, requested: path };
    }
    if (hits.length > 1) return { status: 'ambiguous', path, candidates: hits.slice().sort() };
    return null;
  };

  const ciFull = pickKnown(known.filter((f) => f.toLowerCase() === reqLc));
  if (ciFull) return ciFull;

  const baseLc = pathBasename(path).toLowerCase();
  if (baseLc) {
    const byBase = pickKnown(known.filter((f) => pathBasename(f).toLowerCase() === baseLc));
    if (byBase) return byBase;
  }

  const bySuffix = pickKnown(
    known.filter((f) => f.toLowerCase() === reqLc || f.toLowerCase().endsWith(`/${reqLc}`)),
  );
  if (bySuffix) return bySuffix;

  // Space-stripped unique match (`src/gre et.ts` / `src/gre et. ts`).
  const reqKey = squeezePathKey(path);
  if (reqKey) {
    const bySqueeze = pickKnown(known.filter((f) => squeezePathKey(f) === reqKey));
    if (bySqueeze) return bySqueeze;
    const baseKey = squeezePathKey(pathBasename(path));
    if (baseKey) {
      const bySqueezeBase = pickKnown(known.filter((f) => squeezePathKey(pathBasename(f)) === baseKey));
      if (bySqueezeBase) return bySqueezeBase;
    }
    const bySqueezeSuffix = pickKnown(
      known.filter((f) => {
        const k = squeezePathKey(f);
        return k === reqKey || k.endsWith(`/${reqKey}`);
      }),
    );
    if (bySqueezeSuffix) return bySqueezeSuffix;
  }

  if (exists(path)) return { status: 'exact', path };
  return { status: 'missing', path };
}

export function pathResolveNote(result: PathResolveResult): string {
  if (result.status === 'resolved') return `resolved path from ${result.requested} → ${result.path}`;
  return '';
}

export function pathResolveError(result: PathResolveResult): string | null {
  if (result.status === 'missing') return `${result.path} not found`;
  if (result.status === 'ambiguous') {
    const shown = result.candidates.slice(0, 8).join(', ');
    const extra = result.candidates.length > 8 ? ` (+${result.candidates.length - 8} more)` : '';
    return `path "${result.path}" is ambiguous — matches: ${shown}${extra}. Pass the exact repo-relative path.`;
  }
  return null;
}

const EXCERPT_LINES = 40;

/** First ~40 lines, or a graph span when one is supplied. */
export function fileExcerpt(
  file: string,
  content: string,
  span?: { name?: string; start: number; end: number } | null,
): string {
  const lines = (content ?? '').split('\n');
  if (span && span.start >= 1 && span.end >= span.start) {
    const from = span.start - 1;
    const to = Math.min(lines.length, span.end);
    const slice = lines.slice(from, to).join('\n');
    const label = span.name ? `${file} (${span.name} ${span.start}-${span.end})` : `${file} (lines ${span.start}-${to})`;
    return `${label}:\n${slice}`;
  }
  const n = Math.min(EXCERPT_LINES, lines.length);
  return `${file} (first ${n} line${n === 1 ? '' : 's'}):\n${lines.slice(0, n).join('\n')}`;
}
