/**
 * Real-repository ask relevance runner.
 *
 *   pnpm --filter @vibgrate/cli-public run bench:repos            # all manifest repos
 *   … run bench:repos -- --repo calcom                            # one repo
 *   … run bench:repos -- --repo calcom --dump src/                # explore: list symbols under a dir
 *
 * For each manifest entry: resolve the repo root (local dir, or pinned tarball
 * download into .cache/), build a REAL graph, run the repo's question file
 * through queryGraph, and score with the same evaluator as the synthetic gate
 * (bench/ask-corpus.mjs). Pinned downloads that cannot be fetched (restricted
 * network) are SKIPPED with a notice, never failed — embedded `local` repos are
 * the guaranteed baseline.
 *
 * `--dump` supports the authoring loop (AUTHORING.md): it prints the built
 * graph's symbols grouped by directory so questions can be drafted against
 * what the graph actually contains, then verified by a normal run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REPOS } from './manifest.mjs';
import { evaluateAskEntry } from '../ask-corpus.mjs';
import { scoreByCategory } from '../locate-corpus.mjs';
import { buildGraph } from '../../src/engine/build.js';
import { queryGraph } from '../../src/engine/query.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '.cache');
const SEED_LIMIT = 16;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function resolveRoot(entry) {
  if (entry.source.type === 'local') {
    const dir = path.resolve(HERE, entry.source.dir);
    if (!fs.existsSync(dir)) throw new Error(`local repo missing: ${dir}`);
    return dir;
  }
  if (entry.source.type === 'github-tag') {
    const { owner, repo, tag, sha256 } = entry.source;
    const dest = path.join(CACHE, `${entry.slug}-${tag}`);
    if (fs.existsSync(dest)) return firstSubdir(dest);
    const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/tags/${tag}`;
    let buf;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      const err = new Error(`unreachable (${e.message})`);
      err.skippable = true;
      throw err;
    }
    const digest = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha256 && digest !== sha256) throw new Error(`sha256 mismatch for ${entry.slug}: got ${digest}`);
    if (!sha256) console.log(`  NOTE ${entry.slug}: pin sha256 in manifest.mjs → ${digest}`);
    fs.mkdirSync(dest, { recursive: true });
    const tar = path.join(CACHE, `${entry.slug}-${tag}.tar.gz`);
    fs.writeFileSync(tar, buf);
    const { execFileSync } = await import('node:child_process');
    execFileSync('tar', ['-xzf', tar, '-C', dest]);
    fs.rmSync(tar);
    return firstSubdir(dest);
  }
  throw new Error(`unknown source type: ${entry.source.type}`);
}

function firstSubdir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  return entries.length === 1 ? path.join(dir, entries[0].name) : dir;
}

async function buildRepoGraph(root) {
  const built = await buildGraph({
    root,
    inline: true,
    noGround: true,
    noTsc: true,
    noCoverage: true,
    noScip: true,
    generatedAt: '2026-01-01T00:00:00Z',
  });
  return built.graph;
}

function dumpSymbols(graph, prefix) {
  const byDir = new Map();
  for (const n of graph.nodes) {
    if (n.kind === 'file' || n.kind === 'external') continue;
    const file = n.file.replace(/\\/g, '/');
    if (prefix && !file.startsWith(prefix)) continue;
    const dir = path.dirname(file);
    const list = byDir.get(dir) ?? [];
    list.push(`${n.qualifiedName} (${n.kind})`);
    byDir.set(dir, list);
  }
  for (const [dir, names] of [...byDir.entries()].sort()) {
    console.log(`\n  ${dir}/`);
    for (const n of names.slice(0, 40)) console.log(`    ${n}`);
    if (names.length > 40) console.log(`    … +${names.length - 40} more`);
  }
}

async function main() {
  const only = arg('repo');
  const dump = process.argv.includes('--dump') ? (arg('dump') ?? '') : undefined;
  const targets = REPOS.filter((r) => !only || r.slug === only);
  if (!targets.length) throw new Error(`no manifest entry for --repo ${only}`);

  let anyFail = false;
  for (const entry of targets) {
    let root;
    try {
      root = await resolveRoot(entry);
    } catch (e) {
      if (e.skippable) {
        console.log(`\n○ ${entry.slug} — skipped: ${e.message}`);
        continue;
      }
      throw e;
    }
    const graph = await buildRepoGraph(root);
    console.log(`\n■ ${entry.slug} — ${graph.nodes.length} nodes (${entry.note})`);

    if (dump !== undefined) {
      dumpSymbols(graph, dump);
      continue;
    }

    const qFile = path.join(HERE, entry.questions ?? '');
    if (!entry.questions || !fs.existsSync(qFile)) {
      console.log('  (no questions file yet — author one via AUTHORING.md)');
      continue;
    }
    const questions = JSON.parse(fs.readFileSync(qFile, 'utf8'));
    const outcomes = [];
    for (const q of questions) {
      const s = process.hrtime.bigint();
      const result = queryGraph(graph, q.q, { limit: SEED_LIMIT });
      const ms = Number(process.hrtime.bigint() - s) / 1e6;
      const seeds = result.matches.map((m) => ({ file: m.node.file }));
      const { pass, reason } = evaluateAskEntry(q, seeds);
      outcomes.push({ entry: q, pass, reason, ms });
    }
    const scored = scoreByCategory(outcomes);
    for (const r of scored) {
      const pct = (r.rate * 100).toFixed(0).padStart(3);
      console.log(`  ${r.rate === 1 ? '✓' : '✗'} ${r.category.padEnd(24)} ${String(r.passed).padStart(3)}/${String(r.total).padEnd(3)} ${pct}%`);
      for (const f of r.failures.slice(0, 6)) console.log(`      "${f.q}" — ${f.reason}`);
    }
    const passed = outcomes.filter((o) => o.pass).length;
    console.log(`  ${passed}/${outcomes.length} questions resolved`);
    if (passed < outcomes.length) anyFail = true;
  }
  if (anyFail) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
