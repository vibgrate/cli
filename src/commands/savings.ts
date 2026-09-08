import { Command } from 'commander';
import { clearSavings, readSavings, readUsage, readModelSavings, type UsageReport, type ModelSaving } from '../engine/savings.js';
import { readSavingsEvents, rollupSavings, resetSavings, type SavingsRollup } from '../compress/ledger.js';
import { defaultStore, type StoreStats } from '../compress/ccr/store.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg savings` (VG-DEVELOPMENT-PLAN §5) — a local, privacy-safe, honestly
 * estimated report of context tokens / $ saved vs a grep/read baseline.
 * Nothing leaves the machine. Recording is opt-in via `vg serve --savings`.
 *
 * A second section reports what context compression saved (the proxy, the
 * SDK wrappers and the `compress_content` tool all append to one global,
 * numbers-only ledger): today / 7 days / 30 days, by model, client and project.
 */
export function registerSavings(program: Command): void {
  const cmd = program
    .command('savings')
    .description('local, privacy-safe report of tokens/$ saved — grep baseline for map queries, and context compression by window/model/client (estimates)')
    .option('--days <n>', 'window in days', '30')
    .option('--clear', 'delete the recorded usage data for this repo')
    .option('--reset', 'delete the context-compression ledger (global)')
    .option('--compression', 'show only the context-compression section')
    .option('--benchmark', 'measure the compression pipeline offline over built-in fixtures instead of reporting recorded savings')
    .option('--iterations <n>', 'with --benchmark: runs per fixture', '5')
    .option('--fixture <name>', 'with --benchmark: only this fixture or content type (json, build_output, search_results, git_diff, source_code, html, plain_text, tabular)')
    .option('--model <id>', 'with --benchmark: model id used for tokenizer selection', 'claude-sonnet-4-5')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const days = Number(this.opts().days) || 30;
      const root = rootOf(global);

      // Measurement mode (P4): a pinned corpus, reproducible, no network.
      if (this.opts().benchmark) {
        const { runSavingsBenchmark } = await import('./savings-benchmark.js');
        await runSavingsBenchmark(this.opts(), global);
        return;
      }

      if (this.opts().reset) {
        const existed = resetSavings();
        if (global.json) {
          json({ ok: true, reset: existed });
          return;
        }
        info(
          existed
            ? `${c.cyan('vg savings')} ${c.dim('--reset')} · context-compression ledger deleted`
            : `${c.cyan('vg savings')} ${c.dim('--reset')} · no compression ledger yet — nothing to delete`,
        );
        return;
      }

      if (this.opts().compression) {
        const now = Date.now();
        const compression = compressionReport(now);
        if (global.json) {
          json({ compression });
          return;
        }
        info(`${c.cyan('vg savings')} · context compression ${c.dim('(local, nothing left your machine)')}`);
        printCompression(compression);
        return;
      }

      if (this.opts().clear) {
        const existed = clearSavings(root);
        if (global.json) {
          json({ ok: true, cleared: existed });
          return;
        }
        info(
          existed
            ? `${c.cyan('vg savings')} ${c.dim('--clear')} · usage data deleted for this repo`
            : `${c.cyan('vg savings')} ${c.dim('--clear')} · nothing recorded here — nothing to delete`,
        );
        return;
      }

      const now = Date.now();
      const report = readSavings(root, days, now);
      const usage = readUsage(root, days, now);
      const models = readModelSavings(root, days, now);
      const compression = compressionReport(now);

      if (global.json) {
        json({ ...report, usage, models, compression });
        return;
      }

      info(`${c.cyan('vg savings')} · last ${days} days ${c.dim('(local, nothing left your machine)')}`);
      if (usage.totals.calls === 0) {
        info(
          c.dim(
            report.enabled
              ? '  no calls recorded yet in this window'
              : '  recording is off. Enable it for MCP with `vg serve --savings`, and for CLI calls by passing `--client=<ai>` to vg.',
          ),
        );
        printCompression(compression);
        return;
      }

      // Token-savings summary — only the grep-baseline tools (query_graph / get_node).
      if (report.queries > 0) {
        info(`  queries ${report.queries} · context tokens ${fmt(report.vgTokens)}  (grep/read baseline ≈ ${fmt(report.baselineTokens)})  → ${report.ratio}× fewer`);
        info(`  est. cost (${report.rateLabel}): $${report.estCostVg} vs $${report.estCostBaseline}  → saved ≈ $${report.saved}`);
        info(c.dim('  estimates with stated assumptions (~4 chars/token; ~400 tokens/file baseline); scales with repo size.'));
      }

      // Per-command breakdown — every recorded tool, its outcomes, and success rate.
      printBreakdown(usage);
      // The command-vs-MCP split and which AI is calling.
      printSplit(usage);
      // Per-model savings (VG Code attributes each call to its model).
      printModels(models);
      // Context compression (proxy / SDK / MCP compress_content).
      printCompression(compression);
    });
  applyGlobalOptions(cmd);
}

export interface CompressionReport {
  enabled: boolean;
  windows: Record<'today' | '7d' | '30d' | 'all', SavingsRollup>;
  store: StoreStats | { entries: number; bytes: number };
}

/** Rollups over the global compression ledger plus the retrievable-store size. Never throws. */
export function compressionReport(now: number): CompressionReport {
  let events: ReturnType<typeof readSavingsEvents> = [];
  try {
    events = readSavingsEvents(undefined, { now });
  } catch {
    /* no ledger yet */
  }
  let store: CompressionReport['store'] = { entries: 0, bytes: 0 };
  try {
    store = defaultStore().stats();
  } catch {
    /* store dir not created yet */
  }
  return { enabled: events.length > 0, windows: rollupSavings(events, now), store };
}

function printCompression(r: CompressionReport): void {
  info('');
  info(c.bold('  context compression') + c.dim('  (vg serve --compress / vg code / SDK; tokens and $ are estimates)'));
  if (!r.enabled) {
    info(c.dim('    nothing recorded yet — start `vg serve --compress` and point an agent at it with `vg install <agent> --compress`'));
    return;
  }
  info(c.dim('    ' + 'window'.padEnd(8) + ['requests', 'before', 'after', 'saved', 'saved %', 'saved $'].map((h) => h.padStart(11)).join('')));
  for (const w of ['today', '7d', '30d', 'all'] as const) {
    const x = r.windows[w];
    const pct = x.tokensBefore > 0 ? `${Math.round((x.tokensSaved / x.tokensBefore) * 100)}%` : '—';
    info(
      '    ' +
        w.padEnd(8) +
        String(x.requests).padStart(11) +
        fmt(x.tokensBefore).padStart(11) +
        fmt(x.tokensAfter).padStart(11) +
        fmt(x.tokensSaved).padStart(11) +
        pct.padStart(11) +
        `$${x.usdSaved.toFixed(2)}`.padStart(11),
    );
  }
  const month = r.windows['30d'];
  const dims: Array<[string, Record<string, { requests: number; tokensSaved: number; usdSaved: number }>]> = [
    ['by model', month.byModel],
    ['by client', month.byClient],
    ['by project', month.byProject],
  ];
  for (const [label, rows] of dims) {
    const keys = Object.keys(rows).sort((a, b) => rows[b].tokensSaved - rows[a].tokensSaved || a.localeCompare(b));
    if (!keys.length) continue;
    info(c.dim(`    ${label} (30d)`));
    const w = Math.max(12, ...keys.map((k) => k.length));
    for (const k of keys.slice(0, 10)) {
      const x = rows[k];
      info(`      ${k.padEnd(w)} ${String(x.requests).padStart(8)} req ${fmt(x.tokensSaved).padStart(9)} saved  $${x.usdSaved.toFixed(2)}`);
    }
  }
  info(c.dim(`    retrievable store: ${r.store.entries} entr${r.store.entries === 1 ? 'y' : 'ies'} · ${fmt(r.store.bytes)} bytes · vg serve retrieve --list`));
}

function fmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Render the per-command usage table: calls, complete/partial/miss, success %. */
function printBreakdown(usage: UsageReport): void {
  info('');
  info(c.bold('  by command') + c.dim('  (complete = full result · partial = capped/paginated · miss = no result)'));
  const nameW = Math.max(7, ...usage.commands.map((cmd) => cmd.tool.length));
  const header =
    '    ' +
    'command'.padEnd(nameW) +
    ['calls', 'complete', 'partial', 'miss', 'success%', 'avg ms'].map((h) => h.padStart(9)).join('');
  info(c.dim(header));
  for (const cmd of usage.commands) {
    info(
      '    ' +
        cmd.tool.padEnd(nameW) +
        String(cmd.calls).padStart(9) +
        String(cmd.complete).padStart(9) +
        String(cmd.partial).padStart(9) +
        String(cmd.miss).padStart(9) +
        `${cmd.successPct}%`.padStart(9) +
        // Absent ≠ zero: calls recorded before timing existed show '—'.
        (cmd.avgMs === null ? '—' : String(cmd.avgMs)).padStart(9),
    );
  }
  const t = usage.totals;
  info(c.dim('    ' + '─'.repeat(nameW + 54)));
  info(
    '    ' +
      c.bold('total'.padEnd(nameW)) +
      String(t.calls).padStart(9) +
      String(t.complete).padStart(9) +
      String(t.partial).padStart(9) +
      String(t.miss).padStart(9) +
      ''.padStart(9) +
      ''.padStart(9),
  );
  info(c.dim(`    avg success across commands: ${usage.avgSuccessPct}%`));
}

/** Render per-model savings — how many calls each model made and the tokens/$ saved. */
function printModels(models: ModelSaving[]): void {
  if (models.length === 0) return;
  info('');
  info(c.bold('  by model') + c.dim('  (VG Code attributes each call to its provider/model)'));
  const nameW = Math.max(12, ...models.map((m) => m.key.length));
  info(c.dim('    ' + 'model'.padEnd(nameW) + ['queries', 'tokens', 'baseline', 'saved $'].map((h) => h.padStart(11)).join('')));
  for (const m of models) {
    info(
      '    ' +
        m.key.padEnd(nameW) +
        String(m.queries).padStart(11) +
        fmt(m.vgTokens).padStart(11) +
        fmt(m.baselineTokens).padStart(11) +
        `$${m.saved}`.padStart(11),
    );
  }
}

/**
 * Render the command-vs-MCP split (how calls arrived) and which AI client made
 * them — the signals that show whether assistants use the MCP tools or shell out
 * to `vg`, and that feed the opt-in share-stats upload.
 */
function printSplit(usage: UsageReport): void {
  const label = (key: string): string => (key === 'mcp' ? 'MCP tools' : key === 'cli' ? 'vg CLI' : key);
  if (usage.sources.length) {
    info('');
    info(c.bold('  by source') + c.dim('  (how the call arrived)'));
    for (const s of usage.sources) {
      const pct = usage.totals.calls ? Math.round((s.calls / usage.totals.calls) * 100) : 0;
      info(`    ${label(s.key).padEnd(12)} ${String(s.calls).padStart(6)} calls ${c.dim(`(${pct}%)`)}`);
    }
  }
  if (usage.clients.length) {
    info('');
    info(c.bold('  by client') + c.dim('  (which AI is calling; pass --client to vg to attribute CLI calls)'));
    for (const cl of usage.clients) {
      info(`    ${cl.key.padEnd(12)} ${String(cl.calls).padStart(6)} calls`);
    }
  }
}
