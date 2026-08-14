import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { registerHcs } from './hcs.js';
import { resetHcsEngineCache } from '../engine/hcs-provider.js';
import { CliError, ExitCode } from '../util/exit.js';

/**
 * Incremental-extraction shim tests (per the HCS layering rule): prove the CLI
 * drives the engine's plan → extract-only-what-changed → merge loop correctly.
 * The engine is faked through VIBGRATE_HCS_PATH with a faithful miniature of
 * the incremental ABI (sha256 FileHashIndex, plan, merge) that also logs every
 * extraction request, so the tests can assert EXACTLY which files crossed the
 * seam. The real diff/merge logic is tested in the engine's Rust suite
 * (packages/vibgrate-hcs/wasm/src/incremental/tests.rs), never here.
 */

let tmp: string;
let savedEnv: Record<string, string | undefined>;
let savedExitCode: typeof process.exitCode;
const ENV = ['XDG_CACHE_HOME', 'VIBGRATE_NO_KERNEL', 'VIBGRATE_MODULE_REGISTRY', 'VIBGRATE_HCS_PATH'] as const;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  savedExitCode = process.exitCode;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-hcs-incr-'));
  process.env.XDG_CACHE_HOME = tmp; // no real module dir, no real consent state
  delete process.env.VIBGRATE_NO_KERNEL;
  delete process.env.VIBGRATE_MODULE_REGISTRY;
  delete process.env.VIBGRATE_HCS_PATH;
  resetHcsEngineCache();
});

afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  process.exitCode = savedExitCode;
  fs.rmSync(tmp, { recursive: true, force: true });
  resetHcsEngineCache();
  vi.restoreAllMocks();
});

/**
 * A fake engine implementing the incremental ABI faithfully in miniature:
 *  - extractFacts: one content-addressed fact per file (a changed file yields a
 *    different factId), logged to calls.ndjson so tests can assert exactly
 *    which files were (re-)extracted.
 *  - planExtract: sha256 the current files, diff against the previous stream's
 *    FileHashIndex preamble; "full" when the previous stream has no index.
 *  - mergeExtract: reuse previous fact lines byte-for-byte unless their file
 *    changed/was removed or their factId is superseded, splice in the fresh
 *    lines, and stamp a fresh FileHashIndex.
 */
const FAKE_INCREMENTAL_ENGINE = `
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (s) => createHash('sha256').update(s).digest('hex');

const hashFiles = (files) => {
  const out = {};
  for (const f of files) out[f.path] = f.hash ?? sha(f.content);
  return out;
};

const indexFromStream = (ndjson) => {
  for (const line of ndjson.split('\\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.factType === 'FileHashIndex') return obj.payload.files;
  }
  return null;
};

const plan = (previousNdjson, currentFilesJson) => {
  const current = hashFiles(JSON.parse(currentFilesJson));
  const previous = indexFromStream(previousNdjson);
  if (!previous) {
    return { mode: 'full', added: Object.keys(current).sort(), changed: [], removed: [], unchanged: 0 };
  }
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
    version: () => 'fake-incremental-hcs@1',
    supportedLanguages: () => 'rust,ruby',
    extractFacts: (req) => {
      const r = JSON.parse(req);
      appendFileSync(join(here, 'calls.ndjson'), JSON.stringify({ language: r.language, paths: r.files.map((f) => f.path) }) + '\\n');
      return r.files
        .map((f) => JSON.stringify({
          factId: 'hcs:Symbol:' + sha(f.path + '\\0' + f.content).slice(0, 12),
          m: r.language,
          payload: { filePath: f.path, bytes: f.content.length },
        }))
        .join('\\n');
    },
    renderDigest: () => '',
    buildMap: () => '',
    evaluateGate: () => '{"pass":true}',
    planExtract: (previousNdjson, currentFilesJson) => JSON.stringify(plan(previousNdjson, currentFilesJson)),
    mergeExtract: (previousNdjson, freshNdjson, currentFilesJson) => {
      const p = plan(previousNdjson, currentFilesJson);
      const stale = new Set([...p.changed, ...p.removed]);
      const freshLines = freshNdjson.split('\\n').filter((l) => l.trim());
      const freshIds = new Set(freshLines.map((l) => JSON.parse(l).factId));
      const stats = {
        mode: p.mode, reusedFacts: 0, freshFacts: freshLines.length, droppedFacts: 0,
        filesAdded: p.added.length, filesChanged: p.changed.length,
        filesRemoved: p.removed.length, filesUnchanged: p.unchanged,
      };
      const kept = [];
      for (const line of previousNdjson.split('\\n')) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj.factId) continue; // preamble (FileHashIndex)
        if (stale.has(obj.payload?.filePath) || freshIds.has(obj.factId)) { stats.droppedFacts++; continue; }
        stats.reusedFacts++;
        kept.push(line);
      }
      const indexLine = JSON.stringify({
        factType: 'FileHashIndex', indexVersion: '1.0', algo: 'sha256',
        payload: { files: hashFiles(JSON.parse(currentFilesJson)), dirs: {} },
      });
      const factLines = [...kept, ...freshLines];
      stats.factCount = factLines.length;
      stats.contentHash = 'sha256:' + sha([...factLines].sort().join('\\n'));
      return JSON.stringify({ ndjson: [indexLine, ...factLines].join('\\n') + '\\n', stats });
    },
  };
}`;

let engineDir: string;

function useFakeEngine(source: string = FAKE_INCREMENTAL_ENGINE): void {
  engineDir = fs.mkdtempSync(path.join(tmp, 'engine-'));
  fs.writeFileSync(path.join(engineDir, 'index.js'), source);
  process.env.VIBGRATE_HCS_PATH = engineDir;
  resetHcsEngineCache();
}

/** Extraction requests the engine received since the last call (drained). */
function drainExtractionCalls(): Array<{ language: string; paths: string[] }> {
  const log = path.join(engineDir, 'calls.ndjson');
  if (!fs.existsSync(log)) return [];
  const calls = fs
    .readFileSync(log, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { language: string; paths: string[] });
  fs.rmSync(log);
  return calls;
}

function extractedPaths(): string[] {
  return drainExtractionCalls()
    .flatMap((c) => c.paths)
    .sort();
}

/** Run `vg hcs <args…>` against a fresh program, capturing stdout. */
async function run(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerHcs(program);
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    chunks.push(String(s));
    return true;
  });
  try {
    await program.parseAsync(['hcs', ...args], { from: 'user' });
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

// ── Repo fixture helpers ──────────────────────────────────────────────────────

let repo: string;

/** (Re)write the repo to exactly these files. */
function setRepo(files: Record<string, string>): void {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

const INITIAL_REPO = {
  'src/alpha.rs': 'fn alpha() {}',
  'src/beta.rs': 'fn beta() {}',
  'src/deep/gamma.rs': 'fn gamma() {}',
  'lib/delta.rb': 'def delta; end',
};

beforeEach(() => {
  repo = path.join(tmp, 'repo');
});

const stateFile = () => path.join(tmp, 'state.ndjson');

/** One incremental run writing to the state file (the self-priming loop). */
async function incrementalRun(extra: string[] = []): Promise<string> {
  await run(['extract', repo, '--previous', stateFile(), '-o', stateFile(), ...extra]);
  return fs.readFileSync(stateFile(), 'utf-8');
}

/** Fact lines of a stream (preamble records like FileHashIndex excluded). */
function factLines(ndjson: string): string[] {
  return ndjson
    .split('\n')
    .filter((l) => l.trim())
    .filter((l) => (JSON.parse(l) as { factId?: string }).factId !== undefined);
}

function indexedFiles(ndjson: string): string[] {
  for (const l of ndjson.split('\n')) {
    if (!l.trim()) continue;
    const obj = JSON.parse(l) as { factType?: string; payload?: { files: Record<string, string> } };
    if (obj.factType === 'FileHashIndex') return Object.keys(obj.payload!.files).sort();
  }
  return [];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('vg hcs extract --previous — incremental loop correctness', () => {
  it('bootstraps with a full extraction when the previous stream is missing, stamping a FileHashIndex', async () => {
    useFakeEngine();
    setRepo(INITIAL_REPO);
    const out = await incrementalRun();
    // Every discoverable file was extracted, ruby before rust (sorted languages).
    expect(drainExtractionCalls()).toEqual([
      { language: 'ruby', paths: ['lib/delta.rb'] },
      { language: 'rust', paths: ['src/alpha.rs', 'src/beta.rs', 'src/deep/gamma.rs'] },
    ]);
    // The output stream is indexed (so the next run can be incremental) and
    // carries one fact per file.
    expect(indexedFiles(out)).toEqual(['lib/delta.rb', 'src/alpha.rs', 'src/beta.rs', 'src/deep/gamma.rs']);
    expect(factLines(out)).toHaveLength(4);
  });

  it('re-extracts nothing when nothing changed, reusing every fact byte-for-byte', async () => {
    useFakeEngine();
    setRepo(INITIAL_REPO);
    const first = await incrementalRun();
    drainExtractionCalls();

    const second = await incrementalRun();
    expect(drainExtractionCalls()).toEqual([]); // zero files crossed the seam
    expect(factLines(second)).toEqual(factLines(first)); // byte-identical reuse
    expect(second).toBe(first); // whole stream (index included) is stable
  });

  it('re-extracts only a changed file and replaces exactly its facts', async () => {
    useFakeEngine();
    setRepo(INITIAL_REPO);
    const first = await incrementalRun();
    drainExtractionCalls();

    setRepo({ ...INITIAL_REPO, 'src/beta.rs': 'fn beta() { changed(); }' });
    const second = await incrementalRun();

    expect(extractedPaths()).toEqual(['src/beta.rs']);
    const firstByFile = new Map(factLines(first).map((l) => [(JSON.parse(l) as { payload: { filePath: string } }).payload.filePath, l]));
    const secondByFile = new Map(factLines(second).map((l) => [(JSON.parse(l) as { payload: { filePath: string } }).payload.filePath, l]));
    // Unchanged files: previous fact lines carried over byte-for-byte.
    for (const p of ['src/alpha.rs', 'src/deep/gamma.rs', 'lib/delta.rb']) {
      expect(secondByFile.get(p)).toBe(firstByFile.get(p));
    }
    // The changed file got a fresh (different) fact.
    expect(secondByFile.get('src/beta.rs')).toBeDefined();
    expect(secondByFile.get('src/beta.rs')).not.toBe(firstByFile.get('src/beta.rs'));
    expect(factLines(second)).toHaveLength(4);
  });

  it('extracts only an added file and appends its facts', async () => {
    useFakeEngine();
    setRepo(INITIAL_REPO);
    await incrementalRun();
    drainExtractionCalls();

    setRepo({ ...INITIAL_REPO, 'src/deep/epsilon.rs': 'fn epsilon() {}' });
    const out = await incrementalRun();

    expect(extractedPaths()).toEqual(['src/deep/epsilon.rs']);
    expect(factLines(out)).toHaveLength(5);
    expect(indexedFiles(out)).toContain('src/deep/epsilon.rs');
  });

  it('drops the facts and index entry of a removed file without extracting anything', async () => {
    useFakeEngine();
    setRepo(INITIAL_REPO);
    await incrementalRun();
    drainExtractionCalls();

    const { 'lib/delta.rb': _gone, ...withoutDelta } = INITIAL_REPO;
    setRepo(withoutDelta);
    const out = await incrementalRun();

    expect(drainExtractionCalls()).toEqual([]);
    expect(factLines(out)).toHaveLength(3);
    expect(out).not.toContain('lib/delta.rb');
    expect(indexedFiles(out)).toEqual(['src/alpha.rs', 'src/beta.rs', 'src/deep/gamma.rs']);
  });

  it('converges an emptied repo to an empty fact set instead of keeping stale facts', async () => {
    useFakeEngine();
    setRepo(INITIAL_REPO);
    await incrementalRun();
    drainExtractionCalls();

    setRepo({}); // every extractable source deleted
    const out = await incrementalRun();
    expect(drainExtractionCalls()).toEqual([]);
    expect(factLines(out)).toHaveLength(0);
    expect(indexedFiles(out)).toEqual([]);
  });
});

describe('vg hcs extract --previous — accuracy against a from-scratch extraction', () => {
  it('a batch of add + change + remove converges to exactly the full-extraction result', async () => {
    useFakeEngine();
    setRepo(INITIAL_REPO);
    await incrementalRun();
    drainExtractionCalls();

    // Evolve the repo: change one file, add one, remove one.
    const { 'src/alpha.rs': _removed, ...rest } = INITIAL_REPO;
    const evolved = {
      ...rest,
      'src/beta.rs': 'fn beta() { v2(); }',
      'lib/zeta.rb': 'def zeta; end',
    };
    setRepo(evolved);
    const incremental = await incrementalRun();
    // Only the delta crossed the seam…
    expect(extractedPaths()).toEqual(['lib/zeta.rb', 'src/beta.rs']);

    // …yet the merged stream equals a from-scratch extraction of the same
    // tree, fact-for-fact and index-for-index (order excepted).
    const fullFile = path.join(tmp, 'full.ndjson');
    await run(['extract', repo, '--previous', path.join(tmp, 'no-such-previous.ndjson'), '-o', fullFile]);
    const full = fs.readFileSync(fullFile, 'utf-8');
    expect(extractedPaths()).toEqual(['lib/delta.rb', 'lib/zeta.rb', 'src/beta.rs', 'src/deep/gamma.rs']);

    expect([...factLines(incremental)].sort()).toEqual([...factLines(full)].sort());
    expect(indexedFiles(incremental)).toEqual(indexedFiles(full));
  });

  it('successive incremental runs stay deterministic (same tree ⇒ byte-identical stream)', async () => {
    useFakeEngine();
    setRepo(INITIAL_REPO);
    await incrementalRun();
    setRepo({ ...INITIAL_REPO, 'src/alpha.rs': 'fn alpha() { v2(); }' });
    const afterEdit = await incrementalRun();
    const again = await incrementalRun(); // no-op run on the edited tree
    expect(again).toBe(afterEdit);
  });

  it('honors --language and test-file exclusion in the incremental file set', async () => {
    useFakeEngine();
    setRepo({
      ...INITIAL_REPO,
      'src/alpha.test.rs': 'fn t() {}', // excluded by default
    });
    const out = await incrementalRun(['--language', 'rust']);
    expect(extractedPaths()).toEqual(['src/alpha.rs', 'src/beta.rs', 'src/deep/gamma.rs']);
    expect(indexedFiles(out)).toEqual(['src/alpha.rs', 'src/beta.rs', 'src/deep/gamma.rs']);
    expect(out).not.toContain('lib/delta.rb');
    expect(out).not.toContain('alpha.test.rs');
  });
});

describe('vg hcs extract — incremental is the default for -o runs', () => {
  it('a repeated `-o` run is incremental without any --previous flag', async () => {
    useFakeEngine();
    setRepo(INITIAL_REPO);
    await run(['extract', repo, '-o', stateFile()]);
    const first = fs.readFileSync(stateFile(), 'utf-8');
    expect(drainExtractionCalls()).toHaveLength(2); // bootstrap: both language buckets
    expect(indexedFiles(first)).toHaveLength(4); // index stamped for the next run

    await run(['extract', repo, '-o', stateFile()]);
    expect(drainExtractionCalls()).toEqual([]); // no-op re-run: nothing crossed the seam
    expect(fs.readFileSync(stateFile(), 'utf-8')).toBe(first);

    setRepo({ ...INITIAL_REPO, 'src/beta.rs': 'fn beta() { v2(); }' });
    await run(['extract', repo, '-o', stateFile()]);
    expect(extractedPaths()).toEqual(['src/beta.rs']); // only the edit re-extracted
  });

  it('--full re-extracts everything but keeps the loop primed (index stamped, output identical)', async () => {
    useFakeEngine();
    setRepo(INITIAL_REPO);
    await run(['extract', repo, '-o', stateFile()]);
    const first = fs.readFileSync(stateFile(), 'utf-8');
    drainExtractionCalls();

    await run(['extract', repo, '-o', stateFile(), '--full']);
    expect(extractedPaths()).toEqual(['lib/delta.rb', 'src/alpha.rs', 'src/beta.rs', 'src/deep/gamma.rs']);
    const full = fs.readFileSync(stateFile(), 'utf-8');
    expect(full).toBe(first); // deterministic: full re-extract converges to the same stream

    await run(['extract', repo, '-o', stateFile()]);
    expect(drainExtractionCalls()).toEqual([]); // still incremental afterwards
  });

  it('stdout extraction (no -o, no --previous) stays a plain unindexed full extraction', async () => {
    useFakeEngine();
    setRepo(INITIAL_REPO);
    const out = await run(['extract', repo]);
    expect(drainExtractionCalls()).toHaveLength(2);
    expect(out).not.toContain('FileHashIndex');
    expect(factLines(out)).toHaveLength(4);
  });

  it('degrades to a plain full extraction on an engine without incremental support (no error without --previous)', async () => {
    useFakeEngine(`export function createHcsEngine() {
      return {
        version: () => 'old@0',
        supportedLanguages: () => 'rust',
        extractFacts: (req) => JSON.parse(req).files.map((f) => JSON.stringify({ factId: 'f:' + f.path, m: 'rust', payload: { filePath: f.path } })).join('\\n'),
        renderDigest: () => '',
        buildMap: () => '',
        evaluateGate: () => '{"pass":true}',
      };
    }`);
    setRepo({ 'src/alpha.rs': 'fn alpha() {}' });
    fs.writeFileSync(stateFile(), 'stale previous content\n');
    await run(['extract', repo, '-o', stateFile()]);
    const out = fs.readFileSync(stateFile(), 'utf-8');
    expect(out).not.toContain('FileHashIndex');
    expect(out.trim()).toBe('{"factId":"f:src/alpha.rs","m":"rust","payload":{"filePath":"src/alpha.rs"}}');
  });
});

describe('vg hcs extract --previous — engine capability contract', () => {
  it('fails loudly (ENGINE_UNAVAILABLE) when the engine lacks incremental support', async () => {
    useFakeEngine(`export function createHcsEngine() {
      return {
        version: () => 'old@0',
        supportedLanguages: () => 'rust',
        extractFacts: () => '',
        renderDigest: () => '',
        buildMap: () => '',
        evaluateGate: () => '{"pass":true}',
      };
    }`);
    setRepo(INITIAL_REPO);
    let caught: unknown;
    try {
      await run(['extract', repo, '--previous', stateFile()]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe(ExitCode.ENGINE_UNAVAILABLE);
    expect((caught as CliError).message).toMatch(/incremental/);
    expect((caught as CliError).message).toMatch(/--force/);
  });

  it('plain extract (no --previous) still works against an engine without incremental support', async () => {
    useFakeEngine(`export function createHcsEngine() {
      return {
        version: () => 'old@0',
        supportedLanguages: () => 'rust',
        extractFacts: (req) => JSON.parse(req).files.map((f) => JSON.stringify({ factId: 'f:' + f.path, m: 'rust', payload: { filePath: f.path } })).join('\\n'),
        renderDigest: () => '',
        buildMap: () => '',
        evaluateGate: () => '{"pass":true}',
      };
    }`);
    setRepo({ 'src/alpha.rs': 'fn alpha() {}' });
    const out = await run(['extract', repo]);
    expect(out.trim()).toBe('{"factId":"f:src/alpha.rs","m":"rust","payload":{"filePath":"src/alpha.rs"}}');
  });
});
