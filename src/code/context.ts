/**
 * Graph-grounded context assembly for `vg code` (VG-CLI-CODE §3).
 *
 * A generic coding agent starts blind and reconstructs structure by grepping and
 * reading whole files — which is exactly what blows the context window and
 * degrades the model. This module instead uses the deterministic code graph to
 * hand the planner a *small, high-signal, budget-bounded* context: the symbols
 * most relevant to the instruction, their immediate relations, the blast radius
 * of changing them, and any declared facts (hard constraints) that must not be
 * dropped by later compaction. Deterministic given a graph + instruction, so it
 * is fully offline-testable and benchmarkable.
 */

import { queryGraph } from '../engine/query.js';
import { indexFor } from '../engine/relations.js';
import { impactOf } from '../engine/impact.js';
import type { CodeContext } from './types.js';
import type { GraphNode, VgGraph } from '../schema.js';

export interface BuildContextOptions {
  /** Approx token budget for the rendered block (default 3000). */
  budget?: number;
  /** How many retrieval seeds to expand (default 8). */
  seeds?: number;
  /** Impact BFS depth for the blast radius (default 2). */
  impactDepth?: number;
  /** Restrict the edit surface to these files (from `--file`), if given. */
  files?: string[];
}

/**
 * Build the context block for a coding instruction. The ordering is
 * cache-stable by design (see router.ts): the invariant, repo-derived material
 * (facts, symbols, relations) comes first and the volatile instruction is
 * echoed last, so a provider's prompt cache can reuse the stable prefix across
 * turns.
 */
export function buildCodeContext(graph: VgGraph, instruction: string, options: BuildContextOptions = {}): CodeContext {
  const budget = options.budget ?? 3000;
  const seedLimit = options.seeds ?? 8;
  const impactDepth = options.impactDepth ?? 2;
  const index = indexFor(graph);

  // Retrieval seeds: reuse the deterministic lexical/structural retrieval that
  // backs `vg ask`. When `--file` narrows the surface, keep only seeds in those
  // files (but still let impact reach outside them, so the review is honest).
  const q = queryGraph(graph, instruction, { budget: Math.floor(budget * 0.6), limit: seedLimit * 2 });
  let seeds = q.matches.map((m) => ({ node: m.node, why: m.why }));
  if (options.files && options.files.length) {
    const set = new Set(options.files.map(normalize));
    const inScope = seeds.filter((s) => set.has(normalize(s.node.file)));
    // If nothing matched inside the named files, keep the best global seeds but
    // still steer target files to what the caller asked for.
    if (inScope.length) seeds = inScope;
  }
  seeds = seeds.slice(0, seedLimit);

  // Blast radius: who depends on the seeds. This is the impact-aware review
  // signal — an edit to a hub is riskier and the context says so.
  const impacted = new Map<string, { node: GraphNode; via: string }>();
  for (const s of seeds) {
    const impact = impactOf(graph, s.node.id, { depth: impactDepth });
    for (const item of impact.affected.slice(0, 6)) {
      const node = index.node(item.id);
      if (node && !impacted.has(node.id)) impacted.set(node.id, { node, via: s.node.qualifiedName });
    }
  }

  // Target files: the seed files (or the explicit --file set), stable order.
  const targetFiles = options.files?.length
    ? [...new Set(options.files.map(normalize))].sort()
    : [...new Set(seeds.map((s) => s.node.file))].sort();

  // Pinned facts: declared invariants/contracts that touch the seeds. These are
  // hard constraints; they are surfaced explicitly and never summarized away.
  const seedIds = new Set(seeds.map((s) => s.node.id));
  const pinnedFacts = pinnedFactsFor(graph, seedIds);

  const rendered = render(instruction, seeds, [...impacted.values()], targetFiles, pinnedFacts, index, budget);
  return {
    instruction,
    seeds,
    targetFiles,
    impacted: [...impacted.values()],
    pinnedFacts,
    rendered,
    tokensEstimate: estimateTokens(rendered),
  };
}

function pinnedFactsFor(graph: VgGraph, seedIds: Set<string>): string[] {
  if (!graph.facts?.length) return [];
  const out: string[] = [];
  for (const f of graph.facts) {
    if (f.kind === 'characterization') continue; // keep hard constraints only
    if (!f.subjectIds.some((id) => seedIds.has(id))) continue;
    const subjects = f.subjectIds
      .map((id) => graph.nodes.find((n) => n.id === id)?.qualifiedName ?? id)
      .join(', ');
    out.push(`${f.kind}: ${subjects} — ${JSON.stringify(f.predicate)}`);
  }
  return out.sort().slice(0, 12);
}

function render(
  instruction: string,
  seeds: { node: GraphNode; why: string }[],
  impacted: { node: GraphNode; via: string }[],
  targetFiles: string[],
  pinnedFacts: string[],
  index: ReturnType<typeof indexFor>,
  budget: number,
): string {
  const lines: string[] = [];
  lines.push('# Repository context (from the deterministic code graph)');
  lines.push('');

  if (pinnedFacts.length) {
    lines.push('## Hard constraints (do not violate)');
    for (const f of pinnedFacts) lines.push(`- ${f}`);
    lines.push('');
  }

  lines.push('## Relevant symbols');
  for (const { node, why } of seeds) {
    const block: string[] = [];
    block.push(`### ${node.qualifiedName}  (${node.kind}, ${node.file}:${node.span.start}-${node.span.end})`);
    if (node.signature) block.push('`' + node.signature + '`');
    const callees = uniqueNames(index.callees(node.id).map((x) => x.node.qualifiedName)).slice(0, 6);
    const callers = uniqueNames(index.callers(node.id).map((x) => x.node.qualifiedName)).slice(0, 6);
    if (callees.length) block.push(`calls: ${callees.join(', ')}`);
    if (callers.length) block.push(`called by: ${callers.join(', ')}`);
    block.push(`importance ${node.importance.toFixed(3)}${node.isHub ? ' · hub (high blast radius)' : ''} · ${why}`);
    block.push('');
    const candidate = lines.concat(block).join('\n');
    if (estimateTokens(candidate) > budget && lines.length > 3) break;
    lines.push(...block);
  }

  if (impacted.length) {
    lines.push('## Blast radius (would be affected by a change here)');
    for (const { node, via } of impacted.slice(0, 10)) {
      lines.push(`- ${node.qualifiedName} (${node.file}:${node.span.start}) — depends on ${via}`);
    }
    lines.push('');
  }

  lines.push('## Files in scope for this edit');
  for (const f of targetFiles) lines.push(`- ${f}`);
  lines.push('');

  lines.push('## Task');
  lines.push(instruction);
  return lines.join('\n');
}

function uniqueNames(xs: string[]): string[] {
  return [...new Set(xs)];
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
