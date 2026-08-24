import { indexFor, type GraphIndex } from './relations.js';
import { cosine, type Embedder } from './embeddings.js';
import type { SanitizedRank } from './relevance-provider.js';
import type { GraphNode, VgGraph } from '../schema.js';
import { userAskFromInstruction } from './user-ask.js';

/**
 * Retrieval front-end for `vg ask` / `vg code` capsule seeds (VG-CLI-SPEC
 * §3.2).
 *
 * Since the 2026-08 relevance relocation, the RANKING ENGINE lives in the
 * optional relevance module (`@vibgrate/relevance`, auto-provisioned): the
 * async callers run the ask through the module via
 * `relevance-provider.rankQuestion` and pass the SANITIZED result in as
 * `options.ranked`. This file keeps only what is mechanical:
 *
 *  - literal string/URL needle handling (the locate path — exact-text
 *    matching, not relevance);
 *  - a deliberately dumb module-less fallback: exact identifier-name and
 *    name-part matching, nothing that understands language (no lexicon, no
 *    term roles, no IDF, no typo repair, no expansion) — enough that an ask
 *    NAMING a symbol still pins its file when the module is unavailable;
 *  - context-block rendering and the semantic Reciprocal Rank Fusion
 *    plumbing (`--semantic`), which fuses ORDERINGS and carries no ranking
 *    heuristics of its own.
 */

export interface QueryOptions {
  budget?: number; // approx token budget for the context block (default 2000)
  limit?: number; // max seed matches to expand (default 12)
  /** Sanitized module ranking (engine/relevance-provider.ts rankQuestion),
   *  injected by async callers so this module stays pure and sync. When
   *  absent — module not installed, predates the ranking API, or failed —
   *  the mechanical fallback below answers. */
  ranked?: SanitizedRank | null;
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

/**
 * Function-word hygiene for the mechanical fallback tokenizer. This is NOT a
 * relevance stopword model (that moved into the module): nothing here scores,
 * ranks, weights, or reorders anything. It is a purely SUBTRACTIVE floor —
 * the words a caller uses to FRAME an ask rather than to name the code they
 * mean, which therefore cannot be identifier evidence.
 *
 * The floor exists because `mechanicalRank` treats every surviving token as
 * equal evidence, and English framing words collide with real identifier
 * parts constantly. Without it, `"add a new feature"` scores `AddBlogForm`
 * on the camel-part tier (`add`) and `FeatureFlagStore` (`feature`) and fills
 * the entire seed window — a grab-bag Task Capsule for an ask that named
 * nothing. That is the capsule-poisoning failure of the 2026-07 field report,
 * and an empty result is the correct answer.
 *
 * Note this is the floor ONLY. Deciding which of several genuine candidates
 * is most relevant remains the module's job, and no part of that logic —
 * term roles, weighting, expansion, morphology — belongs in this file.
 */
const FUNCTION_WORDS = new Set([
  // Closed-class English: could only ever match by coincidence.
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
  'where', 'what', 'which', 'how', 'do', 'does', 'did', 'i', 'we', 'it', 'this', 'that', 'with',
  'when', 'who', 'why', 'can', 'should', 'my', 'our', 'you', 'your', 'from', 'by', 'at', 'as',
  // Process verbs. A caller says what they want DONE with these; they never
  // name the code it should be done to. Left in, bare `add` seeds every
  // Add*/*Add* symbol in the repo ahead of the terms that carry the subject.
  'add', 'adds', 'added', 'adding',
  'create', 'creates', 'created', 'creating',
  'make', 'makes', 'making', 'made',
  'remove', 'removes', 'removed', 'removing',
  'delete', 'deletes', 'deleted', 'deleting',
  'update', 'updates', 'updated', 'updating',
  'change', 'changes', 'changed', 'changing',
  'set', 'sets', 'setting', 'setup', 'get', 'gets', 'getting',
  'use', 'uses', 'used', 'using', 'want', 'wants', 'wanted', 'doing', 'done',
  'support', 'supports', 'supported', 'supporting',
  'enable', 'enables', 'enabled', 'enabling',
  'disable', 'disables', 'disabled', 'disabling',
  'allow', 'allows', 'allowed', 'handle', 'handles', 'handling',
  'implement', 'implements', 'implemented', 'implementing',
  'build', 'builds', 'building', 'built', 'need', 'needs', 'needed',
  // Filler nouns and connectives: the generic scaffolding of a request.
  'new', 'newly', 'via', 'through', 'into', 'onto',
  'way', 'ways', 'thing', 'things', 'stuff',
  'feature', 'features', 'functionality',
  'method', 'methods', 'option', 'options', 'ability',
  'form', 'forms', 'page', 'pages', 'screen', 'screens', 'button', 'buttons',
  'help', 'start', 'begin', 'work', 'works', 'working',
  'also', 'currently', 'properly', 'correctly', 'please',
  'happens', 'happen', 'something', 'somewhere',
  'step', 'steps', 'flow', 'process',
  // Discovery-question scaffolding: words that FRAME the search itself
  // ("find the code responsible for X", "explain how X works").
  'find', 'code', 'responsible', 'modify', 'me',
  'implementation', 'explain', 'codebase', 'contains', 'file',
  // Bug-report framing: says something is WRONG, never what is wrong.
  // `fix` alone lit up `export_fixed_width_records`, `out` lit up every
  // *Router*/*rollout* symbol (vg code prompt-relevance corpus).
  'fix', 'fixes', 'fixing', 'bug', 'bugs', 'broken', 'busted', 'borked',
  'wrong', 'incorrect', 'incorrectly', 'figure', 'out', 'sure',
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
  // Drop host-injected "User attachments" appendix (backticked image paths)
  // before classify — same rule as buildCodeContext. Avoids treating a screenshot
  // filename as a locate-only occurrence search.
  const q = userAskFromInstruction(instruction).trim();
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
  const literals = extractLiteralNeedles(question);
  const index = indexFor(graph);

  let seeds: QueryMatch[];
  if (options.ranked) {
    // Module ranking (already sanitized: every id names a real symbol).
    // An honest miss from the engine stays an honest miss here.
    const byId = new Map<string, GraphNode>();
    for (const node of graph.nodes) byId.set(node.id, node);
    seeds = options.ranked.hasContent
      ? options.ranked.seeds
          .map((s) => {
            const node = byId.get(s.id);
            return node ? { node, score: s.score, why: s.why } : null;
          })
          .filter((m): m is QueryMatch => m !== null)
          .slice(0, limit)
      : [];
  } else {
    seeds = mechanicalRank(graph, question, literals).slice(0, limit);
  }

  const { context, tokensEstimate } = buildContext(graph, index, question, seeds, budget, literals);
  return { question, matches: seeds, context, tokensEstimate };
}

/**
 * The module-less fallback: mechanical identifier matching, deliberately free
 * of language understanding. A token scores only when it IS a symbol's name,
 * one of its camel/snake parts, or (length ≥ 4) a substring of the qualified
 * name — so "write tests for chargeCard" or a pasted `src/…/File.ts` path
 * still pins the right file, while intent phrasings honestly miss until the
 * relevance module is available. No lexicon, no term roles, no IDF, no typo
 * repair, no expansions — that is the module's job now.
 */
function mechanicalRank(graph: VgGraph, question: string, literals: string[]): QueryMatch[] {
  const forTokens = literals.length > 0 ? stripLiteralNeedles(question) : question;
  let tokens = tokenize(forTokens);
  // A literal ask's residual framing ("does not exist", "find occurrences")
  // must not light up DoesNot*/NonExisting*/commandExists lookalikes — the
  // honest-miss contract of the locate path holds module-less too.
  if (literals.length > 0) tokens = tokens.filter((t) => !LOCATE_SCAFFOLD.has(t));
  if (tokens.length === 0) return [];
  const scored: QueryMatch[] = [];
  for (const node of graph.nodes) {
    if (node.kind === 'file' || node.kind === 'external') continue;
    const name = node.name.toLowerCase();
    const qn = node.qualifiedName.toLowerCase();
    const parts = identifierParts(node.name);
    let score = 0;
    const hits: string[] = [];
    for (const t of tokens) {
      if (name === t) {
        score += 10;
        hits.push(t);
      } else if (parts.has(t)) {
        score += 6;
        hits.push(t);
      } else if (t.length >= 4 && qn.includes(t)) {
        score += 3;
        hits.push(t);
      }
    }
    if (score > 0) {
      scored.push({
        node,
        score: round(score * (1 + IMPORTANCE_WEIGHT * node.importance)),
        why: `matched: ${hits.join(', ')}`,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.node.qualifiedName.localeCompare(b.node.qualifiedName));
  return diversifyByFile(scored);
}

function tokenize(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 1 && !FUNCTION_WORDS.has(t)),
    ),
  ];
}

/**
 * Importance is a mild tiebreaker, not a doubling: at 0.4 a top hub adds at
 * most 40%, enough to break genuine ties without overriding term evidence.
 */
const IMPORTANCE_WEIGHT = 0.4;

/** Residual framing of a string/URL locate ask — never symbol evidence. */
const LOCATE_SCAFFOLD = new Set([
  'not', 'no', 'exist', 'exists', 'existing', 'occurrence', 'occurrences',
  'occurence', 'occurences', 'find', 'every', 'place', 'places', 'string',
  'literal', 'text', 'search', 'locate', 'look', 'looking', 'show', 'list', 'all',
]);

/**
 * Stable file-diversity pass over the ranked list: each file's best node
 * keeps its rank; further nodes from an already-represented file are demoted
 * behind the first representative of every other matching file (never
 * dropped). Mechanical presentation hygiene — the seed window is a coverage
 * budget either way.
 */
function diversifyByFile(matches: QueryMatch[]): QueryMatch[] {
  const seen = new Set<string>();
  const firstPerFile: QueryMatch[] = [];
  const rest: QueryMatch[] = [];
  for (const m of matches) {
    if (seen.has(m.node.file)) {
      rest.push(m);
    } else {
      seen.add(m.node.file);
      firstPerFile.push(m);
    }
  }
  return firstPerFile.concat(rest);
}

export interface SemanticQueryOptions extends QueryOptions {
  /** Local embedder. Optional only when {@link semanticRanked} supplies the pass. */
  embedder?: Embedder;
  /** Precomputed node vectors (from getNodeEmbeddings); falls back to lexical for nodes without one. */
  nodeVectors?: Map<string, number[]>;
  /**
   * A semantic pass someone else already ran — vgd ranking the question
   * against its resident slot index. Supplied instead of `embedder` +
   * `nodeVectors` so the caller pays neither a model load nor a vector scan,
   * and no vectors cross the socket.
   *
   * Only the ORDER of this list is consumed (RRF fuses rankings, not scores),
   * so a truncated top-K is not an approximation: a candidate ranked past a
   * few hundred cannot reach a 12-row answer.
   */
  semanticRanked?: Array<{ id: string; score: number }>;
}

/**
 * Reciprocal Rank Fusion constant (the standard k=60). Fusing RANKINGS
 * instead of blending raw scores removes the need to calibrate two
 * incomparable scales: a node's fused score is Σ 1/(k + rankᵢ) over the
 * lists it appears in, so agreement between signals dominates and a single
 * signal's outlier magnitude cannot.
 */
const RRF_K = 60;

/** 1-based ranks for a scored id list (desc score, qualifiedName tiebreak). */
function ranksOf(scores: Map<string, number>, nameOf: (id: string) => string): Map<string, number> {
  const ids = [...scores.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1] || nameOf(a[0]).localeCompare(nameOf(b[0])))
    .map(([id]) => id);
  return new Map(ids.map((id, i) => [id, i + 1]));
}

/**
 * Hybrid retrieval, combined with Reciprocal Rank Fusion: the module ranking
 * (or the mechanical fallback) is one arm, the local-embedding pass the
 * other, so a question like "where do we handle auth failures?" can surface
 * `verify_token` even with no shared word. Deterministic given the same
 * model + cached vectors; embeddings live in a binary sidecar next to the
 * map, never in `graph.json`.
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
  const residualTokens = tokenize(forTokens);
  // Embed the residual ask (without URL/quote noise) so semantic neighbours
  // aren't dragged toward package names that share host path segments. Skipped
  // entirely when the ranking arrives pre-computed (vgd already embedded it).
  const queryVec = options.semanticRanked
    ? null
    : await options.embedder?.embedQuery(forTokens || question);
  const index = indexFor(graph);

  // Lexical arm: module ranking order when available, mechanical otherwise.
  // RRF consumes only the ORDER. An honest miss contributes an empty arm.
  const lexRaw = new Map<string, number>();
  const whyById = new Map<string, string>();
  const lexSeeds = options.ranked
    ? options.ranked.hasContent
      ? options.ranked.seeds.map((s) => ({ id: s.id, score: s.score, why: s.why }))
      : []
    : mechanicalRank(graph, question, literals).map((m) => ({ id: m.node.id, score: m.score, why: m.why }));
  for (const s of lexSeeds) {
    lexRaw.set(s.id, s.score);
    whyById.set(s.id, s.why);
  }

  const scored: QueryMatch[] = [];
  // Literal-only asks: skip the semantic loop entirely — embeddings over
  // "does not exist find occurrences" still surface unrelated hubs.
  if (residualTokens.length > 0 || literals.length === 0) {
    const semRaw = new Map<string, number>();
    const nodeById = new Map<string, GraphNode>();
    for (const node of graph.nodes) {
      if (node.kind === 'file' || node.kind === 'external') continue;
      nodeById.set(node.id, node);
      if (options.semanticRanked || !queryVec) continue;
      const vec = options.nodeVectors?.get(node.id);
      const sem = vec && residualTokens.length > 0 ? Math.max(0, cosine(queryVec, vec)) : 0;
      if (sem > 0) semRaw.set(node.id, sem);
    }
    if (options.semanticRanked && residualTokens.length > 0) {
      // Ignore ids the ranking knows about but this graph no longer has: the
      // daemon's index can be one publish behind a locally refreshed map.
      for (const { id, score } of options.semanticRanked) {
        if (score > 0 && nodeById.has(id)) semRaw.set(id, score);
      }
    }
    const nameOf = (id: string) => nodeById.get(id)?.qualifiedName ?? id;
    const lexRanks = ranksOf(lexRaw, nameOf);
    const semRanks = ranksOf(semRaw, nameOf);
    for (const [id, node] of nodeById) {
      const lr = lexRanks.get(id);
      const sr = semRanks.get(id);
      if (lr === undefined && sr === undefined) continue;
      const fused = (lr !== undefined ? 1 / (RRF_K + lr) : 0) + (sr !== undefined ? 1 / (RRF_K + sr) : 0);
      const sem = semRaw.get(id) ?? 0;
      const lexWhy = whyById.get(id);
      const why = lexWhy || (sem > 0.3 ? `semantic match (${sem.toFixed(2)})` : 'weak match');
      scored.push({ node, score: round(fused * (1 + IMPORTANCE_WEIGHT * node.importance)), why });
    }
    scored.sort((a, b) => b.score - a.score || a.node.qualifiedName.localeCompare(b.node.qualifiedName));
  }

  const seeds = diversifyByFile(scored).slice(0, limit);
  const { context, tokensEstimate } = buildContext(graph, index, question, seeds, budget, literals);
  return { question, matches: seeds, context, tokensEstimate };
}

/**
 * camelCase / snake_case / kebab / letter↔digit split of an identifier →
 * lowercased parts. The separator alternative is Unicode-letter-aware
 * (`\p{L}\p{N}`, not ASCII-only) so non-Latin identifiers split on
 * punctuation without losing every character to it; the camelCase boundary
 * lookaround stays ASCII-only since casing is itself an ASCII-script concept.
 * Letter↔digit boundaries split too, so `Session2` keeps `session` reachable.
 */
export function identifierParts(name: string): Set<string> {
  return new Set(
    name
      .split(/[^\p{L}\p{N}]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[\p{L}])(?=[0-9])|(?<=[0-9])(?=[\p{L}])/u)
      .filter(Boolean)
      .map((s) => s.toLowerCase()),
  );
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
