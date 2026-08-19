import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startVgdServer, type VgdServer } from '../runtime/vgd/index.js';
import { vgdIsRunning } from '../runtime/vgd/client.js';
import {
  compareDaemonVersion,
  retireWedgedVgd,
  startDetachedVgd,
  stopVgd,
  vgdCliVersion,
  vgdVersionSkew,
  type VgdSkew,
} from './daemon.js';
import { VERSION } from '../version.js';

const dirs: string[] = [];
const servers: VgdServer[] = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close().catch(() => {});
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A real vgd on a throwaway socket — never the user's machine-wide one. */
async function daemon(): Promise<{ socketPath: string; server: VgdServer }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-skew-'));
  dirs.push(dir);
  const socketPath =
    process.platform === 'win32' ? `\\\\.\\pipe\\vg-skew-${process.pid}-${dirs.length}` : path.join(dir, 'd.sock');
  const server = await startVgdServer({
    socketPath,
    pidPath: path.join(dir, 'vgd.pid'),
    onShutdownRequest: () => void server.close(),
  });
  servers.push(server);
  return { socketPath, server };
}

describe('compareDaemonVersion', () => {
  it('treats a daemon with no reported version as older', () => {
    // The absence of `cliVersion` dates the daemon to a pre-2026.817 build.
    expect(compareDaemonVersion(null, '2026.817.2')).toBe('older');
  });

  it('classifies older, matching, and newer builds', () => {
    expect(compareDaemonVersion('2026.814.2', '2026.817.2')).toBe('older');
    expect(compareDaemonVersion('2026.817.2', '2026.817.2')).toBe('match');
    expect(compareDaemonVersion('2026.818.0', '2026.817.2')).toBe('newer');
  });

  it('resolves monotonically so two builds cannot restart each other forever', () => {
    const a = '2026.814.2';
    const b = '2026.817.2';
    // Exactly one side may consider the other stale.
    const aSeesB = compareDaemonVersion(b, a); // older CLI looking at newer daemon
    const bSeesA = compareDaemonVersion(a, b); // newer CLI looking at older daemon
    expect(aSeesB).toBe('newer');
    expect(bSeesA).toBe('older');
  });

  it('never declares a mismatch it cannot judge', () => {
    // An unparseable *self* means we have no standing to replace anything.
    expect(compareDaemonVersion('2026.817.2', 'dev')).toBe('match');
    // An unparseable daemon version against a real one is stale.
    expect(compareDaemonVersion('dev', '2026.817.2')).toBe('older');
  });
});

describe('vgdVersionSkew', () => {
  it('reports not-running when no daemon holds the socket', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-skew-'));
    dirs.push(dir);
    expect(await vgdVersionSkew(path.join(dir, 'absent.sock'))).toEqual({ running: false });
  });

  it('reads the live build off the socket and matches this CLI', async () => {
    const { socketPath } = await daemon();
    expect(await vgdCliVersion(socketPath)).toBe(VERSION);
    expect(await vgdVersionSkew(socketPath)).toEqual({ running: true, version: VERSION, state: 'match' });
  });

  it('flags the running daemon as older when this build is newer', async () => {
    const { socketPath } = await daemon();
    // The daemon reports VERSION; pretend the caller is a later build.
    expect(await vgdVersionSkew(socketPath, '9999.1.0')).toMatchObject({ running: true, state: 'older' });
  });
});

describe('startDetachedVgd — the listener is not necessarily our child', () => {
  it('retires an older daemon that won the bind race and tries again', async () => {
    // The exact `vg update` failure: while the socket was free, another
    // client (a VS Code extension bundling an older engine) bound ITS daemon
    // first. "Ready" alone would report success against the stale build.
    const events: string[] = [];
    const skews: VgdSkew[] = [
      { running: true, version: null, state: 'older' },
      { running: true, version: VERSION, state: 'match' },
    ];
    const pid = await startDetachedVgd('sock', {
      startOnce: async () => {
        events.push('start');
        return 111;
      },
      skew: async () => skews.shift() ?? { running: true, version: VERSION, state: 'match' },
      stop: async () => {
        events.push('stop');
        return 'stopped';
      },
    });
    expect(pid).toBe(111);
    expect(events).toEqual(['start', 'stop', 'start']);
  });

  it('leaves a newer daemon alone — newest wins, no restart fight', async () => {
    const events: string[] = [];
    await startDetachedVgd('sock', {
      startOnce: async () => {
        events.push('start');
        return 7;
      },
      skew: async () => ({ running: true, version: '9999.1.0', state: 'newer' }),
      stop: async () => {
        events.push('stop');
        return 'stopped';
      },
    });
    expect(events).toEqual(['start']);
  });

  it('gives up with an actionable error when an old daemon keeps re-binding', async () => {
    let stops = 0;
    await expect(
      startDetachedVgd('sock', {
        startOnce: async () => 1,
        skew: async () => ({ running: true, version: '2026.814.2', state: 'older' }),
        stop: async () => {
          stops++;
          return 'stopped';
        },
      }),
    ).rejects.toThrow(/older vgd keeps re-binding/);
    expect(stops).toBe(3);
  });
});

describe('retireWedgedVgd — freeing a socket held by a daemon that no longer answers', () => {
  // The VS Code loop this guards against: a stale daemon holds the pipe but
  // its event loop is stuck, so ping times out ("not running") while every
  // fresh `daemon start` dies on EADDRINUSE — forever, until the holder goes.
  it('retires the holder with SIGTERM when that frees the address', async () => {
    const signals: string[] = [];
    let held = true;
    const res = await retireWedgedVgd('sock', {
      isRunning: async () => false,
      readPid: () => 4242,
      signal: (pid, sig) => {
        signals.push(`${sig}:${pid}`);
        held = false; // polite termination releases the socket
        return true;
      },
      held: async () => held,
      waitBudgetMs: 200,
      selfPid: 1,
    });
    expect(res).toEqual({ ok: true, pid: 4242 });
    expect(signals).toEqual(['SIGTERM:4242']);
  });

  it('escalates to SIGKILL when SIGTERM does not free the address', async () => {
    const signals: string[] = [];
    let held = true;
    const res = await retireWedgedVgd('sock', {
      isRunning: async () => false,
      readPid: () => 4242,
      signal: (pid, sig) => {
        signals.push(`${sig}:${pid}`);
        if (sig === 'SIGKILL') held = false;
        return true;
      },
      held: async () => held,
      waitBudgetMs: 200,
      selfPid: 1,
    });
    expect(res).toEqual({ ok: true, pid: 4242 });
    expect(signals).toEqual(['SIGTERM:4242', 'SIGKILL:4242']);
  });

  it('never touches a live daemon — a lost start race is not a wedge', async () => {
    const signals: string[] = [];
    const res = await retireWedgedVgd('sock', {
      isRunning: async () => true,
      readPid: () => 4242,
      signal: (pid, sig) => {
        signals.push(`${sig}:${pid}`);
        return true;
      },
      held: async () => true,
      waitBudgetMs: 200,
      selfPid: 1,
    });
    expect(res).toEqual({ ok: false, live: true });
    expect(signals).toEqual([]);
  });

  it('refuses without a pid file — no guessing at who to kill', async () => {
    const res = await retireWedgedVgd('sock', {
      isRunning: async () => false,
      readPid: () => null,
      signal: () => {
        throw new Error('must not signal without a pid');
      },
      held: async () => true,
      waitBudgetMs: 200,
      selfPid: 1,
    });
    expect(res).toMatchObject({ ok: false, reason: expect.stringMatching(/pid file/) });
  });

  it('never signals its own process', async () => {
    const res = await retireWedgedVgd('sock', {
      isRunning: async () => false,
      readPid: () => 77,
      signal: () => {
        throw new Error('must not signal self');
      },
      held: async () => true,
      waitBudgetMs: 200,
      selfPid: 77,
    });
    expect(res).toMatchObject({ ok: false, reason: expect.stringMatching(/this process/) });
  });

  it('reports failure when the address stays held after SIGKILL', async () => {
    const res = await retireWedgedVgd('sock', {
      isRunning: async () => false,
      readPid: () => 4242,
      signal: () => true,
      held: async () => true,
      waitBudgetMs: 200,
      selfPid: 1,
    });
    expect(res).toMatchObject({ ok: false, reason: expect.stringMatching(/still held/) });
  });
});

describe('stopVgd', () => {
  it('is idempotent when nothing is running', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-skew-'));
    dirs.push(dir);
    expect(await stopVgd(path.join(dir, 'absent.sock'), { force: true })).toBe('not-running');
  });

  it('stops a daemon that honours the shutdown op, with or without force', async () => {
    const { socketPath } = await daemon();
    expect(await stopVgd(socketPath, { force: true })).toBe('stopped');
    expect(await vgdIsRunning({ socketPath })).toBe(false);
  });

  it('refuses a daemon with no shutdown hook, but only when not forced', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-skew-'));
    dirs.push(dir);
    const socketPath =
      process.platform === 'win32' ? `\\\\.\\pipe\\vg-skew-nohook-${process.pid}` : path.join(dir, 'nohook.sock');
    // No onShutdownRequest → the daemon answers `shutdown_unsupported`.
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid') });
    servers.push(server);
    expect(await stopVgd(socketPath)).toBe('refused');
    expect(await vgdIsRunning({ socketPath })).toBe(true);
  });

  it('will not signal its own process, even under force', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-skew-'));
    dirs.push(dir);
    const socketPath =
      process.platform === 'win32' ? `\\\\.\\pipe\\vg-skew-self-${process.pid}` : path.join(dir, 'self.sock');
    // Hosted in this very process and refusing remote shutdown: escalating
    // would kill the test runner. It must report failure instead.
    const server = await startVgdServer({ socketPath, pidPath: path.join(dir, 'vgd.pid') });
    servers.push(server);
    expect(await stopVgd(socketPath, { force: true })).toBe('failed');
    expect(await vgdIsRunning({ socketPath })).toBe(true);
  }, 20_000);
});
