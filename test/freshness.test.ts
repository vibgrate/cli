import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { writeArtifacts } from '../src/engine/artifacts.js';
import {
  writeSnapshot,
  loadSnapshot,
  probeFreshness,
  hasDrift,
  driftCount,
} from '../src/engine/freshness.js';
import { refreshIfStale } from '../src/engine/refresh.js';
import { GraphSource } from '../src/mcp/server.js';
import { parseGraph } from '../src/engine/serialize.js';
import { makeProject, cleanup, SAMPLE_FILES } from './helpers.js';

/** Build the map + artifacts + freshness snapshot, like `vg build` does. */
async function buildAndSnapshot(dir: string): Promise<void> {
  const result = await buildGraph({ root: dir, inline: true, generatedAt: '2020-01-01T00:00:00.000Z' });
  writeArtifacts(result.graph, { root: dir, html: false, report: false });
  writeSnapshot(dir, result.graph.provenance.corpusHash, result.fileStats, {});
}

/** Rewrite a file with a guaranteed size change so coarse-mtime filesystems can't hide it. */
function editFile(dir: string, rel: string, append: string): void {
  const abs = path.join(dir, rel);
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8') + append);
}

let dir: string;
beforeEach(async () => {
  dir = makeProject(SAMPLE_FILES);
  await buildAndSnapshot(dir);
});
afterEach(() => cleanup(dir));

describe('freshness probe', () => {
  it('reports no drift right after a build', () => {
    const probe = probeFreshness(dir);
    expect(probe).not.toBeNull();
    expect(hasDrift(probe!.drift)).toBe(false);
  });

  it('returns null when no snapshot exists', () => {
    fs.rmSync(path.join(dir, '.vibgrate', 'cache', 'freshness.json'));
    expect(probeFreshness(dir)).toBeNull();
  });

  it('detects a content edit', () => {
    editFile(dir, 'src/math.ts', 'export function triple(x: number): number { return x * 3; }\n');
    const probe = probeFreshness(dir)!;
    expect(probe.drift.changed).toEqual(['src/math.ts']);
    expect(driftCount(probe.drift)).toBe(1);
  });

  it('detects added and removed files', () => {
    fs.writeFileSync(path.join(dir, 'src/new.ts'), 'export const fresh = 1;\n');
    fs.rmSync(path.join(dir, 'svc/app.py'));
    const probe = probeFreshness(dir)!;
    expect(probe.drift.added).toEqual(['src/new.ts']);
    expect(probe.drift.removed).toEqual(['svc/app.py']);
  });

  it('absorbs touch-only changes (same content, new mtime) without reporting drift', () => {
    const abs = path.join(dir, 'src/math.ts');
    const content = fs.readFileSync(abs, 'utf8');
    fs.writeFileSync(abs, content); // identical bytes, fresh mtime
    fs.utimesSync(abs, new Date(), new Date(Date.now() + 5000)); // force a visible mtime move
    expect(hasDrift(probeFreshness(dir)!.drift)).toBe(false);
    // ...and the absorption is persisted: the snapshot now carries the new stat.
    const snap = loadSnapshot(dir)!;
    expect(snap.files['src/math.ts'].mtimeMs).toBe(fs.statSync(abs).mtimeMs);
  });
});

describe('refreshIfStale', () => {
  it('is a no-op when the tree matches the map', async () => {
    const before = fs.readFileSync(path.join(dir, '.vibgrate', 'graph.json'), 'utf8');
    const outcome = await refreshIfStale(dir, { inline: true });
    expect(outcome.status).toBe('fresh');
    expect(fs.readFileSync(path.join(dir, '.vibgrate', 'graph.json'), 'utf8')).toBe(before);
  });

  it('reports no-snapshot when nothing was built on this machine', async () => {
    fs.rmSync(path.join(dir, '.vibgrate', 'cache', 'freshness.json'));
    const outcome = await refreshIfStale(dir, { inline: true });
    expect(outcome.status).toBe('no-snapshot');
  });

  it('rebuilds incrementally after an edit and updates map + snapshot', async () => {
    editFile(dir, 'src/math.ts', 'export function triple(x: number): number { return x * 3; }\n');
    const outcome = await refreshIfStale(dir, { inline: true });
    expect(outcome.status).toBe('refreshed');
    if (outcome.status !== 'refreshed') return;
    expect(outcome.wrote).toBe(true);
    expect(outcome.drift.changed).toEqual(['src/math.ts']);

    const graph = parseGraph(fs.readFileSync(path.join(dir, '.vibgrate', 'graph.json'), 'utf8'));
    expect(graph.nodes.some((n) => n.qualifiedName.endsWith('triple'))).toBe(true);
    // Snapshot caught up: probing again is clean.
    expect(hasDrift(probeFreshness(dir)!.drift)).toBe(false);
  });

  it('never adds report/html artifacts the build did not produce', async () => {
    editFile(dir, 'src/math.ts', 'export const nine = 9;\n');
    await refreshIfStale(dir, { inline: true });
    expect(fs.existsSync(path.join(dir, '.vibgrate', 'GRAPH_REPORT.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.vibgrate', 'graph.html'))).toBe(false);
  });

  it('yields to a concurrent refresh holding the lock', async () => {
    editFile(dir, 'src/math.ts', 'export const ten = 10;\n');
    const lock = path.join(dir, '.vibgrate', 'cache', 'refresh.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const outcome = await refreshIfStale(dir, { inline: true });
    expect(outcome.status).toBe('locked');
    fs.rmSync(lock);
  });
});

describe('GraphSource auto-refresh (vg serve)', () => {
  it('serves the rebuilt graph after files change', async () => {
    const graphPath = path.join(dir, '.vibgrate', 'graph.json');
    const source = new GraphSource(graphPath, true, { probeIntervalMs: 0 });
    const first = await source.get();
    expect(first.nodes.some((n) => n.qualifiedName.endsWith('quadruple'))).toBe(false);

    editFile(dir, 'src/math.ts', 'export function quadruple(x: number): number { return x * 4; }\n');
    const second = await source.get();
    expect(second.nodes.some((n) => n.qualifiedName.endsWith('quadruple'))).toBe(true);
  });

  it('with refresh off, keeps serving the map as built', async () => {
    const graphPath = path.join(dir, '.vibgrate', 'graph.json');
    const source = new GraphSource(graphPath, false);
    await source.get();
    editFile(dir, 'src/math.ts', 'export function quintuple(x: number): number { return x * 5; }\n');
    const graph = await source.get();
    expect(graph.nodes.some((n) => n.qualifiedName.endsWith('quintuple'))).toBe(false);
  });
});
