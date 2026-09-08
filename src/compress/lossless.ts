/**
 * Byte-reversible folds. Every fold ships with an exact inverse and
 * `compactLossless` verifies the round-trip before adopting a result, so a
 * fold applied to non-matching content is a safe no-op. No retrieval marker
 * is ever emitted here — the model must be able to reconstruct the original
 * shape from the folded side alone.
 *
 * Kinds: `log` (ANSI strip + run collapse), `search` (grep heading / dir
 * heading), `paths` (path heading), `diff` (index-line strip — subtractive,
 * no inverse), `text` (run collapse), `config` (run collapse + repeated block
 * fold). `unfold()` reverses the reversible kinds.
 */

export type LosslessKind = 'log' | 'search' | 'paths' | 'diff' | 'text' | 'config';

export const LOSSLESS_KINDS: readonly LosslessKind[] = ['log', 'search', 'paths', 'diff', 'text', 'config'];

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const RUN_MARKER_RE = /^\.\.\. \(repeated (\d+) times\)$/;
const BLOCK_MARKER_RE = /^\.\.\. \(repeats (\d+) lines from (\d+) lines back\)$/;
const GREP_ROW_RE = /^([^\n:]+):(\d+):(.*)$/;
const HEADING_ROW_RE = /^(\d+):(.*)$/;
const DIR_DATA_RE = /^([^/\n:]+):(\d+):(.*)$/;
const DIFF_INDEX_RE = /^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+( [0-7]+)?$/;
const PATH_ROW_RE = /^((?:\.{0,2}\/)?(?:[^/\s:]+\/)+)([^/\s:]+)$/;
const TIMESTAMP_ROW_RE = /^\s*\[?(?:\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}|\d{2}\/\d{2}\/\d{2,4}[ T]\d{1,2}:\d{2}|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}|\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s|\]|$))/;

export const FOLD_MIN_BLOCK = 3;
export const FOLD_MAX_BLOCK = 64;
export const FOLD_MAX_CANDIDATES = 8;
export const FOLD_MAX_LINES = 20_000;

/** Split keeping track of a trailing newline so the join is byte-exact. */
export function splitKeepTrailing(text: string): { lines: string[]; trailing: boolean } {
  if (text === '') return { lines: [], trailing: false };
  const trailing = text.endsWith('\n');
  const body = trailing ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), trailing };
}

export function joinLines(lines: string[], trailing: boolean): string {
  return trailing ? `${lines.join('\n')}\n` : lines.join('\n');
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Runs of ≥2 identical consecutive lines → line once + `... (repeated N times)`. */
export function collapseRuns(text: string): string {
  const { lines, trailing } = splitKeepTrailing(text);
  if (!lines.length) return text;
  const out: string[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    let j = i;
    while (j + 1 < n && lines[j + 1] === lines[i]) j++;
    const run = j - i + 1;
    out.push(lines[i]);
    if (run >= 2) out.push(`... (repeated ${run} times)`);
    i = j + 1;
  }
  return joinLines(out, trailing);
}

export function expandRuns(text: string): string {
  const { lines, trailing } = splitKeepTrailing(text);
  if (!lines.length) return text;
  const out: string[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (i + 1 < n) {
      const m = RUN_MARKER_RE.exec(lines[i + 1]);
      if (m) {
        const count = Number.parseInt(m[1], 10);
        for (let k = 0; k < count; k++) out.push(line);
        i += 2;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return joinLines(out, trailing);
}

export function isRunCollapsed(text: string): boolean {
  for (const line of text.split('\n')) if (RUN_MARKER_RE.test(line)) return true;
  return false;
}

function remember(positions: Map<string, number[]>, line: string, index: number): void {
  let bucket = positions.get(line);
  if (!bucket) {
    bucket = [];
    positions.set(line, bucket);
  }
  bucket.push(index);
  if (bucket.length > FOLD_MAX_CANDIDATES) bucket.shift();
}

/** K ≥ 3 consecutive lines reproducing K lines D lines earlier → `... (repeats K lines from D lines back)`. */
export function foldRepeatedBlocks(text: string): string {
  const { lines, trailing } = splitKeepTrailing(text);
  const n = lines.length;
  if (n < FOLD_MIN_BLOCK * 2 || n > FOLD_MAX_LINES) return text;
  const positions = new Map<string, number[]>();
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    const anchors = positions.get(lines[i]);
    if (anchors) {
      for (let a = anchors.length - 1; a >= 0; a--) {
        const q = anchors[a];
        const maxLen = Math.min(FOLD_MAX_BLOCK, n - i, i - q);
        let length = 0;
        while (length < maxLen && lines[q + length] === lines[i + length]) length++;
        if (length > bestLen) {
          bestLen = length;
          bestDist = i - q;
        }
      }
    }
    if (bestLen >= FOLD_MIN_BLOCK) {
      const marker = `... (repeats ${bestLen} lines from ${bestDist} lines back)`;
      let blockChars = 0;
      for (let k = 0; k < bestLen; k++) blockChars += lines[i + k].length + 1;
      if (blockChars > marker.length + 1) {
        out.push(marker);
        for (let k = 0; k < bestLen; k++) remember(positions, lines[i + k], i + k);
        i += bestLen;
        continue;
      }
    }
    remember(positions, lines[i], i);
    out.push(lines[i]);
    i++;
  }
  return joinLines(out, trailing);
}

export function unfoldRepeatedBlocks(text: string): string {
  const { lines, trailing } = splitKeepTrailing(text);
  if (!lines.length) return text;
  const out: string[] = [];
  for (const line of lines) {
    const m = BLOCK_MARKER_RE.exec(line);
    if (m) {
      const length = Number.parseInt(m[1], 10);
      const dist = Number.parseInt(m[2], 10);
      const start = out.length - dist;
      if (start >= 0 && length <= dist) {
        for (let k = 0; k < length; k++) out.push(out[start + k]);
        continue;
      }
    }
    out.push(line);
  }
  return joinLines(out, trailing);
}

function grepRow(line: string): RegExpExecArray | null {
  if (TIMESTAMP_ROW_RE.test(line)) return null;
  return GREP_ROW_RE.exec(line);
}

/** `path:line:content` rows sharing a path → path header once, then `line:content`. */
export function searchHeading(text: string): string {
  const { lines, trailing } = splitKeepTrailing(text);
  if (!lines.length) return text;
  const out: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    const m = grepRow(line);
    if (m) {
      if (m[1] !== current) {
        out.push(m[1]);
        current = m[1];
      }
      out.push(`${m[2]}:${m[3]}`);
    } else {
      out.push(line);
      current = null;
    }
  }
  return joinLines(out, trailing);
}

export function searchUnheading(text: string): string {
  const { lines, trailing } = splitKeepTrailing(text);
  if (!lines.length) return text;
  const out: string[] = [];
  let current: string | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const data = HEADING_ROW_RE.exec(line);
    if (current !== null && data) {
      out.push(`${current}:${data[1]}:${data[2]}`);
      i++;
      continue;
    }
    if (!data && i + 1 < n && HEADING_ROW_RE.test(lines[i + 1])) {
      current = line;
      i++;
      continue;
    }
    current = null;
    out.push(line);
    i++;
  }
  return joinLines(out, trailing);
}

/** Rows sharing a parent directory → directory header (ending `/`), then `base:line:content`. */
export function searchDirHeading(text: string): string {
  const { lines, trailing } = splitKeepTrailing(text);
  if (!lines.length) return text;
  const out: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    const m = grepRow(line);
    if (m && m[1].includes('/')) {
      const path = m[1];
      const cut = path.lastIndexOf('/') + 1;
      const dir = path.slice(0, cut);
      const base = path.slice(cut);
      if (dir !== current) {
        out.push(dir);
        current = dir;
      }
      out.push(`${base}:${m[2]}:${m[3]}`);
    } else {
      out.push(line);
      current = null;
    }
  }
  return joinLines(out, trailing);
}

export function searchDirUnheading(text: string): string {
  const { lines, trailing } = splitKeepTrailing(text);
  if (!lines.length) return text;
  const out: string[] = [];
  let current: string | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const data = DIR_DATA_RE.test(line);
    if (current !== null && data) {
      out.push(`${current}${line}`);
      i++;
      continue;
    }
    if (line.endsWith('/') && i + 1 < n && DIR_DATA_RE.test(lines[i + 1])) {
      current = line;
      i++;
      continue;
    }
    current = null;
    out.push(line);
    i++;
  }
  return joinLines(out, trailing);
}

/** Drop `index <sha>..<sha>[ mode]` lines (the diff still applies). Subtractive. */
export function diffStripIndex(text: string): string {
  const { lines, trailing } = splitKeepTrailing(text);
  if (!lines.length) return text;
  return joinLines(
    lines.filter((l) => !DIFF_INDEX_RE.test(l)),
    trailing,
  );
}

/** Pure path listing → parent dir once (ending `/`), then basenames. Needs ≥2 path rows. */
export function pathHeading(text: string): string {
  const { lines, trailing } = splitKeepTrailing(text);
  let rows = 0;
  for (const l of lines) if (PATH_ROW_RE.test(l)) rows++;
  if (rows < 2) return text;
  const out: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    const m = PATH_ROW_RE.exec(line);
    if (m) {
      if (m[1] !== current) {
        out.push(m[1]);
        current = m[1];
      }
      out.push(m[2]);
    } else {
      out.push(line);
      current = null;
    }
  }
  return joinLines(out, trailing);
}

export function pathUnheading(text: string): string {
  const { lines, trailing } = splitKeepTrailing(text);
  if (!lines.length) return text;
  const out: string[] = [];
  let current: string | null = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const isBase = line !== '' && !line.includes('/');
    if (current !== null && isBase) {
      out.push(current + line);
      i++;
      continue;
    }
    if (line.endsWith('/') && i + 1 < n && lines[i + 1] !== '' && !lines[i + 1].includes('/')) {
      current = line;
      i++;
      continue;
    }
    current = null;
    out.push(line);
    i++;
  }
  return joinLines(out, trailing);
}

function smaller(candidate: string, original: string): boolean {
  return candidate.length < original.length;
}

/**
 * Apply one fold kind with round-trip verification. Never throws; unknown
 * kinds, empty content, non-shrinking or non-round-tripping results → the
 * original content.
 */
export function compactLossless(content: string, kind: LosslessKind | string): string {
  if (!content) return content;
  try {
    switch (kind) {
      case 'log': {
        const baseline = stripAnsi(content);
        const candidate = collapseRuns(baseline);
        if (expandRuns(candidate) !== baseline) return content;
        return smaller(candidate, content) ? candidate : content;
      }
      case 'search': {
        let best = content;
        const a = searchHeading(content);
        if (searchUnheading(a) === content && smaller(a, best)) best = a;
        const b = searchDirHeading(content);
        if (searchDirUnheading(b) === content && smaller(b, best)) best = b;
        return best;
      }
      case 'paths': {
        const candidate = pathHeading(content);
        if (pathUnheading(candidate) !== content) return content;
        return smaller(candidate, content) ? candidate : content;
      }
      case 'diff': {
        const candidate = diffStripIndex(content);
        return smaller(candidate, content) ? candidate : content;
      }
      case 'text': {
        const candidate = collapseRuns(content);
        if (expandRuns(candidate) !== content) return content;
        return smaller(candidate, content) ? candidate : content;
      }
      case 'config': {
        const candidate = foldRepeatedBlocks(collapseRuns(content));
        if (expandRuns(unfoldRepeatedBlocks(candidate)) !== content) return content;
        return smaller(candidate, content) ? candidate : content;
      }
      default:
        return content;
    }
  } catch {
    return content;
  }
}

/**
 * Inverse of `compactLossless` for the reversible kinds (log/text: runs;
 * search: headings; paths: path headings; config: blocks then runs). `diff`
 * has no inverse and is returned unchanged.
 *
 * Every candidate inverse is **verified by re-folding**: an expansion is
 * accepted only when folding it again reproduces the input exactly. That makes
 * `unfold` the identity on anything this layer did not fold — content that
 * merely *contains* a marker-shaped line (a log that literally prints
 * `... (repeated 3 times)`, a listing with a bare `dir/` line) is returned
 * untouched instead of being silently rewritten. Combined with
 * `compactLossless` never returning a fold that fails its own round-trip, this
 * is what makes the "byte-reversible" claim hold for arbitrary tool output.
 */
export function unfold(folded: string, kind: LosslessKind | string): string {
  if (!folded) return folded;
  try {
    switch (kind) {
      case 'log':
      case 'text':
        return verified(folded, expandRuns(folded), collapseRuns);
      case 'search': {
        const a = searchUnheading(folded);
        if (a !== folded && searchHeading(a) === folded) return a;
        const b = searchDirUnheading(folded);
        if (b !== folded && searchDirHeading(b) === folded) return b;
        return folded;
      }
      case 'paths':
        return verified(folded, pathUnheading(folded), pathHeading);
      case 'config':
        return verified(folded, expandRuns(unfoldRepeatedBlocks(folded)), (x) => foldRepeatedBlocks(collapseRuns(x)));
      default:
        return folded;
    }
  } catch {
    return folded;
  }
}

/** Accept `expanded` only when re-folding it reproduces `folded`; else leave the input alone. */
function verified(folded: string, expanded: string, refold: (x: string) => string): string {
  if (expanded === folded) return folded;
  return refold(expanded) === folded ? expanded : folded;
}

export interface BestFold {
  kind: LosslessKind;
  text: string;
}

/**
 * Try every kind (optionally `diff`, which is only safe on diff content) and
 * keep the single fold that shrinks the most. Null when nothing shrinks.
 */
export function bestLosslessFold(content: string, opts: { allowDiff?: boolean; primary?: LosslessKind } = {}): BestFold | null {
  if (!content) return null;
  const kinds: LosslessKind[] = [];
  if (opts.primary) kinds.push(opts.primary);
  for (const k of ['search', 'paths', 'log', 'diff', 'text', 'config'] as LosslessKind[]) if (!kinds.includes(k)) kinds.push(k);
  let best: BestFold | null = null;
  for (const kind of kinds) {
    if (kind === 'diff' && !opts.allowDiff) continue;
    const folded = compactLossless(content, kind);
    if (folded.length < content.length && (!best || folded.length < best.text.length)) best = { kind, text: folded };
  }
  return best;
}

/** True when some byte-exact fold shrinks the content (lets small blocks bypass the lossy floor). */
export function hasLosslessFold(content: string, opts: { allowDiff?: boolean } = {}): boolean {
  return bestLosslessFold(content, opts) !== null;
}
