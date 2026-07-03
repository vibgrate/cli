import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Cross-process single-writer lock (O_EXCL create), shared by the embedding
 * cache writer and the auto-refresh rebuild so two vg processes never write
 * the same repo-local artifact at once. A lock whose owning process is dead,
 * or that is older than `staleMs`, is presumed abandoned and reclaimed.
 */

/** A lock older than this is presumed dead (crashed process). */
export const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, just not ours to signal
  }
}

function lockIsStale(file: string, staleMs: number): boolean {
  try {
    const { pid, at } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; at?: number };
    if (typeof at === 'number' && Date.now() - at > staleMs) return true;
    if (typeof pid === 'number' && !isProcessAlive(pid)) return true;
    return false;
  } catch {
    return true; // unreadable/corrupt → reclaim it
  }
}

/** Take the lock (O_EXCL), reclaiming a stale/dead one. Returns success. */
export function acquireLock(file: string, staleMs = DEFAULT_LOCK_STALE_MS): boolean {
  const write = (): boolean => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };
  if (write()) return true;
  if (lockIsStale(file, staleMs)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* another process may have reclaimed it */
    }
    return write();
  }
  return false;
}

export function releaseLock(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best-effort */
  }
}
