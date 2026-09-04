/**
 * Interprocedural inherit for the duty IR — one to two hops along the call
 * edges the graph already stores.
 *
 * A controller whose whole body is `return _products.Create(dto);` has no
 * store call of its own, so its own duties say nothing about persistence.
 * The write lives one call away. This pass copies a callee's *own* live
 * duties (persist / query / http / publish / fs / auth / crypto / cache)
 * onto each caller as `hop: 1`, and a callee's hop-1 duties as `hop: 2`,
 * with `via` naming the callee. Purpose only, never role: the kernel scores
 * an inherited duty at half weight per hop, and the caller's role stays
 * where its names put it. Bounded: 8 inherited duties per caller, two hops,
 * deterministic order.
 */
import type { GraphEdge, GraphNode } from '../schema.js';
import type { Duty } from './duties.js';

const INHERITABLE = new Set<Duty['k']>(['persist', 'query', 'http', 'publish', 'fs', 'auth', 'crypto', 'cache']);
const CALLABLE = new Set(['function', 'method', 'route', 'component', 'job', 'test']);
const MAX_INHERITED = 8;
const MAX_HOPS = 2;

/**
 * Call edges worth inheriting through: a precise rung (scip / tsc /
 * stack-graph), or a heuristic edge the resolver was sure of — a unique
 * same-file or strictly-imported match. A pick among several candidates
 * (confidence 0.4–0.6) names a plausible callee, not the one that runs, and
 * a duty inherited through it would over-paint the caller.
 */
export const TRUSTED_HEURISTIC_CONFIDENCE = 0.75;
export function edgeTrusted(e: Pick<GraphEdge, 'resolution' | 'confidence'>): boolean {
  return e.resolution !== 'heuristic' || e.confidence >= TRUSTED_HEURISTIC_CONFIDENCE;
}

/** Last segment of a `via` (`repo.add` → `add`, `IProductService.Create` → `Create`). */
function lastSeg(via: string | undefined): string {
  return via?.split(/[.:#]/).pop() ?? '';
}

/**
 * The caller's own duty sites that target `callee`: a `delegate` whose `via`
 * is the callee's qualified name, or a typed site whose receiver type and
 * method name the callee. Returns the merged liveness — live when any site
 * is live, carrying a guard only when every live site has one.
 */
function callSite(caller: GraphNode, callee: GraphNode): { live: boolean; guard?: string } | undefined {
  const qn = callee.qualifiedName;
  const segs = qn.split('.');
  const method = segs[segs.length - 1] ?? '';
  const cls = segs.length >= 2 ? segs[segs.length - 2]! : '';
  const sites = (caller.duties ?? []).filter((d) => {
    if (d.hop) return false;
    if (d.via === qn) return true;
    if (!d.t || !cls || lastSeg(d.via) !== method) return false;
    return d.t === cls || d.t.replace(/^I(?=[A-Z])/, '') === cls || `${d.t}Impl` === cls;
  });
  if (!sites.length) return undefined;
  const live = sites.filter((d) => d.live);
  if (!live.length) return { live: false };
  const guard = live.every((d) => d.g) ? live[0]!.g : undefined;
  return guard ? { live: true, guard } : { live: true };
}

export function inheritDuties(nodes: GraphNode[], edges: GraphEdge[]): void {
  const byId = new Map<string, GraphNode>();
  for (const n of nodes) if (CALLABLE.has(n.kind)) byId.set(n.id, n);
  const callees = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== 'call' || e.src === e.dst) continue;
    if (!byId.has(e.src) || !byId.has(e.dst)) continue;
    if (!edgeTrusted(e)) continue;
    let list = callees.get(e.src);
    if (!list) {
      list = [];
      callees.set(e.src, list);
    }
    if (!list.includes(e.dst)) list.push(e.dst);
  }
  // Typed delegations the edge resolver could not follow: a duty `via`
  // `ProductService.Create` (or `IProductService.Create`) names a callable;
  // a MediatR-style `Send(CreateProductCommand)` names `CreateProductCommandHandler.Handle`.
  // A qualified name can exist in several files (and languages): pick the
  // caller's own file first, then its language; never cross languages.
  const byQualified = new Map<string, GraphNode[]>();
  const handlerByClass = new Map<string, string>();
  const pick = (caller: GraphNode, name: string): string | undefined => {
    const cands = byQualified.get(name);
    if (!cands) return undefined;
    const hit = cands.find((c) => c.file === caller.file) ?? cands.find((c) => c.lang === caller.lang);
    return hit?.id;
  };
  for (const n of byId.values()) {
    let list = byQualified.get(n.qualifiedName);
    if (!list) {
      list = [];
      byQualified.set(n.qualifiedName, list);
    }
    list.push(n);
    const segs = n.qualifiedName.split('.');
    if (segs.length >= 2 && /^(?:Handle|handle|HandleAsync|Execute|execute|ExecuteAsync|__call__|run|Run|invoke|Invoke)$/.test(segs[segs.length - 1]!)) {
      const cls = segs[segs.length - 2]!;
      if (!handlerByClass.has(cls)) handlerByClass.set(cls, n.id);
    }
  }
  for (const n of byId.values()) {
    for (const d of n.duties ?? []) {
      if (d.k !== 'delegate' || d.hop) continue;
      const targets: string[] = [];
      if (d.via) {
        const [cls, method] = d.via.split('.');
        if (cls && method) {
          for (const c of [cls, cls.replace(/^I(?=[A-Z])/, ''), `${cls}Impl`]) {
            const id = pick(n, `${c}.${method}`);
            if (id) targets.push(id);
          }
        }
      }
      if (d.o && /mediator|sender|bus|dispatch/i.test(d.via ?? '')) {
        for (const c of [`${d.o}Handler`, d.o.replace(/(?:Command|Query|Request)$/, '') + 'Handler']) {
          const id = handlerByClass.get(c);
          if (id) targets.push(id);
        }
      }
      if (!targets.length) continue;
      let list = callees.get(n.id);
      if (!list) {
        list = [];
        callees.set(n.id, list);
      }
      for (const t of targets) if (t !== n.id && !list.includes(t)) list.push(t);
    }
  }
  if (!callees.size) return;

  // Own duties are the seed; each hop reads the previous hop's result only,
  // so a cycle cannot feed on itself.
  const layer = new Map<string, Duty[]>();
  for (const n of byId.values()) {
    const own = (n.duties ?? []).filter((d) => !d.hop && d.live && INHERITABLE.has(d.k));
    if (own.length) layer.set(n.id, own);
  }
  const added = new Map<string, Duty[]>();
  let current = layer;
  for (let hop = 1; hop <= MAX_HOPS; hop++) {
    const next = new Map<string, Duty[]>();
    const callerIds = [...callees.keys()].sort();
    for (const callerId of callerIds) {
      const caller = byId.get(callerId)!;
      const have = new Set((caller.duties ?? []).map((d) => `${d.k}|${d.via ?? ''}`));
      const out = added.get(callerId) ?? [];
      for (const calleeId of [...callees.get(callerId)!].sort()) {
        const src = current.get(calleeId);
        if (!src) continue;
        const callee = byId.get(calleeId)!;
        // The caller's own sites for this callee decide whether the callee's
        // duties can happen here: a call under `if (false)` or after a
        // `return` inherits nothing; a guarded call passes its guard on.
        const site = callSite(caller, callee);
        if (site && !site.live) continue;
        for (const d of src) {
          if (out.length >= MAX_INHERITED) break;
          const key = `${d.k}|${callee.qualifiedName}`;
          if (have.has(key)) continue;
          have.add(key);
          const inherited: Duty = { k: d.k, via: callee.qualifiedName, live: true, hop, line: 0 };
          if (d.o) inherited.o = d.o;
          if (d.t) inherited.t = d.t;
          if (site?.guard) inherited.g = site.guard;
          out.push(inherited);
        }
      }
      if (out.length) {
        added.set(callerId, out);
        const thisHop = out.filter((d) => d.hop === hop);
        if (thisHop.length) next.set(callerId, thisHop);
      }
    }
    current = next;
    if (!current.size) break;
  }
  for (const [id, extra] of added) {
    const n = byId.get(id)!;
    n.duties = [...(n.duties ?? []), ...extra];
  }
}
