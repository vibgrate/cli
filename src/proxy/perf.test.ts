import { describe, expect, it } from 'vitest';
import { builtinFixtures, percentile, runPerf } from './perf.js';
import { loadDefaultDeps } from './fallbacks.js';

describe('percentile', () => {
  it('indexes a sorted sample without interpolating', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('fixtures', () => {
  it('covers every content type the router can route', () => {
    const types = builtinFixtures().map((f) => f.contentType).sort();
    expect(types).toEqual(['build_output', 'git_diff', 'html', 'json', 'plain_text', 'search_results', 'source_code', 'tabular']);
  });

  it('puts the payload outside the protected window, and asks about something else last', () => {
    // both protections are correct in a session but would make the bench measure
    // them instead of the compressors — see the comment on `toolTurn`
    for (const f of builtinFixtures()) {
      expect(f.messages.length).toBeGreaterThanOrEqual(6);
      const toolResultIndex = f.messages.findIndex((m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === 'tool_result'));
      expect(toolResultIndex).toBeGreaterThanOrEqual(0);
      expect(f.messages.length - toolResultIndex).toBeGreaterThan(3);
      expect(f.messages[f.messages.length - 1].role).toBe('user');
    }
  });
});

describe('runPerf', () => {
  it('compresses every fixture, deterministically, with the real pipeline', async () => {
    const { deps, missing } = await loadDefaultDeps({ env: process.env });
    expect(missing).toEqual([]);
    await deps.warmRouter?.();
    let t = 0;
    const report = await runPerf(deps, { iterations: 2, clock: () => (t += 5), generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(report.rows).toHaveLength(8);
    expect(report.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    for (const row of report.rows) {
      // every content type must actually compress: a row at 0% means a
      // compressor stopped working, or the bench stopped exercising it
      expect(row.savedPercent, `${row.fixture} saved nothing`).toBeGreaterThan(5);
      expect(row.keptRatio).toBeLessThan(1);
      expect(row.deterministic, `${row.fixture} was not deterministic`).toBe(true);
      expect(row.transforms.join(',')).not.toBe('router:noop');
    }
    expect(report.totals.savedPercent).toBeGreaterThan(50);
    expect(report.totals.tokensAfter).toBeLessThan(report.totals.tokensBefore);
  });

  it('filters by fixture name or content type', async () => {
    const { deps } = await loadDefaultDeps({ env: process.env });
    const byName = await runPerf(deps, { iterations: 1, fixture: 'build-log' });
    expect(byName.rows.map((r) => r.fixture)).toEqual(['build-log']);
    const byType = await runPerf(deps, { iterations: 1, fixture: 'json' });
    expect(byType.rows.map((r) => r.fixture)).toEqual(['json-array']);
  });
});
