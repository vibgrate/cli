import { indexFor, type GraphIndex } from './relations.js';
import { cosine, type Embedder } from './embeddings.js';
import { WEAK_TERMS, expandConcepts, bigramConsumedTokens } from './concepts.js';
import type { RelevanceAnalysis } from './relevance-provider.js';
import type { GraphNode, VgGraph } from '../schema.js';
import { userAskFromInstruction } from './user-ask.js';

/**
 * Deterministic retrieval for `vg ask` (VG-CLI-SPEC §3.2).
 *
 * Builds a structured, fact-annotated, budget-bounded context block for a
 * question — designed to drop straight into an assistant's context. The default
 * is deterministic lexical+structural retrieval: identifier/term matching with
 * morphological prefix-fuzzing, term-role weighting (process verbs like "add"
 * only corroborate, never seed — see engine/concepts.ts), static concept
 * expansion ("payments" → stripe/billing/…, "direct debit" → sepa/bacs/mandate),
 * and a multi-term coverage bonus, ranked with importance as a mild tiebreaker.
 * `--semantic`/`--deep` adds
 * a hybrid local-embedding pass (`queryGraphSemantic`) that surfaces conceptually
 * related code even when no word is shared — still no API key.
 */

export interface QueryOptions {
  budget?: number; // approx token budget for the context block (default 2000)
  limit?: number; // max seed matches to expand (default 12)
  /** Optional pre-computed relevance analysis (engine/relevance-provider.ts).
   *  Injected by async callers so this module stays pure and sync; when
   *  absent, ranking is exactly the built-in lexicon path. */
  relevance?: RelevanceAnalysis | null;
  /** Optional per-node topic tags (engine/relevance-enrich.ts). Combined with
   *  `relevance.topics` into a bounded affinity bonus: a node structurally
   *  tagged with a topic the question is about ranks above an equal textual
   *  match outside it. Never seeds alone — it multiplies existing evidence. */
  topicTags?: Map<string, readonly string[]> | null;
  /** Previous conversational ask (multi-turn `vg code`). Its content terms —
   *  never its process verbs — join ranking at a damped weight (CARRY_WEIGHT)
   *  so a follow-up like "can we use direct debits?" keeps the prior turn's
   *  topic ("where is stripe used?") instead of ranking the repo on the
   *  follow-up's words alone. Absent → behaviour is unchanged. */
  priorQuestion?: string | null;
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
  // When the ask embeds a URL or quoted string, score symbols only on the
  // residual framing text. Empty residual → empty matches (honest miss) rather
  // than path-token false positives that poison Task Capsules.
  const literals = extractLiteralNeedles(question);
  const forTokens = literals.length > 0 ? stripLiteralNeedles(question) : question;
  const prep = prepareTerms(forTokens, options.relevance, priorResidual(options.priorQuestion));
  const weightOf = termWeights(graph, prep.terms.map((t) => t.term));
  const index = indexFor(graph);

  const scored: QueryMatch[] = [];
  // Two honest-miss paths: literal-only locate (no identifier terms after
  // stripping needles) and weak-only asks ("add a new feature") whose every
  // term is a process verb — seeding those from `add*`/`create*` surface
  // matches is exactly the capsule-poisoning failure (field report 2026-07).
  if (prep.hasContent) {
    for (const node of graph.nodes) {
      if (node.kind === 'file' || node.kind === 'external') continue;
      const { score, why } = scoreNode(node, prep.terms, weightOf);
      if (score > 0) {
        const affinity = topicAffinity(node.id, options.relevance, options.topicTags);
        scored.push({
          node,
          score: round(score * affinity.boost * (1 + IMPORTANCE_WEIGHT * node.importance)),
          why: why + affinity.label,
        });
      }
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
 * Reciprocal Rank Fusion constant (the standard k=60). Fusing RANKINGS
 * instead of blending raw scores removes the need to calibrate two
 * incomparable scales (tiered lexical evidence vs cosine similarity): a node's
 * fused score is Σ 1/(k + rankᵢ) over the lists it appears in, so agreement
 * between signals dominates and a single signal's outlier magnitude cannot.
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
 * Hybrid lexical + local-embedding retrieval, combined with Reciprocal Rank
 * Fusion (Phase 3.2 — replaces the former 50/50 score blend), so a question
 * like "where do we handle auth failures?" can surface `verify_token` even
 * with no shared identifier. Topic affinity and importance stay multiplicative
 * tiebreakers on the fused score. Deterministic given the same model + cached
 * vectors; embeddings live in a binary sidecar next to the map, never in `graph.json`.
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
  const prep = prepareTerms(forTokens, options.relevance, priorResidual(options.priorQuestion));
  const terms = prep.terms.map((t) => t.term);
  const weightOf = termWeights(graph, terms);
  const index = indexFor(graph);
  // Embed the residual ask (without URL/quote noise) so semantic neighbours
  // aren't dragged toward package names that share host path segments.
  const queryVec = await options.embedder.embedQuery(forTokens || question);

  // Raw lexical scores (pre-importance) — RRF consumes only their ORDER.
  // Weak-only asks get no lexical evidence (same suppression as queryGraph);
  // the semantic cosine below may still surface conceptual neighbours for them.
  const lexRaw = new Map<string, number>();
  const whyById = new Map<string, string>();
  if (prep.hasContent) {
    for (const node of graph.nodes) {
      if (node.kind === 'file' || node.kind === 'external') continue;
      const { score, why } = scoreNode(node, prep.terms, weightOf);
      lexRaw.set(node.id, score);
      whyById.set(node.id, why);
    }
  }

  const scored: QueryMatch[] = [];
  // Literal-only asks: skip the semantic loop entirely — embeddings over
  // "does not exist find occurrences" still surface unrelated hubs.
  if (terms.length > 0 || literals.length === 0) {
    // Independent per-signal rankings, then RRF.
    const semRaw = new Map<string, number>();
    const nodeById = new Map<string, GraphNode>();
    for (const node of graph.nodes) {
      if (node.kind === 'file' || node.kind === 'external') continue;
      nodeById.set(node.id, node);
      const vec = options.nodeVectors.get(node.id);
      const sem = vec && terms.length > 0 ? Math.max(0, cosine(queryVec, vec)) : 0;
      if (sem > 0) semRaw.set(node.id, sem);
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
      const affinity = topicAffinity(id, options.relevance, options.topicTags);
      const why = (lexWhy || (sem > 0.3 ? `semantic match (${sem.toFixed(2)})` : 'weak match')) + affinity.label;
      scored.push({ node, score: round(fused * affinity.boost * (1 + IMPORTANCE_WEIGHT * node.importance)), why });
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

/** Ordered, lowercased token stream WITH stopwords — bigram concepts ("sign in",
 *  "direct debit") need adjacency over the raw word order. */
function tokenizeOrdered(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 1);
}

/**
 * A query term with its role resolved. Roles decide how much evidence a match
 * carries (see scoreNode):
 *  - content  — names the topic; full weight, counts toward coverage
 *  - weak     — process verb ("add", "create", "via"); down-weighted, can only
 *               corroborate a content match, never carry a seed alone
 *  - expansion — concept vocabulary from the lexicon ("payments"→"stripe");
 *               reduced weight, counts as content evidence, provenance in `why`
 */
interface QueryTerm {
  term: string;
  weak: boolean;
  /** Source token/bigram when this term came from concept expansion. */
  from?: string;
  /** Provider-supplied confidence (0..1) when this term came from the optional
   *  relevance provider; replaces the flat EXPANSION_WEIGHT for that term. */
  providerWeight?: number;
  /** True when this term was carried over from the previous conversational
   *  turn (QueryOptions.priorQuestion); scores at CARRY_WEIGHT. */
  carried?: boolean;
}

interface PreparedTerms {
  terms: QueryTerm[];
  /** True when at least one content or expansion term exists — the bar a
   *  question must clear before ANY node may seed. */
  hasContent: boolean;
}

/** Weak process verbs corroborate at a fraction of a content term's weight. */
const WEAK_TERM_WEIGHT = 0.25;
/** Concept expansions score below a literal question term of the same rarity. */
const EXPANSION_WEIGHT = 0.7;
/** Per extra distinct content term matched, the multiplicative coverage bonus.
 *  Multi-topic evidence ("direct" + "debit" + "payments") must beat any
 *  single-term surface hit ("add") by construction, not by luck. */
const COVERAGE_BONUS = 0.35;
/** Terms carried from the previous conversational turn score at half weight:
 *  enough to keep a follow-up anchored to the conversation's topic (and to
 *  rescue weak-only follow-ups like "can we use it?"), never enough for stale
 *  context to outrank a clearly-named new topic in the current ask. */
const CARRY_WEIGHT = 0.5;

/** Resolve term roles + concept expansions for the residual ask text. */
function prepareTerms(forTokens: string, relevance?: RelevanceAnalysis | null, prior?: string | null): PreparedTerms {
  const base = tokenize(forTokens);
  const ordered = tokenizeOrdered(forTokens);
  const baseSet = new Set(base);
  // A token consumed by a fired bigram concept ("direct" in "direct debits")
  // is demoted to the weak role: the bigram's expansions carry the topic, and
  // the constituent alone is a distractor magnet (directGet, redirectUrl, …).
  const consumed = bigramConsumedTokens(ordered);
  const terms: QueryTerm[] = base.map((t) => ({ term: t, weak: WEAK_TERMS.has(t) || consumed.has(t) }));
  const have = new Set(base);
  for (const e of expandConcepts(ordered)) {
    if (baseSet.has(e.term)) continue;
    terms.push({ term: e.term, weak: false, from: e.from });
    have.add(e.term);
  }
  // Provider expansions (already sanitized by engine/relevance-provider.ts)
  // join as expansion-role terms with their own confidence weight. The
  // built-in lexicon wins ties: a term it already produced is not re-added,
  // so provider presence never changes the score of a lexicon-covered term.
  for (const e of relevance?.expansions ?? []) {
    if (have.has(e.term)) continue;
    terms.push({ term: e.term, weak: false, from: e.from, providerWeight: e.weight });
    have.add(e.term);
  }
  // Conversation carry-over: the previous turn's CONTENT terms (plus their
  // lexicon expansions) join at CARRY_WEIGHT. Weak process verbs from the
  // prior turn are dropped outright — carrying "add"/"use" forward would
  // re-open the grab-bag failure this module exists to prevent. A term the
  // current ask already produced is never re-added, so the current turn
  // always wins ties and single-turn behaviour is byte-identical.
  if (prior?.trim()) {
    const priorOrdered = tokenizeOrdered(prior);
    const priorConsumed = bigramConsumedTokens(priorOrdered);
    for (const t of tokenize(prior)) {
      if (have.has(t) || WEAK_TERMS.has(t) || priorConsumed.has(t)) continue;
      terms.push({ term: t, weak: false, carried: true });
      have.add(t);
    }
    for (const e of expandConcepts(priorOrdered)) {
      if (have.has(e.term)) continue;
      terms.push({ term: e.term, weak: false, from: e.from, carried: true });
      have.add(e.term);
    }
  }
  const hasContent = terms.some((t) => !t.weak);
  return { terms, hasContent };
}

/** Residual text of the previous ask, with URL/quoted needles stripped so a
 *  pasted link in turn N-1 cannot poison turn N's carried vocabulary. */
function priorResidual(prior: string | null | undefined): string | null {
  const raw = prior?.trim();
  if (!raw) return null;
  return extractLiteralNeedles(raw).length > 0 ? stripLiteralNeedles(raw) : raw;
}

/**
 * Plain-language concept map for one ask: how its words were interpreted —
 * fired concept/bigram expansions, relevance-kernel topics and vocabulary,
 * and terms carried from the previous conversational turn. Rendered into the
 * Task Capsule so a model (especially a small local one) can read the
 * inference chain ("direct debits" → debit/mandate/…; topic payments →
 * stripe/billing/…) as sentences instead of reverse-engineering the `a→b`
 * slugs in per-seed match provenance. Deterministic and bounded; empty when
 * nothing fired (honest-empty asks stay empty).
 */
export function conceptMapLines(
  question: string,
  relevance?: RelevanceAnalysis | null,
  priorQuestion?: string | null,
): string[] {
  const cap = (xs: string[]) => [...new Set(xs)].slice(0, 8).join(', ');
  const literals = extractLiteralNeedles(question);
  const residual = literals.length > 0 ? stripLiteralNeedles(question) : question;
  const lines: string[] = [];

  // Lexicon / bigram expansions, grouped by the ask term that fired them.
  const byFrom = new Map<string, string[]>();
  for (const e of expandConcepts(tokenizeOrdered(residual))) {
    const list = byFrom.get(e.from) ?? [];
    list.push(e.term);
    byFrom.set(e.from, list);
  }
  for (const [from, terms] of byFrom) {
    lines.push(`- "${from}" in the ask implies these codebase identifiers: ${cap(terms)}.`);
  }

  // ---------------------------------------------------------------------
  // What the ask is about, deepest first.
  //
  // Order is the message. A reader (or a model) wants the most specific thing
  // first — "cname" — then the product that makes it concrete — "cloudflare" —
  // then the containing levels, widening out to "infrastructure". Files come
  // after that, because they are where to look once you know what you are
  // looking for. Corrections come last: they explain how the ask was read,
  // which only matters once the reading itself is on the page.
  // ---------------------------------------------------------------------
  const matches = relevance?.taxonomy ?? [];
  if (matches.length) {
    // Every matched level, deduped, deepest first. Ties keep provider order,
    // which is evidence-ranked.
    const seenPath = new Set<string>();
    const levels: Array<{ path: string; id: string; depth: number; terms: string[] }> = [];
    for (const m of matches) {
      for (const l of m.levels) {
        if (seenPath.has(l.path)) continue;
        seenPath.add(l.path);
        levels.push({ path: l.path, id: l.id, depth: l.path.split('/').length, terms: l.terms });
      }
    }
    const deepest = Math.max(...levels.map((l) => l.depth));
    const describe = (l: { id: string; terms: string[] }, lead: string) =>
      l.terms.length
        ? `${lead} ${l.id}; code for it typically uses: ${cap(l.terms)}.`
        : `${lead} ${l.id}.`;

    for (const l of levels.filter((l) => l.depth === deepest)) {
      lines.push(describe(l, '- The ask is specifically about'));
    }

    // The product named sits directly under the most specific topic — it is
    // what turns that topic into this codebase's version of it. When the
    // product IS the most specific topic, the line above already said so, and
    // only the typed form is worth adding.
    const deepestIds = new Set(levels.filter((l) => l.depth === deepest).map((l) => l.id));
    for (const v of (relevance?.vendors ?? []).filter((v) => v.score > 0).slice(0, 3)) {
      if (deepestIds.has(v.name)) {
        if (v.from !== v.name) lines.push(`- That product was typed "${v.from}".`);
        continue;
      }
      lines.push(
        v.from === v.name
          ? `- It names the product "${v.name}".`
          : `- It names the product "${v.name}" (typed "${v.from}").`,
      );
    }

    // Then widen, one level at a time — skipping any level the vendor line
    // already named, so a Cloudflare ask does not say "cloudflare" twice.
    const named = new Set((relevance?.vendors ?? []).map((v) => v.name));
    for (let d = deepest - 1; d >= 1; d--) {
      for (const l of levels.filter((l) => l.depth === d && !named.has(l.id))) {
        lines.push(describe(l, '- More broadly, this is'));
      }
    }
  } else if (relevance?.topics?.length) {
    // Provider without a taxonomy (or an older one): flat topics, as before.
    const topicVocab = new Map<string, string[]>();
    for (const e of relevance.expansions ?? []) {
      const list = topicVocab.get(e.from) ?? [];
      list.push(e.term);
      topicVocab.set(e.from, list);
    }
    for (const t of relevance.topics.slice(0, 3)) {
      const vocab = topicVocab.get(t.id);
      lines.push(
        vocab?.length
          ? `- The ask is about the "${t.id}" domain; code for it typically uses: ${cap(vocab)}.`
          : `- The ask is about the "${t.id}" domain.`,
      );
    }
  }

  // What governs the work, named at the revision the provider tracks. This is
  // the difference between "this is accessibility work" and "this is
  // accessibility work, and WCAG 2.2 is what it has to satisfy".
  const standards = relevance?.standards ?? [];
  if (standards.length) {
    const specs = standards.filter((st) => st.kind !== 'regulation');
    const rules = standards.filter((st) => st.kind === 'regulation');
    const render = (list: typeof standards) =>
      list
        .slice(0, 3)
        .map((st) => (st.publisher ? `${st.name} (${st.publisher})` : st.name))
        .join('; ');
    // A spec and a legal duty are not the same obligation, so they are not
    // pooled into one sentence.
    if (specs.length) lines.push(`- Standards that govern this area: ${render(specs)}.`);
    if (rules.length) lines.push(`- Regulations that apply here: ${render(rules)}.`);
  }

  // The site's own category slugs for everything above, so a reader (or a
  // lookup) can cross-reference content by the same key.
  const categories = relevance?.categories ?? [];
  if (categories.length) {
    lines.push(`- Related categories: ${cap(categories)}.`);
  }

  // Where that work usually lives — the concrete lead, after the abstract one.
  const fileHints = relevance?.files ?? [];
  if (fileHints.length) {
    lines.push(`- Files for this kind of work are usually named or extended: ${cap(fileHints)}.`);
  }

  // How the ask was read, if it was read as something other than typed.
  for (const c of (relevance?.corrections ?? []).slice(0, 3)) {
    lines.push(`- Read "${c.from}" in the ask as "${c.to}".`);
  }

  // Conversation carry-over provenance.
  const priorText = priorResidual(priorQuestion);
  if (priorText) {
    const current = new Set(tokenize(residual));
    const consumed = bigramConsumedTokens(tokenizeOrdered(priorText));
    const carried = tokenize(priorText).filter((t) => !current.has(t) && !WEAK_TERMS.has(t) && !consumed.has(t));
    if (carried.length) {
      lines.push(`- This is a follow-up; topic words carried from the previous ask: ${cap(carried)}.`);
    }
  }

  if (lines.length) {
    lines.push(
      '- Seed notation below: `a→b` = ask term "a" implied identifier "b"; `~t` = word-form match; `↩t` = carried from the previous ask.',
    );
  }
  return lines;
}

function scoreNode(node: GraphNode, terms: QueryTerm[], weightOf: (t: string) => number = () => 1): { score: number; why: string } {
  let score = 0;
  let contentHits = 0;
  const hits: string[] = [];
  const name = node.name.toLowerCase();
  const qn = node.qualifiedName.toLowerCase();
  const file = node.file.toLowerCase();
  // Directory segments of the file path: a term naming a whole directory
  // ("payments" → src/payments/…) is domain evidence, stronger than an
  // incidental substring somewhere in the path.
  const dirSegments = new Set(file.split('/').slice(0, -1));
  // Split the ORIGINAL name on camelCase / snake_case, then lowercase the parts
  // (splitting must see the capitals, so it happens before lowercasing).
  const nameParts = identifierParts(node.name);
  for (const { term: t, weak, from, providerWeight, carried } of terms) {
    // Each term's contribution is weighted by its specificity (IDF over symbol
    // names): a match on a distinctive term ("toComparable", "layoutFor") counts
    // for more than a match on a term shared by hundreds of symbols ("code",
    // "get", "run"). Without this, an incidental exact-name hit on a common word
    // in a natural-language question outranked the conceptually-correct symbol,
    // and importance weighting amplified the wrong hit (VG-NAVIGATION trace).
    // Role multipliers stack on top: process verbs corroborate at a fraction,
    // concept expansions score below a literal term of the same rarity.
    // Expansion role multiplier: provider expansions carry their own 0..1
    // confidence (capped at the lexicon's EXPANSION_WEIGHT so an installed
    // provider can widen vocabulary but never outrank the reviewed lexicon's
    // evidence class); lexicon expansions keep the flat EXPANSION_WEIGHT.
    const expansionW = providerWeight !== undefined ? Math.min(providerWeight, EXPANSION_WEIGHT) : from ? EXPANSION_WEIGHT : 1;
    const w = weightOf(t) * (weak ? WEAK_TERM_WEIGHT : 1) * expansionW * (carried ? CARRY_WEIGHT : 1);
    const label = (carried ? '↩' : '') + (from ? `${from}→${t}` : t);
    let contribution = 0;
    if (name === t) {
      contribution = 10 * w;
      hits.push(label);
    } else if (nameParts.has(t)) {
      contribution = 6 * w;
      hits.push(label);
    } else if (name.includes(t)) {
      contribution = 4 * w;
      hits.push(label);
    } else if (qn.includes(t)) {
      contribution = 3 * w;
      hits.push(label);
    } else if (fuzzyPartMatch(t, nameParts)) {
      // Morphological / subword match: "authentication" ↔ "authenticate"
      // (shared prefix), so lexical ask survives word-form differences without
      // a model. The semantic path handles non-shared-root synonyms.
      contribution = 2 * w;
      hits.push((carried ? '↩' : '') + (from ? `~${from}→${t}` : `~${t}`));
    } else if (dirSegments.has(t)) {
      contribution = 2 * w;
      hits.push(label);
    } else if (file.includes(t)) {
      contribution = 1 * w;
      hits.push(label);
    }
    if (contribution > 0) {
      score += contribution;
      if (!weak) contentHits += 1;
    }
  }
  // A node whose only evidence is weak process verbs is noise by definition —
  // the `add`-grab-bag capsule failure. Suppress it outright: weak terms
  // corroborate content matches, they never carry a seed.
  if (contentHits === 0) return { score: 0, why: '' };
  // Reward multi-term topic coverage multiplicatively so converging evidence
  // ("direct" + "debit" + payments-expansion) dominates single-term hits.
  score *= 1 + COVERAGE_BONUS * Math.min(contentHits - 1, 4);
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
 * Topic-affinity bonus cap: a node whose enrichment tags intersect the
 * question's inferred topics gains at most this fraction on top of its
 * textual evidence. Sized between IMPORTANCE_WEIGHT (0.4) and nothing:
 * strong enough to break domain ties ("direct debits" → the payments file
 * over an equal-scoring name hit elsewhere), never strong enough to outrank
 * a clearly better textual match — and it multiplies an existing non-zero
 * score, so it can never conjure a seed by itself.
 */
const TOPIC_AFFINITY_WEIGHT = 0.3;

/** Affinity multiplier + provenance for one node under the current analysis. */
/**
 * Shared root-first path depth between two taxonomy paths.
 * "infrastructure/networking/dns/cname" vs "infrastructure/networking/dns" → 3.
 */
function sharedDepth(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

/**
 * How strongly a node's taxonomy tags match what the ask is about.
 *
 * Tags and query matches are both PATHS, so agreement is measured by how far
 * down the tree they agree, not merely whether they share a label. A DNS ask
 * and a file tagged `infrastructure/networking/dns` agree three levels deep
 * and get most of the bonus; the same ask and a file tagged
 * `infrastructure/containers` agree only at the root and get a fraction of it.
 * That is the whole reason tags carry paths.
 *
 * Falls back to flat topic-id matching when the provider predates the
 * taxonomy (or a stale sidecar still holds flat tags), so an older install
 * ranks exactly as it did before.
 */
function topicAffinity(
  nodeId: string,
  relevance: RelevanceAnalysis | null | undefined,
  topicTags: Map<string, readonly string[]> | null | undefined,
): { boost: number; label: string } {
  if (!topicTags) return { boost: 1, label: '' };
  const tags = topicTags.get(nodeId);
  if (!tags?.length) return { boost: 1, label: '' };

  const paths = relevance?.taxonomy ?? [];
  if (paths.length && tags.some((t) => t.includes('/'))) {
    let best = 0;
    let label = '';
    for (const match of paths) {
      const askDepth = match.path.split('/').length;
      for (const tag of tags) {
        const shared = sharedDepth(match.path, tag);
        if (shared === 0) continue;
        // Specificity of agreement × confidence in the match.
        const affinity = (shared / askDepth) * match.score;
        if (affinity > best) {
          best = affinity;
          label = shared === askDepth ? match.path : match.path.split('/').slice(0, shared).join('/');
        }
      }
    }
    if (best <= 0) return { boost: 1, label: '' };
    return { boost: 1 + TOPIC_AFFINITY_WEIGHT * Math.min(best, 1), label: `, topic:${label}` };
  }

  if (!relevance?.topics?.length) return { boost: 1, label: '' };
  let affinity = 0;
  const matched: string[] = [];
  for (const t of relevance.topics) {
    if (tags.includes(t.id)) {
      affinity += t.score;
      matched.push(t.id);
    }
  }
  if (affinity <= 0) return { boost: 1, label: '' };
  return { boost: 1 + TOPIC_AFFINITY_WEIGHT * Math.min(affinity, 1), label: `, topic:${matched.sort().join('+')}` };
}

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
