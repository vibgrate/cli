/**
 * The `assess_change` binding: graph + root in, envelope out.
 *
 * Sits between the MCP tool (which owns transport and schema) and
 * `assess.ts` (which owns the rules). Its whole job is assembling the
 * baseline — peer votes, the similarity index, the guard convention — from a
 * graph the server already has loaded, and never throwing while it does so.
 *
 * The baseline is cached per (root, corpusHash). An agent calls this once per
 * edit, so rebuilding the index on every call would put seconds into a loop
 * that has to feel instant; keying on the graph's own corpus hash means a
 * rebuilt map invalidates it automatically and a stale one never silently
 * answers for the current code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyFile } from '../core-open/scanners/architecture/classify.js';
import type { ArchitectureLayer } from '../core-open/types.js';
import type { VgGraph } from '../schema.js';
import { assessChange, type AssessResult } from './assess.js';
import { classifyRoute } from './auth.js';
import { classifyDataAccess, type DataAccessPattern } from './dimensions.js';
import { MIN_GROUP_SIZE, voteAll, type DominanceVote, type PeerFile } from './dominance.js';
import { fileRecencyDays } from './git.js';
import { readDeclaredIntent } from './intent.js';
import { routesForFile } from './routes.js';
import { isComparable, SimilarityIndex, type FunctionBody } from './similarity.js';

interface Baseline {
  corpusHash: string;
  votes: DominanceVote[];
  dataAccess: Map<string, DataAccessPattern>;
  similarity: SimilarityIndex;
  declaredTarget: string | null;
  guardedByDirectory: Map<string, { guarded: number; classified: number }>;
}

const cache = new Map<string, Baseline>();

/** Drop the cached baseline for one root, or all of them. Used by tests. */
export function clearAssessBaselineCache(root?: string): void {
  if (root === undefined) cache.clear();
  else cache.delete(path.resolve(root));
}

const BOUNDARY_EDGE_KINDS = new Set(['import', 'call']);
const FUNCTION_KINDS = new Set(['function', 'method']);
const ROUTE_LAYERS = new Set<ArchitectureLayer>(['routing', 'middleware', 'presentation']);
const MAX_ROUTE_FILES = 300;

function buildBaseline(graph: VgGraph, root: string): Baseline {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const normalize = (p: string): string => p.replace(/\\/g, '/');
  const layerCache = new Map<string, ArchitectureLayer | null>();
  const layerOf = (p: string): ArchitectureLayer | null => {
    if (layerCache.has(p)) return layerCache.get(p)!;
    const cls = classifyFile(p, 'unknown');
    const layer = cls?.layer ?? null;
    layerCache.set(p, layer);
    return layer;
  };

  // Outgoing layer set per file — the input to the data-access dimension.
  const outgoing = new Map<string, Set<ArchitectureLayer>>();
  for (const edge of graph.edges) {
    if (!BOUNDARY_EDGE_KINDS.has(edge.kind)) continue;
    const src = nodeById.get(edge.src);
    const dst = nodeById.get(edge.dst);
    if (!src || !dst) continue;
    const from = normalize(src.file);
    const to = normalize(dst.file);
    if (from === to) continue;
    const toLayer = layerOf(to);
    if (!toLayer) continue;
    let set = outgoing.get(from);
    if (!set) outgoing.set(from, (set = new Set()));
    set.add(toLayer);
  }

  const areaOfFile = new Map<string, number>();
  for (const area of graph.areas) {
    for (const member of area.members) {
      const node = nodeById.get(member);
      if (node) areaOfFile.set(normalize(node.file), area.id);
    }
  }

  const files = [...new Set(graph.nodes.map((n) => normalize(n.file)))].sort();
  const recency = fileRecencyDays(root);
  const intent = readDeclaredIntent(root);

  const dataAccess = new Map<string, DataAccessPattern>();
  const candidates: { path: string; pattern: DataAccessPattern; role: string; areaGroup: string | null }[] = [];
  for (const file of files) {
    const cls = classifyFile(file, 'unknown');
    if (!cls) continue;
    const pattern = classifyDataAccess(cls.layer, [...(outgoing.get(file) ?? [])]);
    if (!pattern) continue;
    dataAccess.set(file, pattern);
    const areaId = areaOfFile.get(file);
    const role = cls.role ?? cls.layer;
    candidates.push({
      path: file,
      pattern,
      role,
      areaGroup: areaId !== undefined ? `area:${areaId}:${role}` : null,
    });
  }

  // Same grouping rule as the capsule compiler: area when thick enough, role
  // otherwise. It has to match, or the tool and the review would disagree about
  // what a file's peers even are.
  const areaCounts = new Map<string, number>();
  for (const c of candidates) {
    if (c.areaGroup) areaCounts.set(c.areaGroup, (areaCounts.get(c.areaGroup) ?? 0) + 1);
  }
  const peerFiles: PeerFile[] = candidates.map((c) => {
    const useArea = c.areaGroup !== null && (areaCounts.get(c.areaGroup) ?? 0) >= MIN_GROUP_SIZE;
    return {
      path: c.path,
      pattern: c.pattern,
      group: useArea ? c.areaGroup! : `role:${c.role}`,
      groupKind: useArea ? 'area' : 'role',
      daysSinceCommit: recency.get(c.path) ?? null,
    };
  });

  // Similarity index over existing bodies.
  const similarity = new SimilarityIndex();
  const lineCache = new Map<string, string[] | null>();
  const linesOf = (rel: string): string[] | null => {
    if (lineCache.has(rel)) return lineCache.get(rel)!;
    let value: string[] | null = null;
    try {
      const abs = path.join(root, rel);
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size <= 1024 * 1024) value = fs.readFileSync(abs, 'utf8').split('\n');
    } catch {
      value = null;
    }
    lineCache.set(rel, value);
    return value;
  };
  for (const node of graph.nodes) {
    if (!FUNCTION_KINDS.has(node.kind)) continue;
    const rel = normalize(node.file);
    if (!isComparable(rel)) continue;
    const lines = linesOf(rel);
    if (!lines) continue;
    const text = lines.slice(node.span.start - 1, node.span.end).join('\n');
    if (!text.trim()) continue;
    const body: FunctionBody = {
      id: node.id,
      name: node.name,
      file: rel,
      startLine: node.span.start,
      endLine: node.span.end,
      text,
    };
    similarity.add(body);
  }

  // Guard convention per directory.
  const guardedByDirectory = new Map<string, { guarded: number; classified: number }>();
  let routeFiles = 0;
  for (const file of files) {
    if (routeFiles >= MAX_ROUTE_FILES) break;
    const layer = layerOf(file);
    if (!layer || !ROUTE_LAYERS.has(layer)) continue;
    const lines = linesOf(file);
    if (!lines) continue;
    routeFiles++;
    const dir = file.split('/').slice(0, -1).join('/') || '.';
    for (const route of routesForFile(file, lines.join('\n'))) {
      const verdict = classifyRoute(route);
      if (verdict.verdict === 'unsure') continue;
      if (!/^(POST|PUT|PATCH|DELETE|ALL)$/i.test(route.method)) continue;
      const entry = guardedByDirectory.get(dir) ?? { guarded: 0, classified: 0 };
      entry.classified++;
      if (verdict.verdict === 'auth') entry.guarded++;
      guardedByDirectory.set(dir, entry);
    }
  }

  return {
    corpusHash: graph.provenance.corpusHash,
    votes: voteAll(peerFiles, { declaredPatterns: intent.patterns }),
    dataAccess,
    similarity,
    declaredTarget: intent.patterns[0] ?? null,
    guardedByDirectory,
  };
}

/**
 * Assess a proposed change against the served graph.
 *
 * Never throws: a tool that raises mid-edit gives an agent nothing to act on
 * and teaches it to stop asking. Every failure is a value with a status.
 */
export function assessProposedChange(
  graph: VgGraph,
  root: string,
  file: string,
  content: string,
): AssessResult | { error: string; message: string } {
  if (!file) return { error: 'bad_request', message: 'file is required' };
  if (!content) return { error: 'bad_request', message: 'content is required' };

  const key = path.resolve(root);
  let baseline = cache.get(key);
  // The graph's own corpus hash is the cache key, so a rebuilt map invalidates
  // this automatically and a stale one can never answer for current code.
  if (!baseline || baseline.corpusHash !== graph.provenance.corpusHash) {
    try {
      baseline = buildBaseline(graph, root);
      cache.set(key, baseline);
    } catch {
      return {
        status: 'no_baseline',
        ok: true,
        conflicts: [],
        duplicateOf: [],
        convention: null,
        declaredTarget: null,
        unknowns: ['The baseline could not be built from the code map, so nothing was checked.'],
        confidence: 0.2,
      };
    }
  }

  const normalized = file.replace(/\\/g, '/');
  const cls = classifyFile(normalized, 'unknown');
  const role = cls ? (cls.role ?? cls.layer) : null;
  const directory = normalized.split('/').slice(0, -1).join('/') || '.';

  return assessChange({
    file: normalized,
    content,
    votes: baseline.votes,
    dataAccess: baseline.dataAccess,
    similarity: baseline.similarity,
    declaredTarget: baseline.declaredTarget,
    // Resolve the peer group the same way the capsule does, preferring the
    // file's area when it has one and falling back to its role.
    group:
      baseline.votes.find((v) => v.exemplars.includes(normalized) || v.deviators.includes(normalized))
        ?.group ?? (role ? `role:${role}` : undefined),
    guardedShare: baseline.guardedByDirectory.get(directory) ?? null,
  });
}
