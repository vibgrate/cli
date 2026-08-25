import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGraph } from './build.js';
import { queryGraph } from './query.js';
import { sanitizeRank, type RankResult } from './relevance-provider.js';
import type { VgGraph } from '../schema.js';

/**
 * The module-less fallback contract, in the parts that need no corpus.
 *
 * The relevance engine — lexicon, term roles, IDF, typo repair, morphology,
 * diversification — lives in the auto-provisioned relevance module, and the
 * full ask/code corpora run in that package's suite: ranker-gate.test.ts with
 * the module, mechanical-fallback-gate.test.ts over this package's own
 * `queryGraph` without it. Both need the intent fixture and the generated
 * corpus, which live beside the module and cannot be imported from here (this
 * package is synced verbatim to the public repo, where that package does not
 * exist), so this suite keeps the two halves that stand on their own:
 *
 *  1. The honest-empty floor: an ask whose words name nothing returns
 *     NOTHING, even when the repo is full of lookalike identifiers — the
 *     grab-bag regression this fixture's distractors reproduce.
 *  2. The seam contract: a provider ranking is consumed in order, sanitized
 *     (unknown ids dropped, strings cleaned), and an honest miss from the
 *     module stays an honest miss.
 */

const SEED_LIMIT = 16;

/**
 * A deliberately small repo whose identifiers collide with the framing words
 * of a contentless ask: `add`/`Add*Form`/`submitAdd*`, `Feature*`, `fix*`,
 * `*Direct*`, `*Via*`. Without the floor, "add a new feature" seeds every one
 * of them. Real domain symbols are here too, so an empty result can never be
 * mistaken for a broken graph — the name-bearing check below pins one.
 */
const FILES: Record<string, string> = {
  'src/admin/forms.ts': [
    'export class AddBlogForm { submitAddBlog() { return true; } }',
    'export class AddUserForm { submitAddUser() { return true; } }',
    'export function addRow(rows: string[], row: string) { rows.push(row); return rows; }',
  ].join('\n'),
  'src/flags/store.ts': [
    'export class FeatureFlagStore {',
    '  private flags = new Map<string, boolean>();',
    '  featureEnabled(name: string) { return this.flags.get(name) ?? false; }',
    '}',
  ].join('\n'),
  'src/util/urls.ts': [
    'export function validDirectUrl(url: string) { return url.startsWith("https://"); }',
    'export function directoryListing(dir: string) { return [dir]; }',
    'export function generateObjectViaResponsesApi(id: string) { return { id }; }',
  ].join('\n'),
  'src/support/bugs.ts': [
    'export function fixBugReport(id: string) { return `fixed ${id}`; }',
    'export class BugTracker { closeBug(id: string) { return id; } }',
  ].join('\n'),
  'src/payments/mandate.ts': [
    'export class DirectDebitMandate {',
    '  collectPayment(amount: number) { return amount; }',
    '}',
  ].join('\n'),
};

let root: string;
let graph: VgGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ask-quality-'));
  for (const [rel, body] of Object.entries(FILES)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body + '\n');
  }
  const built = await buildGraph({
    root,
    inline: true,
    noGround: true,
    noTsc: true,
    noCoverage: true,
    noScip: true,
    generatedAt: '2026-01-01T00:00:00Z',
  });
  graph = built.graph;
}, 180_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('module-less fallback (queryGraph with no ranking)', () => {
  it('an ask that NAMES a symbol pins its file', () => {
    const r = queryGraph(graph, 'explain where FeatureFlagStore is used', { limit: 3 });
    expect(r.matches.map((m) => m.node.file)).toContain('src/flags/store.ts');
  });

  it('asks whose words name nothing return an honest empty, not a grab-bag', () => {
    // The first three are framing words that collide with REAL identifier
    // parts in the fixture, so they are the cases that actually exercise the
    // floor: without it `add` seeds every Add* symbol, `feature` seeds
    // FeatureFlagStore, and `fix`/`bug` seed the *fix*/*bug* lookalikes — a
    // full seed window for an ask that named nothing. The rest are framing
    // words with no collision, plus genuine vocabulary the repo lacks.
    for (const q of [
      'add a new feature',
      'add support for a new thing',
      'fix the bug',
      'do the work',
      'can you make changes',
      'where do we tessellate quaternion frustum meshes?',
    ]) {
      const r = queryGraph(graph, q, { limit: SEED_LIMIT });
      expect(r.matches, q).toEqual([]);
    }
  });
});

describe('provider-ranking seam (stub module)', () => {
  const validIds = () => new Set(graph.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'external').map((n) => n.id));

  it('consumes a sanitized ranking in order and keeps its why strings', () => {
    const picks = graph.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'external').slice(0, 3);
    const raw: RankResult = {
      version: 'stub-ranker@1',
      hasContent: true,
      seeds: picks.map((n, i) => ({ id: n.id, score: 100 - i, why: `stub pick ${i}` })),
      conceptMap: ['- stub interpretation line.'],
    };
    const ranked = sanitizeRank(raw, validIds());
    expect(ranked).not.toBeNull();
    const r = queryGraph(graph, 'anything at all', { limit: SEED_LIMIT, ranked });
    expect(r.matches.map((m) => m.node.id)).toEqual(picks.map((n) => n.id));
    expect(r.matches[0]!.why).toBe('stub pick 0');
  });

  it('drops invented ids, non-finite scores, and control characters at the boundary', () => {
    const real = graph.nodes.find((n) => n.kind !== 'file' && n.kind !== 'external')!;
    const raw: RankResult = {
      version: 'stub-ranker@1',
      hasContent: true,
      seeds: [
        { id: 'not-a-real-node', score: 999, why: 'forged' },
        { id: real.id, score: Number.NaN, why: 'bad score' },
        { id: real.id, score: 5, why: 'ok  why\nline' },
      ],
      conceptMap: ['ok line', ' ', ''],
    };
    const ranked = sanitizeRank(raw, validIds());
    expect(ranked).not.toBeNull();
    expect(ranked!.seeds).toHaveLength(1);
    expect(ranked!.seeds[0]!.id).toBe(real.id);
    expect(ranked!.seeds[0]!.why).toBe('ok why line');
    expect(ranked!.conceptMap).toEqual(['ok line']);
  });

  it("a module honest miss stays an honest miss — the fallback must not second-guess it", () => {
    const ranked = sanitizeRank(
      { version: 'stub-ranker@1', hasContent: false, seeds: [], conceptMap: [] },
      validIds(),
    );
    // A question that WOULD mechanically match: the module's verdict wins.
    const named = graph.nodes.find((n) => n.kind !== 'file' && n.kind !== 'external')!;
    const r = queryGraph(graph, `explain where ${named.name} is used`, { limit: SEED_LIMIT, ranked });
    expect(r.matches).toEqual([]);
  });

  it('a malformed envelope drops the whole ranking (null → mechanical fallback)', () => {
    expect(sanitizeRank({} as RankResult, validIds())).toBeNull();
    expect(sanitizeRank({ version: 1, hasContent: true, seeds: [], conceptMap: [] } as unknown as RankResult, validIds())).toBeNull();
    expect(sanitizeRank({ version: 'v', hasContent: true, seeds: 'x', conceptMap: [] } as unknown as RankResult, validIds())).toBeNull();
  });
});
