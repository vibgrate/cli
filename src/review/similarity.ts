/**
 * Near-duplicate detection — "does this already exist?"
 *
 * The question an AI coding agent is worst at. It cannot see the rest of the
 * repository while it writes, so it re-implements what is already there, in a
 * slightly different shape, under a different name. That is the single most
 * common way agent-written code degrades a codebase, and no linter catches it
 * because each copy is individually fine.
 *
 * MinHash over normalized token shingles, banded into an LSH index for
 * candidate generation, then an LCS check to reject the false positives LSH
 * lets through. Deterministic throughout — the permutation seeds are fixed, so
 * the same corpus always produces the same digests and the receipt stays
 * byte-stable.
 *
 * Cost note: this is O(functions) hashing and O(candidates) verification, not
 * O(functions²) comparison. The band index is what keeps it linear.
 */

/** Tokens per shingle. Long enough to be meaningful, short enough to survive edits. */
export const SHINGLE_SIZE = 5;

/** MinHash permutations. More = tighter Jaccard estimate, linearly more work. */
export const MINHASH_PERMUTATIONS = 128;

/** LSH bands × rows must multiply to MINHASH_PERMUTATIONS. 16×8 ≈ 0.5 threshold. */
export const LSH_BANDS = 16;
export const LSH_ROWS = 8;

/** Minimum LCS ratio for a candidate pair to count as a duplicate. */
export const LCS_THRESHOLD = 0.6;

/** Never verify more than this many candidates for one query. */
export const MAX_CANDIDATES = 20;

/**
 * Minimum overlap between two bodies' *call vocabularies* before they can be
 * called duplicates.
 *
 * Structural similarity alone is not enough. Sibling CRUD handlers — the
 * `ProductsController.GetById` / `OrdersController.GetById` shape that every
 * layered codebase has — score 0.92 on LCS because their control flow really is
 * identical: log, dispatch, 404 or Ok. They are not a duplication defect; they
 * are the framework's shape, and reporting them buries the findings that matter.
 *
 * What separates them from a real copy is *what they call*. Measured on a
 * Clean Architecture repository: sibling controllers share only framework
 * plumbing (`LogInformation`, `NotFound`, `Ok`) and their domain calls are
 * disjoint — `GetProductByIdQuery` vs `GetByIdWithItemsAsync` — giving 0.69. A
 * genuine renamed re-implementation calls the same collaborators and scores
 * 1.00. The gate sits between, with margin on both sides.
 */
export const MIN_CALL_OVERLAP = 0.8;

/** A body shorter than this has no meaningful shape to compare. */
export const MIN_TOKENS = 12;

/** Punctuation carries no shape on its own — it is not counted toward substance. */
const PUNCTUATION = /^[{}()[\];,.]$|^=>$|^[=!<>]=+$|^[+\-*/%&|^!<>?:]+$/;

/**
 * Does this body contain enough actual logic to be worth comparing?
 *
 * The token floor alone is not enough. A one-line delegator
 * (`function a(id: string): string { return b(id); }`) clears twelve tokens
 * purely on punctuation and type annotations, and every delegator that forwards
 * to the same function then looks like a 100% duplicate of every other. They
 * are not duplicates — they are the intended shape of a thin wrapper.
 *
 * So substance requires real content: enough non-punctuation tokens, plus
 * either a branch or more than one distinct call. A body that only forwards
 * somewhere has neither.
 */
export function hasSubstance(tokens: readonly string[]): boolean {
  const meaningful = tokens.filter((t) => !PUNCTUATION.test(t));
  if (meaningful.length < MIN_TOKENS) return false;

  const BRANCHING = new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'try', 'catch', 'elif']);
  const branches = meaningful.filter((t) => BRANCHING.has(t)).length;
  const distinctCalls = new Set(meaningful.filter((t) => t.startsWith('CALL:'))).size;
  return branches > 0 || distinctCalls > 1;
}

export interface FunctionBody {
  id: string;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface SimilarityHit {
  id: string;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  /** LCS ratio, 0..1. */
  score: number;
}

/**
 * Normalize a body to its *shape*: keep call names and control flow, discard
 * identifiers, literals, comments and whitespace.
 *
 * Discarding local names is the point — two functions that do the same thing
 * with different variable names are exactly what we are looking for. Call names
 * are kept because they carry the semantics: `charge(stripe)` and
 * `refund(stripe)` should not look identical just because their control flow
 * matches.
 */
export function normalizeTokens(text: string): string[] {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ');

  const tokens: string[] = [];
  // Call sites (`foo(`) keep their name; bare identifiers collapse to `ID`.
  const pattern = /([A-Za-z_$][\w$]*)\s*\(|([A-Za-z_$][\w$]*)|(["'`])(?:\\.|(?!\3)[^\\])*\3|(\d[\d._]*)|([{}()[\];,.]|=>|[=!<>]=+|[+\-*/%&|^!<>?:]+)/g;

  const KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return', 'try', 'catch',
    'finally', 'throw', 'await', 'async', 'function', 'const', 'let', 'var', 'new',
    'class', 'def', 'elif', 'except', 'raise', 'yield', 'match', 'foreach', 'using',
  ]);

  // A name directly after a declaration keyword is the function's *own* name,
  // not a call. It must collapse: renaming is precisely the transformation this
  // detector exists to see through, and leaving the declaration name in would
  // make every renamed copy differ from its original by exactly that token.
  const DECLARATORS = new Set(['function', 'def', 'class', 'fn', 'func', 'sub', 'method']);

  let m: RegExpExecArray | null;
  while ((m = pattern.exec(withoutComments)) !== null) {
    const previous = tokens[tokens.length - 1];
    if (m[1] !== undefined) {
      if (KEYWORDS.has(m[1])) tokens.push(m[1]);
      else if (previous !== undefined && DECLARATORS.has(previous)) tokens.push('DECL');
      else tokens.push(`CALL:${m[1]}`);
    } else if (m[2] !== undefined) {
      tokens.push(KEYWORDS.has(m[2]) ? m[2] : 'ID');
    } else if (m[3] !== undefined) {
      tokens.push('STR');
    } else if (m[4] !== undefined) {
      tokens.push('NUM');
    } else if (m[5] !== undefined) {
      tokens.push(m[5]);
    }
  }
  return tokens;
}

/** Contiguous k-token shingles. */
export function shingles(tokens: readonly string[], k: number = SHINGLE_SIZE): string[] {
  if (tokens.length < k) return tokens.length > 0 ? [tokens.join(' ')] : [];
  const out: string[] = [];
  for (let i = 0; i + k <= tokens.length; i++) out.push(tokens.slice(i, i + k).join(' '));
  return out;
}

/** FNV-1a, 32-bit. Deterministic across platforms — no `Math.random`, no seeds from the clock. */
function fnv1a(input: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** MinHash signature: the minimum hash per permutation. */
export function minhash(
  shingleSet: readonly string[],
  permutations: number = MINHASH_PERMUTATIONS,
): number[] {
  const signature = new Array<number>(permutations).fill(0xffffffff);
  for (const shingle of shingleSet) {
    for (let p = 0; p < permutations; p++) {
      const h = fnv1a(shingle, p);
      if (h < signature[p]) signature[p] = h;
    }
  }
  return signature;
}

/** The distinct call names a token stream invokes. */
function callVocabulary(tokens: readonly string[]): Set<string> {
  return new Set(tokens.filter((t) => t.startsWith('CALL:')));
}

/** Jaccard overlap of two call vocabularies. Empty on both sides counts as no evidence. */
export function callOverlap(a: readonly string[], b: readonly string[]): number {
  const x = callVocabulary(a);
  const y = callVocabulary(b);
  if (x.size === 0 && y.size === 0) return 0;
  let shared = 0;
  for (const call of x) if (y.has(call)) shared++;
  return shared / new Set([...x, ...y]).size;
}

/** Estimated Jaccard similarity: the fraction of matching signature slots. */
export function jaccard(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/** LSH band keys. Two bodies sharing any band key are candidates. */
export function bandKeys(
  signature: readonly number[],
  bands: number = LSH_BANDS,
  rows: number = LSH_ROWS,
): string[] {
  const keys: string[] = [];
  for (let b = 0; b < bands; b++) {
    const slice = signature.slice(b * rows, (b + 1) * rows);
    if (slice.length === 0) break;
    keys.push(`${b}:${fnv1a(slice.join(','), 0)}`);
  }
  return keys;
}

/**
 * Length-normalized LCS ratio over token sequences.
 *
 * LSH gives candidates cheaply but generously; this is the check that decides.
 * It is order-sensitive where Jaccard is not, so two functions built from the
 * same token vocabulary in a different order — genuinely different logic — are
 * rejected here rather than reported as duplicates.
 *
 * Bounded: sequences are truncated so one pathological body cannot make the
 * O(n·m) table explode.
 */
export function lcsRatio(a: readonly string[], b: readonly string[], cap = 400): number {
  const x = a.slice(0, cap);
  const y = b.slice(0, cap);
  if (x.length === 0 || y.length === 0) return 0;

  // Rolling two-row table — the full matrix is never allocated.
  let previous = new Array<number>(y.length + 1).fill(0);
  let current = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      current[j] = x[i - 1] === y[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[y.length] / Math.max(x.length, y.length);
}

interface IndexedBody extends FunctionBody {
  tokens: string[];
  signature: number[];
}

/**
 * A searchable index over a corpus of function bodies.
 *
 * Build once per review; query per changed function. Bodies below
 * {@link MIN_TOKENS} are excluded — a three-line getter matches every other
 * three-line getter, and reporting that is noise, not a finding.
 */
export class SimilarityIndex {
  private readonly bodies = new Map<string, IndexedBody>();
  private readonly bands = new Map<string, string[]>();

  add(body: FunctionBody): void {
    const tokens = normalizeTokens(body.text);
    if (!hasSubstance(tokens)) return;
    const signature = minhash(shingles(tokens));
    const indexed: IndexedBody = { ...body, tokens, signature };
    this.bodies.set(body.id, indexed);
    for (const key of bandKeys(signature)) {
      let bucket = this.bands.get(key);
      if (!bucket) this.bands.set(key, (bucket = []));
      bucket.push(body.id);
    }
  }

  get size(): number {
    return this.bodies.size;
  }

  /**
   * Bodies similar to `query`, best first. `excludeIds` drops the query's own
   * entry (and anything else the caller knows is the same thing).
   */
  find(query: FunctionBody, excludeIds: ReadonlySet<string> = new Set()): SimilarityHit[] {
    const tokens = normalizeTokens(query.text);
    if (!hasSubstance(tokens)) return [];
    const signature = minhash(shingles(tokens));

    const candidateIds = new Set<string>();
    for (const key of bandKeys(signature)) {
      for (const id of this.bands.get(key) ?? []) {
        if (id !== query.id && !excludeIds.has(id)) candidateIds.add(id);
      }
    }

    // Order candidates by the cheap estimate before paying for LCS, so the cap
    // keeps the most promising ones rather than an arbitrary slice.
    const ranked = [...candidateIds]
      .map((id) => this.bodies.get(id)!)
      .sort((a, b) => jaccard(signature, b.signature) - jaccard(signature, a.signature))
      .slice(0, MAX_CANDIDATES);

    const hits: SimilarityHit[] = [];
    for (const candidate of ranked) {
      const score = lcsRatio(tokens, candidate.tokens);
      if (score < LCS_THRESHOLD) continue;
      // Same shape is not the same work. Two handlers can share every control
      // structure and still call entirely different collaborators.
      if (callOverlap(tokens, candidate.tokens) < MIN_CALL_OVERLAP) continue;
      hits.push({
        id: candidate.id,
        name: candidate.name,
        file: candidate.file,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        score,
      });
    }
    return hits.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1));
  }
}

/**
 * Files whose contents should never count as a duplicate: tests (repetition is
 * the point), generated code, and vendored dependencies.
 */
export function isComparable(file: string): boolean {
  const p = file.replace(/\\/g, '/');
  if (/(^|\/)(__tests__|__mocks__|tests?|spec|fixtures?|vendor|node_modules|dist|build|generated)\//i.test(p)) {
    return false;
  }
  return !/\.(test|spec|d)\.[^.]+$|\.min\.[^.]+$|\.generated\.[^.]+$/i.test(p);
}
