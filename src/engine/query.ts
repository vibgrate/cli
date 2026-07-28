import { indexFor, type GraphIndex } from './relations.js';
import { cosine, type Embedder } from './embeddings.js';
import type { GraphNode, VgGraph } from '../schema.js';

/**
 * Deterministic retrieval for `vg ask` (VG-CLI-SPEC §3.2).
 *
 * Builds a structured, fact-annotated, budget-bounded context block for a
 * question — designed to drop straight into an assistant's context. The default
 * is deterministic lexical+structural retrieval (identifier/term matching with
 * morphological prefix-fuzzing, ranked by importance). `--semantic`/`--deep` adds
 * a hybrid local-embedding pass (`queryGraphSemantic`) that surfaces conceptually
 * related code even when no word is shared — still no API key.
 */

export interface QueryOptions {
  budget?: number; // approx token budget for the context block (default 2000)
  limit?: number; // max seed matches to expand (default 12)
}

export interface QueryMatch {
  node: GraphNode;
  score: number;
  why: string;
}

export interface QueryResult {
  question: string;
  matches: QueryMatch[];
  context: string;
  tokensEstimate: number;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
  'where', 'what', 'which', 'how', 'do', 'does', 'did', 'i', 'we', 'it', 'this', 'that', 'with',
  'when', 'who', 'why', 'can', 'should', 'my', 'our', 'you', 'your', 'from', 'by', 'at', 'as',
  // Discovery-question scaffolding: words a caller uses to FRAME the ask
  // ("find the code responsible for X", "I need to modify X, where do I
  // start?", "explain how X works in this codebase") rather than to name the
  // target. Left in, these compete on equal footing with the real identifier
  // terms and can outrank it outright — e.g. "find the code responsible for
  // deleteAsync" let "find" alone drag in every FindByIdAsync/FindAll method
  // in the repo, none of them the target (VG-LOCATE-FAILURE-ANALYSIS.md).
  'find', 'code', 'responsible', 'need', 'modify', 'me',
  'implementation', 'explain', 'works', 'codebase', 'contains', 'file',
  // String/URL occurrence scaffolding: "does not exist", "find occurrences of …"
  // must not light up DoesNot*/NonExisting*/commandExists via weak substrings
  // (field report: https://…/signup does not exist find occurrences).
  'not', 'no', 'exist', 'exists', 'existing', 'occurrence', 'occurrences',
  'occurence', 'occurences', 'every', 'place', 'places', 'string', 'literal',
  'text', 'search', 'locate', 'look', 'looking', 'show', 'list', 'all',
]);

/**
 * Strip sentence punctuation from a URL match without breaking real query
 * strings (`?key=value`). A lone trailing `?` / `!` is English punctuation
 * ("where is https://…/signup?") — leaving it in the needle makes the literal
 * sweep miss the bare path in source.
 */
function cleanUrlNeedle(raw: string): string {
  let s = raw.trim();
  // Trailing ) ] } > , ; : ! . from markdown links / sentence ends.
  s = s.replace(/[.,;:!)\]}>]+$/g, '');
  // Lone trailing `?` → drop. Keep `?key=…` (content after `?`).
  if (s.endsWith('?')) {
    const qi = s.lastIndexOf('?');
    if (qi === s.length - 1) s = s.slice(0, -1);
  }
  return s;
}

/**
 * Extract string/URL needles a caller is asking to *locate as text*, not as
 * bag-of-words symbol terms. URLs and quoted phrases are exact-match material
 * for the literal sweep (`search_symbols` / `search_code`); feeding their path
 * segments into lexical symbol ranking produces confidently wrong seeds
 * (dash → dashboard package, exist → NonExisting, …).
 */
export function extractLiteralNeedles(question: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string, kind: 'url' | 'quote') => {
    let s = raw.trim();
    s = kind === 'url' ? cleanUrlNeedle(s) : s.replace(/[.,;:!)\]}>?]+$/g, '');
    if (s.length < 2 || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const m of question.matchAll(/https?:\/\/[^\s"'`<>]+/gi)) push(m[0]!, 'url');
  for (const m of question.matchAll(/(["'`])((?:(?!\1)[^\\]|\\.){2,})\1/g)) {
    push(m[2]!.replace(/\\(.)/g, '$1'), 'quote');
  }
  return out;
}

/** Question text with URL/quoted needles removed so residual tokens can name symbols. */
export function stripLiteralNeedles(question: string): string {
  let s = question;
  // Strip raw URL spans first (may still carry a trailing `?` from the ask).
  for (const m of question.matchAll(/https?:\/\/[^\s"'`<>]+/gi)) {
    s = s.split(m[0]!).join(' ');
  }
  for (const lit of extractLiteralNeedles(question)) {
    s = s.split(lit).join(' ');
  }
  // Also strip bare quote pairs left behind.
  s = s.replace(/(["'`])\s*\1/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Residual ask used for graph symbol ranking when the question embeds a
 * URL/quote. Empty when only framing words remain ("where is …?") so we do
 * not light up unrelated symbols like `applyPlan.where`.
 */
export function residualForSymbolSearch(question: string): string {
  const literals = extractLiteralNeedles(question);
  if (literals.length === 0) return question.trim();
  const stripped = stripLiteralNeedles(question);
  return tokenize(stripped).length === 0 ? '' : stripped;
}

/**
 * True when the instruction is a string/URL occurrence locate (not an edit).
 * Used to skip PatchIR grammar and answer from the literal sweep without
 * dumping constrained-decoding JSON into the VG Code panel.
 */
export function isLocateOnlyInstruction(instruction: string): boolean {
  const q = instruction.trim();
  if (!q) return false;
  const needles = extractLiteralNeedles(q);
  const hasLocateFrame =
    /\b(where\s+is|where\s+are|find\s+(all\s+|every\s+)?occurrence|find\s+occurrences|does\s+not\s+exist|locate|search\s+for)\b/i.test(
      q,
    ) ||
    (needles.length > 0 && /^https?:\/\//i.test(q));
  // Strong edit verbs cancel locate-only (ignore "does not exist" as non-edit).
  const withoutExist = q.replace(/\bdoes\s+not\s+exist\b/gi, ' ');
  if (
    /\b(fix|edit|change|replace|implement|refactor|rename|patch|create\s+file|delete\s+file|add\s+a\b|remove\s+the\b)\b/i.test(
      withoutExist,
    )
  ) {
    return false;
  }
  if (needles.some((n) => /^https?:\/\//i.test(n))) return true;
  return hasLocateFrame && needles.length > 0;
}

export function queryGraph(graph: VgGraph, question: string, options: QueryOptions = {}): QueryResult {
  const budget = options.budget ?? 2000;
  const limit = options.limit ?? 12;
  // When the ask embeds a URL or quoted string, score symbols only on the
  // residual framing text. Empty residual → empty matches (honest miss) rather
  // than path-token false positives that poison Task Capsules.
  const literals = extractLiteralNeedles(question);
  const forTokens = literals.length > 0 ? stripLiteralNeedles(question) : question;
  const terms = tokenize(forTokens);
  const weightOf = termWeights(graph, terms);
  const index = indexFor(graph);

  const scored: QueryMatch[] = [];
  // Literal-only locate: no identifier terms left after stripping needles → do
  // not invent symbol seeds from empty/weak residual framing.
  if (terms.length > 0) {
    for (const node of graph.nodes) {
      if (node.kind === 'file' || node.kind === 'external') continue;
      const { score, why } = scoreNode(node, terms, weightOf);
      if (score > 0) scored.push({ node, score: round(score * (1 + IMPORTANCE_WEIGHT * node.importance)), why });
    }
    scored.sort((a, b) => b.score - a.score || a.node.qualifiedName.localeCompare(b.node.qualifiedName));
  }

  const seeds = scored.slice(0, limit);
  const { context, tokensEstimate } = buildContext(graph, index, question, seeds, budget, literals);

  return { question, matches: seeds, context, tokensEstimate };
}

export interface SemanticQueryOptions extends QueryOptions {
  embedder: Embedder;
  /** Precomputed node vectors (from getNodeEmbeddings); falls back to lexical for nodes without one. */
  nodeVectors: Map<string, number[]>;
}

/**
 * Hybrid lexical + local-embedding retrieval. Blends the normalized lexical score
 * with cosine similarity to the query embedding (50/50), so a question like
 * "where do we handle auth failures?" can surface `verify_token` even with no
 * shared identifier. Deterministic given the same model + cached vectors;
 * embeddings live only in the cache, never in `graph.json`.
 */
export async function queryGraphSemantic(
  graph: VgGraph,
  question: string,
  options: SemanticQueryOptions,
): Promise<QueryResult> {
  const budget = options.budget ?? 2000;
  const limit = options.limit ?? 12;
  const literals = extractLiteralNeedles(question);
  const forTokens = literals.length > 0 ? stripLiteralNeedles(question) : question;
  const terms = tokenize(forTokens);
  const weightOf = termWeights(graph, terms);
  const index = indexFor(graph);
  // Embed the residual ask (without URL/quote noise) so semantic neighbours
  // aren't dragged toward package names that share host path segments.
  const queryVec = await options.embedder.embedQuery(forTokens || question);

  // Raw lexical scores (pre-importance) for normalization.
  const lexRaw = new Map<string, number>();
  let lexMax = 0;
  const whyById = new Map<string, string>();
  if (terms.length > 0) {
    for (const node of graph.nodes) {
      if (node.kind === 'file' || node.kind === 'external') continue;
      const { score, why } = scoreNode(node, terms, weightOf);
      lexRaw.set(node.id, score);
      whyById.set(node.id, why);
      if (score > lexMax) lexMax = score;
    }
  }

  const scored: QueryMatch[] = [];
  // Literal-only asks: skip the semantic loop entirely — embeddings over
  // "does not exist find occurrences" still surface unrelated hubs.
  if (terms.length > 0 || literals.length === 0) {
    for (const node of graph.nodes) {
      if (node.kind === 'file' || node.kind === 'external') continue;
      const lexNorm = lexMax > 0 ? (lexRaw.get(node.id) ?? 0) / lexMax : 0;
      const vec = options.nodeVectors.get(node.id);
      const sem = vec && terms.length > 0 ? Math.max(0, cosine(queryVec, vec)) : 0;
      const hybrid = 0.5 * lexNorm + 0.5 * sem;
      if (hybrid <= 0) continue;
      const lexWhy = whyById.get(node.id);
      const why = lexWhy || (sem > 0.3 ? `semantic match (${sem.toFixed(2)})` : 'weak match');
      scored.push({ node, score: round(hybrid * (1 + IMPORTANCE_WEIGHT * node.importance)), why });
    }
    scored.sort((a, b) => b.score - a.score || a.node.qualifiedName.localeCompare(b.node.qualifiedName));
  }

  const seeds = scored.slice(0, limit);
  const { context, tokensEstimate } = buildContext(graph, index, question, seeds, budget, literals);
  return { question, matches: seeds, context, tokensEstimate };
}

/**
 * Split on anything that isn't a Unicode letter/number (`\p{L}\p{N}`, not the
 * ASCII-only `[a-z0-9]`) so identifiers in non-Latin scripts (Japanese,
 * Cyrillic, ...) survive tokenization instead of vanishing entirely — the
 * ASCII-only split treated every character of e.g. `名前` as a separator,
 * producing zero terms and a guaranteed empty result for any question about
 * it (VG-LOCATE-FAILURE-ANALYSIS.md). Length floor is 1, not 2: a single
 * non-stopword letter/digit is still the whole identifier when that's genuinely
 * the symbol's name (adversarial fixtures deliberately use bare `f`/`x`/`h`
 * names to stress this) — STOPWORDS already screens out short function words.
 */
function tokenize(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 1 && !STOPWORDS.has(t)),
    ),
  ];
}

function scoreNode(node: GraphNode, terms: string[], weightOf: (t: string) => number = () => 1): { score: number; why: string } {
  let score = 0;
  const hits: string[] = [];
  const name = node.name.toLowerCase();
  const qn = node.qualifiedName.toLowerCase();
  const file = node.file.toLowerCase();
  // Split the ORIGINAL name on camelCase / snake_case, then lowercase the parts
  // (splitting must see the capitals, so it happens before lowercasing).
  const nameParts = identifierParts(node.name);
  for (const t of terms) {
    // Each term's contribution is weighted by its specificity (IDF over symbol
    // names): a match on a distinctive term ("toComparable", "layoutFor") counts
    // for more than a match on a term shared by hundreds of symbols ("code",
    // "get", "run"). Without this, an incidental exact-name hit on a common word
    // in a natural-language question outranked the conceptually-correct symbol,
    // and importance weighting amplified the wrong hit (VG-NAVIGATION trace).
    const w = weightOf(t);
    if (name === t) {
      score += 10 * w;
      hits.push(t);
    } else if (nameParts.has(t)) {
      score += 6 * w;
      hits.push(t);
    } else if (name.includes(t)) {
      score += 4 * w;
      hits.push(t);
    } else if (qn.includes(t)) {
      score += 3 * w;
      hits.push(t);
    } else if (fuzzyPartMatch(t, nameParts)) {
      // Morphological / subword match: "authentication" ↔ "authenticate"
      // (shared prefix), so lexical ask survives word-form differences without
      // a model. The semantic path handles non-shared-root synonyms.
      score += 2 * w;
      hits.push(`~${t}`);
    } else if (file.includes(t)) {
      score += 1 * w;
      hits.push(t);
    }
  }
  return { score, why: hits.length ? `matched: ${hits.join(', ')}` : '' };
}

/**
 * Importance is a mild tiebreaker, not a doubling. The old `1 + importance`
 * let a hub (importance→1) double its score and outrank a stronger textual
 * match on the actual target; at 0.4 a top hub adds at most 40%, enough to
 * break genuine ties without overriding term evidence.
 */
const IMPORTANCE_WEIGHT = 0.4;

/**
 * Per-term specificity weights (IDF) for one question, computed over the graph's
 * symbol-name vocabulary: `ln((N+1)/(df+1)) + 1`, clamped to a sane band. A term
 * that appears in one symbol name is highly discriminating; one that appears in
 * hundreds ("get", "code", "run", "handler") is near-noise. Clamped so a term
 * matching nothing (huge idf, but it scores 0 anyway) or everything can't
 * distort the scale. Cost is one O(nodes) pass, dwarfed by the scoring loop.
 */
function termWeights(graph: VgGraph, terms: string[]): (t: string) => number {
  if (terms.length === 0) return () => 1;
  const df = new Map<string, number>();
  let n = 0;
  for (const node of graph.nodes) {
    if (node.kind === 'file' || node.kind === 'external') continue;
    n++;
    const name = node.name.toLowerCase();
    const parts = identifierParts(node.name);
    for (const t of terms) {
      if (parts.has(t) || name.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const w = new Map<string, number>();
  for (const t of terms) {
    const idf = Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;
    // Ceiling of 8 (vs a natural df≈40 idf ≈ 5.4) keeps genuinely rare terms
    // dominant while a term matching nothing/only a file path can't distort.
    w.set(t, Math.max(0.5, Math.min(8, idf)));
  }
  return (t: string) => w.get(t) ?? 1;
}

/**
 * camelCase / snake_case / kebab split of an identifier → lowercased parts.
 * The separator alternative is Unicode-letter-aware (`\p{L}\p{N}`, not
 * ASCII-only `a-zA-Z0-9`) so non-Latin identifiers split on punctuation
 * without losing every character to it; the camelCase boundary lookaround
 * stays ASCII-only since upper/lowercase casing is itself an ASCII-script
 * concept — scripts without case simply never trigger it and fall through to
 * the separator split.
 */
export function identifierParts(name: string): Set<string> {
  return new Set(
    name
      .split(/[^\p{L}\p{N}]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/u)
      .filter(Boolean)
      .map((s) => s.toLowerCase()),
  );
}

/** A term fuzzily matches a part if they share a long-enough prefix (same root). */
function fuzzyPartMatch(term: string, parts: Set<string>): boolean {
  for (const part of parts) {
    const shared = sharedPrefixLen(term, part);
    if (shared >= 5 && shared >= 0.6 * Math.min(term.length, part.length)) return true;
  }
  return false;
}

function sharedPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function buildContext(
  graph: VgGraph,
  index: GraphIndex,
  question: string,
  seeds: QueryMatch[],
  budget: number,
  literals: string[] = [],
): { context: string; tokensEstimate: number } {
  const lines: string[] = [];
  lines.push(`# Context for: ${question}`);
  lines.push('');
  if (literals.length) {
    lines.push('## Literal string(s) to locate (exact text, not symbol names)');
    for (const lit of literals) lines.push(`- \`${lit}\``);
    lines.push(
      '_Use a quoted phrase / URL search (`search_symbols` or `search_code` with the exact needle) for occurrences. Graph symbols below (if any) are residual identifier hints only._',
    );
    lines.push('');
  }
  if (seeds.length === 0) {
    lines.push(
      literals.length
        ? '_No graph symbols matched residual terms — this is expected for a pure string/URL occurrence search. Run a literal sweep on the needle(s) above._'
        : '_No matching symbols found in the map. Try different terms, or `vg hubs` for the most important code._',
    );
    const text = lines.join('\n');
    return { context: text, tokensEstimate: estimateTokens(text) };
  }

  for (const { node, why } of seeds) {
    const block: string[] = [];
    block.push(`## ${node.qualifiedName}  (${node.kind}, ${node.file}:${node.span.start})`);
    if (node.signature) block.push('`' + node.signature + '`');
    const callees = index.callees(node.id).map((x) => x.node.qualifiedName);
    const callers = index.callers(node.id).map((x) => x.node.qualifiedName);
    if (callees.length) block.push(`calls: ${unique(callees).slice(0, 8).join(', ')}`);
    if (callers.length) block.push(`called by: ${unique(callers).slice(0, 8).join(', ')}`);
    block.push(`importance ${node.importance.toFixed(3)} · area #${node.area}${node.isHub ? ' · hub' : ''} · ${why}`);
    block.push('');

    const candidate = lines.concat(block).join('\n');
    if (estimateTokens(candidate) > budget && lines.length > 2) break;
    lines.push(...block);
  }

  const text = lines.join('\n');
  return { context: text, tokensEstimate: estimateTokens(text) };
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

function estimateTokens(text: string): number {
  // ~4 chars per token, the standard rough estimate.
  return Math.ceil(text.length / 4);
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
