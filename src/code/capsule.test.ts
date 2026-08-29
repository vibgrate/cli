import { describe, it, expect } from 'vitest';
import {
  buildTaskCapsule,
  capsuleToCodeContext,
  summarizeCapsule,
  capsuleTransparencyLines,
  TASK_CAPSULE_SCHEMA_VERSION,
  CAPSULE_RANKING_VERSION,
} from './capsule.js';
import { fixtureGraph } from './graph-fixture.js';

const FIXTURE_FILES: Record<string, string> = {
  'src/scan.ts': [
    'export type Report = { ok: boolean };',
    'export type Config = { root: string };',
    '',
    '// scanDir must never follow symlinks out of the root',
    'export function scanDir(dir: string): Report {',
    '  const cfg = readConfig();',
    '  return { ok: true };',
    '}',
    '',
    'export function readConfig(): Config {',
    '  return { root: "." };',
    '}',
  ].join('\n'),
  'src/report.ts': [
    'import { scanDir } from "./scan";',
    '',
    'export function formatReport(r: { ok: boolean }): string {',
    '  return r.ok ? "ok" : "fail";',
    '}',
  ].join('\n'),
};

function readFixture(file: string): string | null {
  return FIXTURE_FILES[file] ?? null;
}

describe('buildTaskCapsule', () => {
  it('emits task-capsule/0 with primary seeds and source slices', () => {
    const capsule = buildTaskCapsule(fixtureGraph(), 'add a timeout to scanDir', { readFile: readFixture });
    expect(capsule.schemaVersion).toBe(TASK_CAPSULE_SCHEMA_VERSION);
    expect(capsule.provenance.rankingVersion).toBe(CAPSULE_RANKING_VERSION);
    expect(capsule.primary.some((p) => p.qualifiedName === 'scanDir')).toBe(true);
    expect(capsule.sourceSlices.length).toBeGreaterThan(0);
    expect(capsule.sourceSlices.some((s) => s.content.includes('function scanDir'))).toBe(true);
    expect(capsule.sourceSlices.every((s) => s.contentHash.length === 64)).toBe(true);
    expect(capsule.rendered).toContain('Exact source evidence');
    expect(capsule.rendered).toContain('function scanDir');
    expect(capsule.tokensEstimate).toBeGreaterThan(0);
  });

  it('pins hard constraints and lists blast-radius relationships', () => {
    const capsule = buildTaskCapsule(fixtureGraph(), 'change scanDir', { readFile: readFixture });
    expect(capsule.pinnedFacts.join('\n')).toContain('never follow symlinks');
    expect(capsule.supporting.some((s) => s.qualifiedName === 'formatReport')).toBe(true);
    expect(capsule.relationships.some((r) => r.kind === 'impacts' && r.to === 'formatReport')).toBe(true);
  });

  it('orders the rendered block cache-stably: constraints, then symbols, then evidence', () => {
    const capsule = buildTaskCapsule(fixtureGraph(), 'add a timeout to scanDir', { readFile: readFixture });
    const r = capsule.rendered;
    expect(r.indexOf('## Primary symbols')).toBeLessThan(r.indexOf('## Exact source evidence'));
    expect(r.indexOf('## Exact source evidence')).toBeLessThan(r.indexOf('## Verification plan'));
  });

  it('never echoes the instruction — the caller sends the ask as its own turn', () => {
    // The capsule used to end with "## Task" + the instruction while
    // buildAgentMessages ALSO appended a task turn, so a long ask was billed
    // twice on every step and its echo evicted source slices from the budget.
    const ask = 'add a timeout to scanDir';
    const capsule = buildTaskCapsule(fixtureGraph(), ask, { readFile: readFixture });
    expect(capsule.rendered).not.toContain('## Task');
    expect(capsule.rendered).not.toContain(ask);
    // The instruction is still carried on the capsule for callers that need it.
    expect(capsule.instruction).toBe(ask);
  });

  it('does not let a long ask inflate the capsule or evict its evidence', () => {
    const short = 'add a timeout to scanDir';
    const long = `${short}. ${'This ticket has a great deal of surrounding narrative. '.repeat(60)}`;
    const a = buildTaskCapsule(fixtureGraph(), short, { readFile: readFixture });
    const b = buildTaskCapsule(fixtureGraph(), long, { readFile: readFixture });
    expect(b.tokensEstimate).toBe(a.tokensEstimate);
    expect(b.sourceSlices.length).toBe(a.sourceSlices.length);
  });

  it('is deterministic given the same graph, instruction, and files', () => {
    const a = buildTaskCapsule(fixtureGraph(), 'add a timeout to scanDir', { readFile: readFixture });
    const b = buildTaskCapsule(fixtureGraph(), 'add a timeout to scanDir', { readFile: readFixture });
    expect(a.rendered).toBe(b.rendered);
    expect(a.sourceSlices).toEqual(b.sourceSlices);
    expect(a.relationships).toEqual(b.relationships);
  });

  it('builds without slices when readFile is omitted', () => {
    const capsule = buildTaskCapsule(fixtureGraph(), 'scanDir');
    expect(capsule.sourceSlices).toEqual([]);
    expect(capsule.rendered).toContain('No source slices available');
  });

  it('projects into CodeContext for the legacy agent path', () => {
    const capsule = buildTaskCapsule(fixtureGraph(), 'scanDir', { readFile: readFixture });
    const ctx = capsuleToCodeContext(capsule);
    expect(ctx.instruction).toBe(capsule.instruction);
    expect(ctx.rendered).toBe(capsule.rendered);
    expect(ctx.seeds.some((s) => s.node.qualifiedName === 'scanDir')).toBe(true);
  });

  it('renders the module-authored concept map before the symbol list', () => {
    // The interpretation lines are authored by the relevance module and
    // arrive on the sanitized ranking (the linguistic behaviour itself is
    // gated in the module package); the capsule's job is to render them
    // ahead of the seeds so the a→b/↩ slugs are decodable.
    const graph = fixtureGraph();
    const seed = graph.nodes.find((n) => n.qualifiedName === 'scanDir')!;
    const capsule = buildTaskCapsule(graph, 'do we support direct debits?', {
      readFile: readFixture,
      ranked: {
        version: 'stub-ranker@1',
        hasContent: true,
        seeds: [{ id: seed.id, score: 10, why: 'matched: direct debits→mandate' }],
        conceptMap: ['- "direct debits" in the ask implies these codebase identifiers: mandate, sepa.'],
      },
    });
    const r = capsule.rendered;
    expect(capsule.conceptMap.length).toBeGreaterThan(0);
    expect(r).toContain('## How the ask was interpreted');
    expect(r).toContain('"direct debits"');
    // Interpretation renders before the seeds so the a→b/↩ slugs are decodable.
    expect(r.indexOf('## How the ask was interpreted')).toBeLessThan(r.indexOf('## Primary symbols'));
    // Projection keeps the concept map for the legacy path.
    expect(capsuleToCodeContext(capsule).conceptMap).toEqual(capsule.conceptMap);
    // The ranking engine's version lands in provenance.
    expect(capsule.provenance.relevanceVersion).toBe('stub-ranker@1');
  });

  it('summarizes the interpretation for a host surface, without the model-facing legend', () => {
    // The rendered capsule ends its concept map with a seed-notation legend so a
    // small local model can decode the a→b slugs. A terminal or panel reader
    // gets the reason spelled out next to each symbol, so the legend is noise
    // there and the host projection drops it (with the "- " bullet).
    const graph = fixtureGraph();
    const seed = graph.nodes.find((n) => n.qualifiedName === 'scanDir')!;
    const capsule = buildTaskCapsule(graph, 'do we support direct debits?', {
      readFile: readFixture,
      ranked: {
        version: 'stub-ranker@1',
        hasContent: true,
        seeds: [{ id: seed.id, score: 10, why: 'matched: direct debits→mandate' }],
        conceptMap: [
          '- "direct debits" in the ask implies these codebase identifiers: mandate, sepa.',
          '- Seed notation below: `a→b` = ask term "a" implied identifier "b".',
        ],
      },
    });
    const summary = summarizeCapsule(capsule);

    expect(summary.interpretation).toEqual([
      '"direct debits" in the ask implies these codebase identifiers: mandate, sepa.',
    ]);
    // The reason each symbol matched travels with it, so a host never has to
    // parse the rendered prompt to explain a seed.
    expect(summary.primary[0]?.why).toBe('matched: direct debits→mandate');
  });

  it('caps the transparency block so one line per turn cannot flood a session', () => {
    const graph = fixtureGraph();
    const seed = graph.nodes.find((n) => n.qualifiedName === 'scanDir')!;
    const capsule = buildTaskCapsule(graph, 'do we support direct debits?', {
      readFile: readFixture,
      ranked: {
        version: 'stub-ranker@1',
        hasContent: true,
        seeds: [{ id: seed.id, score: 10, why: 'matched: direct debits→mandate' }],
        conceptMap: [
          '- one.',
          '- two.',
          '- three.',
          '- four.',
          '- five.',
          '- six.',
          '- seven.',
          '- eight.',
        ],
      },
    });
    const lines = capsuleTransparencyLines(summarizeCapsule(capsule));

    const read = lines.filter((l) => l.includes('read:'));
    expect(read).toHaveLength(7); // 6 shown + the "… 2 more" tail
    expect(read[6]).toContain('… 2 more');
    expect(lines.some((l) => l.includes('seed: scanDir') && l.includes('matched: direct debits→mandate'))).toBe(true);
  });

  it('renders a fileless seed without a dangling separator', () => {
    // External / module nodes carry no file of their own, and the relevance
    // engine can rank one into the seeds (an ask naming a vendor reaches the
    // imported package node). Seen in a real render against the bundled fixture.
    const lines = capsuleTransparencyLines({
      schemaVersion: 'task-capsule/0',
      instruction: 'the direct debit mandate fails at checkout',
      primary: [{ qualifiedName: 'stripe', file: '', kind: 'external', why: 'matched: checkout→stripe' }],
      supporting: [],
      sourceSliceCount: 0,
      sourceFiles: [],
      tokensEstimate: 10,
      rankingVersion: 'capsule-rank@test',
      interpretation: [],
      preview: '',
    });
    expect(lines).toEqual(['      seed: stripe — matched: checkout→stripe']);
  });

  it('has nothing to show when no relevance engine widened the ask', () => {
    const capsule = buildTaskCapsule(fixtureGraph(), 'add a timeout to scanDir', { readFile: readFixture });
    expect(summarizeCapsule(capsule).interpretation).toEqual([]);
  });

  it('omits the concept map when nothing fired', () => {
    const capsule = buildTaskCapsule(fixtureGraph(), 'add a timeout to scanDir', { readFile: readFixture });
    expect(capsule.conceptMap).toEqual([]);
    expect(capsule.rendered).not.toContain('## How the ask was interpreted');
  });

  it('does not invent primary symbols from a URL occurrence locate (field report)', () => {
    const capsule = buildTaskCapsule(
      fixtureGraph(),
      'https://dash.vibgrate.com/signup does not exist find occurrences',
      { readFile: readFixture },
    );
    expect(capsule.provenance.rankingVersion).toBe(CAPSULE_RANKING_VERSION);
    expect(capsule.primary).toHaveLength(0);
    expect(capsule.pinnedFacts.some((f) => f.includes('https://dash.vibgrate.com/signup'))).toBe(true);
    expect(capsule.rendered).toMatch(/literal-locate|exact string/i);
  });
});


describe('seed count is the configured limit', () => {
  const graph = fixtureGraph();
  const ids = graph.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'external').map((n) => n.id);

  const ranking = (scores: number[]) => ({
    version: 'test',
    hasContent: true,
    conceptMap: [],
    seeds: scores.map((score, i) => ({ id: ids[i % ids.length]!, score, why: 'test' })),
  });

  /**
   * A relative-floor trim (keep seeds scoring >= a quarter of the top) was
   * measured and dropped: it did little on no-signal asks — their score curves
   * still clear eight seeds — while on a peaked REAL ranking it dropped the
   * mid-score supporting symbols an agent uses to orient. Recall over a
   * speculative trim. docs/graph/VG-ASK-LENGTH-CAPSULE-FOLLOWUP.md
   */
  it('keeps the whole cluster on a peaked ranking, cliff and all', () => {
    const c = buildTaskCapsule(graph, 'change scanDir', {
      readFile: readFixture,
      ranked: ranking([400, 380, 10, 8, 6]),
    });
    expect(c.primary.length).toBe(5);
  });

  it('keeps them on a flat ranking too', () => {
    const c = buildTaskCapsule(graph, 'change scanDir', {
      readFile: readFixture,
      ranked: ranking([100, 5, 4, 3, 2]),
    });
    expect(c.primary.length).toBe(5);
  });

  it('never exceeds the seed limit', () => {
    const c = buildTaskCapsule(graph, 'change scanDir', {
      readFile: readFixture,
      seeds: 3,
      ranked: ranking([100, 100, 100, 100, 100, 100]),
    });
    expect(c.primary.length).toBeLessThanOrEqual(3);
  });
});
