import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRequest, VGD_PROTOCOL_VERSION } from './protocol.js';
import { WorkspaceRegistry } from './registry.js';
import { startVgdServer } from './server.js';
import { defaultVgdTimeoutMs, vgdIsRunning, vgdRequest } from './client.js';
import { fixtureGraph } from '../../code/graph-fixture.js';
import { serializeGraph } from '../../engine/serialize.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-vgd-'));
  dirs.push(d);
  return d;
}

describe('parseRequest', () => {
  it('accepts known ops and rejects junk', () => {
    expect(parseRequest('{"op":"ping"}')).toEqual({ op: 'ping' });
    expect(parseRequest('{"op":"shutdown"}')).toEqual({ op: 'shutdown' });
    expect(parseRequest('{"op":"register","root":"/a"}')).toEqual({ op: 'register', root: '/a' });
    expect(parseRequest('{"op":"query-graph","repositoryId":"r","query":"auth"}')).toEqual({
      op: 'query-graph',
      repositoryId: 'r',
      query: 'auth',
    });
    expect(parseRequest('not-json')).toEqual({ error: 'invalid JSON' });
    expect(parseRequest('{"op":"register"}')).toMatchObject({ error: expect.stringContaining('root') });
  });
});

describe('WorkspaceRegistry', () => {
  it('registers, lists, and unregisters by absolute root', () => {
    const reg = new WorkspaceRegistry();
    const a = reg.register('/repos/a', () => new Date('2026-01-01T00:00:00.000Z'));
    const b = reg.register('/repos/b', () => new Date('2026-01-02T00:00:00.000Z'));
    expect(a.id).not.toBe(b.id);
    expect(a.graphPath).toContain('graphs');
    expect(reg.list().map((w) => w.root)).toEqual([path.resolve('/repos/a'), path.resolve('/repos/b')].sort((x, y) => x.localeCompare(y)));
    expect(reg.unregister('/repos/a')).toBe(true);
    expect(reg.size()).toBe(1);
    expect(reg.get('/repos/b')?.id).toBe(b.id);
  });

  it('re-register refreshes the same id', () => {
    const reg = new WorkspaceRegistry();
    const first = reg.register('/repos/app', () => new Date('2026-01-01T00:00:00.000Z'));
    const second = reg.register('/repos/app', () => new Date('2026-01-02T00:00:00.000Z'));
    expect(second.id).toBe(first.id);
    expect(second.registeredAt).toBe('2026-01-02T00:00:00.000Z');
    expect(reg.size()).toBe(1);
  });
});

describe('defaultVgdTimeoutMs', () => {
  it('keeps liveness probes fast and gives heavy ops headroom', () => {
    // Liveness probes must fail fast so `vgdIsRunning` stays cheap.
    expect(defaultVgdTimeoutMs('ping')).toBe(2000);
    expect(defaultVgdTimeoutMs('status')).toBe(2000);
    // put-graph ships the whole code map in one JSON line — a 2s default
    // guaranteed false "vgd did not respond" failures on large repos.
    expect(defaultVgdTimeoutMs('put-graph')).toBeGreaterThanOrEqual(60_000);
    expect(defaultVgdTimeoutMs('load-graph')).toBeGreaterThanOrEqual(60_000);
    expect(defaultVgdTimeoutMs('host-load')).toBeGreaterThanOrEqual(60_000);
    expect(defaultVgdTimeoutMs('host-generate')).toBeGreaterThanOrEqual(60_000);
    // Everything else can queue behind a put-graph on the daemon's event loop.
    expect(defaultVgdTimeoutMs('register')).toBeGreaterThan(2000);
    expect(defaultVgdTimeoutMs('query-graph')).toBeGreaterThan(2000);
  });
});

describe('vgd server + client', () => {
  it('put-graph survives a daemon that takes longer than the old 2s flat timeout', async () => {
    // Regression: on large repos the daemon needs seconds to absorb a
    // put-graph, and the client used to give up at a flat 2000ms with
    // "vgd did not respond within 2000ms". Simulate a slow daemon.
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const slow = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        setTimeout(() => {
          socket.write(
            JSON.stringify({ ok: true, stored: true, repositoryId: 'r', gitRef: 'main', nodeCount: 1 }) + '\n',
          );
        }, 2300);
      });
    });
    await new Promise<void>((resolve) => slow.listen(socketPath, resolve));
    try {
      const put = await vgdRequest(
        { op: 'put-graph', repositoryId: 'r', gitRef: 'main', graph: fixtureGraph() },
        { socketPath },
      );
      expect(put.ok).toBe(true);
    } finally {
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  }, 10_000);

  it('refuses shutdown without a hook (embedded daemon) and honours it with one', async () => {
    // Embedded (no hook — e.g. the in-process vgd inside `vg code`): refuse,
    // so another process can never take down the owning session.
    const dir = tmp();
    const embedded = await startVgdServer({
      socketPath: path.join(dir, 'vgd.sock'),
      pidPath: path.join(dir, 'vgd.pid'),
    });
    try {
      const res = await vgdRequest({ op: 'shutdown' }, { socketPath: embedded.socketPath });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('shutdown_unsupported');
    } finally {
      await embedded.close();
    }

    // Standalone (`vg daemon start` passes the hook): acknowledge, then invoke.
    const dir2 = tmp();
    let shutdownRequested = false;
    const standalone = await startVgdServer({
      socketPath: path.join(dir2, 'vgd.sock'),
      pidPath: path.join(dir2, 'vgd.pid'),
      onShutdownRequest: () => {
        shutdownRequested = true;
      },
    });
    try {
      const res = await vgdRequest({ op: 'shutdown' }, { socketPath: standalone.socketPath });
      expect(res.ok).toBe(true);
      expect(res.ok && 'stopping' in res && res.stopping).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      expect(shutdownRequested).toBe(true);
    } finally {
      await standalone.close();
    }
  });

  it('load-graph loads the on-disk map inside the daemon (no graph over the socket)', async () => {
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid') });
    try {
      const root = path.join(dir, 'workspace');
      fs.mkdirSync(root);
      const graphPath = path.join(dir, 'graph.json');
      fs.writeFileSync(graphPath, serializeGraph(fixtureGraph()));

      const loaded = await vgdRequest({ op: 'load-graph', root, gitRef: 'main', graphPath }, { socketPath });
      expect(loaded.ok).toBe(true);
      if (loaded.ok && 'stored' in loaded) {
        expect(loaded.gitRef).toBe('main');
        expect(loaded.nodeCount).toBeGreaterThan(0);
      }

      const q = await vgdRequest(
        { op: 'query-graph', repositoryId: loaded.ok && 'stored' in loaded ? loaded.repositoryId : '', query: 'scanDir' },
        { socketPath },
      );
      expect(q.ok).toBe(true);

      // No map on disk → actionable no_map, never a stored=true.
      const missingRoot = path.join(dir, 'empty');
      fs.mkdirSync(missingRoot);
      const missing = await vgdRequest(
        { op: 'load-graph', root: missingRoot, graphPath: path.join(dir, 'nope.json') },
        { socketPath },
      );
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.code).toBe('no_map');
    } finally {
      await server.close();
    }
  });

  it('answers ping, register, list, and status over the socket', async () => {
    const dir = tmp();
    const socketPath = path.join(dir, 'vgd.sock');
    const pidPath = path.join(dir, 'vgd.pid');
    const server = await startVgdServer({ socketPath, pidPath, pid: 4242 });
    try {
      expect(await vgdIsRunning({ socketPath })).toBe(true);
      const pong = await vgdRequest({ op: 'ping' }, { socketPath });
      expect(pong).toEqual({ ok: true, pong: true, version: VGD_PROTOCOL_VERSION });

      const root = path.join(dir, 'workspace');
      fs.mkdirSync(root);
      const reg = await vgdRequest({ op: 'register', root }, { socketPath });
      expect(reg.ok).toBe(true);
      if (reg.ok && 'workspace' in reg) {
        expect(reg.workspace.root).toBe(root);
        expect(reg.workspace.id).toMatch(/^[0-9a-f]{32}$/);
      }

      const list = await vgdRequest({ op: 'list' }, { socketPath });
      expect(list.ok).toBe(true);
      if (list.ok && 'workspaces' in list) {
        expect(list.workspaces).toHaveLength(1);
      }

      const status = await vgdRequest({ op: 'status' }, { socketPath });
      expect(status.ok).toBe(true);
      if (status.ok && 'pid' in status) {
        expect(status.pid).toBe(4242);
        expect(status.workspaces).toBe(1);
        expect(status.socketPath).toBe(socketPath);
      }

      expect(fs.readFileSync(pidPath, 'utf8').trim()).toBe('4242');

      const member = path.join(dir, 'member');
      fs.mkdirSync(member);
      const fed = await vgdRequest(
        {
          op: 'register-federation',
          primaryRoot: root,
          members: [
            { root, label: 'primary', role: 'primary' },
            { root: member, label: 'lib', role: 'member' },
          ],
        },
        { socketPath },
      );
      expect(fed.ok).toBe(true);
      if (fed.ok && 'workspaces' in fed && Array.isArray(fed.workspaces)) {
        expect(fed.workspaces.length).toBeGreaterThanOrEqual(2);
      }

      const put = await vgdRequest(
        {
          op: 'put-graph',
          repositoryId: 'repotest',
          gitRef: 'main',
          graph: fixtureGraph(),
        },
        { socketPath },
      );
      expect(put.ok).toBe(true);

      const slots = await vgdRequest({ op: 'list-graph-slots' }, { socketPath });
      expect(slots.ok).toBe(true);
      if (slots.ok && 'slots' in slots) {
        expect(slots.slots.some((s) => s.gitRef === 'main' && s.repositoryId === 'repotest')).toBe(true);
      }

      const sel = await vgdRequest(
        { op: 'select-git-ref', repositoryId: 'repotest', gitRef: 'main' },
        { socketPath },
      );
      expect(sel.ok).toBe(true);

      const q = await vgdRequest(
        { op: 'query-graph', repositoryId: 'repotest', query: 'scanDir', limit: 5 },
        { socketPath },
      );
      expect(q.ok).toBe(true);
      if (q.ok && 'matches' in q) {
        expect(q.matches.some((m) => m.qualifiedName === 'scanDir' || m.id === 'scanDir')).toBe(true);
        expect(q.gitRef).toBe('main');
      }

      const impact = await vgdRequest(
        { op: 'impact-of', repositoryId: 'repotest', symbol: 'scanDir', depth: 2 },
        { socketPath },
      );
      expect(impact.ok).toBe(true);
      if (impact.ok && 'affected' in impact) {
        expect(Array.isArray(impact.affected)).toBe(true);
      }

      const summary = await vgdRequest({ op: 'graph-summary', repositoryId: 'repotest' }, { socketPath });
      expect(summary.ok).toBe(true);
      if (summary.ok && 'summary' in summary) {
        expect(summary.summary.nodeCount).toBeGreaterThan(0);
      }

      const missing = await vgdRequest(
        { op: 'query-graph', repositoryId: 'no-such-repo', query: 'x' },
        { socketPath },
      );
      expect(missing.ok).toBe(false);
    } finally {
      await server.close();
    }
    expect(await vgdIsRunning({ socketPath })).toBe(false);
  });
});
