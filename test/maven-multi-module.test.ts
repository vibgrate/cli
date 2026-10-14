import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { serializeGraph } from '../src/engine/serialize.js';
import { cleanup, makeProject } from './helpers.js';

const PIN = '2020-01-01T00:00:00.000Z';
const fixture = new URL('./fixtures/maven-multi-module/', import.meta.url);
const poms = ['pom.xml', 'app/pom.xml'];
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) cleanup(dirs.pop()!);
});

function project(paths: string[]): string {
  const root = makeProject(Object.fromEntries(paths.map((rel) => [
    rel, fs.readFileSync(fileURLToPath(new URL(rel, fixture)), 'utf8'),
  ])));
  dirs.push(root);
  return root;
}

describe('vg build: Maven multi-module fixture', () => {
  it('keeps versionless direct coordinates (no managed-version resolution) and builds deterministically offline', async () => {
    const fetch = vi.fn(() => { throw new Error('Maven fixture must build offline'); });
    vi.stubGlobal('fetch', fetch);

    const first = (await buildGraph({
      root: project(poms), generatedAt: PIN, inline: true, noCache: true,
    })).graph;
    const second = (await buildGraph({
      root: project([...poms].reverse()), generatedAt: PIN, inline: true, noCache: true,
    })).graph;

    expect(fetch).not.toHaveBeenCalled();
    expect(serializeGraph(first)).toBe(serializeGraph(second));
    expect(first.nodes.filter((n) => n.kind === 'package')
      .map((n) => [n.qualifiedName, n.file]).sort()).toEqual([
      ['org.example:app', 'app/pom.xml'],
      ['org.example:parent', 'pom.xml'],
    ]);
    const external = first.nodes.filter((n) => n.kind === 'external');
    expect(external.map((n) => n.qualifiedName).sort()).toEqual([
      'com.google.code.gson:gson', 'org.apache.commons:commons-lang3',
    ]);

    const byId = new Map(first.nodes.map((n) => [n.id, n]));
    expect(first.edges.filter((e) => e.kind === 'import')
      .map((e) => [byId.get(e.src)?.qualifiedName, byId.get(e.dst)?.qualifiedName]).sort())
      .toEqual([
        ['org.example:app', 'com.google.code.gson:gson'],
        ['org.example:app', 'org.apache.commons:commons-lang3'],
      ]);
    expect(first.nodes.map((n) => n.id)).toEqual(second.nodes.map((n) => n.id));
    expect(first.edges.map((e) => e.id)).toEqual(second.edges.map((e) => e.id));
  });
});
