import { c } from '../util/output.js';
import { SAVINGS_TOOLS, type Outcome } from '../engine/savings.js';
import { mergeSnapshots } from './live-stats.js';

/**
 * Live, in-memory session stats for `vg serve` — the "is it earning its keep?"
 * display. While the MCP server runs, every tool call is aggregated per tool
 * and per client (which AI is calling, how many calls, how long they take, and
 * the context tokens served vs the grep/read baseline they replaced), and a
 * status block on stderr keeps the operator posted. CLI navigation calls made
 * while serving (`vg impact … --client=<ai>` etc.) are folded in from the local
 * ledger by ./ledger-tail.ts, so agents that shell out to `vg` instead of
 * calling MCP tools still show up here.
 *
 * Privacy: everything here lives and dies with the serve session — nothing is
 * persisted or uploaded, so the display is always on (GUARDRAILS §3.4 applies
 * to the opt-in ledger/upload, which remain separate and off by default).
 * Counts only — never code, paths beyond what the operator already sees, or
 * question text. Sibling serve processes in the same repo (an assistant's own
 * spawned stdio server) surface their counts to a TTY display through the
 * ephemeral live-stats bus (./live-stats.ts) — same counts-only data, swept
 * on exit.
 *
 * Output discipline: stderr only. Under stdio transport, stdout IS the MCP
 * protocol stream and carries nothing else.
 */

export interface CallSample {
  tool: string;
  /** Coarse, sanitized client label ('claude', 'cursor', … or 'unknown'). */
  client: string;
  outcome: Outcome;
  /**
   * How the call arrived: an MCP tool call into this serve process, or a
   * `vg <cmd> --client=<ai>` CLI invocation folded in from the local ledger
   * (see ./ledger-tail.ts). Absent reads as 'mcp'.
   */
  source?: 'mcp' | 'cli';
  /** Wall time of the call, ms. Absent = not measured (CLI ledger lines carry none) — never 0. */
  ms?: number;
  /** Context tokens vg actually returned (savings tools only; else 0). */
  vgTokens: number;
  /** Grep/read baseline estimate those tokens replaced (savings tools only; else 0). */
  baselineTokens: number;
}

export interface RollupRow {
  key: string;
  calls: number;
  complete: number;
  partial: number;
  miss: number;
  /** Calls that carried a measured wall time — the avg-ms denominator. */
  timed: number;
  totalMs: number;
  vgTokens: number;
  baselineTokens: number;
}

export interface SessionSnapshot {
  startedAt: number;
  /** Bumped on every recorded call — cheap dirty check for renderers. */
  revision: number;
  /** Epoch ms of the most recent call, or null when none yet (never 0). */
  lastCallAt: number | null;
  totals: RollupRow;
  /** Sorted by calls desc, then key — deterministic display order. */
  clients: RollupRow[];
  tools: RollupRow[];
  /** The mcp-vs-cli split ('mcp' / 'cli' rows), same ordering. */
  sources: RollupRow[];
}

function zeroRow(key: string): RollupRow {
  return { key, calls: 0, complete: 0, partial: 0, miss: 0, timed: 0, totalMs: 0, vgTokens: 0, baselineTokens: 0 };
}

/** Aggregates tool calls for the lifetime of one serve process. */
export class SessionStats {
  readonly startedAt: number;
  private revision = 0;
  private lastCallAt: number | null = null;
  private readonly totals = zeroRow('total');
  private readonly byClient = new Map<string, RollupRow>();
  private readonly byTool = new Map<string, RollupRow>();
  private readonly bySource = new Map<string, RollupRow>();

  constructor(now: number = Date.now()) {
    this.startedAt = now;
  }

  record(sample: CallSample, now: number = Date.now()): void {
    this.revision++;
    this.lastCallAt = now;
    const rows = [
      this.totals,
      this.rowFor(this.byClient, sample.client),
      this.rowFor(this.byTool, sample.tool),
      this.rowFor(this.bySource, sample.source ?? 'mcp'),
    ];
    for (const row of rows) {
      row.calls++;
      row[sample.outcome]++;
      if (typeof sample.ms === 'number') {
        row.timed++;
        row.totalMs += sample.ms;
      }
      row.vgTokens += sample.vgTokens;
      row.baselineTokens += sample.baselineTokens;
    }
  }

  snapshot(): SessionSnapshot {
    const sorted = (m: Map<string, RollupRow>): RollupRow[] =>
      [...m.values()]
        .map((r) => ({ ...r }))
        .sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
    return {
      startedAt: this.startedAt,
      revision: this.revision,
      lastCallAt: this.lastCallAt,
      totals: { ...this.totals },
      clients: sorted(this.byClient),
      tools: sorted(this.byTool),
      sources: sorted(this.bySource),
    };
  }

  private rowFor(m: Map<string, RollupRow>, key: string): RollupRow {
    let row = m.get(key);
    if (!row) {
      row = zeroRow(key);
      m.set(key, row);
    }
    return row;
  }
}

// ── Formatting helpers (exported for tests) ──

/** '45s' / '12m 03s' / '2h 14m' / '3d 02h' — compact uptime. */
export function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${String(h % 24).padStart(2, '0')}h`;
}

/** 1234 → '1.2k', 2500000 → '2.50M'. */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function fmtAvgMs(row: RollupRow): string {
  // Average only over calls that measured a wall time — CLI-sourced ledger
  // entries carry none, and counting them as 0 would fake a faster average.
  if (row.timed === 0) return '—';
  const avg = row.totalMs / row.timed;
  return avg >= 1000 ? `${(avg / 1000).toFixed(1)}s` : `${Math.round(avg)}ms`;
}

const teal = (s: string): string => c.hex('#3FB0A4')(s);
const mint = (s: string): string => c.hex('#4FE3C1')(s);

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** How many tool rows the live block shows before folding into "+N more". */
const MAX_TOOL_ROWS = 8;

/**
 * The status block as lines (no I/O, injected clock) so it is unit-testable —
 * same pattern as `logoLines`. `tick` drives the spinner frame.
 */
export function serveStatusLines(snap: SessionSnapshot, now: number, tick = 0, siblingServers = 0): string[] {
  const spinner = mint(SPINNER[tick % SPINNER.length]!);
  const up = fmtUptime(now - snap.startedAt);
  const lines: string[] = [];
  // Assistant-spawned serve processes in this repo whose live counts are
  // folded into this view (see ./live-stats.ts) — worth a line either way:
  // "your assistant IS connected, just to its own server process".
  const siblingNote =
    siblingServers > 0
      ? `    ${c.dim(`incl. ${siblingServers} assistant-spawned server${siblingServers === 1 ? '' : 's'} in this repo`)}`
      : null;

  if (snap.totals.calls === 0) {
    lines.push(
      `  ${spinner} ${c.bold.white('vg serve')} ${c.dim('·')} up ${teal(up)} ${c.dim('· waiting for your assistant’s first call (MCP tool call, or `vg … --client=<ai>` CLI)…')}`,
    );
    if (siblingNote) lines.push(siblingNote);
    return lines;
  }

  const t = snap.totals;
  const answered = Math.round(((t.complete + t.partial) / t.calls) * 100);
  // The mcp-vs-cli split — shown once CLI-sourced calls exist, so a pure-MCP
  // session keeps the familiar compact header.
  const cli = snap.sources.find((s) => s.key === 'cli');
  const via = cli
    ? c.dim(' · via ') + snap.sources.map((s) => `${c.white(s.key)} ${teal(String(s.calls))}`).join(c.dim(' · '))
    : '';
  const ago = snap.lastCallAt === null ? '' : c.dim(` · last call ${fmtUptime(now - snap.lastCallAt)} ago`);
  lines.push(
    `  ${spinner} ${c.bold.white('vg serve')} ${c.dim('·')} up ${teal(up)} ${c.dim('·')} ` +
      `${c.bold.white(String(t.calls))} call${t.calls === 1 ? '' : 's'} ${c.dim('·')} ${mint(`${answered}%`)} answered${via}${ago}`,
  );

  // Which AI is calling, and how fast we answer it.
  lines.push(
    `    ${c.dim('clients')}  ` +
      snap.clients
        .map((cl) => `${c.white(cl.key)} ${teal(String(cl.calls))}${c.dim(` (avg ${fmtAvgMs(cl)})`)}`)
        .join(c.dim(' · ')),
  );

  // Per-tool rows: calls, avg time and — for the grep-baseline tools — the
  // context served vs what a grep/read agent would have burned instead.
  const shown = snap.tools.slice(0, MAX_TOOL_ROWS);
  const nameW = Math.max(...shown.map((r) => r.key.length));
  for (const row of shown) {
    let line =
      `    ${c.white(row.key.padEnd(nameW))}  ${teal(String(row.calls).padStart(4))} ${c.dim('·')} ` +
      c.dim(`avg ${fmtAvgMs(row)}`);
    if (SAVINGS_TOOLS.has(row.key) && row.baselineTokens > 0) {
      line += c.dim(' · ctx ') + c.white(fmtTokens(row.vgTokens)) + c.dim(` vs ≈${fmtTokens(row.baselineTokens)} grep/read`);
    }
    if (row.miss > 0) line += c.dim(' · ') + c.yellow(`${row.miss} miss`);
    lines.push(line);
  }
  if (snap.tools.length > shown.length) {
    lines.push(`    ${c.dim(`… +${snap.tools.length - shown.length} more tools`)}`);
  }

  // Session totals + the honest estimate, on two lines so the block survives
  // narrow terminals without wrapping. Tokens only — no monetary figures: the
  // operator's model rate is unknowable here, and a wrong $ number reads as a
  // claim. `vg savings` remains the place for cost estimates with stated rates.
  if (t.baselineTokens > 0) {
    const savedTokens = Math.max(0, t.baselineTokens - t.vgTokens);
    const ratio = t.vgTokens > 0 ? (t.baselineTokens / t.vgTokens).toFixed(1) : '—';
    lines.push(
      `    ${c.dim('session')}  ctx ${c.bold.white(fmtTokens(t.vgTokens))} ` +
        c.dim(`vs grep/read ≈${fmtTokens(t.baselineTokens)} → `) +
        mint(`${ratio}× fewer`),
    );
    lines.push(
      `    ${c.dim('est. saved ≈')} ${mint(`${fmtTokens(savedTokens)} context tokens`)} ${c.dim('(estimate)')}`,
    );
  }
  if (siblingNote) lines.push(siblingNote);
  return lines;
}

/** One-line summary for non-TTY heartbeats (logs, CI, piped stderr). */
export function serveHeartbeatLine(snap: SessionSnapshot, now: number): string {
  const up = fmtUptime(now - snap.startedAt);
  const t = snap.totals;
  if (t.calls === 0) return c.dim(`vg · serving for ${up} — no tool calls yet`);
  const clients = snap.clients.map((cl) => `${cl.key} ${cl.calls}`).join(', ');
  const cli = snap.sources.find((s) => s.key === 'cli');
  let line = `vg · serving for ${up} — ${t.calls} call${t.calls === 1 ? '' : 's'} (${clients})`;
  if (cli) line += ` · ${cli.calls} via CLI`;
  if (t.baselineTokens > 0) {
    const savedTokens = Math.max(0, t.baselineTokens - t.vgTokens);
    line += ` · ctx ${fmtTokens(t.vgTokens)} vs ≈${fmtTokens(t.baselineTokens)} grep/read · est. saved ≈ ${fmtTokens(savedTokens)} tokens`;
  }
  return c.dim(line);
}

/** TTY repaint cadence — 1s keeps the uptime ticking without meaningful cost. */
const TTY_INTERVAL_MS = 1000;
/** Non-TTY heartbeat cadence — a quiet, greppable pulse in logs. */
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Drives the live status display on stderr for the lifetime of a serve process.
 *
 * - **TTY** (a human ran `vg serve` in a terminal): an in-place repainted block,
 *   spinner + uptime + per-client/per-tool stats, redrawn atomically
 *   (cursor-up + erase) with a dirty check, cursor hidden while live.
 * - **non-TTY** (assistant-spawned, logs, CI): one compact heartbeat line every
 *   15 minutes, and only when there is new activity — never log spam.
 *
 * Timers are unref'd: the MCP server, not this display, keeps the process alive.
 */
export class ServeStatusDisplay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private lastRowCount = 0;
  private lastFrame = '';
  private lastHeartbeatRevision = -1;
  private cursorHidden = false;
  private readonly isTTY: boolean;

  constructor(
    private readonly stats: SessionStats,
    private readonly stream: NodeJS.WriteStream = process.stderr,
    /** Fresh sibling-process snapshots to fold into the view (live-stats bus). */
    private readonly siblings?: () => SessionSnapshot[],
  ) {
    this.isTTY = (stream.isTTY ?? false) && process.env.VIBGRATE_PROGRESS_MODE !== 'plain';
  }

  start(): void {
    if (this.timer) return;
    if (this.isTTY) {
      this.hideCursor();
      // Restore the cursor however the process ends. SIGINT/SIGTERM: any
      // earlier-registered handler (e.g. the share-stats final flush) runs
      // first and exits; its process.exit still fires our 'exit' restore.
      process.on('exit', this.restoreCursor);
      process.once('SIGINT', () => {
        this.restoreCursor();
        process.exit(130);
      });
      process.once('SIGTERM', () => {
        this.restoreCursor();
        process.exit(143);
      });
      this.timer = setInterval(() => this.renderTTY(), TTY_INTERVAL_MS);
      this.renderTTY();
    } else {
      this.timer = setInterval(() => this.renderHeartbeat(), HEARTBEAT_INTERVAL_MS);
    }
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isTTY) {
      let buf = '';
      if (this.lastRowCount > 0) buf += `\x1B[${this.lastRowCount}A\x1B[J`;
      this.stream.write(buf);
      this.lastRowCount = 0;
      this.restoreCursor();
    }
  }

  private renderTTY(): void {
    this.tick++;
    const sibs = this.siblings?.() ?? [];
    const snap = mergeSnapshots(this.stats.snapshot(), sibs);
    const lines = serveStatusLines(snap, Date.now(), this.tick, sibs.length);
    const content = lines.join('\n') + '\n';
    if (content === this.lastFrame) return;
    this.lastFrame = content;
    // Atomic repaint: cursor-up over the previous block, erase to end, redraw.
    let buf = '';
    if (this.lastRowCount > 0) buf += `\x1B[${this.lastRowCount}A\x1B[J`;
    buf += content;
    this.stream.write(buf);
    this.lastRowCount = this.countRows(lines);
  }

  private renderHeartbeat(): void {
    const snap = this.stats.snapshot();
    // Only pulse when something happened since the last line — idle logs stay idle.
    if (snap.revision === this.lastHeartbeatRevision) return;
    this.lastHeartbeatRevision = snap.revision;
    this.stream.write(serveHeartbeatLine(snap, Date.now()) + '\n');
  }

  /** Terminal rows the frame occupies, accounting for line wrap. */
  private countRows(lines: string[]): number {
    const columns = Math.max(this.stream.columns ?? 80, 20);
    return lines.reduce((total, line) => {
      const visible = line.replace(/\x1b\[[0-9;]*m/g, '').length;
      return total + Math.max(1, Math.ceil(visible / columns));
    }, 0);
  }

  private hideCursor(): void {
    if (this.cursorHidden) return;
    this.stream.write('\x1B[?25l');
    this.cursorHidden = true;
  }

  private readonly restoreCursor = (): void => {
    if (!this.cursorHidden) return;
    this.stream.write('\x1B[?25h');
    this.cursorHidden = false;
  };
}
