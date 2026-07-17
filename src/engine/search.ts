import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findNodes } from './lookup.js';
import { scanCandidates } from './literal-scan.js';
import type { GraphNode, VgGraph } from '../schema.js';

/**
 * `search_symbols` — the hybrid flashlight next to the map
 * (docs/graph/VG-GRAPH-OPTIMIZATION-PLAN.md P1).
 *
 * Two passes, both bounded and deterministic:
 *   1. symbol pass — the graph's own name index via findNodes (exact id /
 *      qualified name / short name / case-insensitive / substring), ranked;
 *   2. literal pass — a repo-root-jailed substring scan over source files for
 *      strings the graph does not model (config keys, log messages, comments),
 *      only run when the symbol pass has spare result budget.
 *
 * Rows are tiny by contract ({kind, name, file, line, score|preview}) — this
 * tool exists to make "I know the name" discovery one cheap call, so the model
 * never flails through graph queries for a plain string lookup.
 */

export interface SymbolHit {
  kind: string;
  name: string;
  file: string;
  line: number;
  score: number;
}

export interface TextHit {
  kind: 'text';
  file: string;
  line: number;
  preview: string;
}

export interface SearchResult {
  matches: (SymbolHit | TextHit)[];
  moreAvailable: boolean;
  /**
   * Total literal (text) matches across the scanned tree, reported when a
   * literal sweep ran (a whitespace/phrase query). Lets a caller doing a "find
   * every occurrence" sweep know whether the shown text rows are the complete
   * set (`totalTextMatches` === shown text rows) or a page of a larger set
   * (`totalTextMatches` > shown) — so it never mistakes a truncated list for a
   * complete one, and never has to fall back to grep to be sure. A trailing `+`
   * intent is signalled via `moreAvailable`; absent for single-name lookups.
   */
  totalTextMatches?: number;
  /**
   * Present when nothing matched (the pivot to take) or when a literal sweep was
   * truncated (how to get the rest).
   */
  hint?: string;
}

const IGNORE_DIRS = new Set(['.git', '.vibgrate', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__']);
const MAX_FILES_SCANNED = 20_000;

export async function searchSymbols(graph: VgGraph, root: string, query: string, limit: number): Promise<SearchResult> {
  const q = query.trim();
  if (!q) return { matches: [], moreAvailable: false, hint: 'query is required' };

  // A query with internal whitespace can never name a single symbol
  // (identifiers have no spaces), so it is almost always a literal-string sweep
  // — "find every place that says X". Route it literal-first: the symbol pass on
  // such a query only ever produces loose per-token matches (e.g. the `Say`
  // components for the phrase "you say"), and letting those fill the budget
  // starves the real string hits and pushes the caller back to grep — the exact
  // failure the analysis caught. Single-name lookups (no whitespace — the hot
  // path) keep the symbol-first behaviour below unchanged.
  const isPhrase = /\s/.test(q);

  // Pass 1 — graph name index (already ranked by importance).
  let nodes = findNodes(graph, q).filter((n) => n.kind !== 'file');
  // Reconstructed-identifier fallthrough: a humanized/spaced query ("get id",
  // "use team", "f 0304") is frequently a *single* identifier whose original
  // separators (camelCase boundary, `_`) were lost in humanization, not a
  // multi-word phrase. Try the two mechanical rejoins — concatenated (recovers
  // camelCase: "get id" -> "getid" == "getId") and underscore-joined (recovers
  // snake_case: "f 0304" -> "f_0304") — against the exact/case-insensitive name
  // index before falling through to the noisy per-token substring union below,
  // which has no way to re-associate short tokens back into one identifier and
  // silently drops single-character tokens ("f") that carry real information
  // (VG-LOCATE-FAILURE-ANALYSIS.md).
  if (nodes.length === 0 && isPhrase) {
    nodes = reconstructedIdentifierNodes(graph, q);
  }
  // Multi-word fallthrough: an agent that types a phrase ("NewScan modal
  // component", "dsn install command") gets nothing from the whole-string name
  // index and nothing from the whole-string literal scan — a dead end. When the
  // exact query finds no symbol AND the query is multiple words, union the
  // per-token matches and rank by how many distinct query tokens each symbol
  // covers (then importance).
  if (nodes.length === 0) {
    const tokens = queryTokens(q);
    if (tokens.length >= 2) nodes = multiTokenNodes(graph, tokens);
  }
  // For a phrase, cap the symbol section to a fraction of the budget so it can
  // never crowd out the literal scan; the string hits lead, the loosely-matching
  // symbols follow as "the name also means this" context. Single names keep the
  // full budget for the symbol pass.
  const symbolCap = isPhrase ? Math.max(1, Math.floor(limit / 3)) : limit;
  const symbolHits: SymbolHit[] = nodes.slice(0, symbolCap).map((n, i) => ({
    kind: n.kind,
    name: n.qualifiedName,
    file: n.file,
    line: n.span.start,
    score: Math.round((1 - i / Math.max(nodes.length, 1)) * 100) / 100,
  }));

  // Pass 2 — literal scan for what the graph doesn't model. A phrase always gets
  // the budget the symbol cap freed up and a full count of what's out there
  // (`countAll`), so the caller can trust it for a complete sweep. A single name
  // only falls through on spare budget and stops at the budget, as before.
  const spare = limit - symbolHits.length;
  const textHits: TextHit[] = [];
  let truncatedScan = false;
  let totalTextMatches: number | undefined;
  if (spare > 0) {
    const seen = new Set(symbolHits.map((h) => `${h.file}:${h.line}`));
    const scan = await scanFiles(root, q, spare, seen, textHits, isPhrase);
    truncatedScan = scan.truncated;
    if (isPhrase) totalTextMatches = scan.total;
  }

  const matches = [...symbolHits, ...textHits];
  if (matches.length === 0) {
    return {
      matches,
      moreAvailable: false,
      hint: 'no symbol or text match — for meaning-level questions (symptoms, relationships, what-breaks-if) use query_graph',
    };
  }

  const literalTruncated = totalTextMatches !== undefined && totalTextMatches > textHits.length;
  // A phrase's deliberately-capped symbol section is not "more available"; only a
  // truncated literal sweep is. A single name reports the usual symbol overflow.
  const moreAvailable = isPhrase ? literalTruncated || truncatedScan : nodes.length > symbolHits.length || truncatedScan;
  const result: SearchResult = { matches, moreAvailable };
  if (totalTextMatches !== undefined) result.totalTextMatches = totalTextMatches;
  if (literalTruncated) {
    result.hint = `showing ${textHits.length} of ${totalTextMatches}${truncatedScan ? '+' : ''} literal matches — raise limit or narrow the query to get them all`;
  }
  return result;
}

/** Meaningful query words for the multi-word fallthrough (drop tiny tokens). */
function queryTokens(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
}

/**
 * Rejoin a humanized query's words back into one identifier and look it up
 * exactly. Humanization is lossy (both camelCase boundaries and `_`/`-`
 * collapse to a plain space), so the original separator can't be recovered —
 * try both mechanical rejoins and let `findNodes`'s case-insensitive exact
 * match do the rest. Concatenated first (camelCase is the more common source
 * convention across this engine's languages); underscore-joined second.
 */
function reconstructedIdentifierNodes(graph: VgGraph, q: string): GraphNode[] {
  const words = q.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return [];
  const concat = findNodes(graph, words.join(''));
  if (concat.length) return concat.filter((n) => n.kind !== 'file');
  const snake = findNodes(graph, words.join('_'));
  return snake.filter((n) => n.kind !== 'file');
}

/**
 * Union of per-token name-index matches, ranked by how many distinct query
 * tokens each symbol covers (then by importance). Reuses `findNodes` per token
 * so the matching rules (exact/short/case-insensitive/substring) stay identical
 * to a single-name lookup — this only broadens a phrase into its words.
 */
function multiTokenNodes(graph: VgGraph, tokens: string[]): GraphNode[] {
  const cov = new Map<string, { node: GraphNode; hits: number }>();
  for (const t of tokens) {
    for (const n of findNodes(graph, t)) {
      if (n.kind === 'file') continue;
      const e = cov.get(n.id);
      if (e) e.hits++;
      else cov.set(n.id, { node: n, hits: 1 });
    }
  }
  return [...cov.values()]
    .sort((a, b) => b.hits - a.hits || b.node.importance - a.node.importance)
    .map((e) => e.node);
}

interface ScanResult {
  /** Distinct matching lines found (excluding those already in `seen`). When
   *  `countAll` is false this is only a lower bound — the scan stops at `budget`. */
  total: number;
  /** True when the scan stopped early (file cap hit, or budget hit without
   *  `countAll`) — more matches may exist beyond what was counted. */
  truncated: boolean;
}

/**
 * Bounded, repo-root-jailed literal scan. Fills `out` with up to `budget` hits;
 * with `countAll` it reports the true total across the tree (a "find every
 * occurrence" sweep), otherwise it stops at `budget` (a cheap fallthrough).
 *
 * Two stages (VG-LITERAL-INDEX-DESIGN.md, Stage 1):
 *   1. LIST candidate files — `ripgrep` when it's on PATH (SIMD/parallel, prunes
 *      to just the files that match), else a Node directory walk (Node-native,
 *      offline, air-gap-safe). rg is only a pruner, never the authority.
 *   2. SCAN those files — `scanCandidates`, a uniform pure-JS engine that fans
 *      large sweeps across `worker_threads` so it's fast on every platform with
 *      nothing installed. It is the single source of the reported rows and
 *      `total`, so the answer is identical whether or not rg is present.
 *
 * `seen` (the symbol-pass hit lines) is excluded so a line already shown as a
 * symbol isn't repeated as a text hit.
 */
async function scanFiles(root: string, needle: string, budget: number, seen: Set<string>, out: TextHit[], countAll: boolean): Promise<ScanResult> {
  const listing = listCandidateFiles(root, needle);
  const outcome = await scanCandidates(root, listing.files, needle, { collectAll: countAll, budget });

  let overlap = 0; // matches that coincide with a symbol-pass line (near-zero in practice)
  for (const h of outcome.hits) {
    if (seen.has(`${h.file}:${h.line}`)) {
      overlap++;
      continue;
    }
    seen.add(`${h.file}:${h.line}`);
    if (out.length < budget) out.push({ kind: 'text', file: h.file, line: h.line, preview: h.preview });
  }
  return { total: outcome.total - overlap, truncated: listing.truncated || outcome.truncated };
}

interface Listing {
  /** Repo-relative candidate paths, lexicographically sorted (deterministic in
   *  both modes so rows and truncation don't depend on which lister ran). */
  files: string[];
  /** True when the candidate set was capped (more files may match beyond it). */
  truncated: boolean;
}

/** rg-pruned candidates when available (fast), else the full Node walk. */
function listCandidateFiles(root: string, needle: string): Listing {
  return ripgrepCandidates(root, needle) ?? walkCandidates(root);
}

/** Every non-ignored, non-hidden file under root — the Node-native fallback. */
function walkCandidates(root: string): Listing {
  const files: string[] = [];
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (files.length >= MAX_FILES_SCANNED) {
        truncated = true;
        continue;
      }
      files.push(path.relative(root, abs));
    }
  }
  files.sort();
  return { files, truncated };
}

let rgAvailable: boolean | undefined;
/** Is `ripgrep` usable? Probed once; opt out with VG_DISABLE_RIPGREP. */
function hasRipgrep(): boolean {
  if (process.env.VG_DISABLE_RIPGREP) return false;
  if (rgAvailable === undefined) {
    try {
      rgAvailable = spawnSync('rg', ['--version'], { stdio: 'ignore', timeout: 3000 }).status === 0;
    } catch {
      rgAvailable = false;
    }
  }
  return rgAvailable;
}

/**
 * Files containing `needle` per ripgrep, or `null` if rg is unavailable/errored
 * (caller falls back to the Node walk). rg is invoked as a fixed-string,
 * case-insensitive, gitignore-disabled, hidden-skipping lister — the same corpus
 * the Node walk sees — jailed to `root` via cwd. `--fixed-strings` + `--` make
 * the agent-supplied needle inert as a pattern/flag; no shell is involved.
 */
function ripgrepCandidates(root: string, needle: string): Listing | null {
  if (!hasRipgrep()) return null;
  const globs = [...IGNORE_DIRS].flatMap((d) => ['--glob', `!**/${d}/**`, '--glob', `!${d}/**`]);
  const res = spawnSync(
    'rg',
    ['--files-with-matches', '--fixed-strings', '--ignore-case', '--no-ignore', '--no-messages', ...globs, '--', needle, '.'],
    { cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024 },
  );
  // status 0 = matches, 1 = no matches (both fine); anything else / a spawn error
  // (signal kill on timeout, buffer overflow) is untrustworthy — fall back.
  if (res.error || (res.status !== 0 && res.status !== 1) || res.signal) return null;
  const seen = new Set<string>();
  for (const raw of res.stdout.split('\n')) {
    const rel = raw.startsWith('./') ? raw.slice(2) : raw;
    if (!rel) continue;
    // Defensive: never trust a path that escaped the ignore/hidden rules.
    const segs = rel.split('/');
    if (segs.some((s) => s.startsWith('.') || IGNORE_DIRS.has(s))) continue;
    seen.add(rel);
  }
  const files = [...seen].sort();
  if (files.length > MAX_FILES_SCANNED) return { files: files.slice(0, MAX_FILES_SCANNED), truncated: true };
  return { files, truncated: false };
}
