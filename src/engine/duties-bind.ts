/**
 * Edge binding for the duty IR — the "compiler types" rung the walker lacks.
 *
 * `engine/duties.ts` types a receiver from this file's own declarations and,
 * failing that, from its spelling. A field declared on a base class, a
 * collaborator from `GetRequiredService<T>()`, or a port that lives in another
 * package stays untyped there, and a store-shaped call on it is left as a
 * *candidate* rather than guessed. This pass runs on the final edge set:
 * when a scip / tsc / stack-graph edge — or a heuristic edge the resolver was
 * sure of — names the callee, the callee's declaring class types the site
 * (`ProductRepository.AddAsync` → store → `persist Product`), and the bound
 * duty joins the caller's own list with `t` set to that class. Order of
 * trust: precise rung, then a sure heuristic; never a pick among candidates.
 * Candidates nothing resolved are dropped: an untyped call is not evidence.
 */
import type { GraphEdge, GraphNode } from '../schema.js';
import { bindCandidate, mergeDuties, type Duty, type DutyCandidate } from './duties.js';
import { edgeTrusted } from './duties-inherit.js';

const CALLABLE = new Set(['function', 'method', 'route', 'component', 'job', 'test']);

function rank(e: GraphEdge): number {
  switch (e.resolution) {
    case 'scip':
      return 4;
    case 'tsc':
      return 3;
    case 'stackgraph':
      return 2;
    default:
      return edgeTrusted(e) ? 1 : 0;
  }
}

/** The class a callable belongs to: its qualified name's penultimate segment, else its file stem. */
export function declaringClass(n: GraphNode): string {
  const segs = n.qualifiedName.split('.');
  if (segs.length >= 2) return segs[segs.length - 2]!;
  const stem = n.file.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
  return stem;
}

export function bindDutyCandidates(nodes: GraphNode[], edges: GraphEdge[], candidates: Map<string, DutyCandidate[]>): void {
  if (!candidates.size) return;
  const byId = new Map<string, GraphNode>();
  for (const n of nodes) if (CALLABLE.has(n.kind)) byId.set(n.id, n);
  // Per caller: the trusted callees, best edge first.
  const callees = new Map<string, Array<{ node: GraphNode; rank: number }>>();
  for (const e of edges) {
    if (e.kind !== 'call' || e.src === e.dst || !candidates.has(e.src)) continue;
    const target = byId.get(e.dst);
    if (!target) continue;
    const r = rank(e);
    if (r === 0) continue;
    let list = callees.get(e.src);
    if (!list) {
      list = [];
      callees.set(e.src, list);
    }
    list.push({ node: target, rank: r });
  }
  for (const [callerId, cands] of candidates) {
    const caller = byId.get(callerId);
    const targets = callees.get(callerId);
    if (!caller || !targets?.length) continue;
    const bound: Duty[] = [];
    for (const cand of cands) {
      const verb = cand.verb.replace(/[!?]$/, '');
      const matches = targets
        .filter((t) => t.node.name === verb || t.node.name === cand.verb)
        .sort((a, b) => b.rank - a.rank || a.node.qualifiedName.localeCompare(b.node.qualifiedName));
      for (const m of matches) {
        const duty = bindCandidate(cand, declaringClass(m.node));
        if (duty) {
          bound.push(duty);
          break;
        }
      }
    }
    if (bound.length) caller.duties = mergeDuties(caller.duties, bound);
  }
}
