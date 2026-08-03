import { describe, it, expect } from 'vitest';
import { buildTaskCapsule, capsuleToCodeContext, TASK_CAPSULE_SCHEMA_VERSION, CAPSULE_RANKING_VERSION } from './capsule.js';
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

  it('orders the rendered block cache-stably: evidence before task', () => {
    const capsule = buildTaskCapsule(fixtureGraph(), 'add a timeout to scanDir', { readFile: readFixture });
    const r = capsule.rendered;
    expect(r.indexOf('## Primary symbols')).toBeLessThan(r.indexOf('## Task'));
    expect(r.indexOf('## Exact source evidence')).toBeLessThan(r.indexOf('## Task'));
    expect(r.trimEnd().endsWith('add a timeout to scanDir')).toBe(true);
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

  it('renders a plain-language concept map before the symbol list (multi-turn field report)', () => {
    const capsule = buildTaskCapsule(fixtureGraph(), 'do we support direct debits?', {
      readFile: readFixture,
      priorInstruction: 'where is stripe used in the repo?',
    });
    const r = capsule.rendered;
    expect(capsule.conceptMap.length).toBeGreaterThan(0);
    expect(r).toContain('## How the ask was interpreted');
    expect(r).toContain('"direct debits"');
    expect(r).toMatch(/carried from the previous ask: .*stripe/);
    // Interpretation renders before the seeds so the a→b/↩ slugs are decodable.
    expect(r.indexOf('## How the ask was interpreted')).toBeLessThan(r.indexOf('## Primary symbols'));
    // Projection keeps the concept map for the legacy path.
    expect(capsuleToCodeContext(capsule).conceptMap).toEqual(capsule.conceptMap);
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

