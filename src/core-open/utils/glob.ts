// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';

/**
 * Lightweight glob matcher — zero external dependencies.
 *
 * Supports the patterns most commonly used in vibgrate config `exclude`:
 *   - `*`        matches any sequence of non-separator chars
 *   - `**`       matches any sequence of chars including separators (recursive)
 *   - `?`        matches exactly one non-separator char
 *   - `{a,b}`    alternation
 *   - `[abc]`    character class
 *   - Literal folder names like `legacy` match as a prefix (`legacy/**`)
 *
 * Paths are normalised to forward-slash before matching so patterns
 * work identically on Windows and Unix.
 */

/**
 * Compile an array of glob patterns into a single predicate function
 * that tests a **relative** path (forward-slash separated).
 *
 * Returns `null` if the pattern list is empty (nothing excluded).
 */
/**
 * Split one or more raw exclude inputs into individual glob patterns.
 *
 * Each input may contain multiple patterns separated by commas or
 * semicolons, e.g. `"legacy/**, vendor/**; dist"`.  Surrounding
 * whitespace is trimmed and empty entries are dropped.  Pass an array
 * (e.g. a repeated `--exclude` flag) and every element is expanded and
 * flattened into a single de-duplicated list.
 */
export function parseExcludePatterns(input: string | string[] | undefined): string[] {
  if (input === undefined) return [];
  const raw = Array.isArray(input) ? input : [input];
  const out: string[] = [];
  for (const entry of raw) {
    for (const part of entry.split(/[,;]/)) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return [...new Set(out)];
}

export function compileGlobs(patterns: string[]): ((relPath: string) => boolean) | null {
  if (patterns.length === 0) return null;

  const matchers = patterns.map((p) => compileOne(normalise(p)));

  return (relPath: string) => {
    const norm = normalise(relPath);
    return matchers.some((m) => m(norm));
  };
}

function normalise(p: string): string {
  // Always use forward-slash for matching
  return p.split(path.sep).join('/').replace(/\/+$/, '');
}

function compileOne(pattern: string): (p: string) => boolean {
  // If the pattern has no glob metacharacters and no path separator,
  // treat it as a directory name prefix match (e.g. "legacy" → "legacy/**")
  if (!pattern.includes('/') && !hasGlobChars(pattern)) {
    const prefix = pattern + '/';
    return (p) => p === pattern || p.startsWith(prefix);
  }

  const re = globToRegex(pattern);
  return (p) => re.test(p);
}

function hasGlobChars(s: string): boolean {
  return /[*?[\]{}]/.test(s);
}

function globToRegex(pattern: string): RegExp {
  let i = 0;
  let re = '^';
  const len = pattern.length;

  while (i < len) {
    const ch = pattern[i]!;

    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // **  — match everything (including separators)
        i += 2;
        if (pattern[i] === '/') {
          // **/  — matches zero or more path segments followed by /
          i++;
          re += '(?:.+/)?';
        } else {
          // ** at end of pattern — matches everything remaining
          re += '.*';
        }
      } else {
        // * — match non-separator chars
        i++;
        re += '[^/]*';
      }
    } else if (ch === '?') {
      i++;
      re += '[^/]';
    } else if (ch === '[') {
      // Character class — pass through until ]
      const start = i;
      i++; // skip [
      while (i < len && pattern[i] !== ']') i++;
      i++; // skip ]
      re += pattern.slice(start, i);
    } else if (ch === '{') {
      // Alternation {a,b,c}
      i++; // skip {
      const alternatives: string[] = [];
      let current = '';
      while (i < len && pattern[i] !== '}') {
        if (pattern[i] === ',') {
          alternatives.push(current);
          current = '';
        } else {
          current += pattern[i];
        }
        i++;
      }
      alternatives.push(current);
      i++; // skip }
      re += '(?:' + alternatives.map(escapeRegex).join('|') + ')';
    } else {
      re += escapeRegex(ch);
      i++;
    }
  }

  re += '$';
  return new RegExp(re);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
