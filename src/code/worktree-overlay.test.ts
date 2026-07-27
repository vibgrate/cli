import { describe, it, expect } from 'vitest';
import {
  buildWorktreeOverlayEntries,
  listWorktreeDirtyFiles,
  materializeWorktreeGraph,
} from './worktree-overlay.js';
import { fixtureGraph } from './graph-fixture.js';

describe('worktree overlay', () => {
  it('parses porcelain status into sorted relative paths', () => {
    const porcelain = [
      ' M src/scan.ts',
      '?? src/new.ts',
      'D  gone.ts',
      'R  old.ts -> src/renamed.ts',
      ' M package-lock.json',
    ].join('\n');
    const files = listWorktreeDirtyFiles('/repo', {
      porcelain,
      extensions: ['.ts', '.tsx'],
    });
    expect(files).toEqual(['gone.ts', 'src/new.ts', 'src/renamed.ts', 'src/scan.ts']);
  });

  it('buildWorktreeOverlayEntries marks missing files as delete', () => {
    const entries = buildWorktreeOverlayEntries(
      '/repo',
      ['a.ts', 'b.ts'],
      {
        readFile: (abs) => (abs.endsWith('a.ts') ? 'export const a = 1;\n' : null),
      },
    );
    expect(entries.get('a.ts')).toEqual({ kind: 'write', content: 'export const a = 1;\n' });
    expect(entries.get('b.ts')).toEqual({ kind: 'delete' });
  });

  it('materializeWorktreeGraph returns base when no dirty files', async () => {
    const base = fixtureGraph();
    const r = await materializeWorktreeGraph(base, '/repo', { dirtyFiles: [] });
    expect(r.graph).toBe(base);
    expect(r.reparsed).toEqual([]);
  });

  it('materializeWorktreeGraph strips dirty files when parse is unavailable', async () => {
    const base = fixtureGraph();
    const before = base.nodes.filter((n) => n.file === 'src/scan.ts').length;
    expect(before).toBeGreaterThan(0);
    const r = await materializeWorktreeGraph(base, '/repo', {
      dirtyFiles: ['src/scan.ts'],
      readFile: () => 'export function scanDir() { return 99; }\n',
      // Force no reparse: omit parseFile and prevent default by empty content path —
      // applyOverlay still marks rewritten; without parseFile it only strips.
      parseFile: undefined,
    });
    // When parseFile is undefined, applyOverlayToGraph does not reparse (strips only).
    expect(r.dirtyFiles).toEqual(['src/scan.ts']);
    expect(r.rewritten).toContain('src/scan.ts');
    expect(r.graph.nodes.filter((n) => n.file === 'src/scan.ts').length).toBe(0);
  });
});
