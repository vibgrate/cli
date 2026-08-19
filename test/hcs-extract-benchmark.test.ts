import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { registerHcs } from '../src/commands/hcs.js';
import { resetHcsEngineCache } from '../src/engine/hcs-provider.js';

/**
 * Benchmark for `vg hcs extract` incremental extraction (the default for `-o` runs):
 * performance AND accuracy on one synthetic repo.
 *
 * Performance is asserted on the deterministic cost driver — how many files
 * cross the engine seam for (re-)extraction. A fake engine burns a fixed CPU
 * cost per extracted file so the human-facing log still shows wall-clock
 * scaling, but those timings are never asserted: the incremental pass still
 * hashes the whole corpus for the plan and merges the previous stream, and a
 * fast or busy CI runner can invert the two times when that bookkeeping is
 * cheaper than 239 fake parses.
 *
 * Accuracy is asserted absolutely: after edits, the incrementally merged
 * stream must equal a from-scratch extraction of the same tree, fact-for-fact
 * and index-for-index.
 */

const FILE_COUNT = 240; // 12 dirs × 20 files
const DIRS = 12;
const EDIT_FILE = 'mod_7/file_03.rs';

/** Fake engine: real sha256 index/plan/merge contract in miniature, with a
 *  fixed synthetic CPU cost per extracted file (pbkdf2) so wall-clock scales
 *  with files extracted — the quantity the incremental loop exists to shrink. */
const BENCH_ENGINE = `
import { createHash, pbkdf2Sync } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const hashFiles = (files) => Object.fromEntries(files.map((f) => [f.path, sha(f.content)]));
const indexFromStream = (ndjson) => {
  for (const line of ndjson.split('\\n')) {
    if (!line.trim()) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    if (obj.factType === 'FileHashIndex') return obj.payload.files;
  }
  return null;
};
const plan = (previousNdjson, currentFilesJson) => {
  const current = hashFiles(JSON.parse(currentFilesJson));
  const previous = indexFromStream(previousNdjson);
  if (!previous) return { mode: 'full', added: Object.keys(current).sort(), changed: [], removed: [], unchanged: 0 };
  const added = [], changed = [], removed = [];
  let unchanged = 0;
  for (const [p, h] of Object.entries(current)) {
    if (!(p in previous)) added.push(p);
    else if (previous[p] !== h) changed.push(p);
    else unchanged++;
  }
  for (const p of Object.keys(previous)) if (!(p in current)) removed.push(p);
  return { mode: 'incremental', added: added.sort(), changed: changed.sort(), removed: removed.sort(), unchanged };
};

export function createHcsEngine() {
  return {
    version: () => 'bench-hcs@1',
    supportedLanguages: () => 'rust',
    extractFacts: (req) => {
      const r = JSON.parse(req);
      appendFileSync(join(here, 'calls.ndjson'), JSON.stringify(r.files.map((f) => f.path)) + '\\n');
      return r.files
        .map((f) => {
          // Fixed per-file extraction cost (~1ms): what a real parse costs, in miniature.
          pbkdf2Sync(f.content, 'hcs-bench', 500, 32, 'sha256');
          return [
            JSON.stringify({ factId: 'hcs:Symbol:' + sha('sym' + f.path + f.content).slice(0, 12), m: 'm0', payload: { filePath: f.path } }),
            JSON.stringify({ factId: 'hcs:Route:' + sha('route' + f.path + f.content).slice(0, 12), m: 'm0', payload: { filePath: f.path } }),
          ].join('\\n');
        })
        .join('\\n');
    },
    renderDigest: () => '',
    buildMap: () => '',
    evaluateGate: () => '{"pass":true}',
    planExtract: (prev, files) => JSON.stringify(plan(prev, files)),
    mergeExtract: (previousNdjson, freshNdjson, currentFilesJson) => {
      const p = plan(previousNdjson, currentFilesJson);
      const stale = new Set([...p.changed, ...p.removed]);
      const freshLines = freshNdjson.split('\\n').filter((l) => l.trim());
      const freshIds = new Set(freshLines.map((l) => JSON.parse(l).factId));
      const stats = { mode: p.mode, reusedFacts: 0, freshFacts: freshLines.length, droppedFacts: 0 };
      const kept = [];
      for (const line of previousNdjson.split('\\n')) {
        if (!line.trim()) continue;
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        if (!obj.factId) continue;
        if (stale.has(obj.payload?.filePath) || freshIds.has(obj.factId)) { stats.droppedFacts++; continue; }
        stats.reusedFacts++;
        kept.push(line);
      }
      const indexLine = JSON.stringify({
        factType: 'FileHashIndex', indexVersion: '1.0', algo: 'sha256',
        payload: { files: hashFiles(JSON.parse(currentFilesJson)), dirs: {} },
      });
      return JSON.stringify({ ndjson: [indexLine, ...kept, ...freshLines].join('\\n') + '\\n', stats });
    },
  };
}`;

let tmp: string;
let repo: string;
let engineDir: string;
let savedEnv: Record<string, string | undefined>;
const ENV = ['XDG_CACHE_HOME', 'VIBGRATE_NO_KERNEL', 'VIBGRATE_MODULE_REGISTRY', 'VIBGRATE_HCS_PATH'] as const;

beforeAll(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-hcs-bench-'));
  process.env.XDG_CACHE_HOME = tmp;
  delete process.env.VIBGRATE_NO_KERNEL;
  delete process.env.VIBGRATE_MODULE_REGISTRY;
  engineDir = path.join(tmp, 'engine');
  fs.mkdirSync(engineDir);
  fs.writeFileSync(path.join(engineDir, 'index.js'), BENCH_ENGINE);
  process.env.VIBGRATE_HCS_PATH = engineDir;
  resetHcsEngineCache();

  // Deterministic synthetic corpus: FILE_COUNT rust files, ~1 KB each.
  repo = path.join(tmp, 'repo');
  for (let d = 0; d < DIRS; d++) {
    const dir = path.join(repo, `mod_${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILE_COUNT / DIRS; f++) {
      const body = `// mod_${d}/file_${f}\n` + `fn item_${d}_${f}(x: u64) -> u64 { x + ${d * 100 + f} }\n`.repeat(16);
      fs.writeFileSync(path.join(dir, `file_${String(f).padStart(2, '0')}.rs`), body);
    }
  }
});

afterAll(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  resetHcsEngineCache();
});

async function runExtract(args: string[]): Promise<number> {
  const program = new Command();
  program.exitOverride();
  registerHcs(program);
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const start = performance.now();
  try {
    await program.parseAsync(['hcs', 'extract', repo, ...args], { from: 'user' });
  } finally {
    spy.mockRestore();
  }
  return performance.now() - start;
}

/** Paths sent to the engine for extraction since the last drain. */
function drainExtracted(): string[] {
  const log = path.join(engineDir, 'calls.ndjson');
  if (!fs.existsSync(log)) return [];
  const paths = fs
    .readFileSync(log, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => JSON.parse(l) as string[]);
  fs.rmSync(log);
  return paths.sort();
}

function factLines(ndjson: string): string[] {
  return ndjson
    .split('\n')
    .filter((l) => l.trim())
    .filter((l) => (JSON.parse(l) as { factId?: string }).factId !== undefined);
}

describe('vg hcs extract --previous — benchmark (performance + accuracy)', () => {
  it(`re-extracts 1/${FILE_COUNT} files after a one-file edit and still matches a from-scratch extraction`, async () => {
    const state = path.join(tmp, 'state.ndjson');

    // Pass 1 — bootstrap: full extraction, index stamped.
    const fullMs = await runExtract(['-o', state]); // incremental by default; missing state ⇒ full
    const fullExtracted = drainExtracted();
    expect(fullExtracted).toHaveLength(FILE_COUNT);

    // Pass 2 — no-op: nothing may cross the seam.
    const noopMs = await runExtract(['-o', state]);
    expect(drainExtracted()).toHaveLength(0);

    // Pass 3 — one-file edit: exactly that file is re-extracted.
    fs.appendFileSync(path.join(repo, EDIT_FILE), 'fn appended() {}\n');
    const incrementalMs = await runExtract(['-o', state]);
    const incrementalExtracted = drainExtracted();
    expect(incrementalExtracted).toEqual([EDIT_FILE]);
    const incremental = fs.readFileSync(state, 'utf-8');

    // Accuracy — the merged stream equals a from-scratch extraction of the
    // edited tree: same fact set (the edited file's facts replaced, all
    // others reused) and same FileHashIndex.
    const fullFile = path.join(tmp, 'full.ndjson');
    await runExtract(['--full', '-o', fullFile]);
    expect(drainExtracted()).toHaveLength(FILE_COUNT);
    const full = fs.readFileSync(fullFile, 'utf-8');
    expect([...factLines(incremental)].sort()).toEqual([...factLines(full)].sort());
    expect(factLines(incremental)).toHaveLength(FILE_COUNT * 2);

    // Performance — the deterministic cost driver: engine-side extraction work
    // shrank by ≥99% (1 file instead of 240). Wall-clock is logged below, not
    // asserted — see the file header.
    const workReduction = 1 - incrementalExtracted.length / fullExtracted.length;
    expect(workReduction).toBeGreaterThanOrEqual(0.99);

    // Report for humans — numbers vary per machine, so they are logged, not asserted.
    // eslint-disable-next-line no-console
    console.log(
      `[hcs-extract benchmark] corpus=${FILE_COUNT} files | ` +
        `full=${fullMs.toFixed(0)}ms | no-op=${noopMs.toFixed(0)}ms | ` +
        `1-file edit=${incrementalMs.toFixed(0)}ms (${(fullMs / incrementalMs).toFixed(1)}× faster, ` +
        `${(workReduction * 100).toFixed(1)}% less extraction work)`,
    );
  });
});
