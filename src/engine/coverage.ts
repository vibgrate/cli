import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphNode } from '../schema.js';

/**
 * Coverage ingestion (VG-ENGINE-TEARDOWN §3.6) — runtime-grounded test linkage.
 * Parses LCOV (`coverage/lcov.info`) and Istanbul (`coverage-final.json`) into a
 * per-file line→hits map, then sets each node's `coverage` (fraction of its span
 * that ran) and `tested` flag. Stronger than static linkage where present.
 */

export type LineHits = Map<number, number>; // line → hit count
export type CoverageMap = Map<string, LineHits>; // repo-relative posix path → lines

const DEFAULT_PATHS = [
  'coverage/lcov.info',
  'lcov.info',
  'coverage/coverage-final.json',
  'coverage-final.json',
];

/** Find and parse coverage reports under root. Returns null if none found. */
export function loadCoverage(root: string, explicit?: string[]): CoverageMap | null {
  const candidates = (explicit && explicit.length ? explicit : DEFAULT_PATHS).map((p) =>
    path.resolve(root, p),
  );
  const found = candidates.filter((p) => fs.existsSync(p));
  if (found.length === 0) return null;

  const map: CoverageMap = new Map();
  for (const file of found) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (file.endsWith('.json')) mergeIstanbul(map, text, root);
      else mergeLcov(map, text, root);
    } catch {
      /* skip unreadable/garbled report */
    }
  }
  return map.size ? map : null;
}

function rel(root: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  return path.relative(root, abs).split(path.sep).join('/');
}

function bump(map: CoverageMap, file: string, line: number, hits: number): void {
  let lh = map.get(file);
  if (!lh) {
    lh = new Map();
    map.set(file, lh);
  }
  lh.set(line, Math.max(lh.get(line) ?? 0, hits));
}

function mergeLcov(map: CoverageMap, text: string, root: string): void {
  let current: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) current = rel(root, line.slice(3));
    else if (line.startsWith('DA:') && current) {
      const [ln, hits] = line.slice(3).split(',');
      const n = Number(ln);
      const h = Number(hits);
      if (Number.isFinite(n)) bump(map, current, n, Number.isFinite(h) ? h : 0);
    } else if (line === 'end_of_record') current = null;
  }
}

interface IstanbulEntry {
  path?: string;
  statementMap?: Record<string, { start: { line: number }; end: { line: number } }>;
  s?: Record<string, number>;
}

function mergeIstanbul(map: CoverageMap, text: string, root: string): void {
  const data = JSON.parse(text) as Record<string, IstanbulEntry>;
  for (const [key, entry] of Object.entries(data)) {
    const file = rel(root, entry.path ?? key);
    const stmts = entry.statementMap ?? {};
    const counts = entry.s ?? {};
    for (const [id, loc] of Object.entries(stmts)) {
      const hits = counts[id] ?? 0;
      const start = loc.start?.line;
      const end = loc.end?.line ?? start;
      if (!Number.isFinite(start)) continue;
      for (let ln = start; ln <= end; ln++) bump(map, file, ln, hits);
    }
  }
}

/** Apply coverage to nodes: set `coverage` fraction over the node's span + `tested`. */
export function applyCoverage(nodes: GraphNode[], coverage: CoverageMap): GraphNode[] {
  return nodes.map((n) => {
    if (n.kind === 'file' || n.kind === 'external') return n;
    const lh = coverage.get(n.file);
    if (!lh) return n;
    let instrumented = 0;
    let covered = 0;
    for (let ln = n.span.start; ln <= n.span.end; ln++) {
      const hits = lh.get(ln);
      if (hits === undefined) continue;
      instrumented++;
      if (hits > 0) covered++;
    }
    if (instrumented === 0) return n;
    const fraction = Math.round((covered / instrumented) * 1e6) / 1e6;
    const tested = covered > 0 ? true : n.kind === 'function' || n.kind === 'method' ? false : n.tested;
    return { ...n, coverage: fraction, tested };
  });
}
