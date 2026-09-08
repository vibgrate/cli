/**
 * Workspace-scoped context tracker for proactive expansion.
 *
 * Remembers what was compressed (hash, tool, a keyword sample) and, when a
 * later user question looks like it needs that data, names the hashes worth
 * expanding before the model answers. Tracking is scoped to a workspace key
 * and fails closed on an empty key so one project's output never surfaces in
 * another project's session.
 */

export interface TrackedContext {
  hash: string;
  toolName?: string;
  keywords: string[];
  messageIndex: number;
  /** Lower-cased sample (≤ 2000 chars) used for substring matches. */
  sample: string;
  queryContext: string;
  originalItemCount: number;
  compressedItemCount: number;
  trackedAt: number;
  workspace: string;
}

export interface TrackerOptions {
  now?: () => number;
  workspace?: string;
  maxTracked?: number;
  relevanceThreshold?: number;
  maxAgeSeconds?: number;
  maxExpansions?: number;
}

export interface ExpansionRecommendation {
  hash: string;
  relevance: number;
  reason: string;
}

export const DEFAULT_MAX_TRACKED = 100;
export const DEFAULT_RELEVANCE_THRESHOLD = 0.3;
export const DEFAULT_MAX_AGE_SECONDS = 300;
export const DEFAULT_MAX_EXPANSIONS = 2;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'until', 'while', 'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'it', 'its', 'me', 'my', 'i', 'you',
]);

const WORD_RE = /[a-z][a-z0-9_.-]*[a-z0-9]|[a-z]{2,}/g;

/** Lower-case keywords minus stop words (min length 2), first-seen order, deduplicated. */
export function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const lower = text.toLowerCase();
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(lower)) !== null) {
    const w = m[0];
    if (w.length < 2 || STOP_WORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** True for continuation summaries an agent injects after compaction (already context; never expand). */
export function looksLikeCompactSummary(...texts: Array<string | undefined>): boolean {
  const combined = texts
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .join(' ')
    .toLowerCase()
    .split(/\s+/)
    .join(' ');
  if (!combined) return false;
  const hasSummary = combined.includes('summary') || combined.includes('summarized');
  if (combined.includes('this session is being continued from a previous conversation') && hasSummary) return true;
  if (combined.includes('conversation is summarized below') && (combined.includes('ran out of context') || combined.includes('previous conversation'))) return true;
  return combined.includes('/compact') && combined.includes('claude') && hasSummary && (combined.includes('conversation') || combined.includes('session'));
}

const FILE_TOOL_HINTS = ['find', 'glob', 'search', 'grep', 'ls'];
const FILE_QUERY_HINTS = ['file', 'where', 'find', 'show', 'list'];

export class ContextTracker {
  private readonly contexts = new Map<string, TrackedContext>();
  private readonly now: () => number;
  private readonly workspace: string;
  private readonly maxTracked: number;
  private readonly threshold: number;
  private readonly maxAgeSeconds: number;
  private readonly maxExpansions: number;

  constructor(opts: TrackerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.workspace = opts.workspace ?? '';
    this.maxTracked = Math.max(1, opts.maxTracked ?? DEFAULT_MAX_TRACKED);
    this.threshold = opts.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD;
    this.maxAgeSeconds = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    this.maxExpansions = Math.max(0, opts.maxExpansions ?? DEFAULT_MAX_EXPANSIONS);
  }

  get size(): number {
    return this.contexts.size;
  }

  noteCompressed(hash: string, meta: { toolName?: string; keywords: string[]; messageIndex: number; sample?: string; queryContext?: string; originalItemCount?: number; compressedItemCount?: number; workspace?: string }): void {
    const h = hash.toLowerCase();
    const sample = (meta.sample ?? meta.keywords.join(' ')).slice(0, 2000).toLowerCase();
    const queryContext = meta.queryContext ?? '';
    if (looksLikeCompactSummary(queryContext, sample)) return;
    if (this.contexts.has(h)) this.contexts.delete(h); // re-insert = most recent
    this.contexts.set(h, {
      hash: h,
      toolName: meta.toolName,
      keywords: [...new Set(meta.keywords.map((k) => k.toLowerCase()))],
      messageIndex: meta.messageIndex,
      sample,
      queryContext,
      originalItemCount: meta.originalItemCount ?? 0,
      compressedItemCount: meta.compressedItemCount ?? 0,
      trackedAt: this.now(),
      workspace: meta.workspace ?? this.workspace,
    });
    while (this.contexts.size > this.maxTracked) {
      const oldest = this.contexts.keys().next().value;
      if (oldest === undefined) break;
      this.contexts.delete(oldest);
    }
  }

  /** Relevance in [0, 1] of a tracked context to a query (before age discount). */
  relevance(query: string, ctx: TrackedContext): number {
    const queryLower = query.toLowerCase();
    const queryWords = new Set(extractKeywords(queryLower));
    if (queryWords.size === 0) return 0;
    let score = 0;
    const sampleWords = new Set([...extractKeywords(ctx.sample), ...ctx.keywords]);
    if (sampleWords.size) {
      let overlap = 0;
      for (const w of queryWords) if (sampleWords.has(w)) overlap += 1;
      score += (overlap / queryWords.size) * 0.5;
      for (const w of queryWords) if (w.length >= 4 && ctx.sample.includes(w)) score += 0.2;
    }
    if (ctx.queryContext) {
      const ctxWords = new Set(extractKeywords(ctx.queryContext.toLowerCase()));
      if (ctxWords.size) {
        let overlap = 0;
        for (const w of queryWords) if (ctxWords.has(w)) overlap += 1;
        score += (overlap / queryWords.size) * 0.3;
      }
    }
    if (ctx.toolName) {
      const tool = ctx.toolName.toLowerCase();
      if (FILE_TOOL_HINTS.some((w) => tool.includes(w)) && FILE_QUERY_HINTS.some((w) => queryLower.includes(w))) score += 0.1;
    }
    return Math.min(1, score);
  }

  /** Ranked expansion recommendations for a user query (fail-closed on an empty workspace key). */
  recommend(userQuery: string, opts: { workspace?: string } = {}): ExpansionRecommendation[] {
    const ws = opts.workspace ?? this.workspace;
    if (!ws) return [];
    const now = this.now();
    const recs: ExpansionRecommendation[] = [];
    for (const ctx of this.contexts.values()) {
      if (ctx.workspace !== ws) continue;
      const age = Math.max(0, (now - ctx.trackedAt) / 1000);
      if (age > this.maxAgeSeconds) continue;
      let rel = this.relevance(userQuery, ctx);
      rel *= 1 - (age / this.maxAgeSeconds) * 0.5;
      if (rel >= this.threshold) recs.push({ hash: ctx.hash, relevance: rel, reason: this.reason(ctx, rel) });
    }
    recs.sort((a, b) => b.relevance - a.relevance || (a.hash < b.hash ? -1 : 1));
    return recs.slice(0, this.maxExpansions);
  }

  /** Hashes worth expanding for a user query, most relevant first. */
  proactiveHashes(userQuery: string): string[] {
    return this.recommend(userQuery).map((r) => r.hash);
  }

  /** Forget contexts whose hashes are no longer live. */
  prune(activeHashes: Set<string>): void {
    for (const h of [...this.contexts.keys()]) if (!activeHashes.has(h)) this.contexts.delete(h);
  }

  trackedHashes(): string[] {
    return [...this.contexts.keys()];
  }

  clear(): void {
    this.contexts.clear();
  }

  private reason(ctx: TrackedContext, rel: number): string {
    const parts: string[] = [];
    if (ctx.toolName) parts.push(`from ${ctx.toolName}`);
    parts.push(`${ctx.originalItemCount} items compressed at message ${ctx.messageIndex}`);
    parts.push(rel > 0.5 ? 'high relevance to current query' : 'possible relevance to current query');
    return parts.join(', ');
  }
}

/** Wrap expanded originals as a clearly-labelled context block for the model. */
export function formatExpansions(expansions: Array<{ hash: string; content: string; reason: string }>, opts: { workspaceLabel?: string } = {}): string {
  if (expansions.length === 0) return '';
  let header = '[Proactive Context Expansion - relevant to your query';
  if (opts.workspaceLabel) header += ` | workspace: ${opts.workspaceLabel}`;
  header += ']';
  const parts = [header];
  for (const e of expansions) {
    parts.push(`\n--- Expanded from earlier (${e.reason}) ---`);
    parts.push(e.content);
  }
  parts.push('[End Proactive Expansion]');
  const body = parts.join('\n').split('</vg_proactive_expansion>').join('<\\/vg_proactive_expansion>');
  return `<vg_proactive_expansion>\n${body}\n</vg_proactive_expansion>`;
}
