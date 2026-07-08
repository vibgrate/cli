import { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph } from './util.js';
import { impactOf } from '../engine/impact.js';
import { c, info, json } from '../util/output.js';
import type { GraphNode, Unknown, VgGraph } from '../schema.js';

/**
 * `vg unknowns` — the honest inverse of a scanner that hides its blind spots.
 *
 * The graph records every heuristic reference it could not resolve (a call to a
 * name with no reachable definition, a supertype it could not connect), minus any
 * site a precise rung already covered. This command ranks those blind spots by
 * *blast radius*: an unresolved call inside a hub is far more consequential than
 * one in a leaf, because the graph is blind about a node everything depends on.
 * Deterministic: same graph → same ranking.
 */

// Bound the impact BFS work: rank the most-central candidate sites exactly and
// note if the tail was ordered by centrality alone.
const IMPACT_CANDIDATE_CAP = 200;

export interface Site {
  node: GraphNode;
  refs: Unknown[];
  total: number; // total unresolved occurrences at this site
  blastRadius: number; // transitive dependents (blind-spot reach)
  direct: number;
  transitive: number;
}

export interface RankedUnknowns {
  sites: Site[];
  totalSites: number; // distinct sites with unknowns
  /** True when more sites existed than were exactly blast-radius scored (see cap). */
  capped: boolean;
}

export function registerUnknowns(program: Command): void {
  const cmd = program
    .command('unknowns')
    .description('what the graph cannot resolve, ranked by blast radius')
    .option('-n, --limit <n>', 'how many sites to show', '20')
    .action(function (this: Command, opts: { limit?: string }) {
      const global = readGlobal(this);
      const { graph } = requireGraph(global);
      const limit = Number(opts.limit) || 20;

      const ranked = rankUnknowns(graph, limit);
      const { sites, totalSites, capped } = ranked;
      const totalRefs = (graph.unknowns ?? []).reduce((n, u) => n + u.count, 0);

      if (global.json) {
        json({
          unresolvedReferences: totalRefs,
          sites: totalSites,
          shown: sites.length,
          blastRankedCandidateCap: capped ? IMPACT_CANDIDATE_CAP : null,
          top: sites.map((s) => ({
            id: s.node.id,
            name: s.node.qualifiedName,
            kind: s.node.kind,
            file: s.node.file,
            line: s.node.span.start,
            importance: s.node.importance,
            blastRadius: s.blastRadius,
            direct: s.direct,
            transitive: s.transitive,
            unresolved: s.refs.map((r) => ({ name: r.name, kind: r.kind, count: r.count })),
          })),
        });
        return;
      }

      if (totalRefs === 0) {
        info(
          `${c.cyan('vg unknowns')} · none — every heuristic reference resolved ` +
            `(or was covered by a precise rung)`,
        );
        return;
      }

      info(
        `${c.cyan('vg unknowns')} · ${c.bold(String(totalRefs))} unresolved reference(s) at ` +
          `${totalSites} site(s) · top ${sites.length} by blast radius`,
      );
      for (const s of sites) {
        info(
          `  ${c.yellow(pad(String(s.blastRadius), 5))}  ${c.bold(s.node.qualifiedName)}  ` +
            c.dim(`${s.node.file}:${s.node.span.start} · importance ${s.node.importance.toFixed(3)}`),
        );
        info(`         ${c.dim('cannot resolve:')} ${s.refs.map(fmtRef).join(', ')}`);
      }
      info(
        c.dim(
          `  blast radius = transitive dependents; these are the code paths the graph is blind about`,
        ),
      );
      if (capped) {
        info(
          c.dim(
            `  note: ${totalSites} sites have unknowns; only the top ${IMPACT_CANDIDATE_CAP} by ` +
              `centrality were blast-radius scored (the tail is ordered by centrality alone)`,
          ),
        );
      }
    });
  applyGlobalOptions(cmd);
}

/** Group unknowns by their originating node and rank by blast radius. */
export function rankSites(graph: VgGraph, limit: number): Site[] {
  return rankUnknowns(graph, limit).sites;
}

/** Group unknowns by originating node, rank by blast radius, and report truncation. */
export function rankUnknowns(graph: VgGraph, limit: number): RankedUnknowns {
  const unknowns = graph.unknowns ?? [];
  if (unknowns.length === 0) return { sites: [], totalSites: 0, capped: false };

  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const grouped = new Map<string, Unknown[]>();
  for (const u of unknowns) {
    const list = grouped.get(u.from);
    if (list) list.push(u);
    else grouped.set(u.from, [u]);
  }

  // Only sites whose node still exists; pre-rank by centrality so the exact
  // (bounded) impact pass runs on the most consequential candidates first.
  const candidates: { node: GraphNode; refs: Unknown[]; total: number }[] = [];
  for (const [from, refs] of grouped) {
    const node = byId.get(from);
    if (!node) continue;
    candidates.push({ node, refs, total: refs.reduce((n, r) => n + r.count, 0) });
  }
  candidates.sort(
    (a, b) => b.node.importance - a.node.importance || a.node.id.localeCompare(b.node.id),
  );

  const scored: Site[] = candidates.slice(0, IMPACT_CANDIDATE_CAP).map((cand) => {
    const impact = impactOf(graph, cand.node.id);
    return {
      ...cand,
      blastRadius: impact.affected.length,
      direct: impact.direct,
      transitive: impact.transitive,
    };
  });

  scored.sort(
    (a, b) =>
      b.blastRadius - a.blastRadius ||
      b.node.importance - a.node.importance ||
      b.total - a.total ||
      a.node.id.localeCompare(b.node.id),
  );

  return {
    sites: scored.slice(0, limit),
    totalSites: candidates.length,
    capped: candidates.length > IMPACT_CANDIDATE_CAP,
  };
}

function fmtRef(r: Unknown): string {
  const times = r.count > 1 ? ` ×${r.count}` : '';
  const kind = r.kind === 'call' ? '' : ` (${r.kind})`;
  return `${r.name}${kind}${times}`;
}

function pad(s: string, n: number): string {
  return s.padStart(n, ' ');
}
