import { describe, it, expect } from 'vitest';
import { SessionStats, serveStatusLines, type CallSample } from './serve-stats.js';
import { mergeSnapshots } from './live-stats.js';

/**
 * The "est. saved ≈ N context tokens" figure on the live serve display must be
 * CUMULATIVE over the session — every recorded call adds into the same rollup
 * rows; nothing is overwritten by the next call. These tests pin that contract
 * for the in-process stats and for the cross-process sibling merge.
 */

function sample(over: Partial<CallSample> = {}): CallSample {
  return { tool: 'get_node', client: 'claude', outcome: 'complete', ms: 5, vgTokens: 100, baselineTokens: 800, ...over };
}

describe('SessionStats — savings accumulate across calls', () => {
  it('sums vg/baseline tokens over every recorded call (never overwrites)', () => {
    const stats = new SessionStats(1000);
    stats.record(sample(), 2000);
    stats.record(sample({ vgTokens: 50, baselineTokens: 400 }), 3000);
    stats.record(sample({ tool: 'search_symbols', vgTokens: 25, baselineTokens: 1200 }), 4000);
    const snap = stats.snapshot();
    expect(snap.totals.calls).toBe(3);
    expect(snap.totals.vgTokens).toBe(175);
    expect(snap.totals.baselineTokens).toBe(2400);
    // Per-tool rows accumulate independently.
    expect(snap.tools.find((t) => t.key === 'get_node')?.vgTokens).toBe(150);
    expect(snap.tools.find((t) => t.key === 'search_symbols')?.baselineTokens).toBe(1200);
  });

  it('snapshot() is a copy — rendering a snapshot cannot mutate the running totals', () => {
    const stats = new SessionStats(1000);
    stats.record(sample(), 2000);
    const first = stats.snapshot();
    first.totals.vgTokens = 999999;
    expect(stats.snapshot().totals.vgTokens).toBe(100);
  });

  it('the est. saved line reflects the running total (baseline − vg over all calls)', () => {
    const stats = new SessionStats(0);
    stats.record(sample(), 1);
    stats.record(sample(), 2);
    const lines = serveStatusLines(stats.snapshot(), 10_000).join('\n');
    // 2 × (800 − 100) = 1.4k saved — cumulative, not the last call's 700.
    expect(lines).toContain('est. saved');
    expect(lines).toContain('1.4k');
  });
});

describe('mergeSnapshots — sibling counts add, never replace', () => {
  it('sums totals and per-key rows across own + sibling snapshots', () => {
    const own = new SessionStats(0);
    own.record(sample(), 1);
    const sib = new SessionStats(0);
    sib.record(sample({ tool: 'search_symbols', vgTokens: 10, baselineTokens: 400 }), 1);
    sib.record(sample(), 2);
    const merged = mergeSnapshots(own.snapshot(), [sib.snapshot()]);
    expect(merged.totals.calls).toBe(3);
    expect(merged.totals.vgTokens).toBe(210);
    expect(merged.totals.baselineTokens).toBe(2000);
    // Shared keys sum; unique keys survive.
    expect(merged.tools.find((t) => t.key === 'get_node')?.calls).toBe(2);
    expect(merged.tools.find((t) => t.key === 'search_symbols')?.calls).toBe(1);
  });

  it('merging is non-destructive: the own snapshot object is not mutated', () => {
    const own = new SessionStats(0);
    own.record(sample(), 1);
    const ownSnap = own.snapshot();
    const sib = new SessionStats(0);
    sib.record(sample(), 1);
    mergeSnapshots(ownSnap, [sib.snapshot()]);
    expect(ownSnap.totals.vgTokens).toBe(100);
  });
});
