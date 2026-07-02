import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph } from '../src/engine/build.js';
import { serializeGraph } from '../src/engine/serialize.js';
import { LANGUAGES } from '../src/engine/languages.js';

/**
 * Adversarial-corpus tests: generate the deterministic adversarial repos
 * (scripts/gen-adversarial-fixtures.mjs) into a temp dir and build a graph
 * over each language tree that the engine currently supports.
 *
 * The generator emits trees for languages the engine does NOT support yet
 * (php, kotlin, swift, ...). Those are generated but not built — the build
 * list is derived from the live LANGUAGES registry, so this suite picks new
 * languages up automatically as grammars land.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'scripts', 'gen-adversarial-fixtures.mjs');
const PIN = '2020-01-01T00:00:00.000Z';

/** Every language the generator emits (kept in sync with ALL_LANGS there). */
const GENERATED_LANGS = [
  'ts', 'js', 'py', 'go', 'java', 'rust', 'cs', 'rb',
  'php', 'kotlin', 'swift', 'scala', 'dart', 'lua', 'elixir', 'bash', 'zig', 'c', 'cpp',
];

/** Generator directory name → engine language id where they differ. */
const DIR_TO_ENGINE_ID: Record<string, string> = { bash: 'sh', elixir: 'ex' };
const engineId = (dir: string): string => DIR_TO_ENGINE_ID[dir] ?? dir;

// Only build graphs for languages the engine supports at runtime. (`tsx` is a
// supported id but lives inside the ts tree as widget.tsx, not its own dir.)
const supported = new Set(LANGUAGES.map((l) => l.id));
const buildableLangs = GENERATED_LANGS.filter((dir) => supported.has(engineId(dir)));

/**
 * Grammars whose in-process RE-parse of identical content wobbles (stale
 * tree-sitter scanner/heap state on parser reuse). Minimal repro:
 * `parseSource('a.lua','lua','local function f()\n  return 1\nend\n')` twice
 * in one process — the def's endByte is 33 cold and 34 warm; under heap
 * pressure the wobble shifts spans/signatures enough to change node ids.
 * Cross-process builds ARE byte-identical — the CLI determinism contract
 * (one build per `vg` invocation) holds — so for these languages the
 * determinism assertion runs each build in a fresh child process instead of
 * comparing in-process rebuilds. Shrink this set as the grammar wiring is
 * fixed upstream.
 */
const KNOWN_REPARSE_UNSTABLE = new Set(['lua']);

let out: string;

beforeAll(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-adversarial-'));
  execFileSync(process.execPath, [SCRIPT, '--out', out, '--scale', '1'], { stdio: 'pipe' });
}, 60_000);

afterAll(() => {
  if (out) fs.rmSync(out, { recursive: true, force: true });
});

describe('adversarial fixture generator', () => {
  it('emits a tree for every language, including not-yet-supported ones', () => {
    for (const lang of GENERATED_LANGS) {
      const entries = fs.readdirSync(path.join(out, lang));
      expect(entries.length, `expected generated files for ${lang}`).toBeGreaterThan(0);
    }
  });

  it('is byte-deterministic across two runs', () => {
    const again = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-adversarial-again-'));
    try {
      execFileSync(process.execPath, [SCRIPT, '--out', again, '--scale', '1'], { stdio: 'pipe' });
      expect(readTree(again)).toEqual(readTree(out));
    } finally {
      fs.rmSync(again, { recursive: true, force: true });
    }
  }, 60_000);
});

for (const lang of buildableLangs) {
  describe(`adversarial corpus: ${lang}`, () => {
    it(
      'builds cleanly, deterministically, with self-loops only on recur* symbols',
      async () => {
        const root = path.join(out, lang);

        // (a) build does not throw; (b) it produces nodes for this language.
        const first = await buildGraph({ root, inline: true, generatedAt: PIN, noCache: true });
        expect(first.graph.nodes.length).toBeGreaterThan(0);
        expect(first.graph.meta.languages).toContain(engineId(lang));

        // (c) no parse failures. `BuildResult.warnings` is the engine's only
        // per-file failure signal (parse/query problems surface as
        // "parse failed: ..." warnings from the worker); it must be empty.
        expect(first.warnings).toEqual([]);
        expect(first.warnings.filter((w) => /query|parse failed/i.test(w))).toEqual([]);

        // (d) determinism: rebuilding serializes byte-identically via the same
        // serializer the CLI writes graph.json with. For known re-parse-unstable
        // grammars (see KNOWN_REPARSE_UNSTABLE) compare two fresh-process builds
        // instead — that is the contract a `vg build` invocation actually makes.
        if (KNOWN_REPARSE_UNSTABLE.has(lang)) {
          expect(buildHashInChildProcess(root)).toBe(buildHashInChildProcess(root));
        } else {
          const second = await buildGraph({ root, inline: true, generatedAt: PIN, noCache: true });
          expect(serializeGraph(second.graph)).toBe(serializeGraph(first.graph));
        }

        // (e) the delegation bait (`foo()` calling `other.foo()`) must not
        // produce call self-loops. The only legitimate self-loops are the
        // explicitly-recursive fixtures, which are all named `recur*`.
        const byId = new Map(first.graph.nodes.map((n) => [n.id, n]));
        const badSelfLoops = first.graph.edges
          .filter((e) => e.kind === 'call' && e.src === e.dst)
          .map((e) => byId.get(e.src)?.name ?? `<unknown node ${e.src}>`)
          .filter((name) => !name.startsWith('recur'));
        expect(badSelfLoops).toEqual([]);
      },
      120_000,
    );
  });
}

/**
 * Build `root` in a fresh child process (via tsx, so src imports work) and
 * return the sha256 of the serialized graph. Used for grammars whose
 * in-process re-parses wobble: each `vg` invocation is one cold build, so
 * fresh-process byte-identity is the determinism contract that matters.
 */
function buildHashInChildProcess(root: string): string {
  const script = path.join(out, `_build-hash-${path.basename(root)}.mts`);
  const engineDir = path.join(here, '..', 'src', 'engine');
  fs.writeFileSync(
    script,
    [
      `import { buildGraph } from ${JSON.stringify(path.join(engineDir, 'build.js'))};`,
      `import { serializeGraph } from ${JSON.stringify(path.join(engineDir, 'serialize.js'))};`,
      "import { createHash } from 'node:crypto';",
      'const r = await buildGraph({',
      `  root: ${JSON.stringify(root)},`,
      '  inline: true,',
      `  generatedAt: ${JSON.stringify(PIN)},`,
      '  noCache: true,',
      '});',
      "process.stdout.write(createHash('sha256').update(serializeGraph(r.graph)).digest('hex'));",
      '',
    ].join('\n'),
  );
  const tsx = path.join(here, '..', 'node_modules', '.bin', 'tsx');
  return execFileSync(tsx, [script], { encoding: 'utf8' }).trim();
}

/** Stable relPath → content map of a generated tree (for byte comparison). */
function readTree(dir: string): Record<string, string> {
  const map: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else map[path.relative(dir, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'latin1');
    }
  };
  walk(dir);
  return map;
}
