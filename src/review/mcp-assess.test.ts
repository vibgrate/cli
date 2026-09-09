import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assessProposedChange, clearAssessBaselineCache } from './mcp-assess.js';
import type { AssessResult } from './assess.js';
import type { VgGraph } from '../schema.js';
import { edge, graph, node } from './test-fixtures.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const ORIGINAL = [
  'export function calculateInvoiceTotal(items, taxRate) {',
  '  let total = 0;',
  '  for (const item of items) {',
  '    total = total + item.price * item.quantity;',
  '  }',
  '  const tax = total * taxRate;',
  '  return round(total + tax, 2);',
  '}',
].join('\n');

const RENAMED_COPY = ORIGINAL.replace('calculateInvoiceTotal', 'computeBillSum')
  .replace(/items/g, 'lines')
  .replace(/item\b/g, 'line')
  .replace(/total/g, 'sum')
  .replace(/taxRate/g, 'vatPercent')
  .replace(/tax\b/g, 'vat');

const GUARDED_ROUTE = "import { getThing } from '../services/thingService.js';\nrouter.post('/x', requireAuth, handler);\n";

/**
 * A small repository on disk: three guarded route files that go through a
 * service, the service, and a billing function worth duplicating.
 */
function fixture(): { root: string; graph: VgGraph } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-assess-'));
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const nodes = [node('svc', 'src/services/thingService.ts'), node('calc', 'src/billing.ts', { name: 'calculateInvoiceTotal', span: { start: 1, end: 8 } })];
  const edges = [];
  for (const p of ['p1', 'p2', 'p3']) {
    write(`src/routes/${p}.ts`, GUARDED_ROUTE);
    nodes.push(node(p, `src/routes/${p}.ts`, { span: { start: 1, end: 2 } }));
    edges.push(edge('import', p, 'svc'));
  }
  write('src/services/thingService.ts', 'export const getThing = (id) => id;\n');
  write('src/billing.ts', `${ORIGINAL}\n`);
  return { root, graph: graph(nodes, edges) };
}

const asResult = (r: ReturnType<typeof assessProposedChange>): AssessResult => {
  if ('error' in r) throw new Error(`unexpected error envelope: ${r.error}`);
  return r;
};

beforeEach(() => clearAssessBaselineCache());

// ── envelope ────────────────────────────────────────────────────────────────

describe('assessProposedChange — envelope', () => {
  it('rejects a missing file or content as a bad request, not an exception', () => {
    const { root, graph: g } = fixture();
    expect(assessProposedChange(g, root, '', 'x')).toEqual({ error: 'bad_request', message: 'file is required' });
    expect(assessProposedChange(g, root, 'src/a.ts', '')).toEqual({ error: 'bad_request', message: 'content is required' });
  });

  it('answers no_baseline rather than throwing when the baseline cannot be built', () => {
    const { root, graph: g } = fixture();
    const broken = { ...g, areas: undefined } as unknown as VgGraph;
    const result = asResult(assessProposedChange(broken, root, 'src/routes/new.ts', 'x'));
    expect(result.status).toBe('no_baseline');
    expect(result.ok).toBe(true);
    expect(result.confidence).toBe(0.2);
    expect(result.unknowns.join(' ')).toContain('baseline could not be built');
    // The failure is not cached: a usable graph on the next call builds normally.
    expect(asResult(assessProposedChange(g, root, 'src/routes/new.ts', GUARDED_ROUTE)).status).not.toBe('no_baseline');
  });
});

// ── the baseline ────────────────────────────────────────────────────────────

describe('assessProposedChange — baseline', () => {
  it('votes the proposal against its role peers and names the files to follow', () => {
    const { root, graph: g } = fixture();
    const deviating = "import { findThing } from '../repositories/thingRepository.js';\nexport const r = (id) => findThing(id);\n";
    const result = asResult(assessProposedChange(g, root, 'src/routes/new.ts', deviating));
    expect(result.status).toBe('ok');
    expect(result.ok).toBe(false);
    expect(result.convention).toMatchObject({ group: 'role:routing', pattern: 'via-service', share: 1 });
    expect(result.conflicts.map((c) => c.kind)).toEqual(['peer_deviation']);
    expect(result.conflicts[0].referenceFiles).toEqual(['src/routes/p1.ts', 'src/routes/p2.ts', 'src/routes/p3.ts']);
  });

  it('approves a proposal that follows the convention', () => {
    const { root, graph: g } = fixture();
    const result = asResult(assessProposedChange(g, root, 'src/routes/new.ts', "import { getThing } from '../services/thingService.js';\nexport const r = (id) => getThing(id);\n"));
    expect(result).toMatchObject({ status: 'ok', ok: true, conflicts: [], duplicateOf: [] });
  });

  it('reads the guard convention per directory from the route files on disk', () => {
    const { root, graph: g } = fixture();
    const open = "router.delete('/purge', purgeEverything);\n";
    const same = asResult(assessProposedChange(g, root, 'src/routes/admin.ts', open));
    expect(same.conflicts.map((c) => c.kind)).toEqual(['unguarded_route']);
    expect(same.conflicts[0].protectedRule).toBe(true);
    expect(same.conflicts[0].message).toContain('3 of 3 mutating routes alongside it do');

    // A different directory has no classified peers: an unknown, not a verdict.
    const elsewhere = asResult(assessProposedChange(g, root, 'src/api/admin.ts', open));
    expect(elsewhere.conflicts).toEqual([]);
    expect(elsewhere.unknowns.join(' ')).toContain('too few classified peer routes');
  });

  it('indexes the map\'s function bodies and reports a re-implementation', () => {
    const { root, graph: g } = fixture();
    const result = asResult(assessProposedChange(g, root, 'src/orders.ts', RENAMED_COPY));
    expect(result.duplicateOf).toEqual([{ name: 'calculateInvoiceTotal', file: 'src/billing.ts', startLine: 1, score: expect.any(Number) }]);
    expect(result.ok).toBe(false);
  });

  it('resolves the peer group from the vote a known file already sits in', () => {
    const { root, graph: g } = fixture();
    // p1 is an exemplar of role:routing — its group comes from the vote, not the path.
    const result = asResult(assessProposedChange(g, root, 'src/routes/p1.ts', "import { findThing } from '../repositories/thingRepository.js';\n"));
    expect(result.convention?.group).toBe('role:routing');
    expect(result.conflicts.map((c) => c.kind)).toEqual(['peer_deviation']);
  });

  it('has no convention to offer a file the classifier cannot place', () => {
    const { root, graph: g } = fixture();
    const result = asResult(assessProposedChange(g, root, 'src/foo.ts', "import { findThing } from '../repositories/thingRepository.js';\n"));
    expect(result.convention).toBeNull();
    expect(result.conflicts).toEqual([]);
    expect(result.unknowns.join(' ')).toContain('No peer convention could be established');
  });

  it('carries the declared target read from the repository root', () => {
    const { root, graph: g } = fixture();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'We use a layered architecture.\n');
    expect(asResult(assessProposedChange(g, root, 'src/routes/new.ts', GUARDED_ROUTE)).declaredTarget).toBe('layered');
  });
});

// ── the cache ───────────────────────────────────────────────────────────────

describe('assessProposedChange — baseline cache', () => {
  it('reuses the baseline for the same root and corpus hash', () => {
    const { root, graph: g } = fixture();
    expect(asResult(assessProposedChange(g, root, 'src/orders.ts', RENAMED_COPY)).duplicateOf).toHaveLength(1);
    // The file the duplicate was found in is gone, but the cached index still knows it.
    fs.rmSync(path.join(root, 'src/billing.ts'));
    expect(asResult(assessProposedChange(g, root, 'src/orders.ts', RENAMED_COPY)).duplicateOf).toHaveLength(1);
  });

  it('rebuilds when the graph carries a new corpus hash — a stale baseline never answers for new code', () => {
    const { root, graph: g } = fixture();
    expect(asResult(assessProposedChange(g, root, 'src/orders.ts', RENAMED_COPY)).duplicateOf).toHaveLength(1);
    fs.rmSync(path.join(root, 'src/billing.ts'));
    const rebuilt = { ...g, provenance: { ...g.provenance, corpusHash: 'corpus-2' } };
    expect(asResult(assessProposedChange(rebuilt, root, 'src/orders.ts', RENAMED_COPY)).duplicateOf).toEqual([]);
  });

  it('rebuilds after the cache is cleared for that root, and leaves other roots alone', () => {
    const a = fixture();
    const b = fixture();
    expect(asResult(assessProposedChange(a.graph, a.root, 'src/orders.ts', RENAMED_COPY)).duplicateOf).toHaveLength(1);
    expect(asResult(assessProposedChange(b.graph, b.root, 'src/orders.ts', RENAMED_COPY)).duplicateOf).toHaveLength(1);
    fs.rmSync(path.join(a.root, 'src/billing.ts'));
    fs.rmSync(path.join(b.root, 'src/billing.ts'));

    clearAssessBaselineCache(a.root);
    expect(asResult(assessProposedChange(a.graph, a.root, 'src/orders.ts', RENAMED_COPY)).duplicateOf).toEqual([]);
    expect(asResult(assessProposedChange(b.graph, b.root, 'src/orders.ts', RENAMED_COPY)).duplicateOf).toHaveLength(1);

    clearAssessBaselineCache();
    expect(asResult(assessProposedChange(b.graph, b.root, 'src/orders.ts', RENAMED_COPY)).duplicateOf).toEqual([]);
  });

  it('keys the cache on the resolved root so a relative spelling hits the same entry', () => {
    const { root, graph: g } = fixture();
    expect(asResult(assessProposedChange(g, root, 'src/orders.ts', RENAMED_COPY)).duplicateOf).toHaveLength(1);
    fs.rmSync(path.join(root, 'src/billing.ts'));
    const spelled = path.join(root, '.', 'src', '..');
    expect(asResult(assessProposedChange(g, spelled, 'src/orders.ts', RENAMED_COPY)).duplicateOf).toHaveLength(1);
  });
});
