import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { GraphProcess, type SpawnLike } from './graph-process.js';

/** A fake child process that records kill() calls. */
function fakeChild(pid: number | undefined = 4242) {
  const ee = new EventEmitter() as EventEmitter & { pid?: number; killed: boolean; kill: (sig?: string) => boolean };
  ee.pid = pid;
  ee.killed = false;
  ee.kill = vi.fn((_sig?: string) => {
    ee.killed = true;
    return true;
  });
  return ee;
}

describe('GraphProcess', () => {
  it('spawns `vg serve --client vg-code` in the repo root', () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as SpawnLike;
    const gp = GraphProcess.start({ root: '/repo', spawnImpl, launch: { command: 'vg', args: ['serve'] } })!;
    expect(spawnImpl).toHaveBeenCalledWith('vg', ['serve', '--client', 'vg-code'], { cwd: '/repo', stdio: 'ignore', detached: false });
    expect(gp.pid).toBe(4242);
    expect(gp.running).toBe(true);
  });

  it('does NOT enable --savings on the child (avoids double-counting per-model savings)', () => {
    const spawnImpl = vi.fn(() => fakeChild()) as unknown as SpawnLike;
    GraphProcess.start({ root: '/repo', spawnImpl, launch: { command: 'vg', args: ['serve'] } });
    const args = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).not.toContain('--savings');
  });

  it('dispose kills the child and is idempotent', () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as SpawnLike;
    const gp = GraphProcess.start({ root: '/repo', spawnImpl, launch: { command: 'vg', args: ['serve'] } })!;
    gp.dispose();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(gp.running).toBe(false);
    gp.dispose(); // no throw, no second kill
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('returns null (never throws) when spawn fails', () => {
    const spawnImpl = vi.fn(() => {
      throw new Error('ENOENT');
    }) as unknown as SpawnLike;
    expect(GraphProcess.start({ root: '/repo', spawnImpl, launch: { command: 'vg', args: ['serve'] } })).toBeNull();
  });

  it('returns null when the spawned child has no pid', () => {
    const child = fakeChild();
    child.pid = undefined; // spawn that never actually started
    const spawnImpl = vi.fn(() => child) as unknown as SpawnLike;
    expect(GraphProcess.start({ root: '/repo', spawnImpl, launch: { command: 'vg', args: ['serve'] } })).toBeNull();
  });

  it('treats a child that exits on its own as no longer running (dispose is a no-op)', () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as SpawnLike;
    const gp = GraphProcess.start({ root: '/repo', spawnImpl, launch: { command: 'vg', args: ['serve'] } })!;
    child.emit('exit', 0);
    expect(gp.running).toBe(false);
    gp.dispose();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
