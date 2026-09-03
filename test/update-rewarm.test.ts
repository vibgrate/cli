import { describe, expect, it } from 'vitest';
import { rewarmVgdAndReport } from '../src/reporting/commands/update.js';
import type { VgdRequest, VgdResponse } from '../src/runtime/vgd/index.js';

/**
 * A fake daemon whose blocking `embed-index` never answers — the shape of a
 * large repo with a cold vector cache, where the real daemon embeds every
 * node before replying. Only a non-blocking kick (`wait: false`) is answered.
 */
function fakeVgd(opts: { running?: boolean; loadGraph?: VgdResponse; embedIndex?: VgdResponse } = {}) {
  const requests: VgdRequest[] = [];
  const lines: string[] = [];
  const loadGraph: VgdResponse =
    opts.loadGraph ?? { ok: true, stored: true, repositoryId: 'repo-1', gitRef: 'main', nodeCount: 3 };
  const embedIndex: VgdResponse = opts.embedIndex ?? {
    ok: true,
    indexed: true,
    repositoryId: 'repo-1',
    gitRef: 'main',
    state: 'building',
    vectors: 0,
  };
  const deps = {
    vgdIsRunning: async () => opts.running ?? true,
    vgdRequest: (req: VgdRequest): Promise<VgdResponse> => {
      requests.push(req);
      if (req.op === 'load-graph') return Promise.resolve(loadGraph);
      if (req.op === 'embed-index') {
        if (req.wait === false) return Promise.resolve(embedIndex);
        return new Promise<VgdResponse>(() => {}); // a blocking build: never answers
      }
      return Promise.resolve({ ok: false, error: `unexpected op ${req.op}` });
    },
    log: (line: string) => {
      lines.push(line);
    },
  };
  return { deps, requests, lines };
}

/** Resolves to 'hung' when the rewarm has not returned within `ms`. */
async function settles(p: Promise<void>, ms = 1500): Promise<'done' | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'hung'>((r) => {
    timer = setTimeout(() => r('hung'), ms);
  });
  try {
    return await Promise.race([p.then(() => 'done' as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('vg update: daemon rewarm after a restart', () => {
  it('kicks the semantic index build without waiting for it, so the update exits', async () => {
    const vgd = fakeVgd();
    expect(await settles(rewarmVgdAndReport('/repo', vgd.deps))).toBe('done');
    const kick = vgd.requests.find((r) => r.op === 'embed-index');
    expect(kick).toEqual({ op: 'embed-index', repositoryId: 'repo-1', wait: false });
    expect(vgd.lines[0]).toBe('Re-published the code map into the restarted daemon.');
    expect(vgd.lines[1]).toMatch(/rebuilding in the background/);
  });

  it('reports a warm index when the on-disk cache already covered it', async () => {
    const vgd = fakeVgd({
      embedIndex: { ok: true, indexed: true, repositoryId: 'repo-1', gitRef: 'main', state: 'ready', vectors: 42 },
    });
    await rewarmVgdAndReport('/repo', vgd.deps);
    expect(vgd.lines).toEqual([
      'Re-published the code map into the restarted daemon.',
      'Semantic index warm again (42 vectors).',
    ]);
  });

  it('does nothing when no daemon is running', async () => {
    const vgd = fakeVgd({ running: false });
    await rewarmVgdAndReport('/repo', vgd.deps);
    expect(vgd.requests).toEqual([]);
    expect(vgd.lines).toEqual([]);
  });

  it('does not kick the index when there is no map to publish', async () => {
    const vgd = fakeVgd({ loadGraph: { ok: false, error: 'no graph for /repo', code: 'no_graph' } });
    await rewarmVgdAndReport('/repo', vgd.deps);
    expect(vgd.requests.map((r) => r.op)).toEqual(['load-graph']);
    expect(vgd.lines).toEqual([]);
  });

  it('is best-effort: a refused kick still leaves the map published', async () => {
    const vgd = fakeVgd({ embedIndex: { ok: false, error: 'semantic unavailable', code: 'semantic_unavailable' } });
    await rewarmVgdAndReport('/repo', vgd.deps);
    expect(vgd.lines).toEqual(['Re-published the code map into the restarted daemon.']);
  });
});
