#!/usr/bin/env node
/**
 * Diagnostic for the hosted `vg fix` path — dumps the RAW responses of the two
 * API hops so we can see why a plan comes back with nothing to upgrade:
 *
 *   1. GET  /v1/ingest/scan/preflight   ("preflight") — plan/entitlement gating.
 *        A 402 FEATURE_NOT_ENTITLED here is the usual reason `vg fix` produces
 *        no upgrades: the workspace's tier lacks the paid planner.
 *   2. POST /v1/fix/plan                 ("upgrade path") — the planner itself.
 *        Its response carries, per tier, both `upgrades[]` and `excluded[]`
 *        (each with a human `reason`). If everything lands in `excluded`, that
 *        reason string is the answer.
 *
 * Unlike `vg fix`, this prints the raw HTTP status and body for BOTH hops —
 * including non-2xx bodies (401/402/429/5xx) that the CLI sanitises away — so
 * the failure is visible instead of a one-line "errors" message.
 *
 * Usage:
 *   VIBGRATE_DSN='vibgrate+https://key:secret@host/ws' node scripts/diagnose-fix-api.mjs
 *
 * Optional env:
 *   FIX_CANDIDATES   JSON array of FixCandidateInput to plan (defaults to a
 *                    representative "lodash 2 majors behind" candidate). Paste
 *                    your own drifted deps here to reproduce a real case.
 *   FIX_REPOSITORY   Repository name to record on the request (default none).
 *
 * The DSN secret is never printed. Exits 0 on a completed diagnosis (even when
 * the API returns 4xx — the log is the deliverable); exits 1 only when a hop
 * could not be reached at all.
 */

const DSN = process.env.VIBGRATE_DSN?.trim();
if (!DSN) {
  console.error('VIBGRATE_DSN is not set. Pass a DSN to diagnose the fix API.');
  process.exit(1);
}

/** Parse `vibgrate+https://<keyId>:<secret>@<host>/<workspaceId>` (mirrors core-open parseDsn). */
function parseDsn(dsn) {
  const cleaned = dsn.replace(/[\x00-\x1F\x7F﻿​-‍⁠]/g, '').trim();
  const m = cleaned.match(/^vibgrate\+(https?):?\/\/([^:]+):([^@]+)@([^/]+)\/(.+)$/);
  if (!m) return null;
  return { scheme: m[1], keyId: m[2], secret: m[3], host: m[4], workspaceId: m[5] };
}

const parsed = parseDsn(DSN);
if (!parsed) {
  console.error('Invalid DSN format. Expected vibgrate+https://<keyId>:<secret>@<host>/<workspaceId>.');
  process.exit(1);
}

const mask = (s) => (s.length <= 6 ? '***' : `${s.slice(0, 6)}…`);
const authHeader = `VibgrateDSN ${parsed.keyId}:${parsed.secret}`;

console.log('── DSN identity (secret withheld) ─────────────────────────────');
console.log(`  scheme:      ${parsed.scheme}`);
console.log(`  host:        ${parsed.host}`);
console.log(`  workspaceId: ${parsed.workspaceId}`);
console.log(`  keyId:       ${mask(parsed.keyId)}`);
console.log('');

/** Pretty-print a response body, tolerating non-JSON. */
async function dumpResponse(label, res) {
  const text = await res.text();
  let body;
  try {
    body = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    body = text || '(empty body)';
  }
  const flag = res.ok ? '✔' : '✖';
  console.log(`  ${flag} HTTP ${res.status} ${res.statusText}`);
  const ct = res.headers.get('content-type');
  if (ct) console.log(`  content-type: ${ct}`);
  console.log(indent(body));
  console.log('');
  return { status: res.status, ok: res.ok, text };
}

const indent = (s) => s.split('\n').map((l) => `    ${l}`).join('\n');

// ── 1. Preflight ──────────────────────────────────────────────────────────────
let preflightBody = null;
async function preflight() {
  console.log('── 1. Preflight  GET /v1/ingest/scan/preflight ────────────────');
  const url = new URL(`${parsed.scheme}://${parsed.host}/v1/ingest/scan/preflight`);
  if (process.env.FIX_REPOSITORY) url.searchParams.set('repository', process.env.FIX_REPOSITORY);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-Vibgrate-Timestamp': String(Date.now()),
        Authorization: authHeader,
      },
    });
    const { text } = await dumpResponse('preflight', res);
    try {
      preflightBody = JSON.parse(text);
    } catch {
      /* non-JSON already dumped */
    }
    if (preflightBody?.plan) {
      console.log(`  → plan tier: ${preflightBody.plan.tier} (${preflightBody.plan.label ?? ''})`);
      if (preflightBody.code || preflightBody.error) {
        console.log(`  → NOTE: ${preflightBody.code ?? ''} ${preflightBody.error ?? ''}`.trim());
      }
      console.log('');
    }
    return true;
  } catch (e) {
    console.error(`  ✖ Could not reach preflight: ${e instanceof Error ? e.message : String(e)}`);
    console.log('');
    return false;
  }
}

// ── 2. Fix plan ───────────────────────────────────────────────────────────────
function defaultCandidates() {
  return [
    {
      package: 'lodash',
      ecosystem: 'npm',
      currentVersion: '2.4.2',
      latestVersion: '4.17.21',
      majorsBehind: 2,
      section: 'dependencies',
      usage: { importSites: 3, filesTouched: 2 },
    },
  ];
}

function loadCandidates() {
  if (!process.env.FIX_CANDIDATES) return defaultCandidates();
  try {
    const parsedC = JSON.parse(process.env.FIX_CANDIDATES);
    if (Array.isArray(parsedC) && parsedC.length) return parsedC;
    console.error('  ⚠ FIX_CANDIDATES was not a non-empty array — falling back to the default candidate.');
  } catch (e) {
    console.error(`  ⚠ FIX_CANDIDATES is not valid JSON (${e instanceof Error ? e.message : e}) — using the default candidate.`);
  }
  return defaultCandidates();
}

async function fixPlan() {
  console.log('── 2. Upgrade path  POST /v1/fix/plan ─────────────────────────');
  const candidates = loadCandidates();
  // Self-heal residency: prefer the region host preflight reported, if any.
  const host = preflightBody?.ingestHost || parsed.host;
  const request = {
    cliVersion: 'diagnostic',
    ...(process.env.FIX_REPOSITORY ? { repository: { name: process.env.FIX_REPOSITORY } } : {}),
    candidates,
  };
  console.log(`  host: ${host}`);
  console.log(`  candidates (${candidates.length}):`);
  console.log(indent(JSON.stringify(candidates, null, 2)));
  console.log('');

  let res;
  try {
    res = await fetch(`${parsed.scheme}://${host}/v1/fix/plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Vibgrate-Timestamp': String(Date.now()),
        Authorization: authHeader,
        Connection: 'close',
      },
      body: JSON.stringify(request),
    });
  } catch (e) {
    console.error(`  ✖ Could not reach the planner: ${e instanceof Error ? e.message : String(e)}`);
    console.log('');
    return false;
  }

  const { text } = await dumpResponse('fix/plan', res);
  let plan = null;
  try {
    plan = JSON.parse(text);
  } catch {
    /* non-JSON already dumped */
  }
  if (plan) summarisePlan(plan);
  return true;
}

/** Human summary of why the upgrade path did or didn't produce upgrades. */
function summarisePlan(plan) {
  console.log('  ── summary ─────────────────────────────────────────────────');
  if (plan.status === 'error') {
    console.log(`  ✖ planner error: ${plan.code ?? ''} ${plan.error ?? ''}`.trim());
    console.log('');
    return;
  }
  console.log(`  totalCandidates: ${plan.totalCandidates ?? '?'} · recommended: ${plan.recommended ?? '?'} · deepAnalysis: ${plan.deepAnalysis ?? false} · vulnData: ${plan.vulnerabilityData ?? '?'}`);
  let anyUpgrade = false;
  for (const p of plan.plans ?? []) {
    const ups = p.upgrades ?? [];
    if (ups.length) anyUpgrade = true;
    console.log(`  · ${p.tier}: ${ups.length} upgrade(s), ${(p.excluded ?? []).length} excluded (risk ${p.riskScore ?? '?'})`);
    for (const u of ups) console.log(`      ↑ ${u.package} ${u.from} → ${u.to} [${u.kind}]`);
    for (const ex of p.excluded ?? []) console.log(`      ✗ ${ex.package}: ${ex.reason ?? 'excluded'}`);
  }
  if (!anyUpgrade) {
    console.log('');
    console.log('  ⚠ No tier produced any upgrade — this is why "nothing is fixed".');
    console.log('    The per-candidate `excluded[].reason` above states the cause');
    console.log('    (peer conflict, breaking-change signal, high blast radius, or');
    console.log('    "no newer stable version resolved"). A 402 on preflight/plan');
    console.log('    means the workspace tier lacks the paid planner entitlement.');
  }
  console.log('');
}

const okPre = await preflight();
const okPlan = await fixPlan();
if (!okPre && !okPlan) process.exit(1);
