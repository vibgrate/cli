/**
 * Offline compression bench for `vg savings --benchmark`: runs the pipeline over built-in
 * fixtures (no network), reporting p50/p95 latency and the kept ratio per
 * content type. Deterministic fixtures, injected clock for the report.
 */

import { CompressionStore } from '../compress/ccr/store.js';
import type { Message } from '../compress/types.js';
import type { ProxyDeps } from './deps.js';

export interface PerfFixture {
  name: string;
  contentType: string;
  messages: Message[];
}

function lines(n: number, f: (i: number) => string): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(f(i));
  return out.join('\n');
}

/**
 * One tool call, answered, and then the session moves on.
 *
 * The trailing turns are not padding. Output sitting in the newest few messages
 * is protected (recent code is what the agent is about to edit), and output the
 * latest question is *about* is protected too — so a fixture that ends by asking
 * about its own payload measures those protections rather than the compressor.
 * Both rules are what a real session wants; a benchmark just has to look at the
 * common case instead, where the output was fetched a few turns ago and the
 * conversation has moved on.
 */
function toolTurn(name: string, output: string, ask = 'Summarize what matters in this output.'): Message[] {
  return [
    { role: 'user', content: `Run ${name} and report back.` },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name, input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: output }, { type: 'text', text: ask }] },
    { role: 'assistant', content: 'Noted — I have what I need from that.' },
    { role: 'user', content: 'Good. Next, update the changelog entry for the release.' },
    { role: 'assistant', content: 'Drafting the changelog entry.' },
    { role: 'user', content: 'Keep the wording plain and mention the migration note.' },
  ];
}

export function builtinFixtures(): PerfFixture[] {
  const json = JSON.stringify(
    Array.from({ length: 400 }, (_, i) => ({ id: i + 1, name: `item-${i + 1}`, status: i % 7 === 0 ? 'failed' : 'ok', score: (i * 37) % 100, tags: ['alpha', 'beta', i % 2 ? 'odd' : 'even'], updatedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z` })),
    null,
    2,
  );
  const log = lines(1200, (i) => `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z ${i % 50 === 0 ? 'ERROR' : i % 9 === 0 ? 'WARN' : 'INFO'} worker-${i % 8} request ${1000 + i} handled in ${(i * 13) % 900}ms status=${i % 50 === 0 ? 500 : 200}`);
  const search = lines(600, (i) => `src/module-${i % 40}/file-${i}.ts:${(i * 7) % 300}:  export function handler${i}(input: Input${i % 5}): Output { return process(input); }`);
  // A real unified diff. Without the `diff --git` / `---` / `+++` headers there
  // are no files to parse and the compressor has nothing to work on; and with
  // almost every line changed there is nothing to trim either, so the hunks
  // carry the context git actually emits.
  const diff = lines(800, (i) =>
    i % 100 === 0
      ? `diff --git a/src/file${i / 100}.ts b/src/file${i / 100}.ts\n--- a/src/file${i / 100}.ts\n+++ b/src/file${i / 100}.ts`
      : i % 25 === 0
        ? `@@ -${i},20 +${i},21 @@ function block${i}()`
        : i % 25 === 12
          ? `+  const value${i} = compute(${i});`
          : i % 25 === 13
            ? `-  const old${i} = legacy(${i});`
            : `   context line ${i} untouched`,
  );
  const code = lines(900, (i) => (i % 15 === 0 ? `export function fn${i}(a: number, b: string): string {` : i % 15 === 14 ? '}' : `  const v${i} = a * ${i} + b.length; // step ${i}`));
  const html = `<html><head><style>${lines(50, (i) => `.c${i}{color:#${(i * 12345).toString(16).slice(0, 6)}}`)}</style><script>${lines(80, (i) => `var x${i}=${i};`)}</script></head><body>${lines(300, (i) => `<div class="c${i % 50}"><p>Paragraph ${i} with some readable text about topic ${i % 12}.</p></div>`)}</body></html>`;
  const text = lines(400, (i) => `Sentence ${i} explains the ${['design', 'tradeoff', 'constraint', 'decision'][i % 4]} number ${i} in plain prose, adding detail that repeats the same idea with small variations across the document.`);
  const table = lines(500, (i) => `${i},user${i}@example.com,${['active', 'inactive', 'pending'][i % 3]},${(i * 17) % 1000},${i % 2 === 0 ? 'true' : 'false'}`);
  return [
    { name: 'json-array', contentType: 'json', messages: toolTurn('list_items', json, 'Which items failed?') },
    { name: 'build-log', contentType: 'build_output', messages: toolTurn('run_build', log, 'What errors occurred?') },
    { name: 'search-results', contentType: 'search_results', messages: toolTurn('grep', search, 'Where is handler42 defined?') },
    { name: 'git-diff', contentType: 'git_diff', messages: toolTurn('git_diff', diff, 'Summarize the change.') },
    // deliberately not `read_file`: reads are byte-exact under every profile, so
    // routing the fixture through one would measure the protection, not the
    // code compressor this row exists to benchmark
    { name: 'source-code', contentType: 'source_code', messages: toolTurn('search_source', code, 'What does fn15 do?') },
    { name: 'html-page', contentType: 'html', messages: toolTurn('fetch_page', html, 'What is the page about?') },
    { name: 'plain-text', contentType: 'plain_text', messages: toolTurn('read_doc', text, 'What is the main design decision?') },
    { name: 'csv-table', contentType: 'tabular', messages: toolTurn('query_users', `id,email,status,score,verified\n${table}`, 'How many are pending?') },
  ];
}

export interface PerfRow {
  fixture: string;
  contentType: string;
  iterations: number;
  tokensBefore: number;
  tokensAfter: number;
  keptRatio: number;
  savedPercent: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  transforms: string[];
  deterministic: boolean;
}

export interface PerfReport {
  generatedAt: string;
  iterations: number;
  rows: PerfRow[];
  totals: { tokensBefore: number; tokensAfter: number; savedPercent: number; p50Ms: number; p95Ms: number };
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export async function runPerf(deps: Pick<ProxyDeps, 'compressMessages'>, opts: { iterations?: number; fixture?: string; model?: string; clock?: () => number; generatedAt?: string; store?: CompressionStore } = {}): Promise<PerfReport> {
  const iterations = Math.max(1, opts.iterations ?? 5);
  const clock = opts.clock ?? (() => performance.now());
  const store = opts.store ?? new CompressionStore({ backend: 'memory' });
  const fixtures = builtinFixtures().filter((f) => !opts.fixture || f.name === opts.fixture || f.contentType === opts.fixture);
  const rows: PerfRow[] = [];
  const allMs: number[] = [];
  let totalBefore = 0;
  let totalAfter = 0;
  for (const f of fixtures) {
    const ms: number[] = [];
    let first: string | null = null;
    let deterministic = true;
    let last: { tokensBefore: number; tokensAfter: number; transformsApplied: string[] } | null = null;
    for (let i = 0; i < iterations; i++) {
      const t0 = clock();
      const r = await deps.compressMessages(JSON.parse(JSON.stringify(f.messages)) as Message[], {
        model: opts.model ?? 'claude-sonnet-4-5',
        mode: 'token',
        optimize: true,
        // Measure the pipeline as it actually runs. With retrieval off, every
        // compressor that drops anything is refused as unrecoverable and the
        // bench reports 0% for exactly the paths it exists to watch. The store
        // is in-memory so a benchmark never writes to the user's own.
        ccr: { enabled: true, injectMarker: true, store },
      });
      ms.push(clock() - t0);
      const sig = JSON.stringify(r.messages);
      if (first === null) first = sig;
      else if (sig !== first) deterministic = false;
      last = r;
    }
    ms.sort((a, b) => a - b);
    allMs.push(...ms);
    const before = last?.tokensBefore ?? 0;
    const after = last?.tokensAfter ?? 0;
    totalBefore += before;
    totalAfter += after;
    rows.push({ fixture: f.name, contentType: f.contentType, iterations, tokensBefore: before, tokensAfter: after, keptRatio: before > 0 ? after / before : 1, savedPercent: before > 0 ? ((before - after) / before) * 100 : 0, p50Ms: round(percentile(ms, 50)), p95Ms: round(percentile(ms, 95)), maxMs: round(ms[ms.length - 1] ?? 0), transforms: [...new Set(last?.transformsApplied ?? [])].sort(), deterministic });
  }
  allMs.sort((a, b) => a - b);
  return { generatedAt: opts.generatedAt ?? new Date().toISOString(), iterations, rows, totals: { tokensBefore: totalBefore, tokensAfter: totalAfter, savedPercent: totalBefore > 0 ? ((totalBefore - totalAfter) / totalBefore) * 100 : 0, p50Ms: round(percentile(allMs, 50)), p95Ms: round(percentile(allMs, 95)) } };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
