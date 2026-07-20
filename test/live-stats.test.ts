import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LiveStatsBus, liveStatsDir, mergeSnapshots } from '../src/mcp/live-stats.js';
import { SessionStats, serveStatusLines, type CallSample } from '../src/mcp/serve-stats.js';

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const sample = (over: Partial<CallSample> = {}): CallSample => ({
  tool: 'query_graph',
  client: 'claude',
  outcome: 'complete',
  ms: 100,
  vgTokens: 500,
  baselineTokens: 4000,
  ...over,
});

describe('LiveStatsBus', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-live-stats-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('publishes a snapshot other buses can read — excluding their own', () => {
    const spawned = new SessionStats(0);
    spawned.record(sample(), 10);
    const publisher = new LiveStatsBus(dir, spawned, 111);
    publisher.publish(1000);

    const watcher = new LiveStatsBus(dir, new SessionStats(0), 222);
    const sibs = watcher.siblings(2000);
    expect(sibs).toHaveLength(1);
    expect(sibs[0]!.totals.calls).toBe(1);
    // The publisher never sees itself as a sibling.
    expect(publisher.siblings(2000)).toHaveLength(0);
  });

  it('skips writes when nothing changed, but keeps a keepalive fresh', () => {
    const stats = new SessionStats(0);
    const bus = new LiveStatsBus(dir, stats, 111);
    bus.publish(0);
    const first = fs.statSync(path.join(dir, 'serve-111.json')).mtimeMs;
    bus.publish(2000); // unchanged + within keepalive → no rewrite
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'serve-111.json'), 'utf8')).updatedAt).toBe(0);
    bus.publish(15_000); // past keepalive → refreshed even while idle
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'serve-111.json'), 'utf8')).updatedAt).toBe(15_000);
    void first;
  });

  it('ignores and sweeps stale snapshots of dead processes', () => {
    const dead = new SessionStats(0);
    dead.record(sample(), 1);
    new LiveStatsBus(dir, dead, 111).publish(0);

    const watcher = new LiveStatsBus(dir, new SessionStats(0), 222);
    expect(watcher.siblings(120_000)).toHaveLength(0); // > 60s old
    expect(fs.existsSync(path.join(dir, 'serve-111.json'))).toBe(false); // swept
  });

  it('tolerates corrupt files and a missing directory', () => {
    const watcher = new LiveStatsBus(path.join(dir, 'nonexistent'), new SessionStats(0), 222);
    expect(watcher.siblings(0)).toEqual([]);
    fs.writeFileSync(path.join(dir, 'serve-333.json'), '{broken');
    const w2 = new LiveStatsBus(dir, new SessionStats(0), 222);
    expect(w2.siblings(0)).toEqual([]);
  });

  it('is isolated per repo root — a serve for one repo never sees another repo’s servers', () => {
    // Several repos open in different editors: each spawned serve publishes
    // under ITS OWN root's .vibgrate/cache/serve-live, keyed off the process
    // cwd (the MCP entry is a bare `vg serve`, so the editor's project dir is
    // the root). The dirs must be disjoint and reads must not cross them.
    const repoA = path.join(dir, 'repo-a');
    const repoB = path.join(dir, 'repo-b');
    expect(liveStatsDir(repoA)).not.toBe(liveStatsDir(repoB));
    expect(liveStatsDir(repoA).startsWith(repoA)).toBe(true);
    expect(liveStatsDir(repoB).startsWith(repoB)).toBe(true);

    const statsA = new SessionStats(0);
    statsA.record(sample(), 1);
    new LiveStatsBus(liveStatsDir(repoA), statsA, 111).publish(0);

    const watcherB = new LiveStatsBus(liveStatsDir(repoB), new SessionStats(0), 222);
    expect(watcherB.siblings(1000)).toEqual([]); // repo B sees nothing of repo A
    const watcherA = new LiveStatsBus(liveStatsDir(repoA), new SessionStats(0), 222);
    expect(watcherA.siblings(1000)).toHaveLength(1); // same repo still shares
  });

  it('stop() unlinks its own snapshot', () => {
    const bus = new LiveStatsBus(dir, new SessionStats(0), 111);
    bus.start();
    expect(fs.existsSync(path.join(dir, 'serve-111.json'))).toBe(true);
    bus.stop();
    expect(fs.existsSync(path.join(dir, 'serve-111.json'))).toBe(false);
  });
});

describe('mergeSnapshots', () => {
  it('sums rows by key across processes, keeps own uptime, takes latest call', () => {
    const own = new SessionStats(1000);
    own.record(sample({ tool: 'impact_of', source: 'cli', ms: undefined }), 50);
    const sib = new SessionStats(2000);
    sib.record(sample(), 80);
    sib.record(sample({ tool: 'search_symbols', client: 'claude' }), 90);

    const merged = mergeSnapshots(own.snapshot(), [sib.snapshot()]);
    expect(merged.startedAt).toBe(1000); // own process's uptime
    expect(merged.lastCallAt).toBe(90);
    expect(merged.totals.calls).toBe(3);
    expect(merged.totals.timed).toBe(2); // the untimed CLI call stays untimed
    expect(merged.clients).toHaveLength(1); // same client label folds together
    expect(merged.clients[0]!.calls).toBe(3);
    expect(merged.tools.map((t) => t.key).sort()).toEqual(['impact_of', 'query_graph', 'search_symbols']);
    expect(merged.sources.map((s) => [s.key, s.calls]).sort()).toEqual([
      ['cli', 1],
      ['mcp', 2],
    ]);
  });

  it('returns the own snapshot untouched when there are no siblings', () => {
    const own = new SessionStats(0);
    own.record(sample(), 1);
    const snap = own.snapshot();
    expect(mergeSnapshots(snap, [])).toBe(snap);
  });
});

describe('serveStatusLines sibling note', () => {
  it('mentions assistant-spawned servers while waiting and once active', () => {
    const stats = new SessionStats(0);
    const waiting = plain(serveStatusLines(stats.snapshot(), 1000, 0, 1).join('\n'));
    expect(waiting).toContain('incl. 1 assistant-spawned server in this repo');

    stats.record(sample(), 1);
    const active = plain(serveStatusLines(stats.snapshot(), 1000, 0, 2).join('\n'));
    expect(active).toContain('incl. 2 assistant-spawned servers in this repo');

    const solo = plain(serveStatusLines(stats.snapshot(), 1000, 0, 0).join('\n'));
    expect(solo).not.toContain('assistant-spawned');
  });
});
