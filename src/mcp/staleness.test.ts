import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphSource, type RefreshImpl } from './server.js';
import { isRelevantChange } from '../engine/watch-filter.js';

/**
 * Serve-loop freshness semantics: watcher events arm an immediate probe and an
 * in-band staleness note; the note clears only on a COMMITTED refresh
 * ('fresh'/'refreshed'), never on locked/error outcomes — false-positive
 * staleness is acceptable, false-negative is not.
 */

function makeSource(refreshImpl: RefreshImpl): { source: GraphSource; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-'));
  const graphPath = path.join(root, '.vibgrate', 'graph.json');
  fs.mkdirSync(path.dirname(graphPath), { recursive: true });
  fs.writeFileSync(graphPath, '{}');
  const source = new GraphSource(graphPath, true, { root, refreshImpl, probeIntervalMs: 0, refreshBudgetMs: 5_000 });
  return { source, root };
}

describe('watch-event staleness on GraphSource', () => {
  it('no changes → no note (responses carry zero overhead)', () => {
    const { source } = makeSource(async () => ({ status: 'fresh' }));
    expect(source.stalenessNote()).toBeNull();
  });

  it('a pending change produces a capped, sorted note', () => {
    const { source } = makeSource(async () => ({ status: 'locked' }));
    for (const f of ['z.ts', 'a.ts', 'm.ts', 'b.ts', 'c.ts']) source.notePendingChange(f);
    const note = source.stalenessNote()!;
    expect(note).toContain('5 file(s) changed since the last rebuild');
    expect(note).toContain('a.ts, b.ts, c.ts');
    expect(note).toContain('+2 more');
    source.stopWatching();
  });

  it('a committed refresh clears pending entries; locked/error outcomes do not', async () => {
    let outcome: 'locked' | 'error' | 'fresh' = 'locked';
    const impl: RefreshImpl = async () =>
      outcome === 'error' ? { status: 'error', message: 'boom' } : ({ status: outcome } as never);
    const { source } = makeSource(impl);

    source.notePendingChange('src/a.ts');
    await source.get(); // probe runs (locked) — must NOT clear
    expect(source.stalenessNote()).toContain('src/a.ts');

    outcome = 'error';
    source.notePendingChange('src/a.ts'); // re-arm probe (clears failure cooldown)
    await source.get(); // probe runs (error) — must NOT clear
    expect(source.stalenessNote()).toContain('src/a.ts');

    outcome = 'fresh';
    source.notePendingChange('src/a.ts');
    await source.get(); // committed → cleared
    expect(source.stalenessNote()).toBeNull();
    source.stopWatching();
  });

  it('a change landing after a refresh started stays pending (no false negatives)', async () => {
    const { source } = makeSource(async () => {
      // A change lands while the refresh is in flight.
      await new Promise((r) => setTimeout(r, 20));
      source.notePendingChange('src/late.ts');
      return { status: 'fresh' };
    });
    source.notePendingChange('src/early.ts');
    await source.get();
    // Wait out the in-flight promise fully (get() races a budget timer).
    await new Promise((r) => setTimeout(r, 60));
    const note = source.stalenessNote();
    expect(note).not.toBeNull();
    expect(note).toContain('src/late.ts');
    expect(note).not.toContain('src/early.ts');
    source.stopWatching();
  });

  it('startWatching reports success and stop is idempotent', () => {
    const { source } = makeSource(async () => ({ status: 'fresh' }));
    expect(source.startWatching()).toBe(true);
    expect(source.startWatching()).toBe(true); // already watching
    source.stopWatching();
    source.stopWatching();
  });

  it('a real file event under the watched root lands in the staleness note', async () => {
    const { source, root } = makeSource(async () => ({ status: 'locked' }));
    expect(source.startWatching()).toBe(true);
    fs.writeFileSync(path.join(root, 'newfile.ts'), 'export const x = 1;\n');
    await new Promise((r) => setTimeout(r, 250));
    const note = source.stalenessNote();
    expect(note).not.toBeNull();
    expect(note).toContain('newfile.ts');
    source.stopWatching();
  });
});

describe('watch filter', () => {
  it('skips vcs/dependency/artifact noise and vg artifacts', () => {
    expect(isRelevantChange(path.join('node_modules', 'x', 'y.js'))).toBe(false);
    expect(isRelevantChange(path.join('.git', 'HEAD'))).toBe(false);
    expect(isRelevantChange(path.join('.vibgrate', 'graph.json'))).toBe(false);
    expect(isRelevantChange(path.join('dist', 'out.js'))).toBe(false);
    expect(isRelevantChange(path.join('src', 'payments', 'mandate.ts'))).toBe(true);
  });
});
