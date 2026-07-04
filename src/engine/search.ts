import * as fs from 'node:fs';
import * as path from 'node:path';
import { findNodes } from './lookup.js';
import type { VgGraph } from '../schema.js';

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
  /** Present only when nothing matched — the pivot the model should take. */
  hint?: string;
}

const IGNORE_DIRS = new Set(['.git', '.vibgrate', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__']);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES_SCANNED = 20_000;
const PREVIEW_CHARS = 120;

export function searchSymbols(graph: VgGraph, root: string, query: string, limit: number): SearchResult {
  const q = query.trim();
  if (!q) return { matches: [], moreAvailable: false, hint: 'query is required' };

  // Pass 1 — graph name index (already ranked by importance).
  const nodes = findNodes(graph, q).filter((n) => n.kind !== 'file');
  const symbolHits: SymbolHit[] = nodes.slice(0, limit).map((n, i) => ({
    kind: n.kind,
    name: n.qualifiedName,
    file: n.file,
    line: n.span.start,
    score: Math.round((1 - i / Math.max(nodes.length, 1)) * 100) / 100,
  }));

  // Pass 2 — literal fallthrough for what the graph doesn't model. Only runs
  // with spare budget, and never re-reports lines the symbol pass already
  // covers.
  const spare = limit - symbolHits.length;
  const textHits: TextHit[] = [];
  let truncatedScan = false;
  if (spare > 0) {
    const seen = new Set(symbolHits.map((h) => `${h.file}:${h.line}`));
    truncatedScan = scanFiles(root, q, spare, seen, textHits);
  }

  const matches = [...symbolHits, ...textHits];
  if (matches.length === 0) {
    return {
      matches,
      moreAvailable: false,
      hint: 'no symbol or text match — for meaning-level questions (symptoms, relationships, what-breaks-if) use query_graph',
    };
  }
  return { matches, moreAvailable: nodes.length > symbolHits.length || truncatedScan };
}

/** Bounded literal scan; returns true when it stopped early (more may exist). */
function scanFiles(root: string, needle: string, budget: number, seen: Set<string>, out: TextHit[]): boolean {
  const lower = needle.toLowerCase();
  let scanned = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Deterministic order regardless of filesystem enumeration.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (++scanned > MAX_FILES_SCANNED) return true;
      let text: string;
      try {
        if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (!text.toLowerCase().includes(lower)) continue;
      const rel = path.relative(root, abs);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(lower)) continue;
        const key = `${rel}:${i + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: 'text', file: rel, line: i + 1, preview: lines[i].trim().slice(0, PREVIEW_CHARS) });
        if (out.length >= budget) return true;
      }
    }
  }
  return false;
}
