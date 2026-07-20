import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { searchSymbols, parseRgFileList, clearListingCache, type TextHit } from './search.js';
import type { GraphNode, VgGraph } from '../schema.js';

/**
 * `search_symbols` literal-string support: a whitespace/phrase query must run a
 * *complete* literal sweep and never let loosely-token-matching symbols starve
 * the string hits. Regression cover for the "you say" trace — the graph ranked
 * the `*SayCard` components first, the literal scan got the leftover (zero)
 * budget, and the agent abandoned vg for grep.
 */

function component(id: string, name: string, file: string): GraphNode {
  return {
    id,
    kind: 'component',
    name,
    qualifiedName: `${file}:${name}`,
    file,
    span: { start: 1, end: 10 },
    lang: 'typescript',
    importance: 0.5,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
    area: 0,
    isHub: false,
    tested: false,
  };
}

// A graph whose only name matches for the phrase "you say" are the `Say`
// components — the different-meaning symbols that used to crowd out the strings.
function makeGraph(): VgGraph {
  const nodes = [
    component('n_bill', 'BillSayCard', 'src/BillSayCard.tsx'),
    component('n_quick', 'QuickSayCard', 'src/QuickSayCard.tsx'),
    component('n_member', 'MemberSayCard', 'src/MemberSayCard.tsx'),
  ];
  return {
    schemaVersion: 'vg-graph/1.0',
    generatedAt: '2026-01-01T00:00:00Z',
    provenance: { tool: 'vg', version: 'test', grammars: {}, resolver: ['heuristic'], deep: false, corpusHash: 'h' },
    meta: {
      root: '.',
      languages: ['typescript'],
      counts: { nodes: 3, edges: 0, areas: 1, tests: 0, untested: 3 },
      cluster: 'louvain',
      edgeKinds: [],
    },
    nodes,
    edges: [],
    areas: [{ id: 0, label: 'core', size: 3, members: ['n_bill', 'n_member', 'n_quick'], cohesion: 0.8, externalEdges: 0 }],
  };
}

const textHits = (r: { matches: unknown[] }): TextHit[] => r.matches.filter((m): m is TextHit => (m as TextHit).kind === 'text');

let root: string;
// 10 literal occurrences of the strapline across two files (mixed case).
const TOTAL_LITERAL = 10;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-search-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(
    path.join(root, 'src', 'Footer.tsx'),
    ['export const tagline = "We watch. You say.";', '// you say it once', '<p>you say</p>', 'const x = "you say";'].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'docs', 'brand.md'),
    ['# You Say', 'you say', 'You say', 'YOU SAY', 'we watch. you say.', 'trailing you say line'].join('\n'),
  );
  // A literal USE of a known symbol (not its definition) — exists to prove that
  // an exact symbol lookup no longer pays a literal sweep to find lines like it.
  fs.writeFileSync(path.join(root, 'src', 'usage.ts'), ['import { BillSayCard } from "./BillSayCard";', 'render(BillSayCard({}));'].join('\n'));
  // Binary-by-extension files carrying the needle as text: the listing-time
  // extension skip must exclude them from the corpus (previously they were read
  // in full and, lacking a NUL byte, even matched).
  fs.writeFileSync(path.join(root, 'lib.dll'), 'you say — inside a dll\n');
  // Generated .NET intermediate output: ignored as a directory.
  fs.mkdirSync(path.join(root, 'obj'));
  fs.writeFileSync(path.join(root, 'obj', 'gen.cs'), '// you say — generated\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('searchSymbols — literal phrase sweep', () => {
  it('does not let symbol matches starve the literal scan (the "you say" regression)', async () => {
    const r = await searchSymbols(makeGraph(), root, 'you say', 8);
    // The literal string hits survive alongside the (capped) symbol matches —
    // before the fix, spare budget was 0 and no text hit appeared.
    expect(textHits(r).length).toBeGreaterThan(0);
    // Symbols are demoted to secondary context, capped to a fraction of the budget.
    const symbolCount = r.matches.length - textHits(r).length;
    expect(symbolCount).toBeLessThanOrEqual(2); // floor(8/3)
  });

  it('reports the true total so a sweep can be trusted as complete', async () => {
    const r = await searchSymbols(makeGraph(), root, 'you say', 50);
    expect(r.totalTextMatches).toBe(TOTAL_LITERAL);
    // With a generous limit every occurrence is shown and nothing is left over.
    expect(textHits(r).length).toBe(TOTAL_LITERAL);
    expect(r.moreAvailable).toBe(false);
    expect(r.hint).toBeUndefined();
  });

  it('flags an incomplete sweep honestly instead of silently truncating', async () => {
    const r = await searchSymbols(makeGraph(), root, 'you say', 8);
    expect(r.totalTextMatches).toBe(TOTAL_LITERAL);
    expect(textHits(r).length).toBeLessThan(TOTAL_LITERAL);
    expect(r.moreAvailable).toBe(true);
    expect(r.hint).toMatch(/of 10 literal matches/);
  });

  it('is case-insensitive across files and reports POSIX repo-relative paths on every platform', async () => {
    const r = await searchSymbols(makeGraph(), root, 'you say', 50);
    const files = new Set(textHits(r).map((h) => h.file));
    // Forward slashes always — matching the graph's own path style, so the
    // symbol-hit/text-hit dedup key agrees across passes on Windows too.
    expect(files.has('src/Footer.tsx')).toBe(true);
    expect(files.has('docs/brand.md')).toBe(true);
    for (const f of files) expect(f).not.toContain('\\');
  });

  it('excludes binary-extension files and generated dirs from the corpus', async () => {
    const r = await searchSymbols(makeGraph(), root, 'you say', 50);
    // lib.dll and obj/gen.cs both contain the needle as plain text; neither may
    // be scanned, so the totals stay pinned at the 10 real occurrences.
    expect(r.totalTextMatches).toBe(TOTAL_LITERAL);
    const files = new Set(textHits(r).map((h) => h.file));
    expect(files.has('lib.dll')).toBe(false);
    expect(files.has('obj/gen.cs')).toBe(false);
  });
});

describe('searchSymbols — single-name lookups are unchanged', () => {
  it('resolves a symbol name symbol-first with no literal-sweep total', async () => {
    const r = await searchSymbols(makeGraph(), root, 'BillSayCard', 8);
    expect(r.matches[0]).toMatchObject({ kind: 'component', name: 'src/BillSayCard.tsx:BillSayCard' });
    // No whitespace → not a literal sweep → no completeness total advertised.
    expect(r.totalTextMatches).toBeUndefined();
  });

  it('empty query asks for input', async () => {
    const r = await searchSymbols(makeGraph(), root, '   ', 8);
    expect(r.matches).toHaveLength(0);
    expect(r.hint).toBe('query is required');
  });

  it('a phrase that matches nothing pivots to query_graph', async () => {
    const r = await searchSymbols(makeGraph(), root, 'zzz qqq nomatch', 8);
    expect(r.matches).toHaveLength(0);
    expect(r.hint).toMatch(/query_graph/);
  });
});

describe('searchSymbols — exact symbol match skips the literal sweep', () => {
  it('an exact name resolves from the graph alone, with no text rows padded in', async () => {
    // src/usage.ts literally contains "BillSayCard(" — before the short-circuit,
    // the spare budget triggered a full-tree scan and returned those lines too.
    const r = await searchSymbols(makeGraph(), root, 'BillSayCard', 8);
    expect(r.matches[0]).toMatchObject({ kind: 'component', name: 'src/BillSayCard.tsx:BillSayCard' });
    expect(textHits(r)).toHaveLength(0);
  });

  it('case-insensitive exact names short-circuit the same way', async () => {
    const r = await searchSymbols(makeGraph(), root, 'billsaycard', 8);
    expect(r.matches.length).toBeGreaterThan(0);
    expect(textHits(r)).toHaveLength(0);
  });

  it('a non-exact single-name query still falls through to the literal scan', async () => {
    // "BillSayCard(" names no symbol exactly (the paren), so the literal pass
    // must still run and surface the call sites — the GetTimezoneId( shape.
    const r = await searchSymbols(makeGraph(), root, 'BillSayCard(', 8);
    const hits = textHits(r);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.file === 'src/usage.ts')).toBe(true);
  });
});

describe('parseRgFileList — Windows and POSIX rg output', () => {
  it('normalises Windows backslash paths instead of discarding them', () => {
    // The regression: '.\\src\\Foo.cs' used to read as ONE dot-leading segment
    // and the defensive filter dropped every Windows rg result silently.
    const out = parseRgFileList('.\\src\\Foo.cs\n.\\tests\\unit\\Bar.cs\n', '\\');
    expect(out).toEqual(['src/Foo.cs', 'tests/unit/Bar.cs']);
  });

  it('still applies ignore/hidden/binary rules to Windows paths per segment', () => {
    const out = parseRgFileList(
      ['.\\src\\Ok.cs', '.\\obj\\Debug\\Gen.cs', '.\\node_modules\\x\\y.js', '.\\.hidden\\z.cs', '.\\bin\\Release\\App.dll'].join('\n') + '\n',
      '\\',
    );
    expect(out).toEqual(['src/Ok.cs']);
  });

  it('POSIX output is unchanged: ./-stripped, filtered, sorted, deduped', () => {
    const out = parseRgFileList('./b.ts\na.ts\n./a.ts\nnode_modules/x.js\n.git/config\nimg.png\n', '/');
    expect(out).toEqual(['a.ts', 'b.ts']);
  });
});

describe('searchSymbols — listing cache freshness', () => {
  // Force the Node walk (the only cached lister) and pin the TTL per test;
  // each test restores the env and clears the cache in its finally block.
  const sweepIn = async (dir: string, needle: string) => searchSymbols(makeGraph(), dir, needle, 50);

  it('reuses the walked listing within the TTL, and clearListingCache invalidates it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cache-'));
    try {
      process.env.VG_DISABLE_RIPGREP = '1';
      process.env.VG_LISTING_TTL_MS = '60000';
      clearListingCache();
      fs.writeFileSync(path.join(dir, 'a.md'), 'cache probe one\n');
      expect((await sweepIn(dir, 'cache probe')).totalTextMatches).toBe(1);
      // A file created inside the TTL window is not in the cached listing…
      fs.writeFileSync(path.join(dir, 'b.md'), 'cache probe two\n');
      expect((await sweepIn(dir, 'cache probe')).totalTextMatches).toBe(1);
      // …and is picked up the moment the cache is invalidated.
      clearListingCache();
      expect((await sweepIn(dir, 'cache probe')).totalTextMatches).toBe(2);
    } finally {
      delete process.env.VG_DISABLE_RIPGREP;
      delete process.env.VG_LISTING_TTL_MS;
      clearListingCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('VG_LISTING_TTL_MS=0 disables caching entirely (every call re-walks)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cache0-'));
    try {
      process.env.VG_DISABLE_RIPGREP = '1';
      process.env.VG_LISTING_TTL_MS = '0';
      clearListingCache();
      fs.writeFileSync(path.join(dir, 'a.md'), 'cache probe one\n');
      expect((await sweepIn(dir, 'cache probe')).totalTextMatches).toBe(1);
      fs.writeFileSync(path.join(dir, 'b.md'), 'cache probe two\n');
      expect((await sweepIn(dir, 'cache probe')).totalTextMatches).toBe(2);
    } finally {
      delete process.env.VG_DISABLE_RIPGREP;
      delete process.env.VG_LISTING_TTL_MS;
      clearListingCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('searchSymbols — ripgrep pruning is engine-independent', () => {
  const withRg = async (disabled: boolean, fn: () => Promise<void>) => {
    const prev = process.env.VG_DISABLE_RIPGREP;
    if (disabled) process.env.VG_DISABLE_RIPGREP = '1';
    else delete process.env.VG_DISABLE_RIPGREP;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.VG_DISABLE_RIPGREP;
      else process.env.VG_DISABLE_RIPGREP = prev;
    }
  };
  const sweep = () => searchSymbols(makeGraph(), root, 'you say', 50);
  const rows = (r: { matches: unknown[] }) =>
    textHits(r as { matches: TextHit[] })
      .map((h) => `${h.file}:${h.line}`)
      .sort();

  it('the forced-fallback Node walk and rg produce identical rows and totals', async () => {
    let viaFallback!: Awaited<ReturnType<typeof sweep>>;
    let viaRg!: Awaited<ReturnType<typeof sweep>>;
    await withRg(true, async () => {
      viaFallback = await sweep();
    });
    await withRg(false, async () => {
      viaRg = await sweep();
    });
    // rg is only a pruner; the pure-JS scan is the authority, so completeness
    // does not depend on whether rg happens to be installed.
    expect(viaRg.totalTextMatches).toBe(viaFallback.totalTextMatches);
    expect(rows(viaRg)).toEqual(rows(viaFallback));
  });

  it('the fallback path alone still finds every occurrence', async () => {
    await withRg(true, async () => {
      const r = await sweep();
      expect(r.totalTextMatches).toBe(TOTAL_LITERAL);
      expect(textHits(r).length).toBe(TOTAL_LITERAL);
    });
  });
});
