import { countTokens } from './tokens.js';
import { tokenizeQuery } from './select.js';

/**
 * Deterministic quality gate for locally-extracted docs (VG-LIB-SUPERSET-PLAN D1/D18).
 *
 * Decides whether the on-disk extraction is good enough to serve, or whether we should
 * **fall through to the hosted catalog** (S2) for a better answer. Pure regex/keyword
 * checks — no LLM, no network — so the decision is free and deterministic. A doc is
 * "sufficient" when it shows a runnable example, isn't a stub, and is on-topic for the
 * query; otherwise it's a candidate for hosted escalation.
 *
 * Focused API queries are strict: identifier-shaped terms (camelCase / PascalCase /
 * snake_case) must appear verbatim, and multi-term queries need a majority of terms.
 * That stops a generic README with one overlapping word (e.g. "middleware") from being
 * marked sufficient for "JWT middleware" or "createMiddleware".
 */
export interface DocQuality {
  score: number;
  sufficient: boolean;
  reasons: string[]; // why it fell short (empty when sufficient)
}

export interface QualityOpts {
  name?: string;
  query?: string;
  symbols?: string[];
  minTokens?: number;
  /**
   * When true, the payload is only a package README (no typed API surface, no
   * package docs/). Focused API queries against README-only sources are never
   * treated as sufficient — agents should fall through to hosted or read types.
   */
  readmeOnly?: boolean;
}

/** camelCase / PascalCase / snake_case / kebab identifiers long enough to be API-shaped. */
const IDENT_RE = /^(?:[A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)$/;

/** Tokens that look like real API symbols (not generic prose words). */
export function identifierTerms(query?: string): string[] {
  if (!query) return [];
  // Keep original casing tokens before lowercasing so we can detect camelCase.
  const raw = [...new Set(query.split(/[^A-Za-z0-9_-]+/).filter((w) => w.length > 2))];
  return raw.filter((t) => IDENT_RE.test(t) || (t.length >= 6 && /[A-Z]/.test(t) && /[a-z]/.test(t)));
}

export function assessDocQuality(content: string, opts: QualityOpts = {}): DocQuality {
  const minTokens = opts.minTokens ?? 60;
  const lc = content.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  // 1. Has a runnable example (fenced or indented code) — docs without one are low-value.
  const hasCode = /```/.test(content) || /(^|\n)( {4}|\t)\S/.test(content);
  if (hasCode) score += 2;
  else reasons.push('no code example');

  // 2. Not a stub.
  const tokens = countTokens(content);
  if (tokens >= minTokens) score += 1;
  else reasons.push(`thin (${tokens} tokens)`);

  // 3. Mentions the library itself.
  const bareName = opts.name?.toLowerCase().replace(/^@[^/]+\//, '');
  if (bareName && bareName.length > 1) {
    if (lc.includes(bareName)) score += 1;
    else reasons.push('library name absent');
  }

  // 4. On-topic for the query (if one was given).
  const qt = tokenizeQuery(opts.query);
  const idents = identifierTerms(opts.query);
  let onTopic = qt.length === 0;
  if (qt.length) {
    // Identifier-shaped query terms must appear (case-insensitive). A single
    // overlapping prose word must not green-light an API lookup.
    const missingIdents = idents.filter((id) => !lc.includes(id.toLowerCase()));
    if (missingIdents.length) {
      reasons.push(`API symbol(s) absent: ${missingIdents.join(', ')}`);
      onTopic = false;
    } else {
      const hits = qt.filter((t) => lc.includes(t)).length;
      // Strict majority of terms (2-of-2, 2-of-3, 3-of-4, …) — a single shared word
      // like "middleware" must not green-light "JWT middleware".
      const need = Math.max(1, Math.floor(qt.length / 2) + 1);
      if (hits >= need) {
        score += Math.min(hits, 2);
        onTopic = true;
      } else {
        reasons.push(hits === 0 ? 'query terms absent' : `query terms weak (${hits}/${qt.length})`);
        onTopic = false;
      }
    }
  }

  // 5. Surfaces at least one real API symbol (when we have a .d.ts surface).
  if (opts.symbols?.length) {
    if (opts.symbols.some((s) => s.length > 2 && lc.includes(s.toLowerCase()))) score += 1;
    else reasons.push('no API symbols present');
  }

  // 6. README-only + focused API query → never sufficient. A package README rarely
  // answers createMiddleware / refine / useQuery; agents must not trust score ≥ 6.
  if (opts.readmeOnly && (idents.length > 0 || qt.length >= 2)) {
    onTopic = false;
    if (!reasons.includes('README-only source cannot answer a focused API query')) {
      reasons.push('README-only source cannot answer a focused API query');
    }
    score = Math.min(score, 4); // cap so agents don't treat this as high-confidence
  }

  // Gate: a usable doc has an example, isn't a stub, and is on-topic.
  const sufficient = hasCode && tokens >= minTokens && onTopic;
  return { score, sufficient, reasons };
}
