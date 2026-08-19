import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isRelevantChange } from '../../engine/watch-filter.js';
import { isDependencyFile } from '../../lsp/scan-cache.js';
import { clearDetectGitRefCache, detectGitRef } from '../git-ref.js';

/**
 * Keeping the daemon's maps current, inside the daemon.
 *
 * Freshness used to live in every consumer instead: `vg serve` and `vg lsp`
 * each ran their own recursive `fs.watch` and their own `RefreshScheduler`, and
 * `vg ask` probed inline on each invocation. vgd — the one process actually
 * holding the graphs — had none of it, so its slots aged out silently while
 * three other processes duplicated the work of noticing.
 *
 * **Rebuilds run in a child, never here.** This is the load-bearing constraint.
 * `buildGraph` on a large repo blocks for seconds, and vgd is single-threaded:
 * the protocol already carries a scar from this (`put-graph` re-encoding a
 * graph "blocked the daemon's event loop for seconds, timing out every
 * concurrent client"). Now that `vg ask` ranks through the daemon, an inline
 * rebuild would stall every ask and every editor call for its whole duration.
 * So a rebuild is `vg build` in a detached child, and the daemon only reloads
 * the finished snapshot from disk — work it already does in microseconds.
 *
 * **Three triggers, one path.** Source edits, dependency-manifest/lockfile
 * edits, and branch switches all converge on "rebuild this repo, then reload
 * the slot". Branch switches additionally re-select the slot first, because a
 * branch's snapshot may already be warm and need no build at all.
 */

/** Settle window after the last change before a rebuild starts. */
export const DEFAULT_SETTLE_MS = 600;
/** Floor between two rebuilds of the same repo, however noisy the tree is. */
export const DEFAULT_MIN_REBUILD_GAP_MS = 5_000;
/** A rebuild child that outlives this is abandoned (never left to wedge a slot). */
export const DEFAULT_REBUILD_TIMEOUT_MS = 10 * 60_000;

export type FreshnessLog = (message: string) => void;

export interface FreshnessReload {
  /** Reload this repo's map from disk into its slot. Returns node count, or null. */
  (repositoryId: string, root: string, gitRef: string): Promise<number | null>;
}

export interface FreshnessSelect {
  /** Point the repo at a different ref's slot (branch switch). */
  (repositoryId: string, gitRef: string): void;
}

export interface FreshnessOptions {
  log?: FreshnessLog;
  reload: FreshnessReload;
  select: FreshnessSelect;
  settleMs?: number;
  minRebuildGapMs?: number;
  rebuildTimeoutMs?: number;
  /** Injected watcher (tests). Must return something with `close()`. */
  watch?: (dir: string, onChange: (filename: string) => void) => { close(): void } | null;
  /** Injected rebuild (tests). Resolves when the child finishes. */
  rebuild?: (root: string) => Promise<{ ok: boolean; error?: string }>;
  /** Injected ref detection (tests). Default re-reads git, bypassing the memo. */
  detectRef?: (root: string) => string;
  now?: () => number;
}

interface Watched {
  repositoryId: string;
  root: string;
  gitRef: string;
  source: { close(): void } | null;
  head: { close(): void } | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Files seen since the last rebuild — reported, then cleared. */
  pending: Set<string>;
  /** A rebuild is in flight; further changes coalesce into the next one. */
  building: boolean;
  /** Another change arrived while building — rebuild again when it lands. */
  again: boolean;
  lastRebuildAt: number;
}

export interface FreshnessSummary {
  repositoryId: string;
  root: string;
  gitRef: string;
  watching: boolean;
  pending: number;
  building: boolean;
  lastRebuildAt?: number;
}

export class FreshnessSupervisor {
  private readonly watched = new Map<string, Watched>();
  /** Told when a manifest or lockfile is written — the shared dependency cache. */
  private manifestListener?: (repositoryId: string) => void;
  private readonly log: FreshnessLog;
  private readonly reload: FreshnessReload;
  private readonly select: FreshnessSelect;
  private readonly settleMs: number;
  private readonly minRebuildGapMs: number;
  private readonly rebuildTimeoutMs: number;
  private readonly watchImpl: NonNullable<FreshnessOptions['watch']>;
  private readonly rebuildImpl: NonNullable<FreshnessOptions['rebuild']>;
  private readonly detectRef: (root: string) => string;
  private readonly now: () => number;

  constructor(options: FreshnessOptions) {
    this.log = options.log ?? ((): void => {});
    this.reload = options.reload;
    this.select = options.select;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.minRebuildGapMs = options.minRebuildGapMs ?? DEFAULT_MIN_REBUILD_GAP_MS;
    this.rebuildTimeoutMs = options.rebuildTimeoutMs ?? DEFAULT_REBUILD_TIMEOUT_MS;
    this.watchImpl = options.watch ?? defaultWatch;
    this.rebuildImpl = options.rebuild ?? ((root) => spawnRebuild(root, this.rebuildTimeoutMs));
    this.detectRef = options.detectRef ?? defaultDetectRef;
    this.now = options.now ?? ((): number => Date.now());
  }

  /**
   * Attach something that must forget derived state when a manifest or
   * lockfile changes. The watcher is already looking at exactly these files,
   * so a cache hung off this has no staleness window — unlike a TTL.
   */
  setManifestListener(listener: (repositoryId: string) => void): void {
    this.manifestListener = listener;
  }

  list(): FreshnessSummary[] {
    return [...this.watched.values()]
      .map((w) => ({
        repositoryId: w.repositoryId,
        root: w.root,
        gitRef: w.gitRef,
        watching: !!w.source,
        pending: w.pending.size,
        building: w.building,
        lastRebuildAt: w.lastRebuildAt || undefined,
      }))
      .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId));
  }

  /**
   * Start watching a repository. Idempotent: re-registering the same root only
   * updates the ref it believes is current.
   */
  start(repositoryId: string, root: string, gitRef: string): void {
    const existing = this.watched.get(repositoryId);
    if (existing) {
      existing.gitRef = gitRef;
      return;
    }
    const entry: Watched = {
      repositoryId,
      root,
      gitRef,
      source: null,
      head: null,
      timer: null,
      pending: new Set(),
      building: false,
      again: false,
      lastRebuildAt: 0,
    };
    this.watched.set(repositoryId, entry);

    entry.source = this.watchImpl(root, (filename) => {
      // `isRelevantChange` also filters vg's own artifacts — without it every
      // rebuild would observe its own output and trigger the next one.
      if (!isRelevantChange(filename)) return;
      entry.pending.add(filename);
      const manifest = isDependencyFile(root, path.join(root, filename));
      if (manifest) this.manifestListener?.(entry.repositoryId);
      this.schedule(entry, manifest ? 'manifest' : 'source');
    });

    // `.git` is excluded from the source watcher by design (its churn is not
    // source change), so branch detection needs its own narrow watch on HEAD.
    const gitDir = path.join(root, '.git');
    if (fs.existsSync(gitDir)) {
      entry.head = this.watchImpl(gitDir, (filename) => {
        if (path.basename(filename) !== 'HEAD') return;
        this.onHeadChanged(entry);
      });
    }

    this.log(
      `freshness: watching ${repositoryId} @${gitRef} (${entry.source ? 'source' : 'no source watcher'}${entry.head ? ' + HEAD' : ''})`,
    );
  }

  /** Stop watching one repository — its slot is gone or was unregistered. */
  stop(repositoryId: string): void {
    const entry = this.watched.get(repositoryId);
    if (!entry) return;
    this.watched.delete(repositoryId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.source?.close();
    entry.head?.close();
    this.log(`freshness: stopped watching ${repositoryId}`);
  }

  /** Daemon shutdown. */
  stopAll(): void {
    for (const id of [...this.watched.keys()]) this.stop(id);
  }

  /**
   * A branch switch: re-select first, and rebuild only when that ref has no
   * usable snapshot. Checking out a branch you were on ten minutes ago should
   * be instant, not a full rebuild.
   */
  private onHeadChanged(entry: Watched): void {
    const ref = this.detectRef(entry.root);
    if (!ref || ref === entry.gitRef) return;
    const from = entry.gitRef;
    entry.gitRef = ref;
    entry.pending.clear();
    this.log(`freshness: ${entry.repositoryId} branch ${from} → ${ref}`);
    this.select(entry.repositoryId, ref);
    void this.reload(entry.repositoryId, entry.root, ref).then((nodes) => {
      if (nodes != null) {
        this.log(`freshness: ${entry.repositoryId}@${ref} slot warm from disk — ${nodes} nodes`);
      } else {
        this.log(`freshness: ${entry.repositoryId}@${ref} has no snapshot yet — rebuilding`);
        this.schedule(entry, 'branch');
      }
    });
  }

  private schedule(entry: Watched, reason: 'source' | 'manifest' | 'branch'): void {
    if (entry.building) {
      entry.again = true;
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    // Hold a noisy tree to one rebuild per gap, measured from the last one.
    const sinceLast = this.now() - entry.lastRebuildAt;
    const wait = Math.max(this.settleMs, entry.lastRebuildAt ? this.minRebuildGapMs - sinceLast : 0);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.rebuild(entry, reason);
    }, wait);
    entry.timer.unref?.();
  }

  private async rebuild(entry: Watched, reason: string): Promise<void> {
    if (entry.building) {
      entry.again = true;
      return;
    }
    entry.building = true;
    const changed = entry.pending.size;
    const names = [...entry.pending].sort().slice(0, 3).join(', ');
    entry.pending.clear();
    const started = this.now();
    this.log(
      `freshness: rebuilding ${entry.repositoryId}@${entry.gitRef} (${reason}${changed ? `, ${changed} file(s): ${names}` : ''})…`,
    );
    try {
      const result = await this.rebuildImpl(entry.root);
      entry.lastRebuildAt = this.now();
      if (!result.ok) {
        this.log(`freshness: rebuild failed for ${entry.repositoryId} — ${result.error ?? 'unknown'}; slot keeps its previous map`);
        return;
      }
      const nodes = await this.reload(entry.repositoryId, entry.root, entry.gitRef);
      this.log(
        nodes != null
          ? `freshness: ${entry.repositoryId}@${entry.gitRef} reloaded — ${nodes} nodes in ${this.now() - started}ms`
          : `freshness: ${entry.repositoryId}@${entry.gitRef} rebuilt but no snapshot to reload`,
      );
    } catch (err) {
      this.log(`freshness: rebuild errored for ${entry.repositoryId} — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      entry.building = false;
      if (entry.again) {
        entry.again = false;
        this.schedule(entry, 'source');
      }
    }
  }
}

/**
 * Read the current ref, defeating the module-level memo first: `detectGitRef`
 * caches per root for the life of the process, which is exactly wrong in a
 * daemon that outlives many checkouts.
 */
function defaultDetectRef(root: string): string {
  clearDetectGitRefCache(root);
  return detectGitRef(root).ref;
}

function defaultWatch(dir: string, onChange: (filename: string) => void): { close(): void } | null {
  try {
    const w = fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (filename) onChange(String(filename));
    });
    w.unref?.();
    return w;
  } catch {
    // A platform without recursive watch, or a root that vanished: freshness
    // degrades to "whatever the next command publishes", never to a crash.
    return null;
  }
}

/**
 * Rebuild in a detached child running the CLI's own `build`.
 *
 * `--no-daemon` matters: without it the child would attach and publish back
 * into the daemon that spawned it, which is both circular and racy — the
 * daemon reloads from disk itself once the child exits.
 */
function spawnRebuild(root: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [process.argv[1] ?? '', 'build', '-C', root, '--json', '--no-daemon', '--no-warm'], {
        stdio: 'ignore',
        env: { ...process.env, NODE_OPTIONS: '' },
        // A console-less daemon parent means this child (and its git/npm
        // grandchildren, which inherit the console this flag creates) would
        // otherwise pop visible console windows on Windows for every
        // background rebuild.
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ ok: false, error: `rebuild exceeded ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: `vg build exited ${code ?? 'null'}` });
    });
  });
}
