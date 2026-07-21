import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reapOtherVersionServers } from './live-stats.js';

/**
 * The reaper signals live OS processes, so its guards are safety-critical: it
 * must retire ONLY vg's own serve processes that are (a) actively heartbeating
 * and (b) on a different version — never a stale/dead pid (which could have
 * been reused by an unrelated process), never itself, never a same-version
 * peer. These tests pin every guard with an injected `kill` so nothing real is
 * signalled.
 */

const NOW = 1_000_000;
const FRESH = NOW - 5_000; // within STALE_MS (60s)
const STALE = NOW - 120_000; // older than STALE_MS

let dir: string;
let killed: Array<{ pid: number; signal: string }>;
const kill = (pid: number, signal: NodeJS.Signals) => {
  killed.push({ pid, signal });
};

function writeServer(pid: number, over: { updatedAt?: number; version?: string | undefined } = {}): void {
  const body: Record<string, unknown> = {
    pid,
    updatedAt: over.updatedAt ?? FRESH,
    snapshot: { totals: { calls: 0 } },
  };
  if ('version' in over) {
    if (over.version !== undefined) body.version = over.version;
  } else {
    body.version = '2026.700.1';
  }
  fs.writeFileSync(path.join(dir, `serve-${pid}.json`), JSON.stringify(body));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-reap-'));
  killed = [];
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reapOtherVersionServers', () => {
  it('signals a fresh, different-version server with SIGTERM', () => {
    writeServer(4242, { version: '2026.700.1', updatedAt: FRESH });
    const reaped = reapOtherVersionServers(dir, '2026.720.5', NOW, kill, /*selfPid*/ 1);
    expect(reaped).toEqual([{ pid: 4242, version: '2026.700.1' }]);
    expect(killed).toEqual([{ pid: 4242, signal: 'SIGTERM' }]);
  });

  it('never signals a same-version server (nothing to upgrade)', () => {
    writeServer(4242, { version: '2026.720.5', updatedAt: FRESH });
    const reaped = reapOtherVersionServers(dir, '2026.720.5', NOW, kill, 1);
    expect(reaped).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('never signals a stale (non-heartbeating) pid — the reused-pid guard', () => {
    // A crashed process left a stale file; its pid may now belong to something
    // else entirely, so it must never be signalled regardless of version.
    writeServer(4242, { version: '2026.700.1', updatedAt: STALE });
    const reaped = reapOtherVersionServers(dir, '2026.720.5', NOW, kill, 1);
    expect(reaped).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('never signals its own pid', () => {
    writeServer(777, { version: '2026.700.1', updatedAt: FRESH });
    const reaped = reapOtherVersionServers(dir, '2026.720.5', NOW, kill, /*selfPid*/ 777);
    expect(reaped).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('treats a version-less (pre-versioning) file as older and reaps it', () => {
    writeServer(4242, { version: undefined, updatedAt: FRESH });
    const reaped = reapOtherVersionServers(dir, '2026.720.5', NOW, kill, 1);
    expect(reaped).toEqual([{ pid: 4242, version: 'unknown' }]);
    expect(killed).toEqual([{ pid: 4242, signal: 'SIGTERM' }]);
  });

  it('signals every stale-version peer and leaves current + self alone', () => {
    writeServer(100, { version: '2026.700.1', updatedAt: FRESH }); // reap
    writeServer(200, { version: '2026.710.1', updatedAt: FRESH }); // reap
    writeServer(300, { version: '2026.720.5', updatedAt: FRESH }); // keep (current)
    writeServer(400, { version: '2026.700.1', updatedAt: STALE }); // skip (dead)
    writeServer(500, { version: '2026.700.1', updatedAt: FRESH }); // self
    const reaped = reapOtherVersionServers(dir, '2026.720.5', NOW, kill, /*selfPid*/ 500);
    expect(reaped.map((r) => r.pid).sort()).toEqual([100, 200]);
    expect(killed.map((k) => k.pid).sort()).toEqual([100, 200]);
  });

  it('a kill that throws (process already gone) is swallowed, not counted, not fatal', () => {
    writeServer(4242, { version: '2026.700.1', updatedAt: FRESH });
    const throwingKill = () => {
      throw new Error('ESRCH');
    };
    const reaped = reapOtherVersionServers(dir, '2026.720.5', NOW, throwingKill, 1);
    expect(reaped).toEqual([]); // not recorded as reaped since the signal failed
  });

  it('returns [] for a missing directory and skips corrupt/foreign files', () => {
    expect(reapOtherVersionServers(path.join(dir, 'nope'), 'v', NOW, kill, 1)).toEqual([]);
    fs.writeFileSync(path.join(dir, 'serve-999.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'serve-abc.json'), '{}'); // non-numeric pid → ignored by name regex
    expect(reapOtherVersionServers(dir, '2026.720.5', NOW, kill, 1)).toEqual([]);
    expect(killed).toEqual([]);
  });
});
