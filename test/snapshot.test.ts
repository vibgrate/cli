import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  encodeGraphPayload,
  loadGraphFileWithSnapshot,
  mapFileExists,
  mapFileStat,
  readGraphSnapshot,
  snapshotPathFor,
  writeGraphSnapshot,
} from '../src/engine/snapshot.js';
import { writeArtifacts } from '../src/engine/artifacts.js';
import { loadGraph } from '../src/engine/load.js';
import { globalGraphPath } from '../src/runtime/paths.js';
import { serializeGraph } from '../src/engine/serialize.js';
import type { VgGraph } from '../src/schema.js';

/**
 * The binary snapshot is a derived cache: graph.json stays canonical, and
 * every failure mode below must degrade to reading the JSON — never throw,
 * never serve stale data after the JSON changed.
 */

function sampleGraph(mutate?: (g: VgGraph) => void): VgGraph {
  const graph = {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    provenance: { corpusHash: 'abc123' },
    nodes: [
      { id: 'n1', kind: 'function', name: 'alpha', file: 'src/a.ts', line: 1 },
      { id: 'n2', kind: 'class', name: 'Beta', file: 'src/b.ts', line: 2 },
    ],
    edges: [{ from: 'n1', to: 'n2', kind: 'calls' }],
    areas: [],
  } as unknown as VgGraph;
  mutate?.(graph);
  return graph;
}

describe('graph snapshot sidecar', () => {
  let dir: string;
  let graphPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-snap-'));
    graphPath = path.join(dir, 'graph.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeJsonAndSnapshot(graph: VgGraph): void {
    fs.writeFileSync(graphPath, serializeGraph(graph));
    expect(writeGraphSnapshot(graphPath, graph)).toBe(true);
  }

  it('derives the sidecar path from the map path', () => {
    expect(snapshotPathFor('/x/graph.json')).toBe('/x/graph.snap');
    expect(snapshotPathFor('/x/custom.map')).toBe('/x/custom.map.snap');
  });

  it('round-trips a graph exactly (snapshot load deep-equals JSON load)', () => {
    const graph = sampleGraph();
    writeJsonAndSnapshot(graph);
    const fromSnap = readGraphSnapshot(graphPath);
    expect(fromSnap).not.toBeNull();
    expect(fromSnap).toEqual(JSON.parse(fs.readFileSync(graphPath, 'utf8')));
  });

  it('encodes identical graphs to identical payload bytes (determinism)', () => {
    const a = encodeGraphPayload(sampleGraph());
    const b = encodeGraphPayload(sampleGraph());
    expect(a.equals(b)).toBe(true);
  });

  it('rejects the snapshot when graph.json changed after it was written', () => {
    writeJsonAndSnapshot(sampleGraph());
    const changed = sampleGraph((g) => {
      (g.nodes as { name: string }[])[0].name = 'renamed';
    });
    fs.writeFileSync(graphPath, serializeGraph(changed));
    expect(readGraphSnapshot(graphPath)).toBeNull();
    // Loader falls back to the fresh JSON and self-heals the sidecar.
    const loaded = loadGraphFileWithSnapshot(graphPath);
    expect((loaded?.nodes as { name: string }[])[0].name).toBe('renamed');
    expect(readGraphSnapshot(graphPath)).not.toBeNull();
  });

  it('rejects a corrupted snapshot (flipped payload byte) and falls back to JSON', () => {
    const graph = sampleGraph();
    writeJsonAndSnapshot(graph);
    const snapPath = snapshotPathFor(graphPath);
    const raw = fs.readFileSync(snapPath);
    raw[raw.length - 3] ^= 0xff;
    fs.writeFileSync(snapPath, raw);
    expect(readGraphSnapshot(graphPath)).toBeNull();
    expect(loadGraphFileWithSnapshot(graphPath)).toEqual(graph);
  });

  it('rejects a truncated snapshot and junk files without throwing', () => {
    writeJsonAndSnapshot(sampleGraph());
    const snapPath = snapshotPathFor(graphPath);
    const raw = fs.readFileSync(snapPath);
    fs.writeFileSync(snapPath, raw.subarray(0, 12));
    expect(readGraphSnapshot(graphPath)).toBeNull();
    fs.writeFileSync(snapPath, 'not a snapshot at all');
    expect(readGraphSnapshot(graphPath)).toBeNull();
    expect(loadGraphFileWithSnapshot(graphPath)).not.toBeNull();
  });

  it('ignores a snapshot with no source graph.json beside it', () => {
    writeJsonAndSnapshot(sampleGraph());
    fs.rmSync(graphPath);
    expect(readGraphSnapshot(graphPath)).toBeNull();
    expect(loadGraphFileWithSnapshot(graphPath)).toBeNull();
  });

  it('self-heals: JSON-only directory gains a snapshot on first load', () => {
    const graph = sampleGraph();
    fs.writeFileSync(graphPath, serializeGraph(graph));
    expect(fs.existsSync(snapshotPathFor(graphPath))).toBe(false);
    expect(loadGraphFileWithSnapshot(graphPath)).toEqual(graph);
    expect(fs.existsSync(snapshotPathFor(graphPath))).toBe(true);
    expect(readGraphSnapshot(graphPath)).toEqual(graph);
  });

  it('returns null for missing or unparseable JSON (pre-snapshot behaviour)', () => {
    expect(loadGraphFileWithSnapshot(graphPath)).toBeNull();
    fs.writeFileSync(graphPath, '{ definitely not json');
    expect(loadGraphFileWithSnapshot(graphPath)).toBeNull();
  });

  it('write is best-effort: unwritable sidecar directory does not throw', () => {
    const missing = path.join(dir, 'nope', 'graph.json');
    expect(writeGraphSnapshot(missing, sampleGraph())).toBe(false);
  });

  it('standalone snapshot is the map: valid with no graph.json beside it', () => {
    const graph = sampleGraph();
    expect(writeGraphSnapshot(graphPath, graph, { standalone: true })).toBe(true);
    expect(fs.existsSync(graphPath)).toBe(false);
    expect(readGraphSnapshot(graphPath)).toEqual(graph);
    expect(loadGraphFileWithSnapshot(graphPath)).toEqual(graph);
  });

  it('mapFileExists: json-only yes, standalone-snap-only yes, sidecar-without-json no', () => {
    expect(mapFileExists(graphPath)).toBe(false);
    fs.writeFileSync(graphPath, serializeGraph(sampleGraph()));
    expect(mapFileExists(graphPath)).toBe(true);
    writeGraphSnapshot(graphPath, sampleGraph()); // sidecar
    fs.rmSync(graphPath);
    expect(mapFileExists(graphPath)).toBe(false); // orphaned sidecar is not a map
    writeGraphSnapshot(graphPath, sampleGraph(), { standalone: true });
    expect(mapFileExists(graphPath)).toBe(true);
  });

  it('mapFileStat: stats the json when present, else the standalone snapshot', () => {
    expect(() => mapFileStat(graphPath)).toThrow();
    writeGraphSnapshot(graphPath, sampleGraph(), { standalone: true });
    expect(mapFileStat(graphPath).mtimeMs).toBe(fs.statSync(snapshotPathFor(graphPath)).mtimeMs);
    fs.writeFileSync(graphPath, serializeGraph(sampleGraph()));
    expect(mapFileStat(graphPath).mtimeMs).toBe(fs.statSync(graphPath).mtimeMs);
  });
});

describe('global-store mode (snapshot is the map, no JSON write)', () => {
  let root: string;
  let dataDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-store-root-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-store-data-'));
    for (const key of ['VIBGRATE_GRAPH_IN_REPO', 'VIBGRATE_DATA_DIR']) savedEnv[key] = process.env[key];
    delete process.env.VIBGRATE_GRAPH_IN_REPO; // vitest sets it suite-wide; store mode needs it off
    process.env.VIBGRATE_DATA_DIR = dataDir;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('writeArtifacts writes only graph.snap to the store, and loadGraph reads it back', () => {
    const graph = sampleGraph();
    const written = writeArtifacts(graph, { root, html: false, report: false });
    expect(written.graphPath.endsWith('.snap')).toBe(true);
    expect(written.graphPath.startsWith(dataDir)).toBe(true);
    expect(fs.existsSync(written.graphPath)).toBe(true);
    // No JSON anywhere: not in the store, not in the repo.
    expect(fs.existsSync(written.graphPath.replace(/\.snap$/, '.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.vibgrate', 'graph.json'))).toBe(false);
    expect(loadGraph(root)).toEqual(graph);
  });

  it('removes a stale store graph.json left by an older CLI', () => {
    const graph = sampleGraph();
    const jsonPath = globalGraphPath(root, 'current');
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, serializeGraph(sampleGraph((g) => {
      (g.nodes as { name: string }[])[0].name = 'stale';
    })));
    writeArtifacts(graph, { root, html: false, report: false });
    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(loadGraph(root)).toEqual(graph);
  });

  it('in-repo mode still writes canonical JSON with the sidecar', () => {
    process.env.VIBGRATE_GRAPH_IN_REPO = '1';
    const graph = sampleGraph();
    const written = writeArtifacts(graph, { root, html: false, report: false });
    expect(written.graphPath).toBe(path.join(root, '.vibgrate', 'graph.json'));
    expect(fs.existsSync(written.graphPath)).toBe(true);
    expect(fs.existsSync(path.join(root, '.vibgrate', 'graph.snap'))).toBe(true);
    expect(loadGraph(root)).toEqual(graph);
  });

  it('an explicit graphPath override still writes JSON (explicit artifacts stay JSON)', () => {
    const target = path.join(root, 'custom-map.json');
    const written = writeArtifacts(sampleGraph(), { root, html: false, report: false, graphPath: target });
    expect(written.graphPath).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
  });
});
