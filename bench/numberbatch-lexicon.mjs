/**
 * Propose concept-lexicon additions from a locally downloaded ConceptNet
 * Numberbatch English embedding file (see bench/NUMBERBATCH.md — the file is
 * CC-BY-SA and is never committed or shipped; only reviewed word lists are).
 *
 *   node bench/numberbatch-lexicon.mjs --file numberbatch-en-19.08.txt.gz [--top 8] [--terms a,b,c]
 *
 * Streams the file twice with O(seeds × top) memory:
 *   pass 1 — collect vectors for the seed terms (lexicon keys by default);
 *   pass 2 — cosine every row against each seed, keeping a top-k list of
 *            identifier-plausible neighbors (ascii, 3–14 chars, no digits).
 *
 * Output: JSON { seed: [neighbor, …] } on stdout, for HUMAN review before any
 * of it is edited into src/engine/concepts.ts. This tool never writes source.
 */
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import * as readline from 'node:readline';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const file = arg('file');
const top = Number(arg('top', '8'));
const termsArg = arg('terms');

if (!file) {
  console.error('usage: node bench/numberbatch-lexicon.mjs --file numberbatch-en-XX.XX.txt[.gz] [--top 8] [--terms a,b,c]');
  process.exit(1);
}

async function defaultSeeds() {
  // The current lexicon keys, so every concept family gets fresh candidates.
  const src = fs.readFileSync(new URL('../src/engine/concepts.ts', import.meta.url), 'utf8');
  const keys = [...src.matchAll(/^ {2}(?:'([^']+)'|([a-z][a-z0-9]*)) *: *\[/gm)]
    .map((m) => m[1] ?? m[2])
    .filter((k) => k && !k.includes(' '));
  return [...new Set(keys)];
}

function lineStream() {
  const raw = fs.createReadStream(file);
  const input = file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  return readline.createInterface({ input, crlfDelay: Infinity });
}

/** Numberbatch rows are `term v1 v2 …`; terms may be bare or /c/en/-prefixed. */
function parseTerm(line) {
  const sp = line.indexOf(' ');
  if (sp <= 0) return null;
  let term = line.slice(0, sp);
  if (term.startsWith('/c/en/')) term = term.slice(6);
  return { term, rest: line.slice(sp + 1) };
}

function parseVec(rest) {
  const parts = rest.split(' ');
  const v = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) v[i] = Number(parts[i]);
  return v;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Words a maintainer would plausibly put in an identifier or directory name. */
function identifierPlausible(term) {
  return /^[a-z]{3,14}$/.test(term);
}

async function main() {
  const seeds = termsArg ? termsArg.split(',').map((s) => s.trim().toLowerCase()) : await defaultSeeds();
  const want = new Set(seeds);

  // Pass 1: seed vectors.
  const seedVecs = new Map();
  for await (const line of lineStream()) {
    const p = parseTerm(line);
    if (!p || !want.has(p.term)) continue;
    seedVecs.set(p.term, parseVec(p.rest));
    if (seedVecs.size === want.size) break;
  }
  const missing = seeds.filter((s) => !seedVecs.has(s));
  if (missing.length) console.error(`(no vector for: ${missing.join(', ')})`);

  // Pass 2: top-k neighbors per seed.
  const tops = new Map([...seedVecs.keys()].map((s) => [s, []]));
  for await (const line of lineStream()) {
    const p = parseTerm(line);
    if (!p || !identifierPlausible(p.term) || want.has(p.term)) continue;
    let vec = null;
    for (const [seed, sv] of seedVecs) {
      vec ??= parseVec(p.rest);
      const sim = cosine(sv, vec);
      const list = tops.get(seed);
      if (list.length < top || sim > list[list.length - 1].sim) {
        list.push({ term: p.term, sim });
        list.sort((a, b) => b.sim - a.sim);
        if (list.length > top) list.pop();
      }
    }
  }

  const out = {};
  for (const [seed, list] of [...tops.entries()].sort()) {
    out[seed] = list.map((x) => `${x.term} (${x.sim.toFixed(2)})`);
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
