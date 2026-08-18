import { describe, it, expect } from 'vitest';
import { attachVgd, daemonDisabledReason } from './attach.js';
import type { VgdRequest, VgdResponse } from './protocol.js';

const stored: VgdResponse = { ok: true, stored: true, repositoryId: 'repo1', gitRef: 'main', nodeCount: 7 };

function transport() {
  const seen: VgdRequest[] = [];
  return { seen, request: (req: VgdRequest): Promise<VgdResponse> => (seen.push(req), Promise.resolve(stored)) };
}

describe('daemonDisabledReason', () => {
  it('honours --no-daemon, the env switch, and CI', () => {
    expect(daemonDisabledReason({ disabled: true, env: {} })).toMatch(/--no-daemon/);
    expect(daemonDisabledReason({ env: { VG_NO_DAEMON: '1' } })).toMatch(/VG_NO_DAEMON/);
    expect(daemonDisabledReason({ env: { VIBGRATE_NO_DAEMON: 'true' } })).toMatch(/VG_NO_DAEMON/);
    expect(daemonDisabledReason({ env: { CI: 'true' } })).toMatch(/CI/);
  });

  it('treats falsy-looking env values as unset, so `CI=false` does not disable it', () => {
    expect(daemonDisabledReason({ env: { CI: 'false' } })).toBeNull();
    expect(daemonDisabledReason({ env: { VG_NO_DAEMON: '0' } })).toBeNull();
    expect(daemonDisabledReason({ env: {} })).toBeNull();
  });
});

describe('attachVgd — skipping a redundant publish', () => {
  it('does not republish a map the daemon already holds', async () => {
    const seen: VgdRequest[] = [];
    const request = (req: VgdRequest): Promise<VgdResponse> => {
      seen.push(req);
      if (req.op === 'register') {
        return Promise.resolve({
          ok: true,
          workspace: { id: 'repo1', root: '/repo', graphPath: '/g', registeredAt: 'now' },
        });
      }
      if (req.op === 'graph-summary') {
        return Promise.resolve({
          ok: true,
          repositoryId: 'repo1',
          gitRef: 'main',
          summary: { nodeCount: 7, edgeCount: 0, languages: [], corpusHash: 'HASH-A', root: '.' },
        });
      }
      return Promise.resolve(stored);
    };

    const result = await attachVgd('/repo', {
      env: {},
      isRunning: () => Promise.resolve(true),
      request,
      corpusHash: 'HASH-A',
    });

    expect(result.status).toBe('attached');
    expect(result.repositoryId).toBe('repo1');
    expect(result.published).toEqual({ status: 'current', repositoryId: 'repo1', gitRef: 'main' });
    // A publish would drop the slot's vectors — the whole point is not to.
    expect(seen.map((r) => r.op)).not.toContain('load-graph');
  });

  it('publishes when the daemon holds a different map', async () => {
    const seen: VgdRequest[] = [];
    const request = (req: VgdRequest): Promise<VgdResponse> => {
      seen.push(req);
      if (req.op === 'register') {
        return Promise.resolve({
          ok: true,
          workspace: { id: 'repo1', root: '/repo', graphPath: '/g', registeredAt: 'now' },
        });
      }
      if (req.op === 'graph-summary') {
        return Promise.resolve({
          ok: true,
          repositoryId: 'repo1',
          gitRef: 'main',
          summary: { nodeCount: 7, edgeCount: 0, languages: [], corpusHash: 'HASH-OLD', root: '.' },
        });
      }
      return Promise.resolve(stored);
    };

    const result = await attachVgd('/repo', {
      env: {},
      isRunning: () => Promise.resolve(true),
      request,
      corpusHash: 'HASH-NEW',
    });

    expect(result.published?.status).toBe('published');
    expect(seen.map((r) => r.op)).toContain('load-graph');
  });

  it('publishes when the daemon has no slot for the repository yet', async () => {
    const seen: VgdRequest[] = [];
    const request = (req: VgdRequest): Promise<VgdResponse> => {
      seen.push(req);
      if (req.op === 'register') {
        return Promise.resolve({
          ok: true,
          workspace: { id: 'repo1', root: '/repo', graphPath: '/g', registeredAt: 'now' },
        });
      }
      if (req.op === 'graph-summary') {
        return Promise.resolve({ ok: false, error: 'no ActiveGraph loaded for repository', code: 'no_graph' });
      }
      return Promise.resolve(stored);
    };

    const result = await attachVgd('/repo', {
      env: {},
      isRunning: () => Promise.resolve(true),
      request,
      corpusHash: 'HASH-A',
    });

    expect(result.published?.status).toBe('published');
    expect(seen.map((r) => r.op)).toContain('load-graph');
  });
});

describe('attachVgd', () => {
  it('publishes the map to a daemon that is already running, without starting one', async () => {
    const t = transport();
    let ensured = 0;
    const result = await attachVgd('/repo', {
      env: {},
      isRunning: () => Promise.resolve(true),
      request: t.request,
      ensure: () => (ensured++, Promise.resolve({ running: true, started: true })),
    });

    expect(result.status).toBe('attached');
    expect(result.started).toBe(false);
    expect(ensured).toBe(0);
    expect(t.seen.map((r) => r.op)).toEqual(['load-graph']);
    expect(result.published).toMatchObject({ status: 'published', repositoryId: 'repo1' });
  });

  it('starts the daemon when none is listening, then publishes', async () => {
    const t = transport();
    let running = false;
    const result = await attachVgd('/repo', {
      env: {},
      isRunning: () => Promise.resolve(running),
      request: t.request,
      ensure: () => {
        running = true;
        return Promise.resolve({ running: true, started: true });
      },
    });

    expect(result.status).toBe('attached');
    expect(result.started).toBe(true);
    expect(t.seen.map((r) => r.op)).toEqual(['load-graph']);
  });

  it('reports unavailable — not an error — when the daemon is still coming up', async () => {
    const t = transport();
    const result = await attachVgd('/repo', {
      env: {},
      isRunning: () => Promise.resolve(false),
      request: t.request,
      ensure: () => Promise.resolve({ running: false, started: true }),
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toMatch(/still starting/);
    expect(t.seen).toEqual([]);
  });

  it('never starts anything when auto-start is off', async () => {
    let ensured = 0;
    const result = await attachVgd('/repo', {
      env: {},
      autoStart: false,
      isRunning: () => Promise.resolve(false),
      ensure: () => (ensured++, Promise.resolve({ running: true, started: true })),
    });

    expect(result.status).toBe('unavailable');
    expect(ensured).toBe(0);
  });

  it('is a no-op when disabled, and touches neither socket nor spawn', async () => {
    let probed = 0;
    const result = await attachVgd('/repo', {
      env: { VG_NO_DAEMON: '1' },
      isRunning: () => (probed++, Promise.resolve(true)),
    });

    expect(result.status).toBe('disabled');
    expect(probed).toBe(0);
  });

  it('turns a throwing transport into a value, so no command fails on it', async () => {
    const result = await attachVgd('/repo', {
      env: {},
      isRunning: () => Promise.reject(new Error('socket refused')),
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('socket refused');
  });
});
