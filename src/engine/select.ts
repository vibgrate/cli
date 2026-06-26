import { countTokens, truncateToTokens } from './tokens.js';
import { DEFAULT_SELECTION_WEIGHTS, type SelectionWeights } from './selection-weights.js';

/**
 * Deterministic, budget-aware doc selection (VG-LIB-SUPERSET-PLAN §7 / S1.x).
 *
 * Replaces naive prefix truncation — which misses the critical chunk when a long
 * README front-loads badges/TOC/install — with priority-layered, relevance-ranked
 * assembly: the typed API surface leads (it's compact + high-value and must survive
 * a tight budget), then README sections are picked by a deterministic score and
 * emitted in reading order, up to the token budget. No LLM, no network, no key; the
 * scoring weights are static (selection-weights.ts), tuned offline.
 */

export interface Section {
  heading: string;
  level: number;
  body: string;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'for', 'and', 'or', 'is', 'how', 'do', 'i', 'use', 'using', 'with', 'on', 'my']);
const USAGE_RE = /\b(usage|example|examples|quick ?start|getting started|api|guide|how to|reference|tutorial|basic)\b/i;
const PREAMBLE_RE = /\b(install|installation|license|licence|contributing|contributors?|sponsors?|table of contents|toc|changelog|funding|code of conduct|security|acknowledge)\b/i;

/** Split markdown at ATX headings; content before the first heading is a level-0 section. */
export function splitSections(md: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { heading: '', level: 0, body: '' };
  let buf: string[] = [];
  const flush = (): void => {
    const body = buf.join('\n').trim();
    if (cur.heading || body) out.push({ heading: cur.heading, level: cur.level, body });
    buf = [];
  };
  for (const line of md.split('\n')) {
    const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (h) {
      flush();
      cur = { heading: h[2].trim(), level: h[1].length, body: '' };
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Split a section body into paragraph/code-block units (blank-line separated, fences
 * kept intact). Used to sub-select within a heading-less or oversized section so a
 * buried critical paragraph is still recoverable, not just the prefix.
 */
export function chunkBody(body: string): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = (): void => {
    const c = cur.join('\n').trim();
    if (c) chunks.push(c);
    cur = [];
  };
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '') {
      flush();
      continue;
    }
    cur.push(line);
  }
  flush();
  return chunks;
}

/** Drop badge/shield-only lines (pure `![..](..)` image rows) — noise, never the answer. */
export function stripNoise(body: string): string {
  return body
    .split('\n')
    .filter((l) => !/^\s*(?:!\[[^\]]*\]\([^)]*\)\s*)+$/.test(l))
    .join('\n')
    .trim();
}

export function tokenizeQuery(q?: string): string[] {
  if (!q) return [];
  return [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
}

/** Exported identifier names from a `.d.ts` API surface, used as relevance signal. */
export function symbolsFromApi(api?: string): string[] {
  if (!api) return [];
  const out = new Set<string>();
  const re = /\b(?:function|class|interface|type|const|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(api))) out.add(m[1]);
  return [...out];
}

export function scoreSection(s: Section, idx: number, queryTerms: string[], symbols: string[], w: SelectionWeights): number {
  const text = `${s.heading}\n${s.body}`.toLowerCase();
  let score = 0;
  if (USAGE_RE.test(s.heading)) score += w.headingUsage;
  if (PREAMBLE_RE.test(s.heading)) score += w.headingPreamble;
  const codeBlocks = Math.floor((s.body.match(/```/g) ?? []).length / 2);
  if (codeBlocks > 0) score += w.hasCode + Math.min(codeBlocks, 5) * w.codeDensity;
  for (const t of queryTerms) if (text.includes(t)) score += w.queryOverlap;
  for (const sym of symbols) if (sym.length > 2 && text.includes(sym.toLowerCase())) score += w.symbolMatch;
  score += idx * w.position;
  const links = (s.body.match(/\]\(|https?:\/\//g) ?? []).length;
  const lineCount = Math.max(1, s.body.split('\n').filter((l) => l.trim()).length);
  if (links / lineCount > 0.5) score += w.linkDensity;
  return score;
}

export interface SelectInput {
  readme: string;
  query?: string;
  /** Verbatim `.d.ts` API surface (leads the payload, survives tight budgets). */
  apiSurface?: string;
  budget?: number;
  weights?: SelectionWeights;
}

export interface SelectResult {
  text: string;
  tokens: number;
  truncated: boolean;
}

const apiBlock = (api?: string): string => (api ? `## API (types)\n\n\`\`\`ts\n${api}\n\`\`\`` : '');

/**
 * Assemble docs to a token budget. Unbudgeted → README then API (familiar full
 * output). Budgeted → API surface first (priority), then README sections ranked by
 * score and emitted in reading order, until the budget is hit.
 */
export function selectForBudget(input: SelectInput): SelectResult {
  const w = input.weights ?? DEFAULT_SELECTION_WEIGHTS;
  const api = apiBlock(input.apiSurface);
  const readme = input.readme.trim();

  if (!input.budget || !Number.isFinite(input.budget)) {
    const full = [readme, api].filter(Boolean).join('\n\n');
    return { text: full, tokens: countTokens(full), truncated: false };
  }
  const budget = input.budget;
  const queryTerms = tokenizeQuery(input.query);
  const symbols = symbolsFromApi(input.apiSurface);

  const render = (s: Section): string => {
    const body = stripNoise(s.body);
    if (!body) return ''; // heading-only / badge-only sections carry no answer
    return `${s.heading ? `## ${s.heading}\n` : ''}${body}`.trim();
  };

  // Drop preamble (install/license/TOC/contributing/badges) ALWAYS — never the answer.
  const sections = splitSections(readme).filter((s) => !PREAMBLE_RE.test(s.heading));

  // If everything that matters (API + non-preamble, noise-stripped sections) fits the
  // budget, return it whole in reading order — preamble-trimmed, but NOT "truncated".
  const full = [api, ...sections.map(render)].filter(Boolean).join('\n\n').trim();
  if (countTokens(full) <= budget) {
    return { text: full, tokens: countTokens(full), truncated: false };
  }

  // Over budget → relevance-ranked assembly. Expand oversized / heading-less sections into
  // paragraph units so a buried critical paragraph is still recoverable (not just the prefix).
  const units: Section[] = [];
  for (const s of sections) {
    if (countTokens(s.body) > budget) {
      chunkBody(s.body).forEach((p, i) => units.push({ heading: i === 0 ? s.heading : '', level: s.level, body: p }));
    } else {
      units.push(s);
    }
  }
  const ranked = units
    .map((s, idx) => ({ s, idx, score: scoreSection(s, idx, queryTerms, symbols, w) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  const out: string[] = [];
  let used = 0;
  const add = (chunk: string): boolean => {
    const t = countTokens(chunk);
    if (used + t <= budget) {
      out.push(chunk);
      used += t;
      return true;
    }
    return false;
  };

  // Layer 1: API surface leads (truncate only if it alone exceeds the budget).
  if (api && !add(api) && used < budget) {
    out.push(truncateToTokens(api, budget - used).text);
    used = budget;
  }

  // Layer 2: greedily pick top-scored units within budget, emit in document order.
  const picked: number[] = [];
  for (const { s, idx } of ranked) {
    const chunk = render(s);
    if (!chunk) continue;
    if (used + countTokens(`\n${chunk}`) <= budget) {
      picked.push(idx);
      used += countTokens(`\n${chunk}`);
    }
  }
  picked.sort((a, b) => a - b);
  for (const idx of picked) out.push(render(units[idx]));

  // Use leftover budget on a truncated head of the top-ranked unpicked unit.
  if (used < budget - 20) {
    const next = ranked.find((r) => !picked.includes(r.idx) && render(r.s));
    if (next) {
      const head = truncateToTokens(render(next.s), budget - used).text;
      if (head.trim()) out.push(head);
    }
  }

  const text = out.join('\n\n').trim();
  return { text, tokens: countTokens(text), truncated: true };
}
