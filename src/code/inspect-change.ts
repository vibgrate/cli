/**
 * inspect_change — blast radius of a proposed edit (Fusion Phase 4).
 *
 * Pure over a graph + optional dirty files / symbols. Does not write the
 * filesystem. Used by the agent tool and unit tests.
 */

import { impactOf } from '../engine/impact.js';
import { resolveOne } from '../engine/lookup.js';
import type { VgGraph } from '../schema.js';

export interface InspectChangeInput {
  /** Explicit symbol ids / qualified names. */
  symbols?: string[];
  /** Files touched by the proposed change (relative paths). */
  files?: string[];
  /** Max impact depth (default 3). */
  depth?: number;
  /** Cap how many root symbols to expand (default 12). */
  maxRoots?: number;
  /** Cap affected rows in the report (default 40). */
  maxAffected?: number;
}

export interface InspectChangeRoot {
  id: string;
  qualifiedName: string;
  kind: string;
  file: string;
  line: number;
}

export interface InspectChangeAffected {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  depth: number;
  confidence: number;
  viaRoot: string;
}

export interface InspectChangeReport {
  roots: InspectChangeRoot[];
  affected: InspectChangeAffected[];
  direct: number;
  transitive: number;
  filesTouched: string[];
  rendered: string;
}

/**
 * Compute impact of changing the given symbols and/or any symbols defined in
 * the given files. Deterministic for a fixed graph + input.
 */
export function inspectChange(graph: VgGraph, input: InspectChangeInput = {}): InspectChangeReport {
  const depth = input.depth ?? 3;
  const maxRoots = input.maxRoots ?? 12;
  const maxAffected = input.maxAffected ?? 40;
  const filesTouched = [...new Set((input.files ?? []).map(normalize).filter(Boolean))].sort();
  const symbolHints = [...new Set((input.symbols ?? []).map((s) => s.trim()).filter(Boolean))];

  const roots = collectRoots(graph, symbolHints, filesTouched).slice(0, maxRoots);
  const affectedMap = new Map<string, InspectChangeAffected>();
  let direct = 0;
  let transitive = 0;

  for (const root of roots) {
    const imp = impactOf(graph, root.id, { depth });
    direct += imp.direct;
    transitive += imp.transitive;
    for (const a of imp.affected) {
      const prev = affectedMap.get(a.id);
      if (!prev || a.depth < prev.depth || (a.depth === prev.depth && a.confidence > prev.confidence)) {
        affectedMap.set(a.id, {
          id: a.id,
          name: a.name,
          kind: a.kind,
          file: a.file,
          line: a.line,
          depth: a.depth,
          confidence: a.confidence,
          viaRoot: root.qualifiedName,
        });
      }
    }
  }

  const affected = [...affectedMap.values()]
    .sort((a, b) => a.depth - b.depth || b.confidence - a.confidence || a.name.localeCompare(b.name))
    .slice(0, maxAffected);

  const report: InspectChangeReport = {
    roots,
    affected,
    direct,
    transitive,
    filesTouched,
    rendered: '',
  };
  report.rendered = renderInspectChange(report);
  return report;
}

function collectRoots(graph: VgGraph, symbols: string[], files: string[]): InspectChangeRoot[] {
  const out: InspectChangeRoot[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (seen.has(id)) return;
    const node = graph.nodes.find((n) => n.id === id);
    if (!node || node.kind === 'file' || node.kind === 'external') return;
    seen.add(id);
    out.push({
      id: node.id,
      qualifiedName: node.qualifiedName,
      kind: node.kind,
      file: node.file,
      line: node.span?.start ?? 0,
    });
  };

  for (const s of symbols) {
    if (graph.nodes.some((n) => n.id === s)) {
      push(s);
      continue;
    }
    const hit = resolveOne(graph, s);
    if (hit.node) push(hit.node.id);
    else if (hit.candidates.length === 1 && hit.candidates[0]) push(hit.candidates[0].id);
  }

  for (const file of files) {
    for (const n of graph.nodes) {
      if (n.kind === 'file' || n.kind === 'external') continue;
      if (normalize(n.file) === file) push(n.id);
    }
  }

  return out.sort((a, b) => a.file.localeCompare(b.file) || a.qualifiedName.localeCompare(b.qualifiedName));
}

function renderInspectChange(r: InspectChangeReport): string {
  const lines: string[] = ['## Inspect change (blast radius)'];
  if (r.filesTouched.length) lines.push(`Files: ${r.filesTouched.join(', ')}`);
  if (!r.roots.length) {
    lines.push('No graph symbols resolved for this change — impact unknown.');
    return lines.join('\n');
  }
  lines.push(`Roots (${r.roots.length}):`);
  for (const root of r.roots) {
    lines.push(`- ${root.qualifiedName} (${root.kind}) ${root.file}:${root.line}`);
  }
  lines.push(`Affected: ${r.affected.length} (direct≈${r.direct}, transitive≈${r.transitive})`);
  if (!r.affected.length) {
    lines.push('Nothing depends on these symbols (safe to change in isolation).');
  } else {
    for (const a of r.affected.slice(0, 30)) {
      lines.push(`- ${a.name} (${a.file}:${a.line}) d=${a.depth} via ${a.viaRoot}`);
    }
    if (r.affected.length > 30) lines.push(`… +${r.affected.length - 30} more`);
  }
  return lines.join('\n');
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}
