import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  companionArtifactDir,
  defaultGraphPath,
  legacyGraphPath,
  preferInRepoGraph,
  resolveGraphPath,
  writeArtifacts,
} from './artifacts.js';
import type { VgGraph } from '../schema.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-art-'));
  dirs.push(d);
  return d;
}

function tinyGraph(): VgGraph {
  return {
    version: 1,
    provenance: { corpusHash: 'x', toolchain: 't', resolver: [] },
    meta: {
      counts: { nodes: 0, edges: 0, areas: 0 },
      languages: [],
      edgeKinds: [],
      cluster: 'none',
      generatedAt: '1970-01-01T00:00:00.000Z',
    },
    nodes: [],
    edges: [],
  } as unknown as VgGraph;
}

describe('preferInRepoGraph / defaultGraphPath', () => {
  it('opts into the legacy in-repo path via env', () => {
    expect(preferInRepoGraph({ VIBGRATE_GRAPH_IN_REPO: '1' })).toBe(true);
    expect(preferInRepoGraph({ VIBGRATE_GRAPH_IN_REPO: 'true' })).toBe(true);
    expect(preferInRepoGraph({})).toBe(false);
    const root = '/repos/app';
    expect(defaultGraphPath(root, { VIBGRATE_GRAPH_IN_REPO: '1' })).toBe(legacyGraphPath(root));
  });

  it('defaults to the global store when env is unset', () => {
    const data = tmpDir();
    const root = path.join(tmpDir(), 'app');
    const env = { VIBGRATE_DATA_DIR: data };
    const p = defaultGraphPath(root, env);
    expect(p.startsWith(data)).toBe(true);
    expect(p.endsWith(`${path.sep}graphs${path.sep}current.graph.json`)).toBe(true);
    expect(p.includes('.vibgrate')).toBe(false);
  });
});

describe('resolveGraphPath', () => {
  it('prefers an existing global snapshot over legacy', () => {
    const data = tmpDir();
    const root = tmpDir();
    const env = { VIBGRATE_DATA_DIR: data };
    const globalPath = defaultGraphPath(root, env);
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, '{}');
    const legacy = legacyGraphPath(root);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '{}');
    expect(resolveGraphPath(root, undefined, env)).toBe(globalPath);
  });

  it('falls back to legacy when only the in-repo map exists', () => {
    const data = tmpDir();
    const root = tmpDir();
    const env = { VIBGRATE_DATA_DIR: data };
    const legacy = legacyGraphPath(root);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '{}');
    expect(resolveGraphPath(root, undefined, env)).toBe(legacy);
  });

  it('honours an explicit override', () => {
    const root = tmpDir();
    const custom = path.join(root, 'custom-map.json');
    expect(resolveGraphPath(root, custom, { VIBGRATE_DATA_DIR: tmpDir() })).toBe(path.resolve(custom));
  });

  it('with VIBGRATE_GRAPH_IN_REPO prefers legacy even when a global snapshot exists', () => {
    // CI / release-benchmark force the portable in-repo layout; they must not
    // resolve to a leftover global map or pay detectGitRef on every resolve.
    const data = tmpDir();
    const root = tmpDir();
    const env = { VIBGRATE_DATA_DIR: data, VIBGRATE_GRAPH_IN_REPO: '1' };
    const globalPath = defaultGraphPath(root, { VIBGRATE_DATA_DIR: data });
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, '{}');
    const legacy = legacyGraphPath(root);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '{}');
    expect(resolveGraphPath(root, undefined, env)).toBe(legacy);
  });
});

describe('writeArtifacts global store', () => {
  it('writes the map and companions outside the repo by default', () => {
    const data = tmpDir();
    const root = tmpDir();
    const prevInRepo = process.env.VIBGRATE_GRAPH_IN_REPO;
    const prevData = process.env.VIBGRATE_DATA_DIR;
    process.env.VIBGRATE_DATA_DIR = data;
    delete process.env.VIBGRATE_GRAPH_IN_REPO;
    try {
      const written = writeArtifacts(tinyGraph(), { root, html: false, report: false });
      expect(written.graphPath.startsWith(data)).toBe(true);
      expect(fs.existsSync(written.graphPath)).toBe(true);
      // Zero in-repo generated graph state by default.
      expect(fs.existsSync(legacyGraphPath(root))).toBe(false);
      expect(fs.existsSync(path.join(root, '.vibgrate'))).toBe(false);
      expect(companionArtifactDir(root, written.graphPath).startsWith(data)).toBe(true);
    } finally {
      if (prevInRepo === undefined) delete process.env.VIBGRATE_GRAPH_IN_REPO;
      else process.env.VIBGRATE_GRAPH_IN_REPO = prevInRepo;
      if (prevData === undefined) delete process.env.VIBGRATE_DATA_DIR;
      else process.env.VIBGRATE_DATA_DIR = prevData;
    }
  });

  it('still writes under .vibgrate when VIBGRATE_GRAPH_IN_REPO is set', () => {
    const root = tmpDir();
    const prev = process.env.VIBGRATE_GRAPH_IN_REPO;
    process.env.VIBGRATE_GRAPH_IN_REPO = '1';
    try {
      const written = writeArtifacts(tinyGraph(), { root, html: false, report: false });
      expect(written.graphPath).toBe(legacyGraphPath(root));
      expect(fs.existsSync(path.join(root, '.vibgrate', '.gitignore'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.VIBGRATE_GRAPH_IN_REPO;
      else process.env.VIBGRATE_GRAPH_IN_REPO = prev;
    }
  });
});
