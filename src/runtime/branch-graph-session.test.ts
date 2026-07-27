import { describe, it, expect } from 'vitest';
import { BranchGraphSession } from './branch-graph-session.js';
import { ActiveGraphCache } from './active-graph-cache.js';
import { SCHEMA_VERSION, type VgGraph } from '../schema.js';
import type { GitRunner } from './git-ref.js';

function tinyGraph(label: string): VgGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '1970-01-01T00:00:00.000Z',
    provenance: { tool: 'vg', version: '0', grammars: {}, resolver: [], deep: false, corpusHash: label },
    meta: {
      root: '.',
      languages: ['ts'],
      counts: { nodes: 0, edges: 0, areas: 0, tests: 0, untested: 0 },
      cluster: 'none',
      edgeKinds: [],
    },
    nodes: [],
    edges: [],
  } as unknown as VgGraph;
}

function gitOn(branch: string): GitRunner {
  return (args) => {
    if (args.includes('--abbrev-ref')) return { stdout: `${branch}\n`, status: 0 };
    return { stdout: '', status: 1 };
  };
}

describe('BranchGraphSession', () => {
  it('loads from disk into cache and serves subsequent ensures from cache', () => {
    let loads = 0;
    const graphs: Record<string, VgGraph> = { main: tinyGraph('main') };
    let branch = 'main';
    const session = new BranchGraphSession({
      root: '/repo',
      cache: new ActiveGraphCache({ idleTimeoutMs: 60_000 }),
      detectGit: (_root, run) => {
        const r = (run ?? gitOn(branch))(['rev-parse', '--abbrev-ref', 'HEAD'], '/repo');
        return { ref: r.stdout.trim(), kind: 'branch' };
      },
      gitRun: (_args, _cwd) => ({ stdout: `${branch}\n`, status: 0 }),
      load: () => {
        loads++;
        return graphs[branch] ?? null;
      },
    });

    const a = session.ensureCurrent();
    expect(a.graph?.provenance.corpusHash).toBe('main');
    expect(a.fromCache).toBe(false);
    expect(loads).toBe(1);

    const b = session.ensureCurrent();
    expect(b.fromCache).toBe(true);
    expect(loads).toBe(1);
    expect(b.switched).toBe(false);
  });

  it('switches branch slots without dropping the previous warm graph', () => {
    const graphs: Record<string, VgGraph> = {
      main: tinyGraph('main'),
      feature: tinyGraph('feature'),
    };
    let branch = 'main';
    const session = new BranchGraphSession({
      root: '/repo',
      cache: new ActiveGraphCache({ idleTimeoutMs: 60_000 }),
      detectGit: () => ({ ref: branch, kind: 'branch' }),
      load: () => graphs[branch] ?? null,
    });

    expect(session.ensureCurrent().graph?.provenance.corpusHash).toBe('main');
    branch = 'feature';
    const switched = session.ensureCurrent();
    expect(switched.switched).toBe(true);
    expect(switched.graph?.provenance.corpusHash).toBe('feature');
    expect(switched.fromCache).toBe(false);

    branch = 'main';
    const back = session.ensureCurrent();
    expect(back.switched).toBe(true);
    expect(back.fromCache).toBe(true);
    expect(back.graph?.provenance.corpusHash).toBe('main');
  });
});
