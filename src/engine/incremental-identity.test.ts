import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGraph } from './build.js';
import { serializeGraph } from './serialize.js';
import { writeSnapshot } from './freshness.js';
import { refreshIfStale } from './refresh.js';
import type { VgGraph } from '../schema.js';

/**
 * The incremental-identity gate (gap-closure spec 2c): a warm-cache
 * incremental rebuild must produce BYTE-IDENTICAL graph output to a cold
 * full rebuild of the same tree — across a mutation corpus, not just the
 * happy path. This converts the parse-cache purity claim (cache.ts: "the
 * graph is byte-identical whether or not the cache was warm") from a comment
 * into a CI-enforced contract, and it is the determinism guarantee no
 * competitor's incremental sync makes.
 *
 * Every case asserts two things:
 *   1. the cache actually engaged on the incremental arm (reused/statHits
 *      > 0) — otherwise the comparison proves nothing;
 *   2. serialize(incremental) === serialize(cold), byte for byte, with only
 *      `generatedAt` normalized (the schema's single documented
 *      nondeterministic field, pinned by --generated-at in production).
 */

const PIN = '2026-01-01T00:00:00.000Z';

const FIXTURE: Record<string, string> = {
  'src/payments/mandate.ts': [
    "import { chargeCard } from './charge.js';",
    'export function collectMandate(id: string): number {',
    "  return chargeCard(id.length) + 1;",
    '}',
    '',
  ].join('\n'),
  'src/payments/charge.ts': [
    'export function chargeCard(amount: number): number {',
    '  return amount * 2;',
    '}',
    '',
  ].join('\n'),
  'src/i18n/locale.ts': [
    "import { collectMandate } from '../payments/mandate.js';",
    'export function localizedTotal(id: string): string {',
    '  return `total: ${collectMandate(id)}`;',
    '}',
    '',
  ].join('\n'),
  'src/util/format.ts': ['export function pad(s: string): string {', "  return s.padStart(4, '0');", '}', ''].join('\n'),
  'src/payments/mandate.test.ts': [
    "import { collectMandate } from './mandate.js';",
    "it('collects', () => {",
    "  if (collectMandate('ab') !== 5) throw new Error('bad');",
    '});',
    '',
  ].join('\n'),
  // Ambient surface: shapes checker answers program-wide without any import
  // edge — the case the tsc cache's ambientHash component exists for.
  'src/globals.d.ts': ['declare global {', '  var vgTraceLevel: number;', '}', 'export {};', ''].join('\n'),
};

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/** Serialize with the one documented nondeterministic field normalized. */
function bytes(graph: VgGraph): string {
  return serializeGraph({ ...graph, generatedAt: PIN });
}

/** Cold arm: the mutated tree in a FRESH directory — no cache can exist. */
async function coldBuild(files: Record<string, string>): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incr-cold-'));
  writeTree(dir, files);
  const r = await buildGraph({ root: dir, generatedAt: PIN, noIndex: true });
  expect(r.reused).toBe(0); // genuinely cold
  return bytes(r.graph);
}

type Mutate = (files: Record<string, string>) => Record<string, string>;

/**
 * Warm arm: build once (populates .vibgrate/cache), apply the mutation
 * in-place, rebuild incrementally. Returns the incremental bytes plus the
 * cache-engagement counters.
 */
async function warmIncremental(
  mutate: Mutate,
): Promise<{ out: string; reused: number; tscReused: number; mutated: Record<string, string> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incr-warm-'));
  writeTree(dir, FIXTURE);
  await buildGraph({ root: dir, generatedAt: PIN, noIndex: true });

  const mutated = mutate({ ...FIXTURE });
  // Apply on disk: delete files gone from the mutated set, (re)write the rest.
  for (const rel of Object.keys(FIXTURE)) {
    if (!(rel in mutated)) fs.rmSync(path.join(dir, rel));
  }
  writeTree(dir, mutated);

  const r = await buildGraph({ root: dir, generatedAt: PIN, noIndex: true });
  expect(r.reused).toBeGreaterThan(0); // the parse cache must have engaged
  return { out: bytes(r.graph), reused: r.reused, tscReused: r.tsc?.reusedFiles ?? 0, mutated };
}

describe('incremental ≡ full rebuild (byte identity across the mutation corpus)', () => {
  it('edit a function body', async () => {
    const mutate: Mutate = (f) => ({
      ...f,
      'src/payments/charge.ts': f['src/payments/charge.ts']!.replace('amount * 2', 'amount * 3 + 1'),
    });
    const warm = await warmIncremental(mutate);
    // The change-scoped tsc rung must have reused checker output for files
    // outside the changed file's reverse-dependency closure.
    expect(warm.tscReused).toBeGreaterThan(0);
    expect(warm.out).toBe(await coldBuild(warm.mutated));
  });

  it('edit an ambient declaration file (declare global) — full checker invalidation, identical output', async () => {
    const mutate: Mutate = (f) => ({
      ...f,
      'src/globals.d.ts': f['src/globals.d.ts']!.replace('vgTraceLevel: number', 'vgTraceLevel: string'),
    });
    const warm = await warmIncremental(mutate);
    // Ambient change invalidates every per-file key — nothing may be reused.
    expect(warm.tscReused).toBe(0);
    expect(warm.out).toBe(await coldBuild(warm.mutated));
  });

  it('add a new file with an import into the existing graph', async () => {
    const mutate: Mutate = (f) => ({
      ...f,
      'src/payments/refund.ts': [
        "import { chargeCard } from './charge.js';",
        'export function refund(amount: number): number {',
        '  return -chargeCard(amount);',
        '}',
        '',
      ].join('\n'),
    });
    const warm = await warmIncremental(mutate);
    expect(warm.out).toBe(await coldBuild(warm.mutated));
  });

  it('delete a file that others import', async () => {
    const mutate: Mutate = (f) => {
      const out = { ...f };
      delete out['src/util/format.ts'];
      return out;
    };
    const warm = await warmIncremental(mutate);
    expect(warm.out).toBe(await coldBuild(warm.mutated));
  });

  it('rename a file (delete + add of identical content)', async () => {
    const mutate: Mutate = (f) => {
      const out = { ...f };
      out['src/util/padding.ts'] = out['src/util/format.ts']!;
      delete out['src/util/format.ts'];
      return out;
    };
    const warm = await warmIncremental(mutate);
    expect(warm.out).toBe(await coldBuild(warm.mutated));
  });

  it('touch-only change (same content, new mtime) — identical output AND identical corpusHash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incr-touch-'));
    writeTree(dir, FIXTURE);
    const first = await buildGraph({ root: dir, generatedAt: PIN, noIndex: true });
    // Rewrite one file with identical content (mtime moves, content does not).
    fs.writeFileSync(path.join(dir, 'src/payments/charge.ts'), FIXTURE['src/payments/charge.ts']!);
    const second = await buildGraph({ root: dir, generatedAt: PIN, noIndex: true });
    expect(second.reused).toBeGreaterThan(0);
    expect(second.graph.provenance.corpusHash).toBe(first.graph.provenance.corpusHash);
    expect(bytes(second.graph)).toBe(bytes(first.graph));
  });

  it('the production refresh path (refreshIfStale over the snapshot) matches a cold rebuild', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incr-refresh-'));
    writeTree(dir, FIXTURE);
    const initial = await buildGraph({ root: dir, generatedAt: PIN, noIndex: true });
    const graphPath = path.join(dir, '.vibgrate', 'graph.json');
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, serializeGraph(initial.graph));
    writeSnapshot(dir, initial.graph.provenance.corpusHash, initial.fileStats);

    const mutated = {
      ...FIXTURE,
      'src/payments/charge.ts': FIXTURE['src/payments/charge.ts']!.replace('amount * 2', 'amount + 41'),
    };
    writeTree(dir, mutated);

    const outcome = await refreshIfStale(dir, { graphPath });
    expect(outcome.status).toBe('refreshed');
    if (outcome.status === 'refreshed') expect(outcome.wrote).toBe(true);

    const refreshed = JSON.parse(fs.readFileSync(graphPath, 'utf8')) as VgGraph;
    expect(bytes(refreshed)).toBe(await coldBuild(mutated));
  });
});
