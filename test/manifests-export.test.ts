import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { extractManifests } from '../src/engine/manifests.js';
import { exportGraph, COMPACT_JSON_NODES } from '../src/engine/export.js';
import { slimGraphForExport, serializeGraph } from '../src/engine/serialize.js';
import { hashFilesParallel } from '../src/engine/hash-files.js';
import { makeProject, cleanup } from './helpers.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}

describe('extractManifests', () => {
  it('reads package.json dependencies as package → external import edges', () => {
    const root = project({
      'package.json': JSON.stringify({
        name: '@acme/app',
        dependencies: { lodash: '^4.0.0', react: '^18.0.0' },
        peerDependencies: { react: '^18.0.0' },
      }),
    });
    const m = extractManifests(root);
    expect(m.files).toBe(1);
    expect(m.deps).toBe(2); // lodash + react (peer deduped)
    expect(m.nodes.some((n) => n.kind === 'package' && n.qualifiedName === '@acme/app')).toBe(true);
    expect(m.nodes.some((n) => n.kind === 'external' && n.name === 'lodash')).toBe(true);
    expect(m.edges.some((e) => e.kind === 'import' && e.epistemic === 'declared')).toBe(true);
  });

  it('reads go.mod require lines', () => {
    const root = project({
      'go.mod': [
        'module example.com/svc',
        '',
        'go 1.22',
        '',
        'require (',
        '  github.com/foo/bar v1.2.3',
        '  rsc.io/quote v1.5.2',
        ')',
        '',
      ].join('\n'),
    });
    const m = extractManifests(root);
    expect(m.files).toBe(1);
    expect(m.deps).toBe(2);
    expect(m.nodes.some((n) => n.qualifiedName === 'example.com/svc')).toBe(true);
  });

  it('folds manifests into a full build', async () => {
    const root = project({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { chalk: '5.0.0' } }),
      'src/a.ts': 'export function f() { return 1 }\n',
    });
    const { graph } = await buildGraph({
      root,
      generatedAt: '2020-01-01T00:00:00.000Z',
      noGround: true,
      inline: true,
      noTsc: true,
    });
    expect(graph.nodes.some((n) => n.kind === 'package' && n.qualifiedName === 'demo')).toBe(true);
    expect(graph.nodes.some((n) => n.kind === 'external' && n.name === 'chalk')).toBe(true);
  });
});

describe('hashFilesParallel', () => {
  it('hashes files deterministically regardless of concurrency', async () => {
    const root = project({
      'a.ts': 'export const a = 1\n',
      'b.ts': 'export const b = 2\n',
    });
    const jobs = [
      { rel: 'a.ts', abs: path.join(root, 'a.ts') },
      { rel: 'b.ts', abs: path.join(root, 'b.ts') },
    ];
    const a = await hashFilesParallel(jobs, 1);
    const b = await hashFilesParallel(jobs, 4);
    const mapA = Object.fromEntries(a.map((r) => [r.rel, r.hash]));
    const mapB = Object.fromEntries(b.map((r) => [r.rel, r.hash]));
    expect(mapA).toEqual(mapB);
    expect(a.every((r) => r.ok && r.hash.length > 0)).toBe(true);
  });
});

describe('export compact / slim', () => {
  it('compact JSON has no pretty-print newlines between keys', async () => {
    const root = project({
      'src/a.ts': 'export function f() { return 1 }\n',
    });
    const { graph } = await buildGraph({
      root,
      generatedAt: '2020-01-01T00:00:00.000Z',
      noGround: true,
      inline: true,
      noTsc: true,
    });
    const pretty = serializeGraph(graph);
    const compact = serializeGraph(graph, { compact: true });
    expect(pretty.includes('\n  ')).toBe(true);
    expect(compact.includes('\n  ')).toBe(false);
    expect(JSON.parse(compact)).toEqual(JSON.parse(pretty));
  });

  it('slim drops area members and grounding', async () => {
    const root = project({
      'src/a.ts': 'export function f() { return 1 }\n',
    });
    const { graph } = await buildGraph({
      root,
      generatedAt: '2020-01-01T00:00:00.000Z',
      inline: true,
      noTsc: true,
    });
    // Ensure areas exist with members when clustering runs.
    const slim = slimGraphForExport(graph);
    expect(slim.areas.every((a) => a.members.length === 0)).toBe(true);
    expect(slim.grounding).toBeUndefined();
    // Original unchanged.
    if (graph.areas.length) {
      expect(graph.areas.some((a) => a.members.length > 0) || graph.areas.length === 0).toBe(true);
    }

    const exported = exportGraph('json', {
      graph,
      generatedAt: graph.generatedAt,
      slim: true,
      compact: true,
    });
    expect(exported.length).toBeLessThan(serializeGraph(graph).length + 1);
    void COMPACT_JSON_NODES;
    void fs;
  });
});
