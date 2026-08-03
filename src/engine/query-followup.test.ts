import { describe, it, expect } from 'vitest';
import { conceptMapLines, queryGraph } from './query.js';
import { bigramConsumedTokens } from './concepts.js';
import { SCHEMA_VERSION, type GraphNode, type VgGraph } from '../schema.js';

function node(partial: Partial<GraphNode> & Pick<GraphNode, 'id' | 'name' | 'qualifiedName' | 'file' | 'kind'>): GraphNode {
  return {
    span: { start: 1, end: 10 },
    lang: 'ts',
    importance: 0.5,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
    area: 0,
    isHub: false,
    tested: false,
    ...partial,
  } as GraphNode;
}

/**
 * Graph shaped like the multi-turn field report (2026-08): a payments/stripe
 * domain plus the `direct*` distractor set that seeded the "do we support
 * direct debits?" capsule with URL-fetch helpers and generated parser code.
 */
function fieldReportGraph(): VgGraph {
  const nodes: GraphNode[] = [
    node({
      id: 'directGet',
      name: 'directGet',
      qualifiedName: 'directGet',
      file: 'src/queue/lib-doc-crawl.ts',
      kind: 'function',
      importance: 0.7,
    }),
    node({
      id: 'testDirectGitHub',
      name: 'testDirectGitHub',
      qualifiedName: 'testDirectGitHub',
      file: 'scripts/debug-github-repos.mjs',
      kind: 'function',
      importance: 0.6,
    }),
    node({
      id: 'shouldRetryDirect',
      name: 'shouldRetryDirect',
      qualifiedName: 'shouldRetryDirect',
      file: 'src/lib/fetcher.ts',
      kind: 'function',
      importance: 0.6,
    }),
    node({
      id: 'stripeCharge',
      name: 'StripeCharge',
      qualifiedName: 'StripeCharge',
      file: 'src/lib/stripe.ts',
      kind: 'interface',
      importance: 0.7,
    }),
    node({
      id: 'listCards',
      name: 'listCardPaymentMethods',
      qualifiedName: 'listCardPaymentMethods',
      file: 'src/lib/stripe.ts',
      kind: 'function',
      importance: 0.8,
    }),
    node({
      id: 'debitMandate',
      name: 'createDebitMandate',
      qualifiedName: 'createDebitMandate',
      file: 'src/lib/billing/mandates.ts',
      kind: 'function',
      importance: 0.6,
    }),
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: '1970-01-01T00:00:00.000Z',
    provenance: { tool: 'vg', version: '0.0.0-test', grammars: {}, resolver: [], deep: false, corpusHash: 'test' },
    meta: {
      root: '.',
      languages: ['ts'],
      counts: { nodes: nodes.length, edges: 0, areas: 0, tests: 0, untested: 0 },
      cluster: 'none',
      edgeKinds: [],
    },
    nodes,
    edges: [],
    areas: [],
    facts: [],
  };
}

describe('bigramConsumedTokens', () => {
  it('demotes the meaningless constituent of a fired bigram, keeps the topical one', () => {
    const consumed = bigramConsumedTokens(['do', 'we', 'support', 'direct', 'debits']);
    expect(consumed.has('direct')).toBe(true);
    // "debits" singularizes to a lexicon concept — it keeps its content role.
    expect(consumed.has('debits')).toBe(false);
  });

  it('leaves tokens alone when no bigram fires', () => {
    expect(bigramConsumedTokens(['retry', 'the', 'direct', 'fetch']).size).toBe(0);
  });
});

describe('queryGraph — bigram constituent demotion', () => {
  it('"do we support direct debits?" no longer seeds direct* surface distractors', () => {
    const result = queryGraph(fieldReportGraph(), 'do we support direct debits?');
    const files = result.matches.map((m) => m.node.file);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f, `direct* distractor seeded: ${f}`).toMatch(/stripe|billing/);
    }
    expect(result.matches.some((m) => m.node.id === 'debitMandate')).toBe(true);
  });

  it('"direct" stays content evidence when no bigram consumed it', () => {
    const result = queryGraph(fieldReportGraph(), 'retry the direct fetch');
    expect(result.matches.some((m) => m.node.id === 'shouldRetryDirect')).toBe(true);
  });
});

describe('queryGraph — conversation carry-over (priorQuestion)', () => {
  it('a follow-up keeps the prior turn topic and marks carried evidence with ↩', () => {
    const result = queryGraph(fieldReportGraph(), 'do we support direct debits?', {
      priorQuestion: 'where is stripe used in the repo?',
    });
    const top = result.matches.slice(0, 4);
    expect(top.some((m) => m.node.file === 'src/lib/stripe.ts')).toBe(true);
    expect(result.matches.some((m) => m.why.includes('↩'))).toBe(true);
  });

  it('rescues a weak-only follow-up that would otherwise be an honest miss', () => {
    const graph = fieldReportGraph();
    const bare = queryGraph(graph, 'can we use it?');
    expect(bare.matches).toHaveLength(0);
    const carried = queryGraph(graph, 'can we use it?', { priorQuestion: 'where is stripe used in the repo?' });
    expect(carried.matches.some((m) => m.node.file === 'src/lib/stripe.ts')).toBe(true);
  });

  it('a clearly-named new topic outranks stale carried context', () => {
    const result = queryGraph(fieldReportGraph(), 'why does shouldRetryDirect retry the fetcher?', {
      priorQuestion: 'where is stripe used in the repo?',
    });
    expect(result.matches[0]?.node.id).toBe('shouldRetryDirect');
  });

  it('no priorQuestion → byte-identical to single-turn behaviour', () => {
    const graph = fieldReportGraph();
    const a = queryGraph(graph, 'do we support direct debits?');
    const b = queryGraph(graph, 'do we support direct debits?', { priorQuestion: null });
    expect(b.matches).toEqual(a.matches);
    expect(b.context).toEqual(a.context);
  });
});

describe('conceptMapLines', () => {
  it('explains bigram inference and carried terms in plain language', () => {
    const lines = conceptMapLines('do we support direct debits?', null, 'where is stripe used in the repo?');
    const text = lines.join('\n');
    expect(text).toContain('"direct debits"');
    expect(text).toContain('debit');
    expect(text).toMatch(/carried from the previous ask: .*stripe/);
    // The notation legend renders whenever the section renders.
    expect(text).toContain('`a→b`');
  });

  it('includes relevance-kernel topics with their vocabulary when a provider is active', () => {
    const lines = conceptMapLines('do we support direct debits?', {
      version: 'test',
      topics: [{ id: 'payments', score: 1 }],
      expansions: [
        { term: 'mandate', from: 'payments', weight: 0.45 },
        { term: 'billing', from: 'payments', weight: 0.45 },
      ],
    });
    const text = lines.join('\n');
    expect(text).toContain('"payments" domain');
    expect(text).toContain('mandate');
  });

  it('stays empty for asks where nothing fired (honest empties)', () => {
    expect(conceptMapLines('tessellate quaternion frustum meshes')).toEqual([]);
  });
});
