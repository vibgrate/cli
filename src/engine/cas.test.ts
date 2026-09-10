import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CasStore,
  MANIFEST_SCHEMA,
  casRepositoryDir,
  casRepositoryId,
  casRoot,
  clearCasRepositoryIdCache,
  loadRefManifest,
  openParseCas,
  openVectorCas,
  writeRefManifest,
} from './cas.js';
import { loadCache } from './cache.js';
import { repositoryIdFromRoot } from '../runtime/paths.js';
import type { FileParse } from './types.js';

/**
 * The content-addressed store is a pure performance layer: an object is a
 * function of its content key and nothing else, so it may be served under any
 * path, on any branch, in any worktree — and never under the wrong tool
 * version, grammar set, or language.
 */

const KEY = { toolVersion: '1.2.3', grammars: 'g1+t1' };
const HASH = 'a'.repeat(64);

function parseOf(rel: string, hash = HASH, lang = 'ts'): FileParse {
  return {
    rel,
    lang,
    hash,
    bytes: 10,
    defs: [{ kind: 'function', name: 'f', qualifiedName: 'f', startLine: 1, endLine: 1, startByte: 0, endByte: 9 }],
    calls: [],
    imports: [],
    heritage: [],
    typeRefs: [],
    guards: [],
  };
}

let cacheDir: string;
let root: string;
let prevCache: string | undefined;
let prevCas: string | undefined;

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cas-cache-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cas-root-'));
  prevCache = process.env.VIBGRATE_CACHE_DIR;
  prevCas = process.env.VIBGRATE_CAS;
  process.env.VIBGRATE_CACHE_DIR = cacheDir;
  delete process.env.VIBGRATE_CAS;
  clearCasRepositoryIdCache();
});

afterEach(() => {
  if (prevCache === undefined) delete process.env.VIBGRATE_CACHE_DIR;
  else process.env.VIBGRATE_CACHE_DIR = prevCache;
  if (prevCas === undefined) delete process.env.VIBGRATE_CAS;
  else process.env.VIBGRATE_CAS = prevCas;
  clearCasRepositoryIdCache();
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

describe('store location', () => {
  it('lives in the machine cache tree, never under the repository', () => {
    expect(casRoot()).toBe(path.join(cacheDir, 'cas'));
    const dir = casRepositoryDir(root);
    expect(dir.startsWith(path.join(cacheDir, 'cas'))).toBe(true);
    expect(path.relative(root, dir).startsWith('..')).toBe(true);
  });

  it('is shared by every worktree of one clone, and path-derived without git', () => {
    // No git → the ordinary path-derived repository id.
    expect(casRepositoryId(root)).toBe(repositoryIdFromRoot(root));
    clearCasRepositoryIdCache();

    git(root, 'init', '-q', '-b', 'main');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
    const wt = path.join(os.tmpdir(), `vg-cas-wt-${process.pid}-${Date.now()}`);
    try {
      git(root, 'worktree', 'add', '-q', '-b', 'side', wt);
      const a = casRepositoryId(root);
      const b = casRepositoryId(wt);
      expect(a).toBe(b);
      expect(a).not.toBe(repositoryIdFromRoot(root)); // keyed on the common git dir, not the path
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe('parse objects', () => {
  it('serves a stored parse under a different path (rename, sibling branch, worktree)', () => {
    const store = openParseCas(root, { parseKey: KEY })!;
    store.putParse(parseOf('src/a.ts'));
    expect(store.stats.parseWrites).toBe(1);

    const hit = store.getParse(HASH, 'ts', 'lib/renamed.ts');
    expect(hit).toBeDefined();
    expect(hit!.rel).toBe('lib/renamed.ts'); // retagged — the one path-bearing field
    expect(hit!.defs).toEqual(parseOf('x').defs);
    expect(store.stats.parseHits).toBe(1);
  });

  it('is keyed by language as well as bytes', () => {
    const store = openParseCas(root, { parseKey: KEY })!;
    store.putParse(parseOf('a.ts', HASH, 'ts'));
    expect(store.getParse(HASH, 'js', 'a.js')).toBeUndefined();
  });

  it('ignores an object from another tool version or grammar set', () => {
    openParseCas(root, { parseKey: KEY })!.putParse(parseOf('a.ts'));
    const newer = openParseCas(root, { parseKey: { ...KEY, toolVersion: '1.2.4' } })!;
    expect(newer.getParse(HASH, 'ts', 'a.ts')).toBeUndefined();
    const otherGrammars = openParseCas(root, { parseKey: { ...KEY, grammars: 'g2+t1' } })!;
    expect(otherGrammars.getParse(HASH, 'ts', 'a.ts')).toBeUndefined();
    expect(newer.stats.parseMisses).toBe(1);
  });

  it('--no-cache bypasses reads but still writes (a verify rebuild can prove identity)', () => {
    const cold = openParseCas(root, { parseKey: KEY, noReads: true })!;
    cold.putParse(parseOf('a.ts'));
    expect(cold.getParse(HASH, 'ts', 'a.ts')).toBeUndefined();
    expect(openParseCas(root, { parseKey: KEY })!.getParse(HASH, 'ts', 'a.ts')).toBeDefined();
  });

  it('a torn or foreign object is a miss, never a throw', () => {
    const store = openParseCas(root, { parseKey: KEY })!;
    const file = store.parsePath(HASH, 'ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from([0x01, 0x02]));
    expect(store.getParse(HASH, 'ts', 'a.ts')).toBeUndefined();
  });

  it('the path-keyed parse cache falls through to the store by content', () => {
    const store = openParseCas(root, { parseKey: KEY })!;
    const first = loadCache(root, { ...KEY, cas: store });
    first.set('src/a.ts', parseOf('src/a.ts'));
    first.save();

    // A second checkout: empty path cache, same store.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cas-root2-'));
    try {
      const second = loadCache(other, { ...KEY, cas: store });
      expect(second.get('src/moved.ts', HASH)).toBeUndefined(); // no language → no content lookup
      const hit = second.get('src/moved.ts', HASH, 'ts');
      expect(hit?.rel).toBe('src/moved.ts');
      // The hint is warmed so the next build takes the path fast path.
      expect(second.get('src/moved.ts', HASH)).toBeDefined();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('vector objects', () => {
  const TEXT_HASH = 'b'.repeat(64);

  it('round-trips as Float32 and is keyed by model and text hash', () => {
    const store = openVectorCas(root)!;
    store.putVector('bge-small-en-v1.5', TEXT_HASH, [0.5, -1, 2]);
    expect(store.stats.vectorWrites).toBe(1);
    const back = store.getVector('bge-small-en-v1.5', TEXT_HASH);
    expect(back).toBeDefined();
    expect(back![0]).toBeCloseTo(0.5, 6);
    expect(back![1]).toBeCloseTo(-1, 6);
    expect(back![2]).toBeCloseTo(2, 6);
    expect(store.getVector('all-MiniLM-L6-v2', TEXT_HASH)).toBeUndefined(); // another model: its own space
    expect(store.getVector('bge-small-en-v1.5', 'c'.repeat(64))).toBeUndefined();
    // A header beside the model's vectors records what they are.
    const header = JSON.parse(fs.readFileSync(path.join(store.vectorDir('bge-small-en-v1.5'), 'header.json'), 'utf8'));
    expect(header).toMatchObject({ modelId: 'bge-small-en-v1.5', dims: 3, textVersion: 2 });
  });

  it('a model id with a slash is a single path segment', () => {
    const store = openVectorCas(root)!;
    expect(path.basename(store.vectorDir('BAAI/bge-small-en-v1.5'))).toBe('BAAI__bge-small-en-v1.5');
  });

  it('a torn vector is a miss', () => {
    const store = openVectorCas(root)!;
    const file = store.vectorPath('m', TEXT_HASH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from([1, 2, 3]));
    expect(store.getVector('m', TEXT_HASH)).toBeUndefined();
    expect(store.stats.vectorMisses).toBe(1);
  });

  it('an existing object is never rewritten (content-addressed: same key, same bytes)', () => {
    const store = openVectorCas(root)!;
    store.putVector('m', TEXT_HASH, [1, 2]);
    store.putVector('m', TEXT_HASH, [9, 9]);
    expect(store.getVector('m', TEXT_HASH)).toEqual([1, 2]);
    expect(store.stats.vectorWrites).toBe(1);
  });
});

describe('manifests', () => {
  it('are written sorted by path and read back by ref', () => {
    const store = openVectorCas(root)!;
    const file = writeRefManifest(store, {
      schema: MANIFEST_SCHEMA,
      repoId: 'r',
      ref: 'feature/x',
      commit: 'c'.repeat(40),
      root,
      engine: '1.2.3',
      corpusHash: 'd'.repeat(64),
      files: [
        { path: 'src/b.ts', addr: `b3:${HASH}`, size: 10 },
        { path: 'src/a.ts', addr: `b3:${'e'.repeat(64)}`, size: 5 },
      ],
    });
    expect(file).toBe(path.join(casRepositoryDir(root), 'manifests', 'branch-feature__x.manifest.json'));
    const back = loadRefManifest(root, 'feature/x');
    expect(back?.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(back?.commit).toBe('c'.repeat(40));
    expect(loadRefManifest(root, 'main')).toBeNull();
  });
});

describe('VIBGRATE_CAS=0', () => {
  it('disables the store entirely', () => {
    process.env.VIBGRATE_CAS = '0';
    expect(openParseCas(root, { parseKey: KEY })).toBeNull();
    expect(openVectorCas(root)).toBeNull();
    expect(loadRefManifest(root, 'main')).toBeNull();
    expect(fs.existsSync(path.join(cacheDir, 'cas'))).toBe(false);
  });

  it('a store with no reads and no key still constructs safely', () => {
    const store = new CasStore(path.join(cacheDir, 'x'), { readsEnabled: false });
    expect(store.getParse(HASH, 'ts', 'a.ts')).toBeUndefined();
    store.putParse(parseOf('a.ts')); // no parse key → no-op
    expect(store.stats.parseWrites).toBe(0);
  });
});
