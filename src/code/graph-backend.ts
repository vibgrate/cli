/**
 * Graph query backend for the agent tool layer (Fusion Runtime).
 *
 * Tools prefer a warm ActiveGraph in vgd when a daemon session is attached;
 * otherwise they fall back to the in-process {@link VgGraph}. Failures never
 * surface to the model as transport errors — they degrade to local query.
 */

import { queryGraph } from '../engine/query.js';
import { impactOf } from '../engine/impact.js';
import { resolveOne } from '../engine/lookup.js';
import { vgdRequest, type VgdClientOptions } from '../runtime/vgd/client.js';
import type { VgdRequest } from '../runtime/vgd/protocol.js';
import type { VgGraph } from '../schema.js';

export type GraphBackendSource = 'local' | 'vgd';

export interface GraphSearchHit {
  id: string;
  qualifiedName: string;
  kind: string;
  file: string;
  line: number;
  score: number;
  why: string;
  signature?: string | null;
}

export interface GraphImpactHit {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  depth: number;
  confidence: number;
}

export interface GraphImpactResult {
  root: { id: string; name: string };
  depth: number;
  affected: GraphImpactHit[];
  direct: number;
  transitive: number;
  source: GraphBackendSource;
}

export interface GraphSearchResult {
  matches: GraphSearchHit[];
  source: GraphBackendSource;
}

export interface GraphBackend {
  readonly source: GraphBackendSource;
  search(query: string, opts?: { limit?: number }): Promise<GraphSearchResult>;
  impact(symbol: string, opts?: { depth?: number }): Promise<GraphImpactResult | null>;
}

/** Pure in-process backend over a loaded graph. */
export function localGraphBackend(graph: VgGraph): GraphBackend {
  return {
    source: 'local',
    async search(query, opts) {
      const res = queryGraph(graph, query, { budget: 1500, limit: opts?.limit ?? 10 });
      return {
        source: 'local',
        matches: res.matches.map((m) => ({
          id: m.node.id,
          qualifiedName: m.node.qualifiedName,
          kind: m.node.kind,
          file: m.node.file,
          line: m.node.span?.start ?? 0,
          score: m.score,
          why: m.why,
          signature: m.node.signature ?? null,
        })),
      };
    },
    async impact(symbol, opts) {
      const node = resolveSymbolId(graph, symbol);
      if (!node) return null;
      const imp = impactOf(graph, node, { depth: opts?.depth ?? 4 });
      return {
        source: 'local',
        root: imp.root,
        depth: imp.depth,
        affected: imp.affected.map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          file: a.file,
          line: a.line,
          depth: a.depth,
          confidence: a.confidence,
        })),
        direct: imp.direct,
        transitive: imp.transitive,
      };
    },
  };
}

export interface VgdGraphBackendOptions {
  repositoryId: string;
  gitRef?: string;
  socketPath?: string;
  /** Always required for fall back when vgd has no slot or is down. */
  fallback: VgGraph;
  request?: (req: VgdRequest, opts?: VgdClientOptions) => Promise<unknown>;
}

/**
 * Prefer vgd query/impact; on any failure or empty daemon state, use local.
 * The returned `source` reflects which path answered.
 */
export function vgdGraphBackend(options: VgdGraphBackendOptions): GraphBackend {
  const local = localGraphBackend(options.fallback);
  const request = options.request ?? ((req, opts) => vgdRequest(req, opts));
  const clientOpts: VgdClientOptions = { socketPath: options.socketPath };

  return {
    source: 'vgd',
    async search(query, opts) {
      try {
        const res = (await request(
          {
            op: 'query-graph',
            repositoryId: options.repositoryId,
            query,
            limit: opts?.limit ?? 10,
            gitRef: options.gitRef,
          },
          clientOpts,
        )) as {
          ok?: boolean;
          matches?: Array<{
            id: string;
            qualifiedName: string;
            kind: string;
            file: string;
            line: number;
            score: number;
            why: string;
          }>;
        };
        if (res?.ok && Array.isArray(res.matches)) {
          return {
            source: 'vgd',
            matches: res.matches.map((m) => ({
              id: m.id,
              qualifiedName: m.qualifiedName,
              kind: m.kind,
              file: m.file,
              line: m.line,
              score: m.score,
              why: m.why,
              signature: null,
            })),
          };
        }
      } catch {
        /* fall through */
      }
      return local.search(query, opts);
    },
    async impact(symbol, opts) {
      try {
        const res = (await request(
          {
            op: 'impact-of',
            repositoryId: options.repositoryId,
            symbol,
            depth: opts?.depth ?? 4,
            gitRef: options.gitRef,
          },
          clientOpts,
        )) as {
          ok?: boolean;
          root?: { id: string; name: string };
          depth?: number;
          affected?: GraphImpactHit[];
          direct?: number;
          transitive?: number;
        };
        if (res?.ok && res.root && Array.isArray(res.affected)) {
          return {
            source: 'vgd',
            root: res.root,
            depth: res.depth ?? opts?.depth ?? 4,
            affected: res.affected,
            direct: res.direct ?? 0,
            transitive: res.transitive ?? 0,
          };
        }
      } catch {
        /* fall through */
      }
      return local.impact(symbol, opts);
    },
  };
}

/**
 * Pick a backend: vgd when repositoryId + socket are known, else local.
 */
export function resolveGraphBackend(input: {
  graph: VgGraph;
  repositoryId?: string | null;
  gitRef?: string | null;
  socketPath?: string | null;
}): GraphBackend {
  if (input.repositoryId && input.socketPath) {
    return vgdGraphBackend({
      repositoryId: input.repositoryId,
      gitRef: input.gitRef ?? undefined,
      socketPath: input.socketPath,
      fallback: input.graph,
    });
  }
  return localGraphBackend(input.graph);
}

function resolveSymbolId(graph: VgGraph, symbol: string): string | null {
  if (graph.nodes.some((n) => n.id === symbol)) return symbol;
  const hit = resolveOne(graph, symbol);
  if (hit.node?.id) return hit.node.id;
  if (hit.candidates.length === 1 && hit.candidates[0]?.id) return hit.candidates[0].id;
  const q = symbol.toLowerCase();
  const byQn = graph.nodes.find((n) => n.qualifiedName?.toLowerCase() === q || n.name?.toLowerCase() === q);
  return byQn?.id ?? null;
}
