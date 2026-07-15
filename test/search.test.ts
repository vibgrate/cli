import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { searchSymbols } from '../src/engine/search.js';
import { makeProject, cleanup } from './helpers.js';
import type { VgGraph } from '../src/schema.js';

let graph: VgGraph;
let dir: string;
beforeAll(async () => {
  dir = makeProject({
    'src/scan.ts': [
      'export function newScanModal() {}',
      'export function resolveWorkspaceDsn() {}',
      'export function copyToClipboard() {}',
    ].join('\n'),
  });
  graph = (await buildGraph({ root: dir, generatedAt: '2020-01-01T00:00:00.000Z', inline: true })).graph;
});
afterAll(() => cleanup(dir));

describe('searchSymbols', () => {
  it('resolves a known exact name (primary path, unchanged)', async () => {
    const r = await searchSymbols(graph, dir, 'newScanModal', 8);
    expect(r.matches[0]?.name).toContain('newScanModal');
  });

  it('resolves a multi-word phrase via per-token fallthrough', async () => {
    // The whole-string name index misses "new scan modal"; the fallthrough unions
    // per-token matches and ranks by coverage. Before, this was an empty dead end.
    const r = await searchSymbols(graph, dir, 'new scan modal', 8);
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches.some((m) => 'name' in m && m.name.includes('newScanModal'))).toBe(true);
  });

  it('ranks the best-covered symbol first for a phrase', async () => {
    const r = await searchSymbols(graph, dir, 'resolve workspace dsn', 8);
    expect(r.matches[0] && 'name' in r.matches[0] && r.matches[0].name).toContain('resolveWorkspaceDsn');
  });

  it('still returns the pivot hint when nothing matches at all', async () => {
    const r = await searchSymbols(graph, dir, 'zzznope qqxyz', 8);
    expect(r.matches.length).toBe(0);
    expect(r.hint).toBeTruthy();
  });
});

describe('searchSymbols reconstructed-identifier fallthrough', () => {
  // A humanized query loses the original separator (camelCase boundary or
  // `_`) — "get id" could have come from either "getId" or "get_id". Before
  // the rejoin fallthrough, this was an empty dead end: the per-token
  // substring union has no way to re-associate short tokens ("f", "id") back
  // into one identifier (VG-LOCATE-FAILURE-ANALYSIS.md).
  let g: VgGraph;
  let d: string;
  beforeAll(async () => {
    d = makeProject({
      'src/gen.ts': [
        'export function f_0304(): void {}', // generated-code numbered handler
        'export function getId(): string { return "1"; }', // camelCase getter
      ].join('\n'),
    });
    g = (await buildGraph({ root: d, generatedAt: '2020-01-01T00:00:00.000Z', inline: true })).graph;
  });
  afterAll(() => cleanup(d));

  it('rejoins a humanized snake_case name ("f 0304" -> "f_0304")', async () => {
    const r = await searchSymbols(g, d, 'f 0304', 8);
    expect(r.matches[0] && 'name' in r.matches[0] && r.matches[0].name).toContain('f_0304');
  });

  it('rejoins a humanized camelCase name ("get id" -> "getId")', async () => {
    const r = await searchSymbols(g, d, 'get id', 8);
    expect(r.matches[0] && 'name' in r.matches[0] && r.matches[0].name).toContain('getId');
  });
});
