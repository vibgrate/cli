import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { serializeGraph } from '../src/engine/serialize.js';
import type { VgGraph } from '../src/schema.js';
import { cleanup, makeProject } from './helpers.js';

/**
 * Java enums, records and annotation types are definitions in their own right:
 * enums and records map to 'class' (as in the C# block) and an `@interface`
 * maps to 'interface'. Methods declared inside them, including an enum
 * constant's own body, stay methods and are qualified by the enclosing type.
 */

const PIN = '2020-01-01T00:00:00.000Z';
const FIXTURE = new URL('./fixtures/java-defs/', import.meta.url);
const RELS = [
  'src/com/example/defs/Audited.java',
  'src/com/example/defs/Point.java',
  'src/com/example/defs/Status.java',
];

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function project(rels = RELS): string {
  const root = makeProject(Object.fromEntries(rels.map((rel) => [rel, readFileSync(new URL(rel, FIXTURE), 'utf8')])));
  dirs.push(root);
  return root;
}

function defs(graph: VgGraph): string[] {
  return graph.nodes
    .filter((n) => n.lang === 'java' && n.kind !== 'file')
    .map((n) => `${n.kind} ${n.qualifiedName} ${n.file}:${n.span.start}`)
    .sort();
}

describe('Java enum, record and annotation type definitions', () => {
  it('captures each type at its declaration and keeps the methods inside it', async () => {
    const { graph } = await buildGraph({ root: project(), generatedAt: PIN, inline: true, noCache: true });

    expect(defs(graph)).toEqual([
      'class Point src/com/example/defs/Point.java:3',
      'class Status src/com/example/defs/Status.java:3',
      // The span starts at the declaration's first annotation, as for classes.
      'interface Audited src/com/example/defs/Audited.java:8',
      'method Point.distanceSquared src/com/example/defs/Point.java:10',
      'method Status.isActive src/com/example/defs/Status.java:19',
      'method Status.label src/com/example/defs/Status.java:17',
      // ACTIVE's constant-specific body.
      'method Status.label src/com/example/defs/Status.java:5',
    ]);
  });

  it('serializes graph.json identically across two runs and a reversed fixture write', async () => {
    const options = { root: project(), generatedAt: PIN, inline: true, noCache: true };
    const first = serializeGraph((await buildGraph(options)).graph);
    const second = serializeGraph((await buildGraph(options)).graph);
    expect(second).toBe(first);

    const reordered = await buildGraph({ ...options, root: project([...RELS].reverse()), noCache: true });
    expect(serializeGraph(reordered.graph)).toBe(first);
  });
});
