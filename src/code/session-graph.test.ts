import { describe, it, expect } from 'vitest';
import { applyOverlayStructural, applyOverlayToGraph } from './session-graph.js';
import { SessionOverlay } from './overlay.js';
import { fixtureGraph } from './graph-fixture.js';
import type { CodeFs } from './session.js';
import type { FileParse } from '../engine/types.js';

function memFs(seed: Record<string, string> = {}): CodeFs {
  const files: Record<string, string | null> = { ...seed };
  return {
    read: (f) => (f in files ? files[f] : null),
    write: (f, c) => {
      files[f] = c;
    },
    remove: (f) => {
      files[f] = null;
    },
    appendAudit: () => {},
  };
}

describe('applyOverlayStructural', () => {
  it('removes nodes for deleted and rewritten files', () => {
    const base = fixtureGraph();
    const dirty = new Map([
      ['src/scan.ts', { kind: 'delete' as const }],
      ['src/report.ts', { kind: 'write' as const, content: 'export {}' }],
    ]);
    const { graph, deleted, rewritten } = applyOverlayStructural(base, dirty);
    expect(deleted).toContain('src/scan.ts');
    expect(rewritten).toContain('src/report.ts');
    expect(graph.nodes.every((n) => n.file !== 'src/scan.ts' && n.file !== 'src/report.ts')).toBe(true);
    expect(graph.nodes.length).toBeLessThan(base.nodes.length);
  });
});

describe('applyOverlayToGraph with reparse', () => {
  it('injects nodes from a synthetic FileParse for rewritten files', async () => {
    const base = fixtureGraph();
    const overlay = new SessionOverlay(memFs());
    overlay.write('src/scan.ts', 'export function scanDir() { return 1; }\n');

    const fakeParse = async (rel: string, _source: string, lang: string): Promise<FileParse> => ({
      rel,
      lang,
      hash: 'h',
      bytes: 10,
      defs: [
        {
          name: 'scanDir',
          qualifiedName: 'scanDir',
          kind: 'function',
          startLine: 1,
          endLine: 1,
          startByte: 0,
          endByte: 10,
        },
      ],
      calls: [],
      imports: [],
      heritage: [],
      typeRefs: [],
      guards: [],
    });

    const result = await applyOverlayToGraph(base, overlay.snapshot(), {
      parseFile: fakeParse,
      readContent: (rel) => overlay.read(rel),
    });
    expect(result.reparsed).toContain('src/scan.ts');
    expect(result.graph.nodes.some((n) => n.name === 'scanDir' || n.qualifiedName.includes('scanDir'))).toBe(true);
  });
});
