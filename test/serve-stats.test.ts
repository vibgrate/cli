import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SessionStats,
  ServeStatusDisplay,
  serveStatusLines,
  serveHeartbeatLine,
  fmtUptime,
  fmtTokens,
  type CallSample,
} from '../src/mcp/serve-stats.js';

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

describe('SessionStats', () => {
  it('starts empty, with lastCallAt null (never), not zero', () => {
    const stats = new SessionStats(1000);
    const snap = stats.snapshot();
    expect(snap.startedAt).toBe(1000);
    expect(snap.revision).toBe(0);
    expect(snap.lastCallAt).toBeNull();
    expect(snap.totals.calls).toBe(0);
    expect(snap.clients).toEqual([]);
    expect(snap.tools).toEqual([]);
  });

  it('aggregates per client and per tool, with timing and token sums', () => {
    const stats = new SessionStats(0);
    stats.record(sample(), 10);
    stats.record(sample({ ms: 300, vgTokens: 100, baselineTokens: 800, outcome: 'partial' }), 20);
    stats.record(sample({ tool: 'get_node', client: 'cursor', outcome: 'miss', ms: 50, vgTokens: 0, baselineTokens: 0 }), 30);

    const snap = stats.snapshot();
    expect(snap.revision).toBe(3);
    expect(snap.lastCallAt).toBe(30);
    expect(snap.totals).toMatchObject({ calls: 3, complete: 1, partial: 1, miss: 1, totalMs: 450, vgTokens: 600, baselineTokens: 4800 });

    expect(snap.clients.map((r) => r.key)).toEqual(['claude', 'cursor']); // calls desc
    expect(snap.clients[0]).toMatchObject({ calls: 2, totalMs: 400, vgTokens: 600 });
    expect(snap.tools.map((r) => r.key)).toEqual(['query_graph', 'get_node']);
    expect(snap.tools[1]).toMatchObject({ calls: 1, miss: 1, totalMs: 50 });
  });

  it('orders equal call counts deterministically by name', () => {
    const stats = new SessionStats(0);
    stats.record(sample({ tool: 'orient' }), 1);
    stats.record(sample({ tool: 'find_path' }), 2);
    expect(stats.snapshot().tools.map((r) => r.key)).toEqual(['find_path', 'orient']);
  });

  it('snapshot is a copy — mutating it never leaks back', () => {
    const stats = new SessionStats(0);
    stats.record(sample(), 1);
    const snap = stats.snapshot();
    snap.totals.calls = 999;
    snap.tools[0]!.calls = 999;
    expect(stats.snapshot().totals.calls).toBe(1);
    expect(stats.snapshot().tools[0]!.calls).toBe(1);
  });
});

describe('formatting', () => {
  it('fmtUptime scales through s/m/h/d', () => {
    expect(fmtUptime(45_000)).toBe('45s');
    expect(fmtUptime(123_000)).toBe('2m 03s');
    expect(fmtUptime(2 * 3600_000 + 14 * 60_000)).toBe('2h 14m');
    expect(fmtUptime(74 * 3600_000)).toBe('3d 02h');
  });

  it('fmtTokens scales through raw/k/M', () => {
    expect(fmtTokens(512)).toBe('512');
    expect(fmtTokens(58_300)).toBe('58.3k');
    expect(fmtTokens(2_500_000)).toBe('2.50M');
  });
});

describe('serveStatusLines', () => {
  it('shows a waiting line before the first call', () => {
    const stats = new SessionStats(0);
    const text = plain(serveStatusLines(stats.snapshot(), 45_000).join('\n'));
    expect(text).toContain('vg serve');
    expect(text).toContain('up 45s');
    expect(text).toContain('waiting for your assistant');
  });

  it('shows uptime, clients, per-tool timing, and the savings estimate', () => {
    const stats = new SessionStats(0);
    for (let i = 0; i < 3; i++) stats.record(sample({ ms: 200 }), i);
    stats.record(sample({ tool: 'get_node', client: 'cursor', ms: 100, vgTokens: 200, baselineTokens: 1200 }), 4);
    stats.record(sample({ tool: 'orient', client: 'cursor', ms: 80, vgTokens: 0, baselineTokens: 0, outcome: 'miss' }), 5);

    const text = plain(serveStatusLines(stats.snapshot(), 60_000).join('\n'));
    expect(text).toContain('up 1m 00s');
    expect(text).toContain('5 calls');
    expect(text).toContain('80% answered');
    expect(text).toMatch(/claude 3 \(avg 200ms\)/);
    expect(text).toMatch(/cursor 2/);
    expect(text).toMatch(/query_graph\s+3 · avg 200ms · ctx 1.5k vs ≈12.0k grep\/read/);
    expect(text).toMatch(/orient\s+1 · avg 80ms · 1 miss/);
    // Session totals: 1.7k served vs 13.2k baseline, honest labelling.
    expect(text).toContain('ctx 1.7k vs grep/read ≈13.2k');
    expect(text).toContain('est. saved ≈ 11.5k context tokens');
    expect(text).toContain('estimate');
    // Tokens only — the live display never shows monetary figures.
    expect(text).not.toContain('$');
  });

  it('folds long tool lists into "+N more"', () => {
    const stats = new SessionStats(0);
    for (let i = 0; i < 10; i++) stats.record(sample({ tool: `tool_${i}`, vgTokens: 0, baselineTokens: 0 }), i);
    const text = plain(serveStatusLines(stats.snapshot(), 1000).join('\n'));
    expect(text).toContain('+2 more tools');
  });
});

describe('serveHeartbeatLine', () => {
  it('is quiet-but-informative with and without activity', () => {
    const stats = new SessionStats(0);
    expect(plain(serveHeartbeatLine(stats.snapshot(), 30_000))).toBe('vg · serving for 30s — no tool calls yet');
    stats.record(sample(), 1);
    stats.record(sample({ client: 'cursor', tool: 'get_node', vgTokens: 100, baselineTokens: 400 }), 2);
    const line = plain(serveHeartbeatLine(stats.snapshot(), 900_000));
    expect(line).toContain('serving for 15m 00s');
    expect(line).toContain('2 calls (claude 1, cursor 1)');
    expect(line).toContain('est. saved ≈');
  });
});

describe('ServeStatusDisplay (non-TTY heartbeat)', () => {
  afterEach(() => vi.useRealTimers());

  const fakeStream = (): { written: string[]; stream: NodeJS.WriteStream } => {
    const written: string[] = [];
    const stream = {
      isTTY: false,
      columns: 80,
      write: (s: string) => {
        written.push(s);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    return { written, stream };
  };

  it('emits a heartbeat only when there is new activity', () => {
    vi.useFakeTimers();
    const stats = new SessionStats(Date.now());
    const { written, stream } = fakeStream();
    const display = new ServeStatusDisplay(stats, stream);
    display.start();

    // Idle first interval: nothing since revision 0 == initial -1? First tick
    // reports the idle state once, then stays quiet while idle.
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(written.length).toBe(1);
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(written.length).toBe(1); // still idle → no spam

    stats.record(sample(), Date.now());
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(written.length).toBe(2);
    expect(plain(written[1]!)).toContain('1 call');

    display.stop();
  });
});

describe('CLI-sourced calls (ledger fold-in)', () => {
  it('records untimed CLI samples without skewing averages', () => {
    const stats = new SessionStats(0);
    stats.record(sample({ ms: 200 }), 1);
    stats.record(sample({ tool: 'impact_of', source: 'cli', ms: undefined, vgTokens: 0, baselineTokens: 0 }), 2);

    const snap = stats.snapshot();
    expect(snap.totals).toMatchObject({ calls: 2, timed: 1, totalMs: 200 });
    expect(snap.sources.map((s) => [s.key, s.calls])).toEqual([
      ['cli', 1],
      ['mcp', 1],
    ]);
    // The untimed CLI call renders as '—', the timed MCP one keeps its avg.
    const text = plain(serveStatusLines(snap, 1000).join('\n'));
    expect(text).toMatch(/impact_of\s+1 · avg —/);
    expect(text).toMatch(/query_graph\s+1 · avg 200ms/);
  });

  it('shows the mcp-vs-cli split only once CLI calls exist', () => {
    const stats = new SessionStats(0);
    stats.record(sample(), 1);
    expect(plain(serveStatusLines(stats.snapshot(), 1000).join('\n'))).not.toContain('via');
    stats.record(sample({ tool: 'impact_of', source: 'cli', ms: undefined }), 2);
    const text = plain(serveStatusLines(stats.snapshot(), 1000).join('\n'));
    expect(text).toMatch(/via (mcp 1 · cli 1|cli 1 · mcp 1)/);
  });

  it('heartbeat line reports the CLI share', () => {
    const stats = new SessionStats(0);
    stats.record(sample(), 1);
    stats.record(sample({ tool: 'impact_of', source: 'cli', ms: undefined }), 2);
    expect(plain(serveHeartbeatLine(stats.snapshot(), 30_000))).toContain('1 via CLI');
  });
});
