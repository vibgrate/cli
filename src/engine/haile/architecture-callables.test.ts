import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { architectureSidecarSummary, loadArchitectureCallables } from './architecture-callables.js';
import { emptySidecar, writeSidecarDocument } from './sidecar.js';
import type { HaileSymbol } from './types.js';

let root: string;
let prevInRepo: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-arch-callables-'));
  prevInRepo = process.env.VIBGRATE_GRAPH_IN_REPO;
  process.env.VIBGRATE_GRAPH_IN_REPO = '1'; // the map (and its sidecar) live under <root>/.vibgrate
  fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vibgrate', 'graph.json'), '{}');
});

afterEach(() => {
  if (prevInRepo === undefined) delete process.env.VIBGRATE_GRAPH_IN_REPO;
  else process.env.VIBGRATE_GRAPH_IN_REPO = prevInRepo;
  fs.rmSync(root, { recursive: true, force: true });
});

function symbol(over: Partial<HaileSymbol> & Pick<HaileSymbol, 'node_id' | 'file_path' | 'name'>): HaileSymbol {
  return {
    qualified_name: over.name,
    symbol_kind: 'function',
    role: { primary: 'controller', alternatives: [], confidence: 0.8, band: 'high' },
    purposes: [{ purpose: 'validate', confidence: 1 }],
    intent: { text: `validates ${over.name}`, verbs: ['validate'], objects: [over.name] },
    evidence: [],
    ...over,
  };
}

function writeSidecar(corpusHash: string, symbols: HaileSymbol[]): void {
  const doc = emptySidecar(corpusHash);
  doc.symbols = symbols;
  writeSidecarDocument(doc, path.join(root, '.vibgrate', 'graph.json'));
}

describe('loadArchitectureCallables', () => {
  it('projects usable symbols, skips abstain / unknown, and copies file-layer as an annotation', () => {
    writeSidecar('abc', [
      symbol({ node_id: 'n1', file_path: 'src/api/users.ts', name: 'createUser', file_layer: 'routing' }),
      symbol({ node_id: 'n2', file_path: 'src/api/misc.ts', name: 'helper', role: { primary: 'unknown', alternatives: [], confidence: 0.1, band: 'abstain' } }),
    ]);
    const rows = loadArchitectureCallables(root, '__repo__', { corpusHash: 'abc' });
    expect(rows).toEqual([
      { file: 'src/api/users.ts', name: 'createUser', role: 'controller', purposes: ['validate'], intent: 'validates createUser', layer: 'routing' },
    ]);
  });

  it('omits everything when the sidecar is bound to a different corpus', () => {
    writeSidecar('abc', [symbol({ node_id: 'n1', file_path: 'src/a.ts', name: 'a' })]);
    expect(loadArchitectureCallables(root, '__repo__', { corpusHash: 'other' })).toBeUndefined();
    expect(architectureSidecarSummary(root, { corpusHash: 'other' })).toBeUndefined();
    expect(architectureSidecarSummary(root, { corpusHash: 'abc' })).toMatchObject({ symbolCount: 1 });
  });

  it('filters to the scope path and returns undefined for an empty scope', () => {
    writeSidecar('abc', [
      symbol({ node_id: 'n1', file_path: 'apps/web/src/a.ts', name: 'a' }),
      symbol({ node_id: 'n2', file_path: 'apps/api/src/b.ts', name: 'b' }),
    ]);
    expect(loadArchitectureCallables(root, 'apps/api', { corpusHash: 'abc' })?.map((r) => r.name)).toEqual(['b']);
    expect(loadArchitectureCallables(root, 'packages/none', { corpusHash: 'abc' })).toBeUndefined();
  });

  it('is absent (not empty) when no sidecar exists', () => {
    expect(loadArchitectureCallables(root, '__repo__', { corpusHash: 'abc' })).toBeUndefined();
  });
});
