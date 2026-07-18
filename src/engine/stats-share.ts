import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cacheDir } from './cache.js';
import { VERSION } from '../version.js';
import { resolveIngestHost } from '../reporting/regions.js';
import type { SavingEntry, Source, Outcome } from './savings.js';

/**
 * Opt-in usage-stats sharing for `vg serve --share-stats`.
 *
 * This is the ONLY path in `vg serve` that sends anything off the machine, and
 * it is off unless the operator explicitly asks for it. What we send is the
 * same counts-only ledger `vg savings` reports locally — per (source, client,
 * tool, outcome): how many calls and the vg-vs-grep token figures — plus the vg
 * version, OS/arch, and a random per-install id. We never send code, file paths,
 * question text, repo identity, or any credential. See GUARDRAILS §3.4.
 *
 * Even when the flag is passed, the universal `DO_NOT_TRACK` opt-out (or
 * `VIBGRATE_TELEMETRY=0`) wins: nothing is uploaded and no install id is ever
 * minted or persisted (see `telemetryOptOut` / `installId`).
 *
 * Design:
 *  - The local ledger (savings.jsonl) is the single source of truth; the flusher
 *    reads only the tail past a persisted byte offset, so a batch is sent once.
 *  - Fire-and-forget with a short timeout. A network problem never blocks a tool
 *    call and never throws — the offset only advances on a confirmed 2xx, so a
 *    failed batch is retried on the next flush.
 *  - Fully offline-safe: under `--local` the sharer is never constructed.
 */

/** Payload schema version — must match the server's `mcpUsageStatsSchema`. */
const SCHEMA_VERSION = '1';
/** Where the offset (and cached install id) live, per repo, beside the ledger. */
const OFFSET_FILE = 'stats-share.json';
/** The machine-global anonymous install id lives here (stable across repos). */
const INSTALL_ID_DIR = path.join(os.homedir(), '.vibgrate');
const INSTALL_ID_FILE = path.join(INSTALL_ID_DIR, 'install-id');
/** Give a flush POST a hard ceiling so a hung endpoint never stalls shutdown. */
const SEND_TIMEOUT_MS = 4000;

/** One aggregated row of the shared batch — counts only. */
export interface StatsRow {
  source: Source;
  client: string;
  tool: string;
  outcome: Outcome;
  calls: number;
  vgTokens: number;
  baselineTokens: number;
}

/** The counts-only batch POSTed to the ingest endpoint. */
export interface StatsBatch {
  schemaVersion: string;
  installId: string;
  vgVersion: string;
  os: string;
  arch: string;
  windowStart: string;
  windowEnd: string;
  totalCalls: number;
  rows: StatsRow[];
}

/**
 * The universal opt-out (https://consoledonottrack.com) plus a tool-specific
 * alias, honoured even when `--share-stats` is passed explicitly. Pure function
 * of the environment for testability. Returns the name of the variable that
 * opted out (for the disclosure message), or null when sharing may proceed.
 */
export function telemetryOptOut(env: NodeJS.ProcessEnv = process.env): string | null {
  const dnt = (env.DO_NOT_TRACK ?? '').trim().toLowerCase();
  if (dnt !== '' && dnt !== '0' && dnt !== 'false') return 'DO_NOT_TRACK';
  const vt = (env.VIBGRATE_TELEMETRY ?? '').trim().toLowerCase();
  if (vt === '0' || vt === 'false' || vt === 'off') return 'VIBGRATE_TELEMETRY';
  return null;
}

/** Common CI environment markers — a CI runner is never an interactive session. */
const CI_ENV_VARS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TF_BUILD',
] as const;

/** True when running under a recognised CI system. Pure function of the env. */
export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return CI_ENV_VARS.some((v) => {
    const val = (env[v] ?? '').trim().toLowerCase();
    return val !== '' && val !== '0' && val !== 'false';
  });
}

/**
 * Read (or lazily create) the anonymous per-install id — a random UUID stored in
 * `~/.vibgrate/install-id`. It is *not* tied to the user, the repo, or any
 * account; it only lets us de-duplicate batches from the same install when
 * aggregating. If the home dir isn't writable we fall back to an ephemeral id
 * so sharing still works (it just can't be de-duplicated across restarts).
 *
 * Under an env opt-out no id is ever read or persisted (the sharing path isn't
 * reached then either — this is defence in depth), and on CI runners the id is
 * ephemeral: a persisted id on a shared/throwaway runner would be meaningless
 * for de-duplication and would leave state behind on machines we don't own.
 */
export function installId(env: NodeJS.ProcessEnv = process.env): string {
  if (telemetryOptOut(env) !== null || isCI(env)) return randomUuid();
  try {
    const existing = fs.readFileSync(INSTALL_ID_FILE, 'utf8').trim();
    if (isUuid(existing)) return existing;
  } catch {
    /* not created yet */
  }
  const id = randomUuid();
  try {
    fs.mkdirSync(INSTALL_ID_DIR, { recursive: true });
    fs.writeFileSync(INSTALL_ID_FILE, id + '\n', { mode: 0o600 });
  } catch {
    /* home dir read-only — use the ephemeral id for this process */
  }
  return id;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function randomUuid(): string {
  return randomUUID();
}

/** Resolve the ingest endpoint: env override wins, else the default region host. */
export function statsEndpoint(): string {
  const override = process.env.VIBGRATE_STATS_ENDPOINT;
  if (override && /^https?:\/\//.test(override)) return override;
  return `https://${resolveIngestHost()}/v1/ingest/cli-mcp-usage`;
}

function offsetPath(root: string): string {
  return path.join(cacheDir(root), OFFSET_FILE);
}

function ledgerFilePath(root: string): string {
  return path.join(cacheDir(root), 'savings.jsonl');
}

function readOffset(root: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(offsetPath(root), 'utf8')) as { offset?: number };
    return typeof raw.offset === 'number' && raw.offset >= 0 ? raw.offset : 0;
  } catch {
    return 0;
  }
}

function writeOffset(root: string, offset: number): void {
  try {
    fs.mkdirSync(cacheDir(root), { recursive: true });
    fs.writeFileSync(offsetPath(root), JSON.stringify({ offset }) + '\n');
  } catch {
    /* best-effort; a lost offset just means one batch may re-send */
  }
}

/**
 * Aggregate the ledger entries after `fromOffset` into a counts-only batch.
 * Returns the batch (or null if there's nothing new) and the new byte offset to
 * persist once the batch is confirmed sent.
 */
export function buildBatch(
  root: string,
  fromOffset: number,
  id = installId(),
): { batch: StatsBatch | null; newOffset: number } {
  const file = ledgerFilePath(root);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { batch: null, newOffset: 0 };
  }
  // The ledger was truncated/recreated under us — re-read from the top.
  const start = fromOffset > size ? 0 : fromOffset;
  if (start >= size) return { batch: null, newOffset: size };

  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { batch: null, newOffset: fromOffset };
  }

  // Only whole lines are complete; a trailing partial line (mid-append) is left
  // for the next flush by rewinding the offset to the last newline.
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return { batch: null, newOffset: start };
  const consumed = start + lastNl + 1;
  const rows = new Map<string, StatsRow>();
  let total = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const line of text.slice(0, lastNl).split('\n')) {
    if (!line.trim()) continue;
    let e: SavingEntry;
    try {
      e = JSON.parse(line) as SavingEntry;
    } catch {
      continue;
    }
    const source: Source = e.source ?? 'mcp';
    const client = e.client ?? 'unknown';
    const outcome: Outcome = e.outcome ?? 'complete';
    const key = `${source}|${client}|${e.tool}|${outcome}`;
    const row = rows.get(key) ?? {
      source,
      client,
      tool: e.tool,
      outcome,
      calls: 0,
      vgTokens: 0,
      baselineTokens: 0,
    };
    row.calls++;
    row.vgTokens += e.vgTokens ?? 0;
    row.baselineTokens += e.baselineTokens ?? 0;
    rows.set(key, row);
    total++;
    if (typeof e.ts === 'number') {
      if (e.ts < minTs) minTs = e.ts;
      if (e.ts > maxTs) maxTs = e.ts;
    }
  }
  if (total === 0 || !Number.isFinite(minTs)) return { batch: null, newOffset: consumed };
  const batch: StatsBatch = {
    schemaVersion: SCHEMA_VERSION,
    installId: id,
    vgVersion: VERSION,
    os: process.platform,
    arch: process.arch,
    windowStart: new Date(minTs).toISOString(),
    windowEnd: new Date(maxTs).toISOString(),
    totalCalls: total,
    rows: [...rows.values()],
  };
  return { batch, newOffset: consumed };
}

/**
 * POST a batch to the endpoint. Never throws; returns whether it was accepted.
 * A short timeout keeps a hung endpoint from stalling the caller (e.g. shutdown).
 */
async function postBatch(batch: StatsBatch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(statsEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify(batch),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Periodic + on-shutdown flusher for one serve session. Holds the install id and
 * the persisted offset so each flush reads only new ledger lines and advances the
 * offset only when the batch is confirmed sent.
 */
export class StatsSharer {
  private readonly id = installId();
  private offset: number;
  private flushing = false;

  constructor(private readonly root: string) {
    this.offset = readOffset(root);
  }

  /**
   * Flush any new ledger entries. Single-flight (a slow POST won't overlap the
   * next tick). Best-effort: any failure is swallowed and retried next time.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const { batch, newOffset } = buildBatch(this.root, this.offset, this.id);
      if (!batch) {
        // Nothing to send, but still advance past consumed blank/partial space.
        if (newOffset > this.offset) {
          this.offset = newOffset;
          writeOffset(this.root, newOffset);
        }
        return;
      }
      const ok = await postBatch(batch);
      if (ok) {
        this.offset = newOffset;
        writeOffset(this.root, newOffset);
      }
    } catch {
      /* never let sharing break serving */
    } finally {
      this.flushing = false;
    }
  }
}
