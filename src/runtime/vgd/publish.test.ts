import { describe, it, expect } from 'vitest';
import { publishGraphToVgd } from './publish.js';
import type { VgdRequest, VgdResponse } from './protocol.js';

function transport(handler: (req: VgdRequest) => VgdResponse) {
  const seen: VgdRequest[] = [];
  return {
    seen,
    request: (req: VgdRequest): Promise<VgdResponse> => {
      seen.push(req);
      return Promise.resolve(handler(req));
    },
  };
}

const stored: VgdResponse = {
  ok: true,
  stored: true,
  repositoryId: 'repo1',
  gitRef: 'main',
  nodeCount: 12,
};

describe('publishGraphToVgd', () => {
  it('loads the map from disk rather than shipping it over the socket', async () => {
    const t = transport(() => stored);
    const result = await publishGraphToVgd('/repo', {
      isRunning: () => Promise.resolve(true),
      request: t.request,
    });

    expect(result).toMatchObject({ status: 'published', repositoryId: 'repo1', gitRef: 'main', nodeCount: 12 });
    expect(t.seen.map((r) => r.op)).toEqual(['load-graph']);
  });

  it('does nothing — and starts nothing — when no daemon is running', async () => {
    const t = transport(() => stored);
    const result = await publishGraphToVgd('/repo', {
      isRunning: () => Promise.resolve(false),
      request: t.request,
    });

    expect(result.status).toBe('not-running');
    expect(t.seen).toEqual([]);
  });

  it('warms the slot index only when asked to', async () => {
    const t = transport((req) =>
      req.op === 'load-graph'
        ? stored
        : { ok: true, indexed: true, repositoryId: 'repo1', gitRef: 'main', state: 'ready', vectors: 12 },
    );
    const result = await publishGraphToVgd('/repo', {
      isRunning: () => Promise.resolve(true),
      request: t.request,
      warmSemantic: true,
    });

    expect(t.seen.map((r) => r.op)).toEqual(['load-graph', 'embed-index']);
    expect(result).toMatchObject({ status: 'published', semantic: 'ready' });
  });

  it('reports a refusal instead of throwing, so a build never fails on it', async () => {
    const t = transport(() => ({ ok: false, error: 'no code map found', code: 'no_map' }));
    const result = await publishGraphToVgd('/repo', {
      isRunning: () => Promise.resolve(true),
      request: t.request,
    });

    expect(result).toEqual({ status: 'failed', error: 'no code map found' });
  });

  it('survives a transport that rejects', async () => {
    const result = await publishGraphToVgd('/repo', {
      isRunning: () => Promise.resolve(true),
      request: () => Promise.reject(new Error('socket gone')),
    });

    expect(result).toEqual({ status: 'failed', error: 'socket gone' });
  });
});
