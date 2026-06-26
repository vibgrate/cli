import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { serializeGraph } from '../src/engine/serialize.js';
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

describe('buildGraph', () => {
  it('builds nodes and typed edges from a multi-language project', async () => {
    const root = project(SAMPLE_FILES);
    const { graph } = await buildGraph({ root, generatedAt: PIN, inline: true });

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const name = (id: string) => byId.get(id)?.qualifiedName ?? id;
    const edge = (kind: string, src: string, dst: string) =>
      graph.edges.some((e) => e.kind === kind && name(e.src) === src && name(e.dst) === dst);

    expect(edge('call', 'OrderService.deleteAsync', 'OrderService.addItem')).toBe(true);
    expect(edge('call', 'double', 'add')).toBe(true);
    expect(edge('extends', 'PaidOrderService', 'OrderService')).toBe(true);
    expect(graph.edges.some((e) => e.kind === 'import')).toBe(true);
    expect(graph.meta.languages).toEqual(expect.arrayContaining(['py', 'ts']));
  });

  it('respects .gitignore', async () => {
    const root = project({
      'keep.ts': 'export function a(){}',
      '.gitignore': 'skip/\n',
      'skip/secret.ts': 'export const SECRET = 1;',
    });
    const { graph } = await buildGraph({ root, generatedAt: PIN, inline: true });
    const files = graph.nodes.filter((n) => n.kind === 'file').map((n) => n.file);
    expect(files).toContain('keep.ts');
    expect(files).not.toContain('skip/secret.ts');
  });

  it('--only restricts languages', async () => {
    const root = project(SAMPLE_FILES);
    const { graph } = await buildGraph({ root, generatedAt: PIN, inline: true, only: ['py'] });
    expect(graph.meta.languages).toEqual(['py']);
  });

  it('is byte-identical across two runs (determinism)', async () => {
    const root = project(SAMPLE_FILES);
    const a = serializeGraph((await buildGraph({ root, generatedAt: PIN, inline: true, noCache: true })).graph);
    const b = serializeGraph((await buildGraph({ root, generatedAt: PIN, inline: true, noCache: true })).graph);
    expect(a).toBe(b);
  });

  it('cache-warm build equals full rebuild', async () => {
    const root = project(SAMPLE_FILES);
    const full = serializeGraph((await buildGraph({ root, generatedAt: PIN, inline: true, noCache: true })).graph);
    // First build warms the cache; second reuses it.
    await buildGraph({ root, generatedAt: PIN, inline: true });
    const cached = serializeGraph((await buildGraph({ root, generatedAt: PIN, inline: true })).graph);
    expect(cached).toBe(full);
  });

  it('node ids are stable when a node moves (blank line inserted)', async () => {
    const root1 = project({ 'a.ts': 'function f(){ return 1; }' });
    const g1 = (await buildGraph({ root: root1, generatedAt: PIN, inline: true })).graph;
    const root2 = project({ 'a.ts': '\n\nfunction f(){ return 1; }' });
    const g2 = (await buildGraph({ root: root2, generatedAt: PIN, inline: true })).graph;
    const id1 = g1.nodes.find((n) => n.qualifiedName === 'f')?.id;
    const id2 = g2.nodes.find((n) => n.qualifiedName === 'f')?.id;
    expect(id1).toBe(id2);
  });
});
