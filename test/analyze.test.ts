import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { makeProject, cleanup, SAMPLE_FILES } from './helpers.js';

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

describe('analyze — centrality, clustering, hubs, surprise', () => {
  it('computes communities (louvain) with labels and cohesion', async () => {
    const { graph } = await buildGraph({ root: project(SAMPLE_FILES), generatedAt: PIN, inline: true });
    expect(graph.meta.cluster).toBe('louvain');
    expect(graph.areas.length).toBeGreaterThan(0);
    for (const a of graph.areas) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.members.length).toBe(a.size);
      expect(a.cohesion).toBeGreaterThanOrEqual(0);
      expect(a.cohesion).toBeLessThanOrEqual(1);
    }
  });

  it('assigns every code node to an area', async () => {
    const { graph } = await buildGraph({ root: project(SAMPLE_FILES), generatedAt: PIN, inline: true });
    for (const n of graph.nodes) expect(n.area).toBeGreaterThanOrEqual(0);
  });

  it('computes blended centrality and flags hubs', async () => {
    const { graph } = await buildGraph({ root: project(SAMPLE_FILES), generatedAt: PIN, inline: true });
    const top = [...graph.nodes].sort((a, b) => b.importance - a.importance)[0];
    expect(top.importance).toBeGreaterThan(0);
    expect(top.centrality.pagerank).toBeGreaterThan(0);
    expect(graph.nodes.some((n) => n.isHub)).toBe(true);
  });

  it('community assignment is deterministic across runs', async () => {
    const root = project(SAMPLE_FILES);
    const g1 = (await buildGraph({ root, generatedAt: PIN, inline: true, noCache: true })).graph;
    const g2 = (await buildGraph({ root, generatedAt: PIN, inline: true, noCache: true })).graph;
    const areas1 = g1.nodes.map((n) => `${n.id}:${n.area}`).sort();
    const areas2 = g2.nodes.map((n) => `${n.id}:${n.area}`).sort();
    expect(areas1).toEqual(areas2);
  });

  it('scores surprise on cross-area edges only', async () => {
    const { graph } = await buildGraph({ root: project(SAMPLE_FILES), generatedAt: PIN, inline: true });
    const areaByNode = new Map(graph.nodes.map((n) => [n.id, n.area]));
    for (const e of graph.edges) {
      if (typeof e.surprise === 'number') {
        expect(areaByNode.get(e.src)).not.toBe(areaByNode.get(e.dst));
      }
    }
  });

  it('cluster=none leaves nodes unassigned', async () => {
    const { graph } = await buildGraph({ root: project(SAMPLE_FILES), generatedAt: PIN, inline: true, cluster: 'none' });
    expect(graph.meta.cluster).toBe('none');
    expect(graph.nodes.every((n) => n.area === -1)).toBe(true);
  });
});
