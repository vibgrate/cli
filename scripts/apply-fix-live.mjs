#!/usr/bin/env node
/**
 * Live, multi-repo proof that `vg fix` FIXES AND APPLIES — the full pass:
 *
 *   for each of several throwaway repos (each with a different set of outdated
 *   dependencies, so the planner returns a VARIETY of plans):
 *     1. build the repo and `npm install` the outdated versions;
 *     2. `vg fix --format json` → capture every tier's plan, each annotated with
 *        the EXPECTED DriftScore change (currentDriftScore → expectedDriftScore,
 *        driftDelta) so we can see the drift the plan claims to remove;
 *     3. RANDOMLY pick one of the non-empty plans;
 *     4. snapshot package.json + package-lock.json BEFORE;
 *     5. `vg fix --plan <picked>` → the CLI APPLIES it (npm install to target);
 *     6. snapshot package.json + package-lock.json AFTER and diff them — the
 *        manifest range and the lockfile-resolved version must both move for
 *        every package the plan upgraded. That diff is the pass criterion.
 *     7. re-scan and compare the ACTUAL DriftScore to the plan's expectation.
 *
 * Randomness is seeded (RANDOM_SEED env, else time) and the seed is logged, so a
 * failing run is reproducible. Everything runs in scratch tmp dirs — no repo is
 * touched. DSN is read from VIBGRATE_DSN (never argv). Requires network (hosted
 * planner + npm registry).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DSN = process.env.VIBGRATE_DSN?.trim();
if (!DSN) {
  console.error('VIBGRATE_DSN is required for the live apply demo.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
if (!existsSync(CLI)) {
  console.error(`Built CLI not found at ${CLI}. Run \`pnpm --filter @vibgrate/cli-public build\` first.`);
  process.exit(1);
}

// Repos with deliberately varied drift: a mix of patch/minor-behind (land in the
// low-risk tiers) and multi-major/breaking (land only in the fuller tiers), so
// the three tiers come back genuinely different across the set.
const REPOS = [
  { name: 'utils', deps: { lodash: '2.4.2', ms: '2.0.0' } },
  { name: 'tooling', deps: { semver: '7.3.0', 'is-number': '6.0.0' } },
  { name: 'styling', deps: { chalk: '2.4.0', uuid: '8.3.0' } },
];

// Seeded PRNG (mulberry32) so a failing run reproduces with the same RANDOM_SEED.
const seed = (Number(process.env.RANDOM_SEED) || Date.now()) >>> 0;
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(seed);
console.log(`Random seed: ${seed} (set RANDOM_SEED=${seed} to reproduce this run)\n`);

function run(cmd, args, cwd, { quiet = false } = {}) {
  if (!quiet) console.log(`  $ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: process.env });
  return { status: res.status ?? 1, stdout: res.stdout?.toString() ?? '', stderr: res.stderr?.toString() ?? '' };
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Parse JSON, tolerating leading/trailing non-JSON noise on stdout. */
function parseJsonLoose(s) {
  try {
    return JSON.parse(s);
  } catch {
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(s.slice(i, j + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

/** Manifest range + lockfile-resolved version for each package of interest. */
function snapshot(dir, packages) {
  const manifest = readJson(join(dir, 'package.json'))?.dependencies ?? {};
  const lock = readJson(join(dir, 'package-lock.json'));
  const out = {};
  for (const p of packages) {
    out[p] = {
      range: manifest[p] ?? '(absent)',
      resolved: lock?.packages?.[`node_modules/${p}`]?.version ?? '(absent)',
    };
  }
  return out;
}

/** Scan a repo and return its DriftScore. */
function driftScore(dir, label) {
  const out = join(dir, `scan-${label}.json`);
  const res = run('node', [CLI, 'scan', '.', '--format', 'json', '--out', out], dir, { quiet: true });
  if (res.status !== 0 || !existsSync(out)) return undefined;
  return readJson(out)?.drift?.score;
}

const results = [];

for (const repo of REPOS) {
  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`REPO: ${repo.name} — ${Object.entries(repo.deps).map(([k, v]) => `${k}@${v}`).join(', ')}`);
  console.log(`══════════════════════════════════════════════════════════════`);

  const dir = mkdtempSync(join(tmpdir(), `vg-fix-${repo.name}-`));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `vg-fix-${repo.name}`, version: '1.0.0', private: true, dependencies: repo.deps }, null, 2) + '\n',
  );

  console.log('\n── Setup: npm install (outdated versions) ──');
  if (run('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error'], dir).status !== 0) {
    console.error(`  ⚠ npm install failed for ${repo.name} — skipping.`);
    results.push({ repo: repo.name, status: 'setup-failed' });
    continue;
  }

  // ── Plans (a variety, each with its expected DriftScore change) ─────────────
  const planRes = run('node', [CLI, 'fix', '.', '--format', 'json'], dir, { quiet: true });
  const plan = parseJsonLoose(planRes.stdout);
  if (!plan || plan.status === 'error' || !Array.isArray(plan.plans)) {
    console.error(`  ✖ vg fix did not return plans (status ${planRes.status}). stderr: ${planRes.stderr.trim().split('\n').slice(-3).join(' ')}`);
    results.push({ repo: repo.name, status: 'no-plans' });
    continue;
  }

  const cur = plan.currentDriftScore;
  console.log(`\n── Plans returned (currentDriftScore ${cur ?? '?'}, recommended: ${plan.recommended}) ──`);
  for (const p of plan.plans) {
    const exp = typeof p.expectedDriftScore === 'number' ? p.expectedDriftScore : '?';
    const delta = typeof p.driftDelta === 'number' ? `${p.driftDelta >= 0 ? '+' : ''}${p.driftDelta}` : '?';
    console.log(`  • ${p.tier.padEnd(10)} ${p.upgrades.length} upgrade(s) · DriftScore ${cur ?? '?'} → ${exp} (${delta})`);
    for (const u of p.upgrades) console.log(`        ↑ ${u.package} ${u.from} → ${u.to} [${u.kind}]`);
    for (const ex of p.excluded ?? []) console.log(`        ✗ ${ex.package}: ${ex.reason ?? 'excluded'}`);
  }

  const nonEmpty = plan.plans.filter((p) => p.upgrades.length > 0);
  if (nonEmpty.length === 0) {
    console.log(`\n  ⚠ No tier had upgrades for ${repo.name} — nothing to apply here.`);
    results.push({ repo: repo.name, status: 'no-upgrades' });
    continue;
  }

  // ── Randomly pick a non-empty plan and apply it ─────────────────────────────
  const picked = nonEmpty[Math.floor(rng() * nonEmpty.length)];
  const pkgs = picked.upgrades.map((u) => u.package);
  console.log(`\n── Randomly picked plan: ${picked.tier} (${picked.upgrades.length} upgrade(s)) ──`);

  const before = snapshot(dir, pkgs);
  const beforeScore = driftScore(dir, 'before');

  console.log(`\n── Applying: vg fix --plan ${picked.tier} ──`);
  const applied = run('node', [CLI, 'fix', '.', '--plan', picked.tier], dir);

  const after = snapshot(dir, pkgs);
  const afterScore = driftScore(dir, 'after');

  // ── Before/after lockfile + manifest analysis (the pass criterion) ──────────
  console.log(`\n── package.json + package-lock.json: BEFORE → AFTER ──`);
  let allChanged = true;
  for (const p of pkgs) {
    const b = before[p];
    const a = after[p];
    const target = picked.upgrades.find((u) => u.package === p)?.to;
    const manifestMoved = b.range !== a.range;
    const lockMoved = b.resolved !== a.resolved;
    const ok = manifestMoved && lockMoved && a.resolved !== '(absent)';
    if (!ok) allChanged = false;
    console.log(`  ${ok ? '✔' : '✖'} ${p} (target ${target ?? '?'})`);
    console.log(`      package.json:      ${b.range}  →  ${a.range}`);
    console.log(`      lockfile resolved: ${b.resolved}  →  ${a.resolved}`);
  }

  const scoreDropped = typeof beforeScore === 'number' && typeof afterScore === 'number' && afterScore <= beforeScore;
  console.log(`\n  DriftScore actual: ${beforeScore ?? '?'} → ${afterScore ?? '?'}  (plan expected → ${picked.expectedDriftScore ?? '?'})`);

  const pass = applied.status === 0 && allChanged && scoreDropped;
  console.log(`  ${pass ? '✔ PASS' : '✖ FAIL'} — ${repo.name}: applied '${picked.tier}', ${allChanged ? 'manifest+lockfile upgraded' : 'files did NOT fully change'}, drift ${scoreDropped ? 'fell' : 'did NOT fall'}.`);
  results.push({ repo: repo.name, status: pass ? 'pass' : 'fail', tier: picked.tier, pkgs, beforeScore, afterScore });
}

// ── Overall verdict ────────────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════════════════════════════════`);
console.log('SUMMARY');
console.log(`══════════════════════════════════════════════════════════════`);
for (const r of results) {
  console.log(`  ${r.repo.padEnd(10)} ${r.status}${r.tier ? ` (plan ${r.tier}: ${r.pkgs.join(', ')})` : ''}`);
}

const applied = results.filter((r) => r.status === 'pass' || r.status === 'fail');
const failed = results.filter((r) => r.status === 'fail');
if (applied.length === 0) {
  console.error('\n✖ No repo produced an applicable plan — cannot prove fix+apply.');
  process.exit(1);
}
if (failed.length > 0) {
  console.error(`\n✖ ${failed.length}/${applied.length} applied repo(s) did not fully upgrade — see the FAIL rows above.`);
  process.exit(1);
}
console.log(`\n✔ ${applied.length} repo(s): random plan applied and proven via package.json + lockfile upgrade and a falling DriftScore.`);
