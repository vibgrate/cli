import { describe, expect, it } from 'vitest';
import { bindDutyCandidates, declaringClass } from './duties-bind.js';
import { extractDutiesWithCandidates, fileBindings, type DutyCandidate } from './duties.js';
import { parseSource } from './parse.js';
import type { GraphEdge, GraphNode } from '../schema.js';

/**
 * The walker leaves an untyped store-shaped call as a candidate; the build
 * binds it to the callee a precise edge resolved to. A pick among several
 * heuristic candidates binds nothing.
 */
function node(id: string, qualifiedName: string, file: string, duties?: GraphNode['duties']): GraphNode {
  return {
    id,
    kind: 'method',
    name: qualifiedName.split('.').pop()!,
    qualifiedName,
    file,
    span: { start: 1, end: 5 },
    lang: 'cs',
    importance: 0,
    centrality: { degree: 0, betweenness: 0, pagerank: 0 } as never,
    area: -1,
    isHub: false,
    tested: null,
    ...(duties ? { duties } : {}),
  } as GraphNode;
}
const edge = (src: string, dst: string, resolution: GraphEdge['resolution'], confidence: number): GraphEdge =>
  ({ id: `${src}-${dst}`, kind: 'call', src, dst, resolution, confidence }) as GraphEdge;

describe('duty candidates', () => {
  it('leaves an untyped store-shaped call as a candidate, not a duty', async () => {
    const src = `
public class ProductsController : ApiControllerBase {
    public async Task<IActionResult> Create(CreateProductDto dto) {
        var product = new Product(dto.Name);
        await Catalog.AddAsync(product);
        return Ok(product);
    }
}`;
    const parsed = await parseSource('Api/ProductsController.cs', 'cs', src);
    const def = parsed.defs.find((d) => d.name === 'Create')!;
    expect((def.duties ?? []).map((d) => d.k)).toEqual(['respond']);
    expect(def.dutyCandidates).toEqual([expect.objectContaining({ verb: 'AddAsync', via: 'Catalog.AddAsync', o: 'Product', live: true })]);
  });

  it('extractDutiesWithCandidates keeps candidates apart from duties', async () => {
    const src = `export async function save(catalog, order) { return catalog.insert(order); }`;
    const parsed = await parseSource('src/orders.ts', 'ts', src);
    const def = parsed.defs.find((d) => d.name === 'save')!;
    expect(def.duties).toBeUndefined();
    expect(def.dutyCandidates?.[0]).toMatchObject({ verb: 'insert', via: 'catalog.insert' });
    void extractDutiesWithCandidates;
    void fileBindings;
  });
});

describe('bindDutyCandidates', () => {
  const cand: DutyCandidate = { verb: 'AddAsync', via: 'Catalog.AddAsync', line: 5, live: true, o: 'Product' };

  it('binds through a tsc edge to the callee\'s declaring class and types the site by it', () => {
    const nodes = [
      node('c', 'ProductsController.Create', 'Api/ProductsController.cs', [{ k: 'respond', o: '200', via: 'Ok', live: true, line: 6 }]),
      node('r', 'ProductRepository.AddAsync', 'Infra/ProductRepository.cs'),
    ];
    bindDutyCandidates(nodes, [edge('c', 'r', 'tsc', 1)], new Map([['c', [cand]]]));
    expect(nodes[0]!.duties).toEqual([
      { k: 'persist', o: 'Product', via: 'Catalog.AddAsync', t: 'ProductRepository', live: true, line: 5 },
      { k: 'respond', o: '200', via: 'Ok', live: true, line: 6 },
    ]);
  });

  it('binds an HTTP client callee on any verb, and a sure heuristic edge, but never a weak pick', () => {
    const nodes = [
      node('s', 'OrderService.place', 'App/OrderService.cs'),
      node('p', 'PaymentClient.charge', 'Infra/PaymentClient.cs'),
      node('x', 'OrderService.charge', 'App/OrderService.cs'),
    ];
    const charge: DutyCandidate = { verb: 'charge', via: 'payments.charge', line: 3, live: true };
    bindDutyCandidates(nodes, [edge('s', 'p', 'heuristic', 0.85)], new Map([['s', [charge]]]));
    expect(nodes[0]!.duties).toEqual([{ k: 'http', via: 'payments.charge', t: 'PaymentClient', live: true, line: 3 }]);

    const weak = [node('s2', 'OrderService.place', 'App/OrderService.cs'), node('p2', 'PaymentClient.charge', 'Infra/PaymentClient.cs')];
    bindDutyCandidates(weak, [edge('s2', 'p2', 'heuristic', 0.5)], new Map([['s2', [charge]]]));
    expect(weak[0]!.duties).toBeUndefined();
  });

  it('drops a candidate whose callee class says nothing, and names a module-level callee by its file', () => {
    const nodes = [node('a', 'A.run', 'a.ts'), node('m', 'Mapper.save', 'lib/mapper.ts'), node('f', 'insert', 'db/repo.ts')];
    (nodes[2] as { qualifiedName: string }).qualifiedName = 'insert';
    expect(declaringClass(nodes[2]!)).toBe('repo');
    const c1: DutyCandidate = { verb: 'save', via: 'mapper.save', line: 1, live: true };
    const c2: DutyCandidate = { verb: 'insert', via: 'db.insert', line: 2, live: true, o: 'User' };
    bindDutyCandidates(nodes, [edge('a', 'm', 'scip', 1), edge('a', 'f', 'scip', 1)], new Map([['a', [c1, c2]]]));
    expect(nodes[0]!.duties).toEqual([{ k: 'persist', o: 'User', via: 'db.insert', t: 'repo', live: true, line: 2 }]);
  });
});
