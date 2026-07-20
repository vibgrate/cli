import * as fs from 'node:fs';
import * as path from 'node:path';
import { cacheDir } from '../engine/cache.js';
import type { SessionStats, SessionSnapshot, RollupRow } from './serve-stats.js';

/**
 * Cross-process live stats for `vg serve` — the missing link between the serve
 * process an operator watches in a terminal and the one their assistant
 * actually talks to.
 *
 * Stdio MCP servers are spawned *by the client*: Claude Code launches its own
 * private `vg serve` child, so a manually-run terminal serve never receives
 * those tool calls and its dashboard would sit at zero forever. Every serve
 * process therefore publishes its in-memory session snapshot (counts only —
 * the exact data the live display already renders) to an ephemeral per-process
 * file under `.vibgrate/cache/serve-live/`, and a TTY display folds fresh
 * sibling snapshots into its render. Net effect: `vg serve` in a terminal
 * shows the MCP traffic of the assistant-spawned server(s) in the same repo.
 *
 * Privacy posture is identical to the live display itself: counts, tool
 * names, and coarse client labels only — never code, paths, or question text;
 * local only; files die with the session (unlinked on exit, and stale files
 * from crashed processes are swept on read). This is NOT the opt-in usage
 * ledger (GUARDRAILS §3.4) — nothing here persists or uploads.
 */

/** Publish cadence; also the reader's poll granularity via the display timer. */
const PUBLISH_INTERVAL_MS = 2000;
/** Rewrite even without new calls so `updatedAt` proves the process is alive. */
const KEEPALIVE_MS = 10_000;
/** A snapshot older than this is a dead process — ignored and swept. */
const STALE_MS = 60_000;

interface LiveSnapshotFile {
  pid: number;
  updatedAt: number;
  snapshot: SessionSnapshot;
}

export function liveStatsDir(root: string): string {
  return path.join(cacheDir(root), 'serve-live');
}

export class LiveStatsBus {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRevision = -1;
  private lastWriteAt = 0;
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly stats: SessionStats,
    private readonly pid: number = process.pid,
  ) {
    this.file = path.join(dir, `serve-${this.pid}.json`);
  }

  start(): void {
    if (this.timer) return;
    this.publish();
    this.timer = setInterval(() => this.publish(), PUBLISH_INTERVAL_MS);
    this.timer.unref?.(); // the MCP server, not this bus, keeps the process alive
    process.on('exit', this.unlinkOwn);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.removeListener('exit', this.unlinkOwn);
    this.unlinkOwn();
  }

  /** Write the current snapshot when it changed (or as a keepalive). Never throws. */
  publish(now: number = Date.now()): void {
    const snap = this.stats.snapshot();
    if (snap.revision === this.lastRevision && now - this.lastWriteAt < KEEPALIVE_MS) return;
    this.lastRevision = snap.revision;
    this.lastWriteAt = now;
    const body: LiveSnapshotFile = { pid: this.pid, updatedAt: now, snapshot: snap };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // tmp + rename so a concurrent reader never sees a half-written file.
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body));
      fs.renameSync(tmp, this.file);
    } catch {
      /* display plumbing must never break serving */
    }
  }

  /**
   * Fresh snapshots of the OTHER serve processes in this repo. Stale files
   * (crashed processes) are swept best-effort while reading.
   */
  siblings(now: number = Date.now()): SessionSnapshot[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: SessionSnapshot[] = [];
    for (const name of entries.sort()) {
      if (!/^serve-\d+\.json$/.test(name)) continue;
      const file = path.join(this.dir, name);
      let parsed: LiveSnapshotFile;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LiveSnapshotFile;
      } catch {
        continue; // mid-write or corrupt — skip, the next poll will see it
      }
      if (typeof parsed?.pid !== 'number' || typeof parsed.updatedAt !== 'number' || !parsed.snapshot?.totals) continue;
      if (now - parsed.updatedAt > STALE_MS) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* best-effort sweep */
        }
        continue;
      }
      if (parsed.pid === this.pid) continue;
      out.push(parsed.snapshot);
    }
    return out;
  }

  private readonly unlinkOwn = (): void => {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  };
}

function addInto(target: RollupRow, add: RollupRow): void {
  target.calls += add.calls;
  target.complete += add.complete;
  target.partial += add.partial;
  target.miss += add.miss;
  target.timed += add.timed;
  target.totalMs += add.totalMs;
  target.vgTokens += add.vgTokens;
  target.baselineTokens += add.baselineTokens;
}

function mergeRows(base: RollupRow[], extra: RollupRow[]): RollupRow[] {
  const byKey = new Map<string, RollupRow>(base.map((r) => [r.key, { ...r }]));
  for (const row of extra) {
    const hit = byKey.get(row.key);
    if (hit) addInto(hit, row);
    else byKey.set(row.key, { ...row });
  }
  return [...byKey.values()].sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
}

/**
 * The operator's aggregate view: own snapshot plus every sibling's, rows
 * summed by key. Uptime stays the own process's; lastCallAt is the latest
 * anywhere; revision sums so change detection fires on sibling activity too.
 */
export function mergeSnapshots(own: SessionSnapshot, siblings: SessionSnapshot[]): SessionSnapshot {
  if (!siblings.length) return own;
  const merged: SessionSnapshot = {
    startedAt: own.startedAt,
    revision: own.revision,
    lastCallAt: own.lastCallAt,
    totals: { ...own.totals },
    clients: [...own.clients.map((r) => ({ ...r }))],
    tools: [...own.tools.map((r) => ({ ...r }))],
    sources: [...own.sources.map((r) => ({ ...r }))],
  };
  for (const s of siblings) {
    merged.revision += s.revision;
    if (s.lastCallAt !== null && (merged.lastCallAt === null || s.lastCallAt > merged.lastCallAt)) {
      merged.lastCallAt = s.lastCallAt;
    }
    addInto(merged.totals, s.totals);
    merged.clients = mergeRows(merged.clients, s.clients);
    merged.tools = mergeRows(merged.tools, s.tools);
    merged.sources = mergeRows(merged.sources, s.sources);
  }
  return merged;
}
