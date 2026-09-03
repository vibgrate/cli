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

export function inheritDuties(nodes: GraphNode[], edges: GraphEdge[]): void {
  const byId = new Map<string, GraphNode>();
  for (const n of nodes) if (CALLABLE.has(n.kind)) byId.set(n.id, n);
  const callees = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== 'call' || e.src === e.dst) continue;
    if (!byId.has(e.src) || !byId.has(e.dst)) continue;
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
  const byQualified = new Map<string, string>();
  const handlerByClass = new Map<string, string>();
  for (const n of byId.values()) {
    if (!byQualified.has(n.qualifiedName)) byQualified.set(n.qualifiedName, n.id);
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
            const id = byQualified.get(`${c}.${method}`);
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
        for (const d of src) {
          if (out.length >= MAX_INHERITED) break;
          const key = `${d.k}|${callee.qualifiedName}`;
          if (have.has(key)) continue;
          have.add(key);
          const inherited: Duty = { k: d.k, via: callee.qualifiedName, live: true, hop, line: 0 };
          if (d.o) inherited.o = d.o;
          if (d.t) inherited.t = d.t;
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
