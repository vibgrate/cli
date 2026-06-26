import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { makeProject, cleanup } from './helpers.js';
import type { GraphEdge, VgGraph } from '../src/schema.js';

/**
 * The precise TS/JS rung (TypeScript Compiler API). These cover what the
 * heuristic structurally cannot: member/`this`/typed-receiver calls and
 * heritage resolved through the type checker, default-on, no external tool.
 */

const PIN = '2020-01-01T00:00:00.000Z';
const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

/** Find a call/heritage edge by the qualifiedNames of its endpoints. */
function edgeByQn(graph: VgGraph, kind: GraphEdge['kind'], srcQn: string, dstQn: string): GraphEdge | undefined {
  const qnById = new Map(graph.nodes.map((n) => [n.id, n.qualifiedName]));
  return graph.edges.find(
    (e) => e.kind === kind && qnById.get(e.src) === srcQn && qnById.get(e.dst) === dstQn,
  );
}

describe('precise TS/JS resolution (TypeScript Compiler API)', () => {
  it('runs by default and is recorded above the heuristic in provenance', async () => {
    const { graph } = await buildGraph({
      root: project({
        'src/math.ts': 'export function add(a: number, b: number) { return a + b; }',
        'src/use.ts': "import { add } from './math';\nexport function calc() { return add(1, 2); }",
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(graph.provenance.resolver).toContain('tsc');
    // Precise rungs sit before the heuristic floor.
    expect(graph.provenance.resolver.indexOf('tsc')).toBeLessThan(graph.provenance.resolver.indexOf('heuristic'));
    const e = edgeByQn(graph, 'call', 'calc', 'add');
    expect(e?.resolution).toBe('tsc');
    expect(e?.confidence).toBe(1);
  });

  it('resolves a typed-receiver member call to the RIGHT class method (heuristic cannot disambiguate)', async () => {
    // Two methods named `run`, both classes imported into the call site — only a
    // type checker knows x:A and y:B, so each call maps to the correct method.
    const { graph } = await buildGraph({
      root: project({
        'src/a.ts': 'export class A { run() { return 1; } }',
        'src/b.ts': 'export class B { run() { return 2; } }',
        'src/use.ts': [
          "import { A } from './a';",
          "import { B } from './b';",
          'export function go() {',
          '  const x = new A();',
          '  const y = new B();',
          '  return x.run() + y.run();',
          '}',
        ].join('\n'),
      }),
      generatedAt: PIN,
      inline: true,
    });
    const toA = edgeByQn(graph, 'call', 'go', 'A.run');
    const toB = edgeByQn(graph, 'call', 'go', 'B.run');
    expect(toA?.resolution).toBe('tsc');
    expect(toB?.resolution).toBe('tsc');
    // The `new A()` / `new B()` constructions resolve to the classes too.
    expect(edgeByQn(graph, 'call', 'go', 'A')?.resolution).toBe('tsc');
    expect(edgeByQn(graph, 'call', 'go', 'B')?.resolution).toBe('tsc');
  });

  it('resolves `this.method()` self-calls and class heritage precisely', async () => {
    const { graph } = await buildGraph({
      root: project({
        'src/svc.ts': [
          'export interface Runnable { run(): void; }',
          'export class Base { protected helper() { return 0; } }',
          'export class Svc extends Base implements Runnable {',
          '  run(): void { this.helper(); }',
          '}',
        ].join('\n'),
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(edgeByQn(graph, 'call', 'Svc.run', 'Base.helper')?.resolution).toBe('tsc');
    expect(edgeByQn(graph, 'extends', 'Svc', 'Base')?.resolution).toBe('tsc');
    expect(edgeByQn(graph, 'implements', 'Svc', 'Runnable')?.resolution).toBe('tsc');
  });

  it('is authoritative for covered files — heuristic guesses there are dropped', async () => {
    const { graph } = await buildGraph({
      root: project({
        'src/math.ts': 'export function add(a: number, b: number) { return a + b; }',
        'src/use.ts': "import { add } from './math';\nexport function calc() { return add(1, 2); }",
      }),
      generatedAt: PIN,
      inline: true,
    });
    // Every relational edge originating in a TS file is precise (no heuristic
    // call/extends/implements/references survives in tsc-covered files).
    const relational = new Set(['call', 'extends', 'implements', 'references']);
    const heuristicLeftovers = graph.edges.filter(
      (e) => relational.has(e.kind) && e.resolution === 'heuristic',
    );
    expect(heuristicLeftovers).toHaveLength(0);
  });

  it('reports tsc stats in the build result', async () => {
    const res = await buildGraph({
      root: project({
        'src/math.ts': 'export function add(a: number, b: number) { return a + b; }',
        'src/use.ts': "import { add } from './math';\nexport function calc() { return add(1, 2); }",
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(res.tsc).toBeDefined();
    expect(res.tsc!.files).toBe(2);
    expect(res.tsc!.resolved).toBeGreaterThan(0);
  });

  it('also resolves plain JavaScript (allowJs)', async () => {
    const { graph } = await buildGraph({
      root: project({
        'lib/util.js': 'export function helper() { return 1; }',
        'lib/main.js': "import { helper } from './util.js';\nexport function main() { return helper(); }",
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(graph.provenance.resolver).toContain('tsc');
    expect(edgeByQn(graph, 'call', 'main', 'helper')?.resolution).toBe('tsc');
  });
});
