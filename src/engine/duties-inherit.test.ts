import { describe, expect, it } from 'vitest';
import { inheritDuties } from './duties-inherit.js';
import type { GraphEdge, GraphNode } from '../schema.js';

/**
 * A delegating one-liner controller inherits the write behind it as a
 * purpose (hop 1), never as a role. Typed delegations resolve by the
 * declared type; MediatR-style sends resolve by the command's handler.
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
const edge = (src: string, dst: string): GraphEdge => ({ id: `${src}-${dst}`, kind: 'call', src, dst, resolution: 'heuristic', confidence: 0.8 }) as GraphEdge;

describe('inheritDuties', () => {
  it('follows call edges one and two hops, damping via hop, purpose only', () => {
    const nodes = [
      node('c', 'ProductsController.Create', 'Api/ProductsController.cs', [{ k: 'delegate', o: 'CreateProductDto', via: 'IProductService.Create', live: true, line: 3 }]),
      node('s', 'ProductService.Create', 'App/ProductService.cs', [{ k: 'delegate', via: 'IProductRepository.AddAsync', live: true, line: 8 }]),
      node('r', 'ProductRepository.AddAsync', 'Infra/ProductRepository.cs', [{ k: 'persist', o: 'Product', via: '_context.Products.Add', t: 'ApplicationDbContext', live: true, line: 12 }]),
    ];
    inheritDuties(nodes, [edge('c', 's'), edge('s', 'r')]);
    const controller = nodes[0]!.duties!;
    // `via` names what the caller itself calls; the hop count says how far
    // behind it the write sits.
    expect(controller.map((d) => [d.k, d.via, d.hop])).toEqual([
      ['delegate', 'IProductService.Create', undefined],
      ['persist', 'ProductService.Create', 2],
    ]);
    expect(nodes[1]!.duties!.find((d) => d.hop === 1)).toMatchObject({ k: 'persist', o: 'Product', via: 'ProductRepository.AddAsync', t: 'ApplicationDbContext' });
  });

  it('resolves a typed delegation without a call edge, stripping the interface I', () => {
    const nodes = [
      node('c', 'ProductsController.Create', 'Api/ProductsController.cs', [{ k: 'delegate', o: 'CreateProductDto', via: 'IProductService.Create', live: true, line: 3 }]),
      node('s', 'ProductService.Create', 'App/ProductService.cs', [{ k: 'persist', o: 'Product', via: 'repo.AddAsync', live: true, line: 8 }]),
    ];
    inheritDuties(nodes, []);
    expect(nodes[0]!.duties!.at(-1)).toMatchObject({ k: 'persist', o: 'Product', via: 'ProductService.Create', hop: 1 });
  });

  it('resolves a MediatR send to the command handler', () => {
    const nodes = [
      node('c', 'ProductsController.Create', 'Api/ProductsController.cs', [{ k: 'delegate', o: 'CreateProductCommand', via: '_mediator.Send', live: true, line: 3 }]),
      node('h', 'CreateProductCommandHandler.Handle', 'App/CreateProductCommand.cs', [{ k: 'persist', o: 'Product', via: '_context.Products.Add', live: true, line: 9 }]),
    ];
    inheritDuties(nodes, []);
    expect(nodes[0]!.duties!.at(-1)).toMatchObject({ k: 'persist', o: 'Product', via: 'CreateProductCommandHandler.Handle', hop: 1 });
  });

  it('never inherits dead, failure-path, log or delegate duties, and never from itself', () => {
    const nodes = [
      node('a', 'A.run', 'a.ts', [{ k: 'delegate', via: 'B.go', live: true, line: 1 }]),
      node('b', 'B.go', 'b.ts', [
        { k: 'persist', o: 'X', via: 'repo.save', live: false, line: 2 },
        { k: 'log', via: 'logger.info', live: true, line: 3 },
        { k: 'http', o: '/x', via: 'client.get', live: false, g: 'catch', line: 4 },
        { k: 'delegate', via: 'C.z', live: true, line: 5 },
      ]),
    ];
    inheritDuties(nodes, [edge('a', 'b'), edge('b', 'b')]);
    expect(nodes[0]!.duties).toHaveLength(1);
  });

  it('is deterministic and capped', () => {
    const many = Array.from({ length: 12 }, (_, i) => node(`s${i}`, `S${i}.do`, `s${i}.ts`, [{ k: 'persist', o: `T${i}`, via: 'repo.save', live: true, line: 1 }]));
    const caller = node('c', 'C.run', 'c.ts', []);
    const edges = many.map((n) => edge('c', n.id));
    const a = [caller, ...many];
    inheritDuties(a, edges);
    const b = [node('c', 'C.run', 'c.ts', []), ...many.map((n) => ({ ...n, duties: n.duties!.filter((d) => !d.hop) }))];
    inheritDuties(b, edges);
    expect(a[0]!.duties).toHaveLength(8);
    expect(JSON.stringify(a[0]!.duties)).toBe(JSON.stringify(b[0]!.duties));
  });
});
