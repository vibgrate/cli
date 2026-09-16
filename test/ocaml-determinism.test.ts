import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { serializeGraph } from '../src/engine/serialize.js';
import { makeProject, cleanup } from './helpers.js';

const PIN = '2020-01-01T00:00:00.000Z';
const files = ['main.ml', 'labels.ml'].map((name) => [
  name,
  readFileSync(new URL(`./fixtures/ocaml/${name}`, import.meta.url), 'utf8'),
]);
const dirs: string[] = [];

function project(entries = files): string {
  const root = makeProject(Object.fromEntries(entries));
  dirs.push(root);
  return root;
}

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('OCaml graph determinism', () => {
  it('retains definitions and local calls across cold, cached, and reordered builds', async () => {
    const root = project();
    const options = { root, generatedAt: PIN, inline: true };
    const { graph } = await buildGraph({ ...options, noCache: true });

    // Empty or partially parsed graphs must not pass merely by being repeatable.
    expect(graph.meta.languages).toEqual(['ocaml']);
    expect(graph.nodes.filter((n) => n.kind !== 'file').map((n) => n.name).sort()).toEqual([
      'Counter', 'display', 'increment', 'label', 'run', 'total', 'twice',
    ]);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const calls = graph.edges.filter((e) => e.kind === 'call').map((e) => [
      byId.get(e.src)!.name,
      byId.get(e.dst)!.name,
    ].join(' -> ')).sort();
    expect(calls).toEqual(['display -> label', 'run -> increment', 'total -> twice']);

    const serialized = serializeGraph(graph);
    const repeated = await buildGraph({ ...options, noCache: true });
    expect(serializeGraph(repeated.graph)).toBe(serialized);

    await buildGraph(options); // Warm the incremental cache before comparing.
    const cached = await buildGraph(options);
    expect(serializeGraph(cached.graph)).toBe(serialized);

    // A second root is populated in the opposite order. Compare the complete
    // serialization without sorting away node/edge ordering or removing IDs.
    const reordered = await buildGraph({
      ...options, root: project([...files].reverse()), noCache: true,
    });
    expect(serializeGraph(reordered.graph)).toBe(serialized);
  });
});
