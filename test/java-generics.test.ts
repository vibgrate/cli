import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { serializeGraph } from '../src/engine/serialize.js';
import type { EdgeKind, VgGraph } from '../src/schema.js';
import { cleanup, makeProject } from './helpers.js';

/**
 * Java generic types are a `generic_type` node whose outer name is a direct
 * `type_identifier` child. Type arguments are nested under `type_arguments`
 * and must not become call or DI edges — including JDK types such as
 * `ArrayList` and `Map`, which stay unresolved.
 */

const PIN = '2020-01-01T00:00:00.000Z';
const FIXTURE = new URL('./fixtures/java-generics/', import.meta.url);
const RELS = [
  'src/com/example/generic/Cache.java',
  'src/com/example/generic/EventBus.java',
  'src/com/example/generic/Handler.java',
  'src/com/example/generic/OrderEvent.java',
  'src/com/example/generic/OrderService.java',
  'src/com/example/generic/Repository.java',
  'src/com/example/generic/User.java',
];

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function fixtureFiles(rels = RELS): Record<string, string> {
  return Object.fromEntries(rels.map((rel) => [rel, readFileSync(new URL(rel, FIXTURE), 'utf8')]));
}

function project(rels = RELS): string {
  const root = makeProject(fixtureFiles(rels));
  dirs.push(root);
  return root;
}

function namedEdges(graph: VgGraph, kind: EdgeKind): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n.qualifiedName]));
  return graph.edges
    .filter((e) => e.kind === kind)
    .map((e) => `${byId.get(e.src)} -> ${byId.get(e.dst)}`)
    .sort();
}

function hasEdge(graph: VgGraph, kind: EdgeKind, srcName: string, dstName: string): boolean {
  const byId = new Map(graph.nodes.map((n) => [n.id, n.name]));
  return graph.edges.some(
    (e) => e.kind === kind && byId.get(e.src) === srcName && byId.get(e.dst) === dstName,
  );
}

describe('Java generic construction and DI', () => {
  it('links project-local generic instantiations and injected types, not their arguments or JDK types', async () => {
    const { graph } = await buildGraph({ root: project(), generatedAt: PIN, inline: true, noCache: true });

    expect(namedEdges(graph, 'call')).toEqual([
      'OrderService.wire -> Cache',
      'OrderService.wire -> Handler',
    ]);
    expect(namedEdges(graph, 'references')).toEqual([
      'OrderService -> EventBus',
      'OrderService.OrderService -> Repository',
    ]);

    const usage = graph.edges.filter((e) => e.kind === 'call' || e.kind === 'references');
    expect(usage.every((e) => e.count === 1)).toBe(true);

    const byId = new Map(graph.nodes.map((n) => [n.id, n.name]));
    const linked = new Set(usage.flatMap((e) => [byId.get(e.src), byId.get(e.dst)]));
    for (const absent of ['User', 'OrderEvent', 'ArrayList', 'HashMap', 'List', 'Map', 'Long', 'String', 'Integer']) {
      expect(linked.has(absent)).toBe(false);
    }
  });

  it('serializes graph.json identically across two runs and a reversed fixture write', async () => {
    const options = { root: project(), generatedAt: PIN, inline: true, noCache: true };
    const first = serializeGraph((await buildGraph(options)).graph);
    const second = serializeGraph((await buildGraph(options)).graph);
    expect(second).toBe(first);

    const reordered = await buildGraph({
      ...options,
      root: project([...RELS].reverse()),
      noCache: true,
    });
    expect(serializeGraph(reordered.graph)).toBe(first);
  });
});

describe('java-spring generic types do not add edges', () => {
  it('keeps non-generic DI and does not follow JDK type arguments to local classes', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'vg-java-spring-'));
    dirs.push(parent);
    const root = path.join(parent, 'java-spring');
    cpSync(fileURLToPath(new URL('../packages/test-solutions/java-spring/', import.meta.url)), root, {
      recursive: true,
    });

    const { graph } = await buildGraph({ root, generatedAt: PIN, inline: true, noCache: true });

    expect(hasEdge(graph, 'references', 'ProductController', 'ProductService')).toBe(true);
    expect(hasEdge(graph, 'references', 'UserController', 'UserService')).toBe(true);
    expect(hasEdge(graph, 'references', 'ProductServiceImpl', 'ProductRepository')).toBe(true);
    expect(hasEdge(graph, 'references', 'UserServiceImpl', 'UserRepository')).toBe(true);

    // `List<Order>`, `List<OrderItem>`, `List<Product>` — the argument is not the dependency.
    expect(hasEdge(graph, 'references', 'User', 'Order')).toBe(false);
    expect(hasEdge(graph, 'references', 'Order', 'OrderItem')).toBe(false);
    expect(hasEdge(graph, 'references', 'Category', 'Product')).toBe(false);
    // `private Category parent` is a real non-generic field. `List<Category>` must
    // not add a second reference to the same class.
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const categoryParent = graph.edges.filter((e) => {
      const src = byId.get(e.src);
      const dst = byId.get(e.dst);
      return e.kind === 'references' && src?.name === 'Category' && dst?.name === 'Category';
    });
    expect(categoryParent).toHaveLength(1);
    expect(categoryParent[0]?.count).toBe(1);

    const library = new Set(['ArrayList', 'HashMap', 'List', 'Map', 'Page', 'PageImpl', 'Optional', 'ResponseEntity', 'JpaRepository']);
    const invented = graph.edges.filter(
      (e) => (e.kind === 'call' || e.kind === 'references') && library.has(byId.get(e.dst)?.name ?? ''),
    );
    expect(invented).toEqual([]);
  });
});
