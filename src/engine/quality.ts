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
  let onTopic = qt.length === 0;
  if (qt.length) {
    const hits = qt.filter((t) => lc.includes(t)).length;
    if (hits) {
      score += Math.min(hits, 2);
      onTopic = true;
    } else {
      reasons.push('query terms absent');
    }
  }

  // 5. Surfaces at least one real API symbol (when we have a .d.ts surface).
  if (opts.symbols?.length) {
    if (opts.symbols.some((s) => s.length > 2 && lc.includes(s.toLowerCase()))) score += 1;
    else reasons.push('no API symbols present');
  }

  // Gate: a usable doc has an example, isn't a stub, and is on-topic.
  const sufficient = hasCode && tokens >= minTokens && onTopic;
  return { score, sufficient, reasons };
}
