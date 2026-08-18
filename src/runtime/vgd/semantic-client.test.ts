import { describe, it, expect } from 'vitest';
import { DaemonSemanticSession } from './semantic-client.js';
import type { AttachResult } from './attach.js';
import type { VgdRequest, VgdResponse } from './protocol.js';

/**
 * A long-lived server holds one of these for its whole life, so the costs that
 * matter are the repeated ones: attaching once rather than per request, not
 * hammering a socket that is down, and noticing when the map underneath moves.
 */

const attached: AttachResult = {
  status: 'attached',
  repositoryId: 'repo1',
  gitRef: 'main',
  socketPath: '/tmp/vgd.sock',
};

function ranked(n = 3): VgdResponse {
  return {
    ok: true,
    ranked: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, score: 1 - i / 10 })),
    repositoryId: 'repo1',
    gitRef: 'main',
    state: 'ready',
    vectors: 100,
    model: 'bge-small-en-v1.5',
    rankMs: 3,
  };
}

describe('DaemonSemanticSession', () => {
  it('attaches once across many requests', async () => {
    let attaches = 0;
    const session = new DaemonSemanticSession('/repo', {
      attach: () => (attaches++, Promise.resolve(attached)),
      request: () => Promise.resolve(ranked()),
    });

    for (let i = 0; i < 5; i++) await session.rank('where is billing');

    expect(attaches).toBe(1);
    expect(session.attached).toBe(true);
  });

  it('re-publishes when the caller’s map has moved, not on every call', async () => {
    const hashes: Array<string | undefined> = [];
    const session = new DaemonSemanticSession('/repo', {
      attach: (_root, opts) => (hashes.push(opts?.corpusHash), Promise.resolve(attached)),
      request: () => Promise.resolve(ranked()),
    });

    await session.rank('q', 'HASH-A');
    await session.rank('q', 'HASH-A');
    await session.rank('q', 'HASH-B');

    expect(hashes).toEqual(['HASH-A', 'HASH-B']);
  });

  it('returns the ranking the daemon produced', async () => {
    const session = new DaemonSemanticSession('/repo', {
      attach: () => Promise.resolve(attached),
      request: () => Promise.resolve(ranked(2)),
    });

    const r = await session.rank('q');

    expect(r?.ranked).toHaveLength(2);
    expect(r?.vectors).toBe(100);
    expect(r?.model).toBe('bge-small-en-v1.5');
  });

  it('returns null on an empty ranking so the caller ranks locally', async () => {
    const session = new DaemonSemanticSession('/repo', {
      attach: () => Promise.resolve(attached),
      request: () => Promise.resolve({ ...ranked(0), ranked: [] } as VgdResponse),
    });

    expect(await session.rank('q')).toBeNull();
  });

  it('asks the daemon to finish the index and ranks again before giving up', async () => {
    const seen: string[] = [];
    let ready = false;
    const session = new DaemonSemanticSession('/repo', {
      attach: () => Promise.resolve(attached),
      request: (req) => {
        seen.push(req.op);
        if (req.op === 'embed-index') {
          ready = true;
          return Promise.resolve({
            ok: true,
            indexed: true,
            repositoryId: 'repo1',
            gitRef: 'main',
            state: 'ready',
            vectors: 100,
          });
        }
        if (req.op === 'embed-status') {
          return Promise.resolve({
            ok: true,
            semantic: {
              worker: 'ready' as const,
              crashes: 0,
              model: 'bge-small-en-v1.5',
              slots: [
                {
                  repositoryId: 'repo1',
                  gitRef: 'main',
                  state: ready ? 'ready' : 'building',
                  vectors: ready ? 100 : 0,
                  nodeCount: 10,
                },
              ],
            },
          });
        }
        // Empty ranked[] means "rank locally" (covered above). A warming
        // slot is the signal to kick embed-index and poll until ready.
        if (!ready) {
          return Promise.resolve({
            ok: false,
            error: 'semantic index is warming — retry shortly',
            code: 'semantic_warming',
            state: 'building',
            vectors: 0,
          });
        }
        return Promise.resolve(ranked(2));
      },
    });

    const r = await session.rank('q');

    expect(seen).toEqual(['embed-rank', 'embed-index', 'embed-status', 'embed-rank']);
    expect(r?.ranked).toHaveLength(2);
    expect(r?.vectors).toBe(100);
  });

  it('does not retry a down daemon on every request', async () => {
    let attaches = 0;
    let clock = 0;
    const session = new DaemonSemanticSession('/repo', {
      now: () => clock,
      retryAfterMs: 30_000,
      attach: () => (attaches++, Promise.resolve({ status: 'unavailable', reason: 'no vgd is running' })),
      request: () => Promise.resolve(ranked()),
    });

    for (let i = 0; i < 10; i++) expect(await session.rank('q')).toBeNull();
    expect(attaches).toBe(1);

    // ...but it does try again once the window passes.
    clock = 31_000;
    await session.rank('q');
    expect(attaches).toBe(2);
  });

  it('forgets the slot when the socket dies, so the next call re-attaches', async () => {
    let attaches = 0;
    let clock = 0;
    let fail = false;
    const session = new DaemonSemanticSession('/repo', {
      now: () => clock,
      retryAfterMs: 0,
      attach: () => (attaches++, Promise.resolve(attached)),
      request: () => (fail ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(ranked())),
    });

    await session.rank('q');
    expect(attaches).toBe(1);

    fail = true;
    expect(await session.rank('q')).toBeNull();
    expect(session.attached).toBe(false);

    fail = false;
    clock = 1;
    await session.rank('q');
    expect(attaches).toBe(2);
  });

  it('shares one attach between concurrent callers', async () => {
    let attaches = 0;
    const session = new DaemonSemanticSession('/repo', {
      attach: () => {
        attaches++;
        return new Promise((r) => setTimeout(() => r(attached), 10));
      },
      request: () => Promise.resolve(ranked()),
    });

    await Promise.all([session.rank('a'), session.rank('b'), session.rank('c')]);

    expect(attaches).toBe(1);
  });

  it('sends the resolved slot, not the raw root', async () => {
    const seen: VgdRequest[] = [];
    const session = new DaemonSemanticSession('/repo', {
      attach: () => Promise.resolve(attached),
      request: (req) => (seen.push(req), Promise.resolve(ranked())),
    });

    await session.rank('where is billing');

    expect(seen[0]).toMatchObject({ op: 'embed-rank', repositoryId: 'repo1', gitRef: 'main', text: 'where is billing' });
  });
});
