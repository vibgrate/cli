import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRequest, VGD_PROTOCOL_VERSION } from './protocol.js';
import { WorkspaceRegistry } from './registry.js';
import { startVgdServer } from './server.js';
import { vgdIsRunning, vgdRequest } from './client.js';
import { fixtureGraph } from '../../code/graph-fixture.js';

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

describe('vgd server + client', () => {
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
