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
]);

export function queryGraph(graph: VgGraph, question: string, options: QueryOptions = {}): QueryResult {
  const budget = options.budget ?? 2000;
  const limit = options.limit ?? 12;
  const terms = tokenize(question);
  const weightOf = termWeights(graph, terms);
  const index = indexFor(graph);

  const scored: QueryMatch[] = [];
  for (const node of graph.nodes) {
    if (node.kind === 'file' || node.kind === 'external') continue;
    const { score, why } = scoreNode(node, terms, weightOf);
    if (score > 0) scored.push({ node, score: round(score * (1 + IMPORTANCE_WEIGHT * node.importance)), why });
  }
  scored.sort((a, b) => b.score - a.score || a.node.qualifiedName.localeCompare(b.node.qualifiedName));

  const seeds = scored.slice(0, limit);
  const { context, tokensEstimate } = buildContext(graph, index, question, seeds, budget);

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
  const terms = tokenize(question);
  const weightOf = termWeights(graph, terms);
  const index = indexFor(graph);
  const queryVec = await options.embedder.embedQuery(question);

  // Raw lexical scores (pre-importance) for normalization.
  const lexRaw = new Map<string, number>();
  let lexMax = 0;
  const whyById = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind === 'file' || node.kind === 'external') continue;
    const { score, why } = scoreNode(node, terms, weightOf);
    lexRaw.set(node.id, score);
    whyById.set(node.id, why);
    if (score > lexMax) lexMax = score;
  }

  const scored: QueryMatch[] = [];
  for (const node of graph.nodes) {
    if (node.kind === 'file' || node.kind === 'external') continue;
    const lexNorm = lexMax > 0 ? (lexRaw.get(node.id) ?? 0) / lexMax : 0;
    const vec = options.nodeVectors.get(node.id);
    const sem = vec ? Math.max(0, cosine(queryVec, vec)) : 0;
    const hybrid = 0.5 * lexNorm + 0.5 * sem;
    if (hybrid <= 0) continue;
    const lexWhy = whyById.get(node.id);
    const why = lexWhy || (sem > 0.3 ? `semantic match (${sem.toFixed(2)})` : 'weak match');
    scored.push({ node, score: round(hybrid * (1 + IMPORTANCE_WEIGHT * node.importance)), why });
  }
  scored.sort((a, b) => b.score - a.score || a.node.qualifiedName.localeCompare(b.node.qualifiedName));

  const seeds = scored.slice(0, limit);
  const { context, tokensEstimate } = buildContext(graph, index, question, seeds, budget);
  return { question, matches: seeds, context, tokensEstimate };
}

function tokenize(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
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

/** camelCase / snake_case / kebab split of an identifier → lowercased parts. */
export function identifierParts(name: string): Set<string> {
  return new Set(
    name
      .split(/[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
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
): { context: string; tokensEstimate: number } {
  const lines: string[] = [];
  lines.push(`# Context for: ${question}`);
  lines.push('');
  if (seeds.length === 0) {
    lines.push('_No matching symbols found in the map. Try different terms, or `vg hubs` for the most important code._');
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
