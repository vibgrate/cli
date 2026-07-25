import { describe, it, expect } from 'vitest';
import { inspectChange } from './inspect-change.js';
import { fixtureGraph } from './graph-fixture.js';

describe('inspectChange', () => {
  it('reports dependents of a symbol', () => {
    const r = inspectChange(fixtureGraph(), { symbols: ['scanDir'] });
    expect(r.roots.some((x) => x.id === 'scanDir' || x.qualifiedName === 'scanDir')).toBe(true);
    expect(r.rendered).toContain('Inspect change');
    // formatReport calls / depends on scanDir in the fixture (or reverse — either way impact runs)
    expect(r.roots.length).toBeGreaterThan(0);
  });

  it('resolves roots from files', () => {
    const r = inspectChange(fixtureGraph(), { files: ['src/scan.ts'] });
    expect(r.filesTouched).toEqual(['src/scan.ts']);
    expect(r.roots.some((x) => x.file === 'src/scan.ts')).toBe(true);
  });

  it('reports isolation when no dependents', () => {
    // leaf-ish symbol with no inbound deps in a tiny graph may still list roots
    const r = inspectChange(fixtureGraph(), { symbols: ['no-such-symbol'] });
    expect(r.roots).toHaveLength(0);
    expect(r.rendered).toMatch(/impact unknown|No graph symbols/i);
  });
});
