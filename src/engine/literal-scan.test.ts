import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanCandidates } from './literal-scan.js';

/**
 * The uniform pure-JS literal core. The interesting case is the parallel path:
 * with enough candidate bytes a "find every occurrence" sweep fans across
 * worker_threads, and that path must return the exact same complete, sorted
 * result as the inline path — the whole point is speed without losing trust.
 * We force the worker path with VG_PARALLEL_MIN_BYTES=0 rather than writing the
 * ~48 MB the default threshold needs.
 */

let root: string;
const FILES = 500;
const MATCHERS = 137; // files that contain the needle, one match line each
const NEEDLE = 'find me here';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-litscan-'));
  for (let i = 0; i < FILES; i++) {
    const hit = i < MATCHERS;
    const body = ['line one', hit ? `  const s = "FIND ME HERE";` : '  const s = "nothing";', 'line three'].join('\n');
    fs.writeFileSync(path.join(root, `f${String(i).padStart(4, '0')}.ts`), body);
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Force the worker path regardless of the small fixture's byte size.
beforeEach(() => {
  process.env.VG_PARALLEL_MIN_BYTES = '0';
});
afterEach(() => {
  delete process.env.VG_PARALLEL_MIN_BYTES;
});

const rels = () =>
  fs
    .readdirSync(root)
    .filter((f) => f.endsWith('.ts'))
    .sort();

describe('scanCandidates — parallel worker path', () => {
  it('counts every match exactly and returns rows sorted by (file, line)', async () => {
    const out = await scanCandidates(root, rels(), NEEDLE, { collectAll: true, budget: FILES });
    expect(out.total).toBe(MATCHERS); // one matching line in each matcher file
    expect(out.hits.length).toBe(MATCHERS);
    expect(out.truncated).toBe(false);
    // Case-insensitive: the needle is lower-case, the source is upper-case.
    expect(out.hits[0].preview).toContain('FIND ME HERE');
    // Deterministic order regardless of which worker found which file.
    const files = out.hits.map((h) => h.file);
    expect(files).toEqual([...files].sort());
    // Only the matcher files (the first MATCHERS by name) appear.
    expect(new Set(files).size).toBe(MATCHERS);
  });

  it('matches the inline path exactly (parallel ≡ inline)', async () => {
    // Same corpus, once forced inline (high threshold) and once forced parallel
    // (threshold 0) — the two must produce byte-identical rows and totals.
    process.env.VG_PARALLEL_MIN_BYTES = String(Number.MAX_SAFE_INTEGER);
    const inline = await scanCandidates(root, rels(), NEEDLE, { collectAll: true, budget: 1000 });
    process.env.VG_PARALLEL_MIN_BYTES = '0';
    const parallel = await scanCandidates(root, rels(), NEEDLE, { collectAll: true, budget: 1000 });
    expect(parallel.total).toBe(inline.total);
    expect(parallel.hits).toEqual(inline.hits);
  });

  it('bounded mode stops at budget and reports truncation', async () => {
    const out = await scanCandidates(root, rels(), NEEDLE, { collectAll: false, budget: 10 });
    expect(out.hits.length).toBe(10);
    expect(out.truncated).toBe(true);
  });

  it('bounded mode over the worker path matches the inline early-stop rows exactly', async () => {
    // The single-name fallthrough (collectAll:false) used to be exempt from the
    // worker fan-out — a rare needle on a big repo swept everything on one
    // thread. It now parallelises above the same byte threshold; rows must be
    // identical to the inline path (files are pre-sorted, so the first `budget`
    // sorted rows are the same set the early-stop collects).
    process.env.VG_PARALLEL_MIN_BYTES = String(Number.MAX_SAFE_INTEGER);
    const inline = await scanCandidates(root, rels(), NEEDLE, { collectAll: false, budget: 10 });
    process.env.VG_PARALLEL_MIN_BYTES = '0';
    const parallel = await scanCandidates(root, rels(), NEEDLE, { collectAll: false, budget: 10 });
    expect(parallel.hits).toEqual(inline.hits);
    expect(parallel.truncated).toBe(true);
  });

  it('bounded worker path with spare budget returns the complete result untruncated', async () => {
    const out = await scanCandidates(root, rels(), NEEDLE, { collectAll: false, budget: 1000 });
    expect(out.hits.length).toBe(MATCHERS);
    expect(out.total).toBe(MATCHERS);
    expect(out.truncated).toBe(false);
  });
});
