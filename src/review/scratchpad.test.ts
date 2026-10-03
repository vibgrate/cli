import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, VgGraph } from '../schema.js';
import { validateReviewDoc, makePinResolver } from './doc.js';
import { buildPathDoc } from './explain-doc.js';
import type { GitRunner } from './git.js';
import { clearScratchpad, entriesOf, getScratchpad, keepInScratchpad, MAX_ENTRIES, patchScratchpad, scratchpadFile } from './scratchpad.js';

/**
 * The explain scratchpad: newest on top, the same explanation kept twice
 * moves rather than copies, an agent patches by id, and code that moved
 * under it is reported rather than blocking.
 */

const noGit: GitRunner = () => ({ stdout: '', status: 1 });
const o = { run: noGit, clock: () => new Date('2026-10-03T10:00:00Z') };

function node(id: string, file: string, start: number, end: number): GraphNode {
  return {
    id, kind: 'function', name: id, qualifiedName: id, file, span: { start, end }, lang: 'ts', importance: 0.1,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 }, area: 0, isHub: false,
  } as GraphNode;
}
const edge = (src: string, dst: string, line: number): GraphEdge =>
  ({ id: `call:${src}>${dst}`, kind: 'call', src, dst, resolution: 'tsc', confidence: 1, sites: [line] }) as GraphEdge;
const graph = {
  schemaVersion: 'vg-graph/1.1',
  nodes: [node('main', 'src/app.ts', 1, 5), node('save', 'src/store.ts', 2, 6), node('audit', 'src/audit.ts', 1, 3)],
  edges: [edge('main', 'save', 3), edge('save', 'audit', 4)],
  areas: [{ id: 0, label: 'app' }],
} as unknown as VgGraph;

let root: string;
const pathDoc = (a: string, b: string) => {
  const ids = a === 'main' && b === 'audit' ? ['main', 'save', 'audit'] : a === 'main' ? ['main', 'save'] : ['save', 'audit'];
  return buildPathDoc({ root, graph, path: { ids, direction: 'forward' }, callsOnly: true, run: noGit }).doc;
};
const lines = (n: number) => Array.from({ length: n }, (_, i) => `// ${i + 1}`).join('\n') + '\n';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vg-scratch-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/app.ts'), lines(10));
  fs.writeFileSync(path.join(root, 'src/store.ts'), lines(10));
  fs.writeFileSync(path.join(root, 'src/audit.ts'), lines(5));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const headings = (root_: string) =>
  entriesOf(getScratchpad(root_, o).doc!.sections.flatMap((s) => s.blocks)).map((e) => (e[0] as { text: string }).text);

describe('keeping explanations', () => {
  it('starts empty, then keeps each explanation on top, newest first, as one valid document', () => {
    expect(getScratchpad(root, o)).toMatchObject({ version: 0, doc: null, stale: [] });
    keepInScratchpad(root, pathDoc('main', 'save'), o);
    const pad = keepInScratchpad(root, pathDoc('save', 'audit'), o);
    expect(pad.version).toBe(2);
    expect(headings(root)).toEqual(['#### Path: save → audit', '#### Path: main → save']);
    expect(pad.doc!.kind).toBe('explain');
    const resolve = makePinResolver({ topLevel: root, baseSha: '', headSha: '', mergeBase: null, ref: null, dirty: false, dirtyTreeHash: null, files: [], remote: null }, { inPlace: true }, noGit);
    expect(validateReviewDoc(pad.doc!, resolve)).toEqual([]);
    const primaries = pad.doc!.sections.flatMap((s) => s.blocks).filter((b) => (b as { primary?: boolean }).primary);
    expect(primaries).toHaveLength(1);
    expect(fs.existsSync(scratchpadFile(root, noGit))).toBe(true);
  });

  it('moves an explanation kept again to the top instead of copying it', () => {
    keepInScratchpad(root, pathDoc('main', 'save'), o);
    keepInScratchpad(root, pathDoc('save', 'audit'), o);
    keepInScratchpad(root, pathDoc('main', 'save'), o);
    expect(headings(root)).toEqual(['#### Path: main → save', '#### Path: save → audit']);
    const ids = getScratchpad(root, o).doc!.sections.flatMap((s) => s.blocks).map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it(`keeps at most ${MAX_ENTRIES} entries`, () => {
    for (let i = 0; i < MAX_ENTRIES + 2; i++) {
      const d = pathDoc('main', 'save');
      keepInScratchpad(root, { ...d, title: `Path ${i}` }, o);
    }
    expect(headings(root)).toHaveLength(MAX_ENTRIES);
    expect(headings(root)[0]).toBe(`#### Path ${MAX_ENTRIES + 1}`);
  });

  it('is deleted once it has not been touched for the retention period', () => {
    keepInScratchpad(root, pathDoc('main', 'save'), o);
    expect(getScratchpad(root, { run: noGit, clock: () => new Date('2027-10-04T10:00:00Z') }).doc).toBeNull();
    expect(fs.existsSync(scratchpadFile(root, noGit))).toBe(false);
  });
});

describe('patching by id', () => {
  it('applies an agent patch against the version it read, and refuses a stale one', () => {
    const pad = keepInScratchpad(root, pathDoc('main', 'save'), o);
    const note = pad.doc!.sections[0]!.blocks.find((b) => b.type === 'markdown' && !(b as { text: string }).text.startsWith('####'))!;
    const res = patchScratchpad(root, pad.version, [{ op: 'set_text', block: note.id, text: 'main saves through [save](head:src/store.ts#L2-L6).' }], o);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const patched = res.scratchpad.doc!.sections[0]!.blocks.find((b) => b.id === note.id) as { text: string; origin?: string };
    expect(patched).toMatchObject({ text: 'main saves through [save](head:src/store.ts#L2-L6).', origin: 'agent' });
    expect(patchScratchpad(root, pad.version, [{ op: 'remove', block: note.id }], o)).toMatchObject({ ok: false, conflict: true });
  });

  it('refuses a patch whose pin does not land, saving nothing', () => {
    const pad = keepInScratchpad(root, pathDoc('main', 'save'), o);
    const res = patchScratchpad(root, pad.version, [{ op: 'insert', section: 'design', at: 'start', block: { type: 'code_peek', pin: { side: 'head', path: 'src/app.ts', start: 99, end: 120 } } }], o);
    expect(res.ok).toBe(false);
    expect(getScratchpad(root, o).version).toBe(pad.version);
  });

  it('reports blocks whose code moved, and still lets other blocks be patched', () => {
    const pad = keepInScratchpad(root, pathDoc('main', 'save'), o);
    fs.writeFileSync(path.join(root, 'src/store.ts'), lines(2));
    const now = getScratchpad(root, o);
    expect(now.stale.length).toBeGreaterThan(0);
    const heading = now.doc!.sections[0]!.blocks[0]!;
    const res = patchScratchpad(root, pad.version, [{ op: 'set_text', block: heading.id, text: '#### Path: main → save (old)' }], o);
    expect(res.ok).toBe(true);
  });

  it('clears', () => {
    keepInScratchpad(root, pathDoc('main', 'save'), o);
    expect(clearScratchpad(root, { run: noGit })).toBe(1);
    expect(getScratchpad(root, o).doc).toBeNull();
    expect(patchScratchpad(root, 0, [{ op: 'remove', block: 'x' }], o)).toMatchObject({ ok: false });
  });
});
