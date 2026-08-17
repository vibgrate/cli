import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCodeRuntimeSession } from './runtime-session.js';
import type { VgdResponse } from '../runtime/vgd/protocol.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-rs-'));
  dirs.push(d);
  return d;
}

describe('startCodeRuntimeSession', () => {
  it('attaches to an existing vgd, registers the workspace, and unregisters on dispose', async () => {
    const root = path.join(tmp(), 'app');
    fs.mkdirSync(root);
    const request = vi.fn(async (req: { op: string; root?: string }): Promise<VgdResponse> => {
      if (req.op === 'register') {
        return {
          ok: true,
          workspace: {
            id: 'abc',
            root,
            graphPath: '/data/graphs/current.graph.json',
            registeredAt: '2026-01-01T00:00:00.000Z',
          },
        };
      }
      if (req.op === 'status') {
        return { ok: true, pid: 99, uptimeMs: 10, workspaces: 1, version: 'vgd/0', socketPath: '/tmp/vgd.sock' };
      }
      if (req.op === 'unregister') return { ok: true, removed: true };
      return { ok: false, error: 'unexpected' };
    });

    const session = await startCodeRuntimeSession({
      root,
      socketPath: '/tmp/vgd.sock',
      isRunning: async () => true,
      request: request as never,
      ensureDaemon: async () => {
        throw new Error('should not start');
      },
    });

    expect(session.kind).toBe('attached');
    expect(session.pid).toBe(99);
    expect(session.workspace?.id).toBe('abc');
    expect(session.label).toContain('99');
    await session.dispose();
    expect(request).toHaveBeenCalledWith({ op: 'unregister', root }, expect.anything());
    await session.dispose(); // idempotent
  });

  it('ensures the standalone daemon when none is running, then attaches', async () => {
    const root = path.join(tmp(), 'app');
    fs.mkdirSync(root);
    const socketPath = path.join(tmp(), 'vgd.sock');
    let ensured = false;
    const request = vi.fn(async (req: { op: string; root?: string }): Promise<VgdResponse> => {
      if (req.op === 'register') {
        return {
          ok: true,
          workspace: {
            id: 'ensured',
            root,
            graphPath: '/g',
            registeredAt: '2026-01-01T00:00:00.000Z',
          },
        };
      }
      if (req.op === 'status') {
        return { ok: true, pid: 77, uptimeMs: 5, workspaces: 1, version: 'vgd/0', socketPath };
      }
      if (req.op === 'unregister') return { ok: true, removed: true };
      return { ok: false, error: 'n/a' };
    });

    const session = await startCodeRuntimeSession({
      root,
      socketPath,
      isRunning: async () => false,
      ensureDaemon: async () => {
        ensured = true;
      },
      request: request as never,
    });

    expect(ensured).toBe(true);
    expect(session.kind).toBe('attached');
    expect(session.pid).toBe(77);
    expect(session.workspace?.id).toBe('ensured');
    await session.dispose();
    expect(request).toHaveBeenCalledWith({ op: 'unregister', root }, expect.anything());
  });

  it('returns a none session when ensuring the standalone daemon fails', async () => {
    const session = await startCodeRuntimeSession({
      root: '/repo',
      isRunning: async () => false,
      ensureDaemon: async () => {
        throw new Error('ensure failed');
      },
    });
    expect(session.kind).toBe('none');
  });

  it('returns a none session when attach and start both fail', async () => {
    const session = await startCodeRuntimeSession({
      root: '/repo',
      isRunning: async () => {
        throw new Error('boom');
      },
    });
    expect(session.kind).toBe('none');
    expect(session.label).toBe('');
    await session.dispose();
  });
});
