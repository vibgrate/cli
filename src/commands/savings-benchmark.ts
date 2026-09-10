import { c, info, json } from '../util/output.js';
import { usageError } from '../util/exit.js';
import { builtinFixtures, runPerf, type PerfReport } from '../proxy/perf.js';
import { loadDefaultDeps } from '../proxy/fallbacks.js';

/**
 * `vg savings --benchmark` — offline compression bench over built-in fixtures:
 * p50/p95 latency and kept ratio per content type. No network, nothing running.
 *
 * P4 says token and performance claims are measured with the harnesses we
 * already have, and P1 says a measurement mode is not its own verb — so this
 * is a mode of the command that already reports tokens and dollars.
 */
export async function runSavingsBenchmark(
  o: { iterations?: string; fixture?: string; model?: string },
  global: { json?: boolean; generatedAt?: string },
): Promise<void> {
  const iterations = Number(o.iterations ?? '5');
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000) throw usageError('--iterations must be an integer between 1 and 1000');
  const known = builtinFixtures();
  if (o.fixture && !known.some((f) => f.name === o.fixture || f.contentType === o.fixture)) throw usageError(`unknown fixture ${o.fixture}; one of ${known.map((f) => f.name).join(', ')}`);
  const { deps, missing } = await loadDefaultDeps({ env: process.env });
  try {
    await deps.warmRouter?.();
  } catch {
    /* best effort */
  }
  const report = await runPerf(deps, { iterations, fixture: o.fixture, model: o.model ?? 'claude-sonnet-5', generatedAt: global.generatedAt });
  if (global.json) {
    json({ ...report, layers: { missing } });
    return;
  }
  printReport(report, missing);
}

function printReport(report: PerfReport, missing: string[]): void {
  info(`${c.cyan('vg savings --benchmark')} · offline compression bench, ${report.iterations} run(s) per fixture ${c.dim('(no network)')}`);
  if (missing.includes('pipeline')) info(c.yellow('  compression pipeline not bound — results reflect passthrough'));
  const nameW = Math.max(12, ...report.rows.map((r) => r.fixture.length));
  info(c.dim('  ' + 'fixture'.padEnd(nameW) + ['type', 'before', 'after', 'saved%', 'p50 ms', 'p95 ms', 'max ms', 'det'].map((h) => h.padStart(11)).join('')));
  for (const r of report.rows) {
    info(
      '  ' +
        r.fixture.padEnd(nameW) +
        r.contentType.padStart(11) +
        String(r.tokensBefore).padStart(11) +
        String(r.tokensAfter).padStart(11) +
        `${r.savedPercent.toFixed(1)}%`.padStart(11) +
        r.p50Ms.toFixed(1).padStart(11) +
        r.p95Ms.toFixed(1).padStart(11) +
        r.maxMs.toFixed(1).padStart(11) +
        (r.deterministic ? 'yes' : c.red('NO')).padStart(11),
    );
  }
  info(c.dim('  ' + '─'.repeat(nameW + 88)));
  info(`  ${'total'.padEnd(nameW)}${''.padStart(11)}${String(report.totals.tokensBefore).padStart(11)}${String(report.totals.tokensAfter).padStart(11)}${`${report.totals.savedPercent.toFixed(1)}%`.padStart(11)}${report.totals.p50Ms.toFixed(1).padStart(11)}${report.totals.p95Ms.toFixed(1).padStart(11)}`);
}
