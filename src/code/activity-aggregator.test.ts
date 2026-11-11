import { describe, it, expect } from 'vitest';
import { ActivityAggregator, formatActivitySummary, summarizeChanges } from './activity-aggregator.js';
import { countDiffStats, unifiedDiff } from './diff.js';
import type { FileChange } from './types.js';

const change = (file: string, before: string | null, after: string | null): FileChange => ({
  file,
  before,
  after,
  outcomes: [],
  diff: unifiedDiff(before, after, file),
});

describe('ActivityAggregator', () => {
  it('folds 3 search_code + 2 edit_file into one activity line with correct counts', () => {
    const agg = new ActivityAggregator();
    for (const q of ['a', 'b', 'c']) agg.observe({ type: 'tool-call', name: 'search_code', args: { query: q } });
    agg.observe({ type: 'tool-call', name: 'edit_file', args: {} });
    agg.observe({ type: 'change', change: change('src/a.ts', 'x\n', 'x\ny\n') });
    agg.observe({ type: 'tool-call', name: 'edit_file', args: {} });
    agg.observe({ type: 'change', change: change('src/b.ts', 'p\nq\n', 'p\n') });
    const live = agg.flush();
    expect(live).toMatchObject({ group: 1, final: false, explored: 3, edited: 2, added: 1, removed: 1 });
    expect(live?.summary).toBe('Explored 3 items · Edited 2 files · +1 −1');
    expect(live?.tools).toEqual(['search_code', 'edit_file']);
    expect(live?.files).toEqual(['src/a.ts', 'src/b.ts']);
    const final = agg.seal();
    expect(final).toMatchObject({ group: 1, final: true, summary: live?.summary });
    expect(agg.groups).toBe(1);
  });

  it('no events → flush and seal return null and no group is counted', () => {
    const agg = new ActivityAggregator();
    expect(agg.flush()).toBeNull();
    expect(agg.seal()).toBeNull();
    expect(agg.groups).toBe(0);
  });

  it('flush is quiet when nothing changed since the last frame', () => {
    const agg = new ActivityAggregator();
    agg.observe({ type: 'tool-call', name: 'read_file', args: {} });
    expect(agg.flush()).not.toBeNull();
    expect(agg.flush()).toBeNull();
  });

  it('control tools (finish, set_progress, ask_user) never open a line', () => {
    const agg = new ActivityAggregator();
    for (const name of ['finish', 'set_progress', 'ask_user', 'abort', 'vg_retrieve']) {
      agg.observe({ type: 'tool-call', name, args: {} });
    }
    expect(agg.flush()).toBeNull();
    expect(agg.seal()).toBeNull();
    expect(agg.groups).toBe(0);
  });

  it('assistant prose splits groups: tools after a sealed group open group 2', () => {
    const agg = new ActivityAggregator();
    agg.observe({ type: 'tool-call', name: 'read_file', args: {} });
    expect(agg.seal()?.group).toBe(1);
    agg.observe({ type: 'tool-call', name: 'run_command', args: {} });
    const g2 = agg.seal();
    expect(g2).toMatchObject({ group: 2, ran: 1, explored: 0, summary: 'Ran 1 command' });
    expect(agg.groups).toBe(2);
  });

  it('the same file edited twice counts as one edited file', () => {
    const agg = new ActivityAggregator();
    agg.observe({ type: 'change', change: change('a.ts', '1\n', '2\n') });
    agg.observe({ type: 'change', change: change('a.ts', '2\n', '3\n') });
    expect(agg.seal()).toMatchObject({ edited: 1, files: ['a.ts'] });
  });

  it('MCP and vendor read tools count as explored', () => {
    const agg = new ActivityAggregator();
    agg.observe({ type: 'tool-call', name: 'mcp__vibgrate__search_symbols', args: {} });
    agg.observe({ type: 'tool-call', name: 'library_docs', args: {} });
    expect(agg.seal()?.explored).toBe(2);
  });

  it('formatActivitySummary singular/plural and the empty fallback', () => {
    expect(formatActivitySummary({ explored: 1, edited: 1, ran: 0, added: 0, removed: 0 })).toBe('Explored 1 item · Edited 1 file');
    expect(formatActivitySummary({ explored: 0, edited: 0, ran: 0, added: 0, removed: 0 })).toBe('Working…');
  });
});

describe('summarizeChanges (the Changes card)', () => {
  it('counts match countDiffStats of the net per-file diff', () => {
    const a1 = change('src/a.ts', 'one\ntwo\n', 'one\nTWO\n');
    const a2 = change('src/a.ts', 'one\nTWO\n', 'one\nTWO\nthree\n');
    const b = change('src/new.ts', null, 'x\ny\nz\n');
    const card = summarizeChanges([a1, b, a2]);
    const netA = countDiffStats(unifiedDiff('one\ntwo\n', 'one\nTWO\nthree\n', 'src/a.ts'));
    const netB = countDiffStats(b.diff);
    expect(card.files).toEqual([
      { path: 'src/a.ts', added: netA.added, removed: netA.removed, status: 'modified' },
      { path: 'src/new.ts', added: netB.added, removed: netB.removed, status: 'created' },
    ]);
    expect(card.totalAdded).toBe(netA.added + netB.added);
    expect(card.totalRemoved).toBe(netA.removed + netB.removed);
    expect(netB.added).toBe(3);
  });

  it('a reverted edit drops out; a delete is marked deleted', () => {
    const card = summarizeChanges([
      change('r.ts', 'a\n', 'b\n'),
      change('r.ts', 'b\n', 'a\n'),
      change('gone.ts', 'x\ny\n', null),
    ]);
    expect(card.files).toEqual([{ path: 'gone.ts', added: 0, removed: 2, status: 'deleted' }]);
  });

  it('no changes → an empty card', () => {
    expect(summarizeChanges([])).toEqual({ files: [], totalAdded: 0, totalRemoved: 0 });
  });
});
