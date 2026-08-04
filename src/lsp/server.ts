/**
 * `vg lsp` — the Vibgrate language server.
 *
 * ONE ENGINE, MANY THIN CLIENTS. This process is the only thing that knows how
 * to score drift. Every editor client (Vibgrate for VS Code, Vibgrate for
 * JetBrains) is a renderer over the messages defined here. If you find yourself
 * adding scoring, banding, or thresholding logic to a client, it belongs here
 * instead — see `docs/IDE-INTEGRATION-PLAN.md` §3, §4.
 *
 * Two rules this file exists to enforce:
 *
 *  1. **The wire carries a `band`, never a colour.** Clients map band → their
 *     own native theme colour. Ship a hex from here and every client inherits
 *     the light-mode bug (plan §5.0).
 *  2. **Never emit an Error-severity diagnostic.** Vibgrate is not a gate.
 *     The engine's findings use `error` for EOL runtimes; we deliberately clamp
 *     that to Warning on the way out (plan §8.2). Erroring in the Problems panel
 *     is how an ambient tool gets uninstalled.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as semver from 'semver';

import { runCoreScan } from '../core-open/index.js';
import type { ScanArtifact, ScanOptions, DependencyRow, ProjectScan, DriftScore } from '../core-open/index.js';
import { perDependencyDrift } from '../core-open/scoring/dependency-drift-v3.js';
import { loadAdvancedScanHook } from '../reporting/advanced-hook.js';
import { VERSION } from '../version.js';
import { Connection } from './protocol.js';
import {
  findPackageLine,
  findRuntimeLine,
  endOfLine,
  isManifest,
  manifestKind,
} from './manifest-positions.js';
import { buildGraph } from '../engine/build.js';
import { loadGraph } from '../engine/load.js';
import { writeArtifacts, resolveGraphPath } from '../engine/artifacts.js';
import { writeSnapshot } from '../engine/freshness.js';
import { refreshIfStale } from '../engine/refresh.js';
import { manifestHash, loadScanCache, writeScanCache, isDependencyFile } from './scan-cache.js';
import { SKIP_DIRS } from '../engine/discover.js';
import { recordScore, lastEntry, deltaFrom, recentHistory, type ScoreHistoryEntry } from './score-history.js';
import { runGraphQuery, type GraphQueryParams, type GraphQueryResult } from './graph-query.js';
import {
  enrichVulns,
  scanWorkspaceVulns,
  type EnrichResult,
  type Reachability,
  type VulnTarget,
  type VulnsWorkspaceResult,
  type VulnReachSite,
} from './enrich.js';
import type { VgGraph } from '../schema.js';

// ── Wire types (the contract every client renders) ─────────────────────────

/** DriftScore band. Mirrors the engine — clients must never re-derive it. */
export type Band = 'low' | 'moderate' | 'high';

/**
 * `vibgrate/scanArtifact` — full Drift scan artifact as prettified JSON for
 * Output ▸ Vibgrate Scan. Kept off the main log channel so operational noise
 * (graph, engine, install) stays readable. Clients must not parse this for UI
 * state — score, band, and inventory still come from `vibgrate/score`.
 */
export interface ScanArtifactNotification {
  /** Pretty-printed scan artifact JSON (same shape as `vg scan --format json`). */
  json: string;
  rootPath: string;
  scannedAt: string;
  /** True when the artifact was replayed from the local LSP scan cache. */
  fromCache?: boolean;
}

/** `vibgrate/score` — pushed whenever the score changes. Drives the status bar. */
export interface ScoreNotification {
  score: number;
  /** DRIFTSCORE-V3-SPEC §5. Clients map band → theme colour; we never send one. */
  band: Band;
  /** `estimated` renders with a leading `~` (v3 §2.4). Offline is NOT estimated. */
  mode: 'verified' | 'estimated';
  /** Clients must break trend lines across a change here (v3 version-tag note). */
  methodology: string;
  scale: '0 best, 100 worst';
  counts: { behind: number; eol: number; unmaintained: number; total: number };
  rootPath: string;
  scannedAt: string;
  /**
   * Drift diff (plan §5.8): signed change from the previously recorded score,
   * engine-computed, same-methodology only. Absent — never 0 — when there is
   * no comparable previous score. Clients render `⌁ +4` / `⌁ -3`; they never
   * subtract two scores themselves.
   */
  delta?: number;
  /**
   * Full dependency inventory for the Dependencies panel — every scoreable
   * package in scope, ranked worst-first (current packages included at drift 0).
   * Built with the same per-dependency scorer as the DriftScore aggregate so the
   * panel number and the row numbers never disagree. Absent when there are no
   * scoreable dependencies. Vulnerability enrichment is fetched lazily on
   * expand, not carried here.
   */
  breakdown?: BreakdownItem[];
  /**
   * Upcoming/overdue runtime end-of-life dates (plan §5.6 "EOL horizon"),
   * soonest/most-overdue first. Built only from real endoflife.date cycles
   * already resolved onto each project (`ProjectScan.runtimeEolDate`) — never
   * the major-version-lag proxy, and never a client-side estimate. Absent when
   * no project has a known EOL date (e.g. an unmapped runtime, or offline).
   */
  eolHorizon?: EolHorizonItem[];
  /**
   * Scanned projects in this workspace (monorepo inventory). Clients use this
   * for a Snyk-style project picker: whole workspace vs one package path.
   * Absent or empty when the scan found nothing scoreable.
   */
  projects?: ProjectRef[];
}

/** One scanned package/project for the monorepo scope picker. */
export interface ProjectRef {
  /** Workspace-relative project path (`.` for the repo root package). */
  path: string;
  /** Human label — package name when known, else the path basename. */
  name: string;
  /** Per-project DriftScore when the engine scored this project. */
  score?: number;
  band?: Band;
  /** `estimated` → badge/tooltip use a leading `~` (same as the status bar). */
  mode?: 'verified' | 'estimated';
  /** Workspace-relative path to this project's manifest (package.json, .csproj, …). */
  manifestPath?: string;
  /** Workspace-relative path to this project's lockfile, when one was resolved. */
  lockfilePath?: string;
}

/**
 * `vibgrate/architecture` — pulled by the Architecture panel on scope change.
 * `undefined path` (or `'__repo__'`) returns the whole-workspace aggregate;
 * a project path returns that project's own architecture detection.
 */
export interface ArchitectureResponse {
  archetype: ProjectArchetypeWire;
  archetypeConfidence: number;
  layers: LayerSummaryWire[];
  totalClassified: number;
  unclassified: number;
  /** Workspace-relative manifest path — absent at whole-workspace scope. */
  manifestPath?: string;
  /** Workspace-relative lockfile path — absent at whole-workspace scope or when none was resolved. */
  lockfilePath?: string;
}

type ProjectArchetypeWire = string;

/** Per-layer summary, wire shape mirrors `LayerSummary` in core-open/types.ts. */
export interface LayerSummaryWire {
  layer: string;
  fileCount: number;
  driftScore: number;
  riskLevel: 'none' | Band;
  techStack: Array<{ name: string; package: string; version: string | null }>;
  services: Array<{ name: string; package: string; version: string | null }>;
  packages: Array<{
    name: string;
    version: string | null;
    latestStable: string | null;
    majorsBehind: number | null;
    drift: 'current' | 'minor-behind' | 'major-behind' | 'unknown';
  }>;
  /** Workspace- or project-relative sample file paths classified into this layer. */
  files: string[];
}

/** One runtime's real EOL date and distance from today, for the panel's horizon. */
export interface EolHorizonItem {
  /** Human label, e.g. "Node.js 18" — not the raw project path. */
  runtime: string;
  /** ISO end-of-life date from the Runtime Catalog (endoflife.date). */
  eolDate: string;
  /** Negative = already past EOL by this many days. */
  daysUntil: number;
}

/** Manifest hit for a dependency (workspace-relative path + optional line). */
export interface BreakdownLocation {
  file: string;
  /** 1-based line of the package in the manifest, when known. */
  line: number | null;
}

/** One dependency's contribution to the score, for the panel accordion. */
export interface BreakdownItem {
  package: string;
  section: string;
  /**
   * OSV.dev ecosystem slug for this dependency (npm, PyPI, Go, Maven, crates.io,
   * RubyGems, NuGet, Packagist, Pub, …), from the owning project's type. Null
   * when the ecosystem has no OSV mapping — the client then skips enrichment.
   */
  ecosystem: string | null;
  /** 0–100 drift contribution for this dependency. */
  drift: number;
  /** Band for `drift` — the client maps it to a colour; it never re-derives it. */
  band: Band;
  currentSpec: string;
  resolvedVersion: string | null;
  latestStable: string | null;
  majorsBehind: number | null;
  ageDays: number | null;
  mode: 'verified' | 'estimated';
  unsupported: boolean;
  abandoned: boolean;
  /** Data-quality guards that fired (canary-latest, scheme-jump, high-cadence…). */
  flags: string[];
  /**
   * Every project manifest that pins this package — the Dependencies panel
   * lists these as open-in-editor links (same pattern as the Vulnerabilities panel).
   */
  locations: BreakdownLocation[];
}

/** One coloured end-of-line decoration. `vibgrate/inline`, pushed per open manifest. */
export interface InlineItem {
  line: number;
  endCol: number;
  text: string;
  band: Band;
  package: string;
}

export interface InlineNotification {
  uri: string;
  items: InlineItem[];
}

/**
 * `vibgrate/status` — a scan lifecycle signal that carries no score. Currently
 * only `error`, pushed when a scan fails, so a client never sits on a "scanning"
 * placeholder forever. Deliberately minimal and non-alarming (the client shows a
 * quiet state, never a toast).
 */
export interface StatusNotification {
  state: 'error';
}

/**
 * `vibgrate/graph/status` — mirrors `vibgrate/status` but for the code map:
 * lets a client show a "building the map…" placeholder for the Graph section
 * the first time it runs on a repo, without blocking the drift score.
 */
export interface GraphStatusNotification {
  /** `disabled` = the client launched with `--no-graph` (the Graph setting is off). */
  state: 'building' | 'ready' | 'error' | 'disabled';
  message?: string;
}

// ── Band + severity mapping ────────────────────────────────────────────────

/**
 * Per-dependency band, from the engine's drift classification.
 *
 * NOTE (P0, plan §0.3): the repo currently ships two band systems — the score
 * bands here (low ≤30 / moderate ≤60 / high >60, `drift-score.ts`) and the
 * badge/dashboard bands (green ≤20 / amber ≤50 / red >50, `drift-badge.ts`).
 * They disagree for scores in 21–30 and 51–60. DRIFTSCORE-V3-SPEC §6 item 5
 * schedules the reconciliation. When it lands, this is the ONLY place in the
 * IDE stack that changes — which is the entire reason clients are forbidden
 * from deriving a band themselves.
 */
function bandForDependency(dep: DependencyRow): Band {
  if (dep.drift === 'major-behind') {
    return (dep.majorsBehind ?? 1) >= 2 ? 'high' : 'moderate';
  }
  if (dep.drift === 'minor-behind') return 'moderate';
  return 'low';
}

/**
 * The engine emits `error` for an EOL runtime. The editor must not.
 * See the file header, rule 2.
 */
function severityFor(level: 'warning' | 'error' | 'note'): 1 | 2 | 3 | 4 {
  // LSP DiagnosticSeverity: 1 Error · 2 Warning · 3 Information · 4 Hint
  if (level === 'note') return 3;
  return 2; // both `warning` and `error` clamp to Warning. Never 1.
}

/**
 * Only hard facts reach the Problems panel, and only when the user opts in.
 * "You are two minors behind" is not a defect and does not belong here
 * (plan §8.2).
 */
const DIAGNOSTIC_RULES = new Set([
  'vibgrate/runtime-eol',
  'vibgrate/runtime-lag',
  'vibgrate/unmaintained',
  'vibgrate/abandoned',
  'vibgrate/license-change',
  'vibgrate/eol',
]);

// ── Server ─────────────────────────────────────────────────────────────────

interface ServerOptions {
  root: string;
  offline: boolean;
  /** Problems-panel diagnostics. OFF unless the client asks (plan §8.1). */
  diagnostics: boolean;
  /** The local Vibgrate Graph. `false` (`--no-graph`) skips the background build and disables graph queries. */
  graph: boolean;
  /** Semantic search over the graph. `false` (`--no-semantic`) forces lexical and never downloads the embedding model. */
  semantic: boolean;
}

export class VibgrateLanguageServer {
  private readonly conn: Connection;
  private readonly docs = new Map<string, string>(); // uri → text
  private artifact: ScanArtifact | null = null;
  private scanning = false;
  private queued = false;
  /**
   * Sticky until the next `scan()` runs: set by explicit "Rescan Workspace"
   * (and preserved if a non-force schedule races the debounce). Bypasses the
   * LSP scan cache so config/SKIP_DIRS changes actually re-score.
   */
  private forceNextScan = false;
  private debounce: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private graph: VgGraph | null = null;
  private graphBuilding = false;

  constructor(
    private readonly opts: ServerOptions,
    output: NodeJS.WritableStream = process.stdout,
  ) {
    this.conn = new Connection(process.stdin, output);
    this.register();
  }

  private register(): void {
    this.conn.onRequest('initialize', () => ({
      capabilities: {
        // 1 = Full sync. We only actually act on save, but full sync keeps our
        // buffer honest so hovers land on the text the user is looking at.
        textDocumentSync: 1,
        hoverProvider: true,
        codeLensProvider: { resolveProvider: false },
        executeCommandProvider: {
          commands: ['vibgrate.rescan', 'vibgrate.explain', 'vibgrate.routeFix'],
        },
      },
      serverInfo: { name: 'Vibgrate', version: VERSION },
    }));

    this.conn.onNotification('initialized', () => {
      this.scheduleScan(0);
      // Independent of the drift scan — a slow first graph build must not
      // delay the score the status bar/panel are waiting on.
      void this.ensureGraph();
    });

    this.conn.onNotification('textDocument/didOpen', (_m, params) => {
      const p = params as { textDocument?: { uri?: string; text?: string } };
      const uri = p.textDocument?.uri;
      if (!uri || !isManifest(uriToPath(uri))) return;
      this.docs.set(uri, p.textDocument?.text ?? '');
      // Already scanned? Render immediately — don't make the user wait on a
      // rescan just because they opened a second manifest.
      if (this.artifact) this.publishForDoc(uri);
      else this.scheduleScan(0);
    });

    this.conn.onNotification('textDocument/didChange', (_m, params) => {
      const p = params as {
        textDocument?: { uri?: string };
        contentChanges?: { text?: string }[];
      };
      const uri = p.textDocument?.uri;
      if (!uri || !this.docs.has(uri)) return;
      const full = p.contentChanges?.[p.contentChanges.length - 1]?.text;
      if (typeof full === 'string') this.docs.set(uri, full);
      // Do NOT rescan on keystroke — that is how you get a tool that heats a
      // laptop. Re-anchor the existing decorations against the new text only.
      if (this.artifact) this.publishForDoc(uri);
    });

    this.conn.onNotification('textDocument/didSave', (_m, params) => {
      const p = params as { textDocument?: { uri?: string } };
      const uri = p.textDocument?.uri;
      if (!uri || !this.docs.has(uri)) return;
      this.scheduleScan(400);
    });

    // External writers — a terminal `vg fix`, a `git checkout`, a package
    // manager install — change manifests without ever producing a `didSave`
    // (that only fires for saves made inside the editor). Without this, the
    // last artifact's decorations stay anchored to the updated text and the
    // editor keeps showing "behind" on a line that is now current. The client
    // watches dependency files and forwards changes here; a false positive is
    // near-free because `scan()` gates on the manifest hash and replays the
    // cache when nothing a scan reads actually changed.
    this.conn.onNotification('workspace/didChangeWatchedFiles', (_m, params) => {
      const p = params as { changes?: { uri?: string }[] };
      const relevant = (p.changes ?? []).some(
        (c) => c.uri && isDependencyFile(this.opts.root, uriToPath(c.uri)),
      );
      if (relevant) this.scheduleScan(400); // same debounce as didSave
    });

    this.conn.onNotification('textDocument/didClose', (_m, params) => {
      const p = params as { textDocument?: { uri?: string } };
      if (p.textDocument?.uri) this.docs.delete(p.textDocument.uri);
    });

    this.conn.onRequest('textDocument/hover', (_m, params) => this.onHover(params));
    this.conn.onRequest('textDocument/codeLens', (_m, params) => this.onCodeLens(params));

    this.conn.onRequest('vibgrate/graph/query', (_m, params) => this.onGraphQuery(params));
    this.conn.onRequest('vibgrate/score/forFile', (_m, params) => this.onScoreForFile(params));
    this.conn.onRequest('vibgrate/score/forProject', (_m, params) => this.onScoreForProject(params));
    this.conn.onRequest('vibgrate/architecture', (_m, params) => this.onArchitecture(params));
    // Trend data for the panel sparkline (plan §5.6). Entries carry their
    // methodology so the client can break the line across a change — the one
    // trend rule v3 imposes. Empty history is an empty array, not an error.
    this.conn.onRequest('vibgrate/score/history', (_m, params) => {
      const p = params as { days?: number } | undefined;
      const days = typeof p?.days === 'number' && p.days > 0 && p.days <= 365 ? p.days : 90;
      return { days, entries: recentHistory(this.opts.root, days) };
    });
    this.conn.onRequest('vibgrate/enrich', (_m, params) => this.onEnrich(params));
    this.conn.onRequest('vibgrate/vulns', (_m, _params) => this.onVulns());

    this.conn.onRequest('workspace/executeCommand', (_m, params) => {
      const p = params as { command?: string };
      if (p.command === 'vibgrate.rescan') {
        // Explicit "Rescan Workspace" must re-run the engine, not replay the
        // LSP scan cache (config/exclude/SKIP_DIRS changes don't alter the
        // manifest hash, so a cache hit would look like "nothing happened").
        this.scheduleScan(0, { force: true });
        return { ok: true };
      }
      return null;
    });

    this.conn.onRequest('shutdown', () => {
      this.shuttingDown = true;
      if (this.debounce) clearTimeout(this.debounce);
      return null;
    });

    this.conn.onNotification('exit', () => {
      process.exit(this.shuttingDown ? 0 : 1);
    });
  }

  // ── Scanning ─────────────────────────────────────────────────────────────

  private scheduleScan(delayMs: number, opts?: { force?: boolean }): void {
    if (opts?.force) this.forceNextScan = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.scan(), delayMs);
  }

  private async scan(): Promise<void> {
    if (this.scanning) {
      this.queued = true;
      return;
    }
    this.scanning = true;
    const force = this.forceNextScan;
    this.forceNextScan = false;

    try {
      // The expensive part of a scan is the per-package registry lookups, not
      // reading the manifest/lockfile — so hash just those first (cheap: no
      // network) and skip `runCoreScan` entirely when nothing a scan cares
      // about has changed since the last successful scan on this machine.
      // `toolVersion`/`offline` are part of the key too: an engine upgrade or a
      // flip of `vibgrate.offline` must not replay a scan from before it.
      // Explicit Rescan Workspace sets `forceNextScan` and always re-runs.
      const cacheKey = { manifestHash: manifestHash(this.opts.root), toolVersion: VERSION, offline: this.opts.offline };
      const cached = force ? null : loadScanCache(this.opts.root, cacheKey);

      let fromCache = false;
      if (cached) {
        // Drop projects under pruned trees (e.g. `.claude/worktrees`) even when
        // replaying a cache written before those dirs were excluded.
        this.artifact = pruneArtifactProjects(cached.artifact);
        fromCache = true;
      } else {
        const scanOpts: ScanOptions = {
          format: 'json',
          concurrency: 8,
          offline: this.opts.offline,
          noLocalArtifacts: true, // an editor scan must not litter the repo
          noGraph: true, // the code map is not needed to score drift; skip the cost
          quiet: true, // no spinners, no artifact dump — an editor is not a terminal
          vibgrateVersion: VERSION,
        } as ScanOptions;

        // Same hook `vg scan` uses, so the number the editor shows is the number
        // the CLI shows — by construction, not by coincidence (plan §8.3).
        //
        // `format: 'json'` makes runCoreScan console.log the full prettified
        // artifact. In the LSP process stdout is redirected to stderr, and the
        // extension used to dump that into Output ▸ Vibgrate — drowning the
        // operational log. Suppress that dump here; we re-emit the same JSON
        // on `vibgrate/scanArtifact` for Output ▸ Vibgrate Scan instead.
        const advanced = await loadAdvancedScanHook();
        this.artifact = pruneArtifactProjects(
          await runCoreScanSilently(this.opts.root, scanOpts, advanced),
        );
        writeScanCache(this.opts.root, cacheKey, this.artifact);
      }

      this.publishScore();
      this.publishScanArtifact(fromCache);
      for (const uri of this.docs.keys()) this.publishForDoc(uri);
    } catch (err) {
      // A failed scan is silent — no red banner because a lockfile was mid-write.
      // But it must not be INVISIBLE: without a signal the client sits on its
      // "scanning…" placeholder forever. The reason goes to the log; a minimal
      // `error` status tells the client to stop pretending it is still working.
      this.conn.notify('window/logMessage', {
        type: 3,
        message: `Vibgrate scan failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.conn.notify('vibgrate/status', { state: 'error' } satisfies StatusNotification);
    } finally {
      this.scanning = false;
      if (this.queued) {
        this.queued = false;
        // forceNextScan may have been set while we were busy; keep it sticky.
        this.scheduleScan(0);
      }
    }
  }

  // ── Publishing ───────────────────────────────────────────────────────────

  /**
   * Full scan artifact for Output ▸ Vibgrate Scan. Operational messages stay
   * on window/logMessage → Output ▸ Vibgrate.
   */
  private publishScanArtifact(fromCache: boolean): void {
    const a = this.artifact;
    if (!a) return;
    this.conn.notify('vibgrate/scanArtifact', {
      json: JSON.stringify(a, null, 2),
      rootPath: a.rootPath,
      scannedAt: a.timestamp,
      ...(fromCache ? { fromCache: true } : {}),
    } satisfies ScanArtifactNotification);
  }

  private publishScore(): void {
    const a = this.artifact;
    if (!a) return;

    let behind = 0;
    let unmaintained = 0;
    let total = 0;
    for (const proj of a.projects ?? []) {
      for (const dep of proj.dependencies ?? []) {
        total++;
        if (dep.drift === 'major-behind' || dep.drift === 'minor-behind') behind++;
      }
    }
    const eol = (a.findings ?? []).filter(
      (f) => f.ruleId === 'vibgrate/runtime-eol' || f.ruleId === 'vibgrate/eol',
    ).length;
    unmaintained = (a.findings ?? []).filter(
      (f) => f.ruleId === 'vibgrate/unmaintained' || f.ruleId === 'vibgrate/abandoned',
    ).length;

    // `riskLevel` is what `driftscore-2.0` ships; v3 renames it `band` (§5
    // envelope). We normalise to `band` on the wire so clients are already
    // speaking v3 and need no change when the engine catches up.
    const band = (a.drift.riskLevel ?? 'low') as Band;

    // History + drift diff (plan §5.6/§5.8): diff against the last recorded
    // entry, then record this one. Both engine-side — clients only render.
    const historyEntry: ScoreHistoryEntry = {
      ts: a.timestamp,
      score: a.drift.score,
      band,
      mode: a.drift.mode ?? (hasReleaseDates(a) ? 'verified' : 'estimated'),
      methodology: a.drift.methodologyVersion ?? 'unknown',
    };
    const delta = deltaFrom(lastEntry(this.opts.root), historyEntry);
    recordScore(this.opts.root, historyEntry);

    const payload: ScoreNotification = {
      score: a.drift.score,
      band,
      // v3 §2.4: `estimated` means "no timestamps at all" — it is NOT an
      // offline marker. An air-gapped scan against a dated snapshot is Verified.
      // The score now carries the authoritative provenance (driftscore-3.0
      // envelope); fall back to the artifact heuristic for pre-v3 engines.
      mode: historyEntry.mode,
      methodology: historyEntry.methodology,
      scale: '0 best, 100 worst',
      counts: { behind, eol, unmaintained, total },
      rootPath: a.rootPath,
      scannedAt: a.timestamp,
      ...(delta !== undefined ? { delta } : {}),
      ...(buildBreakdown(this.opts.root, a.projects ?? [])
        ? { breakdown: buildBreakdown(this.opts.root, a.projects ?? []) }
        : {}),
      ...(buildEolHorizon(a.projects ?? []) ? { eolHorizon: buildEolHorizon(a.projects ?? []) } : {}),
      ...(buildProjectRefs(this.opts.root, a.projects ?? [])
        ? { projects: buildProjectRefs(this.opts.root, a.projects ?? []) }
        : {}),
    };

    this.conn.notify('vibgrate/score', payload);
  }

  /** Decorations + (optionally) diagnostics for one open manifest. */
  private publishForDoc(uri: string): void {
    const a = this.artifact;
    const text = this.docs.get(uri);
    if (!a || text === undefined) return;

    const filePath = uriToPath(uri);
    const kind = manifestKind(filePath);
    const project = projectForFile(this.opts.root, a, filePath);

    // ── inline decorations ──
    const items: InlineItem[] = [];
    for (const dep of project?.dependencies ?? []) {
      if (dep.drift === 'current' || dep.drift === 'unknown') continue;
      const line = findPackageLine(text, dep.package, kind);
      if (line === -1) continue;
      items.push({
        line,
        endCol: endOfLine(text, line),
        text: inlineLabel(dep),
        band: bandForDependency(dep),
        package: dep.package,
      });
    }
    this.conn.notify('vibgrate/inline', { uri, items } satisfies InlineNotification);

    // ── diagnostics (off unless the client asked) ──
    if (!this.opts.diagnostics) {
      this.conn.notify('textDocument/publishDiagnostics', { uri, diagnostics: [] });
      return;
    }

    const diagnostics = (a.findings ?? [])
      .filter((f) => DIAGNOSTIC_RULES.has(f.ruleId))
      .filter((f) => project && sameProject(f.location, project.path))
      .map((f) => {
        const line = Math.max(0, findRuntimeLine(text, kind));
        return {
          range: {
            start: { line, character: 0 },
            end: { line, character: endOfLine(text, line) },
          },
          severity: severityFor(f.level), // never 1 — see file header
          source: 'vibgrate',
          code: f.ruleId,
          message: f.message,
        };
      });

    this.conn.notify('textDocument/publishDiagnostics', { uri, diagnostics });
  }

  // ── Requests ─────────────────────────────────────────────────────────────

  private onHover(params: unknown): unknown {
    const p = params as {
      textDocument?: { uri?: string };
      position?: { line?: number; character?: number };
    };
    const uri = p.textDocument?.uri;
    const line = p.position?.line;
    const a = this.artifact;
    const text = uri ? this.docs.get(uri) : undefined;
    if (!uri || line === undefined || !a || text === undefined) return null;

    const filePath = uriToPath(uri);
    const kind = manifestKind(filePath);
    const project = projectForFile(this.opts.root, a, filePath);

    const dep = (project?.dependencies ?? []).find(
      (d) => findPackageLine(text, d.package, kind) === line,
    );
    if (!dep) return null;

    const contribution = a.drift.dependencyDrift?.top.find((t) => t.package === dep.package)?.drift ?? null;
    return {
      contents: { kind: 'markdown', value: hoverMarkdown(dep, contribution) },
    };
  }

  private onCodeLens(params: unknown): unknown {
    const p = params as { textDocument?: { uri?: string } };
    const uri = p.textDocument?.uri;
    const a = this.artifact;
    if (!uri || !a || !this.docs.has(uri)) return [];

    // ONE lens, at the top of the file. A per-dependency lens would double the
    // height of package.json — and a CodeLens cannot carry colour anyway, which
    // is why the per-dependency detail is an inline decoration (plan §5.2).
    const behind = (a.projects ?? []).reduce(
      (n, proj) =>
        n +
        (proj.dependencies ?? []).filter(
          (d) => d.drift === 'major-behind' || d.drift === 'minor-behind',
        ).length,
      0,
    );
    const eol = (a.findings ?? []).filter(
      (f) => f.ruleId === 'vibgrate/runtime-eol' || f.ruleId === 'vibgrate/eol',
    ).length;

    const estimated = (a.drift.mode ?? (hasReleaseDates(a) ? 'verified' : 'estimated')) === 'estimated';
    const mode = estimated ? '~' : '';
    const title =
      `Vibgrate · drift ${mode}${a.drift.score} (${a.drift.riskLevel}) · ` +
      `${behind} behind · ${eol} EOL`;

    return [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        command: { title, command: 'vibgrate.openPanel', arguments: [] },
      },
    ];
  }

  // ── Graph ────────────────────────────────────────────────────────────────

  /**
   * Load the committed map if one exists, else build it once (this is the
   * "first activation sets up the graph" step). Fire-and-forget from
   * `initialized` so it never blocks the drift score; a query that arrives
   * mid-build awaits the same in-flight promise via the `graphBuilding` guard.
   */
  private async ensureGraph(): Promise<void> {
    if (!this.opts.graph) {
      // Turned off by the user (`--no-graph`). Say so once, quietly — the
      // client's Graph section renders the off state instead of "building…".
      this.conn.notify('vibgrate/graph/status', { state: 'disabled' } satisfies GraphStatusNotification);
      return;
    }
    if (this.graph || this.graphBuilding) return;
    this.graphBuilding = true;
    try {
      const existing = loadGraph(this.opts.root);
      if (existing) {
        this.graph = existing;
        this.conn.notify('vibgrate/graph/status', { state: 'ready' } satisfies GraphStatusNotification);
        return;
      }

      this.conn.notify('vibgrate/graph/status', { state: 'building' } satisfies GraphStatusNotification);
      const result = await buildGraph({ root: this.opts.root });
      // Leaves `.vibgrate/graph.json` exactly as a manual `vg build` would, so
      // `vg ask` from a terminal afterward sees the same map.
      writeArtifacts(result.graph, { root: this.opts.root, html: false, report: false });
      writeSnapshot(this.opts.root, result.graph.provenance.corpusHash, result.fileStats, {});
      this.graph = result.graph;
      this.conn.notify('vibgrate/graph/status', { state: 'ready' } satisfies GraphStatusNotification);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.conn.notify('window/logMessage', { type: 3, message: `Vibgrate graph build failed: ${message}` });
      this.conn.notify('vibgrate/graph/status', { state: 'error', message } satisfies GraphStatusNotification);
    } finally {
      this.graphBuilding = false;
    }
  }

  /** The graph, refreshed if the working tree drifted since the last build (same probe `vg ask` uses). */
  private async graphForQuery(): Promise<VgGraph | null> {
    await this.ensureGraph();
    if (!this.graph) return null;
    const graphPath = resolveGraphPath(this.opts.root);
    const refreshed = await refreshIfStale(this.opts.root, { graphPath });
    if (refreshed.status === 'refreshed' && refreshed.wrote) {
      const reloaded = loadGraph(this.opts.root);
      if (reloaded) this.graph = reloaded;
    }
    return this.graph;
  }

  private async onGraphQuery(params: unknown): Promise<GraphQueryResult> {
    const p = params as GraphQueryParams;
    // The client renders a "Searching…" placeholder for the whole of this call,
    // so each stage is traced: a query that stalls should say where, not just
    // spin. Traces carry counts and timings only — never workspace text.
    const trace = (message: string): void =>
      this.conn.notify('window/logMessage', { type: 3, message: `Vibgrate graph: ${message}` });

    if (!this.opts.graph) {
      trace(`${p.mode} refused — the local Vibgrate Graph is turned off (--no-graph)`);
      return { ok: false, mode: p.mode, error: 'disabled', message: 'the local Vibgrate Graph is turned off' };
    }
    const started = Date.now();
    const graph = await this.graphForQuery();
    if (!graph) {
      trace(`${p.mode} has no code map yet — it is still building`);
      return { ok: false, mode: p.mode, error: 'not-found', message: 'no code map yet — it is still building' };
    }
    trace(
      `${p.mode} over ${graph.nodes.length} nodes / ${graph.edges.length} edges ` +
        `(map ready in ${Date.now() - started}ms)`,
    );
    return runGraphQuery(graph, p, {
      root: this.opts.root,
      offline: this.opts.offline,
      semantic: this.opts.semantic,
      log: trace,
    });
  }

  /**
   * `vibgrate/enrich` — lazy vulnerability enrichment for one expanded package,
   * straight from OSV.dev (never our API). Honours the server's offline flag.
   */
  private onEnrich(params: unknown): Promise<EnrichResult> {
    const p = (params ?? {}) as { ecosystem?: string | null; package?: string; version?: string | null };
    return enrichVulns(p.ecosystem ?? null, p.package ?? '', p.version ?? null, { offline: this.opts.offline });
  }

  /**
   * `vibgrate/vulns` — live OSV.dev pass over every resolved dependency in the
   * current workspace artifact. Powers the Vulnerabilities panel. Empty
   * findings with `source: 'osv'` means checked clean; `offline`/`error` mean
   * we could not check (absent ≠ zero). Attaches manifest locations, fixed-in
   * versions, CISA KEV flags, and a best-effort code-map reachability signal.
   */
  private async onVulns(): Promise<VulnsWorkspaceResult> {
    if (this.opts.offline) {
      return {
        findings: [],
        counts: { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 },
        packagesChecked: 0,
        source: 'offline',
        kevSource: 'skipped',
      };
    }
    const a = this.artifact;
    if (!a) {
      return {
        findings: [],
        counts: { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 },
        packagesChecked: 0,
        source: 'pending',
        kevSource: 'skipped',
      };
    }

    // Best-effort code-map import evidence (do not block on a cold build).
    const importMap = packageImportMap(this.graph);

    const targets: VulnTarget[] = [];
    for (const proj of a.projects ?? []) {
      // Stale LSP caches / older engines may still carry agent worktrees.
      // Never surface them in the Vulnerabilities panel.
      if (isPrunedWorkspacePath(proj.path) || isPrunedWorkspacePath(manifestRelativePath(proj))) {
        continue;
      }
      const ecosystem = osvEcosystem(proj.type);
      if (!ecosystem) continue;
      const relManifest = manifestRelativePath(proj);
      const absManifest = path.resolve(this.opts.root, relManifest);
      let text: string | null = null;
      try {
        if (fs.existsSync(absManifest)) text = fs.readFileSync(absManifest, 'utf8');
      } catch {
        text = null;
      }
      const kind = manifestKind(absManifest);
      for (const dep of proj.dependencies ?? []) {
        if (!dep.resolvedVersion) continue;
        let line: number | null = null;
        if (text && kind) {
          const l = findPackageLine(text, dep.package, kind);
          if (l >= 0) line = l + 1; // 1-based for the editor
        }
        let reachability: Reachability = 'unknown';
        let reachSites: VulnReachSite[] = [];
        let reachEvidence: string | null = null;
        if (importMap) {
          const files = lookupImportFiles(importMap, dep.package);
          if (files.length > 0) {
            // Package-level import evidence is "reached" for the IDE chip
            // (honest: import seen, not necessarily a vulnerable symbol).
            reachability = 'reached';
            reachSites = files.slice(0, 10).map((file) => ({
              file,
              // Best-effort first line that mentions the package name (import site).
              line: firstPackageMentionLine(this.opts.root, file, dep.package),
            }));
            reachEvidence = `${dep.package} is imported by ${files.length} file${files.length === 1 ? '' : 's'} in the code map`;
          } else {
            reachability = 'not-observed';
            reachEvidence = `no import of ${dep.package} was found in the code map`;
          }
        }
        targets.push({
          ecosystem,
          package: dep.package,
          version: dep.resolvedVersion,
          file: relManifest,
          line,
          section: dep.section ?? null,
          latestStable: dep.latestStable ?? null,
          reachability,
          reachSites,
          reachEvidence,
        });
      }
    }
    return scanWorkspaceVulns(targets, { offline: this.opts.offline });
  }

  private onScoreForFile(params: unknown): ScoreNotification | null {
    const p = params as { uri?: string };
    const a = this.artifact;
    if (!a || !p.uri) return null;
    const project = projectForFile(this.opts.root, a, uriToPath(p.uri));
    return project ? scoreForProject(this.opts.root, a, project) : null;
  }

  /**
   * `vibgrate/score/forProject` — monorepo scope picker. Returns the same
   * shape as the whole-repo score, scoped to one scanned project path.
   */
  private onScoreForProject(params: unknown): ScoreNotification | null {
    const p = params as { path?: string };
    const a = this.artifact;
    if (!a || typeof p.path !== 'string') return null;
    const project = projectByPath(a, p.path);
    return project ? scoreForProject(this.opts.root, a, project) : null;
  }

  /**
   * `vibgrate/architecture` — the Architecture panel. `path` absent or
   * `'__repo__'` returns the whole-workspace aggregate (`extended.architecture`);
   * a project path returns that project's own detection (`ProjectScan.architecture`).
   * Returns `null` when the scanner hasn't produced architecture data yet (still
   * scanning, or the archetype/layer scanner is disabled) rather than an empty
   * shape a client might mistake for "no layers detected".
   */
  private onArchitecture(params: unknown): ArchitectureResponse | null {
    const p = params as { path?: string } | undefined;
    const a = this.artifact;
    if (!a) return null;
    if (!p?.path || p.path === '__repo__') {
      const arch = a.extended?.architecture;
      if (!arch) return null;
      return {
        archetype: arch.archetype,
        archetypeConfidence: arch.archetypeConfidence,
        layers: arch.layers,
        totalClassified: arch.totalClassified,
        unclassified: arch.unclassified,
      };
    }
    const project = projectByPath(a, p.path);
    if (!project?.architecture) return null;
    return {
      archetype: project.architecture.archetype,
      archetypeConfidence: project.architecture.archetypeConfidence,
      layers: project.architecture.layers,
      totalClassified: project.architecture.totalClassified,
      unclassified: project.architecture.unclassified,
      manifestPath: manifestRelativePath(project),
      lockfilePath: lockfileRelativePath(this.opts.root, project),
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

/**
 * Run the same core scan as the CLI, but drop the `format: 'json'` console dump.
 *
 * `runCoreScan` always `console.log`s the prettified artifact when format is
 * json and `out` is unset. In the LSP process that lands on stderr (stdout is
 * reserved for the protocol) and used to flood Output ▸ Vibgrate. The return
 * value is unchanged; the full JSON is re-emitted on `vibgrate/scanArtifact`.
 *
 * Non-JSON console.log lines (timeouts, "no projects found", …) still pass
 * through so operational warnings remain visible on the main log channel.
 */
async function runCoreScanSilently(
  root: string,
  opts: ScanOptions,
  advanced: Awaited<ReturnType<typeof loadAdvancedScanHook>>,
): Promise<ScanArtifact> {
  const realLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === 'string' && looksLikeScanArtifactJson(args[0])) {
      return;
    }
    realLog(...args);
  };
  try {
    return await runCoreScan(root, opts, advanced);
  } finally {
    console.log = realLog;
  }
}

/** Heuristic: the prettified scan artifact dump from `format: 'json'`. */
function looksLikeScanArtifactJson(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith('{')) return false;
  // Artifact shape — projects inventory plus either drift score or timestamp.
  return (
    t.includes('"projects"') &&
    (t.includes('"drift"') || t.includes('"timestamp"') || t.includes('"dependencies"'))
  );
}

/**
 * True when a workspace-relative path sits under a tree the scanner must never
 * bill or score — `SKIP_DIRS` (node_modules, .git, …), custom virtualenvs
 * (`.venv-*`), Python install trees (`site-packages`), and Claude agent state
 * (`.claude/worktrees` full-repo copies). Used to scrub stale LSP cache hits
 * and to keep the Vulnerabilities panel honest even when the artifact is old.
 */
function isPrunedWorkspacePath(relPath: string | null | undefined): boolean {
  if (!relPath || relPath === '.' || relPath === '') return false;
  const parts = relPath.split(/[/\\]/).filter(Boolean);
  // Always prune Claude agent trees — also listed in SKIP_DIRS once engines
  // ship that entry; hard-coded here so older caches/engines still filter.
  if (parts.includes('.claude')) return true;
  return parts.some((p) => {
    if (SKIP_DIRS.has(p)) return true;
    // Custom-named virtualenvs and Python install trees (not always exact-name
    // members of SKIP_DIRS; still never billable / never scoreable source).
    if (p.startsWith('.venv') || p.startsWith('venv-') || p === 'site-packages') return true;
    return false;
  });
}

/** Drop pruned projects/findings from a scan artifact (cache scrub + safety net). */
function pruneArtifactProjects(a: ScanArtifact): ScanArtifact {
  const projects = (a.projects ?? []).filter(
    (p) => !isPrunedWorkspacePath(p.path) && !isPrunedWorkspacePath(manifestRelativePath(p)),
  );
  if (projects.length === (a.projects ?? []).length) {
    // Still scrub findings that point into pruned trees (e.g. only location is under .claude).
    const findings = (a.findings ?? []).filter((f) => !isPrunedWorkspacePath(f.location));
    if (findings.length === (a.findings ?? []).length) return a;
    return { ...a, findings };
  }
  const findings = (a.findings ?? []).filter((f) => !isPrunedWorkspacePath(f.location));
  return { ...a, projects, findings };
}

/** Find a scanned project by its workspace-relative path (scope picker). */
function projectByPath(a: ScanArtifact, projectPath: string): ProjectScan | undefined {
  const want = path.normalize(projectPath === '' ? '.' : projectPath);
  for (const proj of a.projects ?? []) {
    const got = path.normalize(proj.path === '' ? '.' : proj.path);
    if (got === want) return proj;
  }
  return undefined;
}

/**
 * Compact monorepo project list for the panel scope picker.
 *
 * Source of truth: scanned projects that carry a DriftScore (same set as
 * `.vibgrate/project_scores.json` / Explorer badges). Full workspace-relative
 * paths are preserved so packages with the same leaf name stay distinct.
 * Duplicate paths in the artifact are collapsed (prefer the scored entry).
 */
function buildProjectRefs(rootDir: string, projects: ProjectScan[]): ProjectRef[] | undefined {
  if (projects.length === 0) return undefined;

  const byPath = new Map<string, ProjectScan>();
  for (const p of projects) {
    const rel = p.path === '' ? '.' : p.path;
    const prev = byPath.get(rel);
    if (!prev) {
      byPath.set(rel, p);
      continue;
    }
    // Prefer the entry that carries a score when the scan lists a path twice.
    if (!prev.drift && p.drift) byPath.set(rel, p);
  }

  const refs: ProjectRef[] = [];
  for (const [rel, p] of byPath) {
    // Scope picker = monorepo packages the scan scored. Unscored discovery
    // noise (if any) stays out of the dropdown.
    if (!p.drift) continue;
    const lockfilePath = lockfileRelativePath(rootDir, p);
    refs.push({
      path: rel,
      // Full relative path for display/identity; package name alone collides
      // across nested fixtures (e.g. two "mcp" leaves).
      name: rel,
      manifestPath: manifestRelativePath(p),
      ...(lockfilePath ? { lockfilePath } : {}),
      score: p.drift.score,
      band: (p.drift.riskLevel ?? 'low') as Band,
      mode: (p.drift.mode ?? 'verified') as 'verified' | 'estimated',
    });
  }
  refs.sort((a, b) => a.path.localeCompare(b.path));
  return refs.length > 0 ? refs : undefined;
}

/**
 * Which scanned project owns this manifest file?
 *
 * Resolve against the *server's* root, not `artifact.rootPath`. The artifact
 * deliberately carries a relative, portable root (it is uploaded and compared
 * across machines), so resolving against it lands on the process cwd — which is
 * wherever the editor happened to spawn us from, and is not the workspace.
 * That mismatch silently produces zero decorations and zero diagnostics: the
 * score renders fine and every in-editor surface is empty.
 */
function projectForFile(root: string, a: ScanArtifact, filePath: string): ProjectScan | undefined {
  const dir = path.dirname(path.resolve(filePath));
  let best: ProjectScan | undefined;
  let bestLen = -1;
  for (const proj of a.projects ?? []) {
    const projDir = path.resolve(root, proj.path);
    // Longest matching prefix wins — correct in a monorepo, where the root
    // package.json and packages/foo/package.json both "contain" the file.
    if ((dir === projDir || dir.startsWith(projDir + path.sep)) && projDir.length > bestLen) {
      best = proj;
      bestLen = projDir.length;
    }
  }
  return best;
}

function sameProject(location: string, projectPath: string): boolean {
  return path.normalize(location) === path.normalize(projectPath);
}

/** Does the artifact carry release-date data? Drives Verified vs Estimated. */
function hasReleaseDates(a: ScanArtifact): boolean {
  for (const proj of a.projects ?? []) {
    for (const dep of proj.dependencies ?? []) {
      if (dep.ageDays !== null && dep.ageDays !== undefined) return true;
    }
  }
  return false;
}

/**
 * `vibgrate/score/forFile` payload for one project — same shape as the
 * whole-repo `ScoreNotification`, scoped to a single manifest. Reuses the
 * per-project `drift` the scan already computed (`ProjectScan.drift`) rather
 * than re-deriving a score client-side, for the same "one engine" reason the
 * whole-repo score is never recomputed in a client.
 */
function scoreForProject(rootDir: string, a: ScanArtifact, proj: ProjectScan): ScoreNotification | null {
  if (!proj.drift) return null;

  let behind = 0;
  let total = 0;
  for (const dep of proj.dependencies ?? []) {
    total++;
    if (dep.drift === 'major-behind' || dep.drift === 'minor-behind') behind++;
  }
  const projFindings = (a.findings ?? []).filter((f) => sameProject(f.location, proj.path));
  const eol = projFindings.filter((f) => f.ruleId === 'vibgrate/runtime-eol' || f.ruleId === 'vibgrate/eol').length;
  const unmaintained = projFindings.filter(
    (f) => f.ruleId === 'vibgrate/unmaintained' || f.ruleId === 'vibgrate/abandoned',
  ).length;
  const hasDates = (proj.dependencies ?? []).some((d) => d.ageDays !== null && d.ageDays !== undefined);

  return {
    score: proj.drift.score,
    band: (proj.drift.riskLevel ?? 'low') as Band,
    mode: proj.drift.mode ?? (hasDates ? 'verified' : 'estimated'),
    methodology: proj.drift.methodologyVersion ?? a.drift.methodologyVersion ?? 'unknown',
    scale: '0 best, 100 worst',
    counts: { behind, eol, unmaintained, total },
    rootPath: proj.path === '' ? '.' : proj.path,
    scannedAt: a.timestamp,
    ...(buildBreakdown(rootDir, [proj]) ? { breakdown: buildBreakdown(rootDir, [proj]) } : {}),
    ...(buildEolHorizon([proj]) ? { eolHorizon: buildEolHorizon([proj]) } : {}),
    ...(buildProjectRefs(rootDir, a.projects ?? [])
      ? { projects: buildProjectRefs(rootDir, a.projects ?? []) }
      : {}),
  };
}

/**
 * Runtime label for a project, e.g. "Node.js 20" — mirrors the label used in
 * the EOL/lag findings above, so the horizon reads consistently with them.
 */
function runtimeHorizonLabel(project: ProjectScan): string {
  const kind =
    project.type === 'node' ? 'Node.js' :
    project.type === 'dotnet' ? '.NET' :
    project.type === 'python' ? 'Python' :
    project.type === 'java' ? 'Java' : project.type;
  return project.runtime ? `${kind} ${project.runtime}` : kind;
}

/**
 * EOL horizon (plan §5.6): the runtimes with a known, real end-of-life date,
 * nearest first — whether that date is still ahead ("EOL in 42 days", advance
 * warning) or already behind (most-overdue reads first, same urgency order as
 * a negative-first sort gives naturally). Built only from
 * `ProjectScan.runtimeEolDate`, which the scanners populate from the Runtime
 * Catalog (endoflife.date) — never invented, never the major-lag proxy. One
 * entry per distinct runtime label (a monorepo with five Node 18 projects
 * shows one horizon line, not five).
 */
function buildEolHorizon(projects: ProjectScan[], now = Date.now()): EolHorizonItem[] | undefined {
  const byLabel = new Map<string, EolHorizonItem>();
  for (const p of projects) {
    if (!p.runtimeEolDate) continue;
    const t = Date.parse(p.runtimeEolDate);
    if (!Number.isFinite(t)) continue;
    const label = runtimeHorizonLabel(p);
    if (byLabel.has(label)) continue; // first occurrence wins; they share a date
    byLabel.set(label, {
      runtime: label,
      eolDate: p.runtimeEolDate,
      daysUntil: Math.round((t - now) / (24 * 60 * 60 * 1000)),
    });
  }
  if (byLabel.size === 0) return undefined;
  return [...byLabel.values()].sort((a, b) => a.daysUntil - b.daysUntil).slice(0, 5);
}

/** Band for a 0–100 drift number — the reconciled score bands (§6.5). The
 *  server sends the band; the client never re-derives one. */
function bandForScore(n: number): Band {
  if (n <= 30) return 'low';
  if (n <= 60) return 'moderate';
  return 'high';
}

/**
 * Full dependency inventory for the Dependencies panel. Scores every unique
 * package with the same `perDependencyDrift` scorer the DriftScore aggregate
 * uses (so row numbers match the portfolio score), then ranks worst-first.
 * Current packages stay in the list at drift 0 — Snyk-style inventory, not
 * only the offenders. Excluded placeholder stubs are omitted.
 *
 * Collects every project manifest that pins the package (with best-effort
 * declaration line) so the panel can open each hit — same pattern as vulns.
 */
function buildBreakdown(rootDir: string, projects: ProjectScan[]): BreakdownItem[] | undefined {
  type Acc = {
    row: DependencyRow;
    ecosystem: string | null;
    locations: BreakdownLocation[];
  };
  const byPkg = new Map<string, Acc>();

  for (const p of projects) {
    const relManifest = manifestRelativePath(p);
    if (isPrunedWorkspacePath(p.path) || isPrunedWorkspacePath(relManifest)) continue;
    const ecosystem = osvEcosystem(p.type);

    // Read each manifest once; line lookup is best-effort (absent when missing).
    const absManifest = path.resolve(rootDir, relManifest);
    let text: string | null = null;
    try {
      if (fs.existsSync(absManifest)) text = fs.readFileSync(absManifest, 'utf8');
    } catch {
      text = null;
    }
    const kind = manifestKind(absManifest);

    for (const d of p.dependencies ?? []) {
      let line: number | null = null;
      if (text && kind !== 'unknown') {
        const l = findPackageLine(text, d.package, kind);
        if (l >= 0) line = l + 1; // 1-based for the editor
      }
      const loc: BreakdownLocation = { file: relManifest, line };
      const existing = byPkg.get(d.package);
      if (!existing) {
        byPkg.set(d.package, { row: d, ecosystem, locations: [loc] });
        continue;
      }
      if (!existing.locations.some((x) => x.file === loc.file && x.line === loc.line)) {
        existing.locations.push(loc);
      }
      // Prefer the worse drift row when the same package appears multiple times
      // (first-wins was silent; keep the higher-signal version for display).
      const prev = perDependencyDrift(existing.row, {
        unsupported: existing.row.unsupported === true,
        abandoned: existing.row.abandoned === true,
      });
      const next = perDependencyDrift(d, {
        unsupported: d.unsupported === true,
        abandoned: d.abandoned === true,
      });
      if (!next.excluded && (prev.excluded || next.drift > prev.drift)) {
        existing.row = d;
        if (ecosystem) existing.ecosystem = ecosystem;
      }
    }
  }
  if (byPkg.size === 0) return undefined;

  const items: BreakdownItem[] = [];
  for (const [, { row, ecosystem, locations }] of byPkg) {
    const scored = perDependencyDrift(row, {
      unsupported: row.unsupported === true,
      abandoned: row.abandoned === true,
    });
    if (scored.excluded) continue;
    items.push({
      package: row.package,
      section: row.section ?? 'dependencies',
      ecosystem,
      drift: scored.drift,
      band: bandForScore(scored.drift),
      currentSpec: row.currentSpec ?? '',
      resolvedVersion: row.resolvedVersion ?? null,
      latestStable: row.latestStable ?? null,
      majorsBehind: row.majorsBehind ?? null,
      ageDays: row.ageDays ?? null,
      mode: scored.mode,
      unsupported: scored.unsupported || row.unsupported === true,
      abandoned: scored.flags.includes('abandoned-floor') || row.abandoned === true,
      flags: scored.flags,
      locations,
    });
  }

  items.sort((a, b) => b.drift - a.drift || a.package.localeCompare(b.package));
  return items.length > 0 ? items : undefined;
}

/** Workspace-relative manifest path for a scanned project (for jump-to-line). */
function manifestRelativePath(proj: ProjectScan): string {
  const base = proj.path === '.' || proj.path === '' ? '' : proj.path;
  const join = (name: string) => (base ? path.join(base, name) : name);
  switch (proj.type) {
    case 'node':
    case 'typescript':
      return join('package.json');
    case 'python':
      return join('pyproject.toml');
    case 'go':
      return join('go.mod');
    case 'rust':
      return join('Cargo.toml');
    case 'ruby':
      return join('Gemfile');
    case 'php':
      return join('composer.json');
    case 'java':
    case 'kotlin':
    case 'scala':
    case 'groovy':
      return join('pom.xml');
    case 'dotnet':
      return join(proj.name ? `${proj.name}.csproj` : 'Directory.Build.props');
    case 'dart':
      return join('pubspec.yaml');
    case 'elixir':
      return join('mix.exs');
    default:
      return join('package.json');
  }
}

/**
 * Workspace-relative lockfile path for a scanned project, when one is present
 * on disk. Checked against the real filesystem (not just inferred from
 * ecosystem) since the lockfile may live at the project's own directory or,
 * for a JS/TS package inside a monorepo, at the workspace root instead.
 * Returns `undefined` when no known lockfile name exists for the project.
 */
function lockfileRelativePath(rootDir: string, proj: ProjectScan): string | undefined {
  const base = proj.path === '.' || proj.path === '' ? '' : proj.path;
  const candidateNames: string[] = (() => {
    switch (proj.type) {
      case 'node':
      case 'typescript':
        return ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb'];
      case 'python':
        return ['poetry.lock', 'uv.lock', 'Pipfile.lock'];
      case 'go':
        return ['go.sum'];
      case 'rust':
        return ['Cargo.lock'];
      case 'ruby':
        return ['Gemfile.lock'];
      case 'php':
        return ['composer.lock'];
      case 'dotnet':
        return ['packages.lock.json'];
      case 'dart':
        return ['pubspec.lock'];
      default:
        return [];
    }
  })();
  const dirsToTry = base ? [base, ''] : [''];
  for (const dir of dirsToTry) {
    for (const name of candidateNames) {
      const rel = dir ? path.join(dir, name) : name;
      try {
        if (fs.existsSync(path.join(rootDir, rel))) return rel;
      } catch {
        // Unreadable path — try the next candidate.
      }
    }
  }
  return undefined;
}

/**
 * Map package name (lowered) → repo-relative files that import it.
 * Returns null when no graph is loaded — callers then report reachability unknown.
 */
function packageImportMap(graph: VgGraph | null | undefined): Map<string, string[]> | null {
  if (!graph?.nodes?.length) return null;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const map = new Map<string, Set<string>>();

  const addPkg = (raw: string, file: string) => {
    if (!file) return;
    const cleaned = raw.replace(/^node_modules\//, '').replace(/\\/g, '/');
    const keys = new Set<string>();
    keys.add(cleaned.toLowerCase());
    if (cleaned.startsWith('@')) {
      const parts = cleaned.split('/');
      if (parts.length >= 2) keys.add(`${parts[0]}/${parts[1]}`.toLowerCase());
    } else {
      keys.add(cleaned.split('/')[0]!.toLowerCase());
    }
    for (const k of keys) {
      let set = map.get(k);
      if (!set) {
        set = new Set();
        map.set(k, set);
      }
      set.add(file);
    }
  };

  // Prefer import edges (source file → external package).
  for (const e of graph.edges ?? []) {
    if (e.kind !== 'import') continue;
    const src = byId.get(e.src);
    const dst = byId.get(e.dst);
    if (!src?.file || !dst) continue;
    if (dst.kind !== 'external' && dst.kind !== 'package' && dst.kind !== 'module') continue;
    for (const raw of [dst.name, dst.qualifiedName].filter(Boolean) as string[]) {
      addPkg(raw, src.file);
    }
  }

  // Also index external nodes that somehow lack edges (defensive).
  for (const n of graph.nodes) {
    if (n.kind !== 'external' && n.kind !== 'package' && n.kind !== 'module') continue;
    // No file list without import edges — keys only for membership.
    for (const raw of [n.name, n.qualifiedName].filter(Boolean) as string[]) {
      const cleaned = raw.replace(/^node_modules\//, '').replace(/\\/g, '/').toLowerCase();
      if (!map.has(cleaned)) map.set(cleaned, new Set());
      if (cleaned.startsWith('@')) {
        const parts = cleaned.split('/');
        if (parts.length >= 2 && !map.has(`${parts[0]}/${parts[1]}`)) {
          map.set(`${parts[0]}/${parts[1]}`, new Set());
        }
      }
    }
  }

  const out = new Map<string, string[]>();
  for (const [k, files] of map) {
    out.set(k, [...files].sort());
  }
  return out;
}

function lookupImportFiles(map: Map<string, string[]>, pkg: string): string[] {
  const p = pkg.toLowerCase();
  if (map.has(p)) return map.get(p)!;
  if (!p.startsWith('@')) {
    const root = p.split('/')[0]!;
    if (map.has(root)) return map.get(root)!;
  }
  return [];
}

/**
 * First 1-based line in `relFile` that mentions the package (import site).
 * Best-effort and bounded; returns null when unreadable or no hit.
 */
function firstPackageMentionLine(root: string, relFile: string, pkg: string): number | null {
  try {
    const abs = path.resolve(root, relFile);
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    const text = fs.readFileSync(abs, 'utf8');
    // Prefer a token that appears in import lines: package name or last segment.
    const tokens = [pkg];
    if (pkg.startsWith('@')) {
      const parts = pkg.split('/');
      if (parts[1]) tokens.push(parts[1]);
    } else if (pkg.includes('/')) {
      tokens.push(pkg.split('/')[0]!);
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!/import|require|from|use |include/.test(line) && !line.includes(pkg)) continue;
      for (const t of tokens) {
        if (t && line.includes(t)) return i + 1;
      }
    }
  } catch {
    /* unreadable */
  }
  return null;
}

/** Map a scanned project type to its OSV.dev ecosystem slug (null = no OSV
 *  coverage, so the client skips vulnerability enrichment). */
function osvEcosystem(type: ProjectScan['type']): string | null {
  switch (type) {
    case 'node':
    case 'typescript': return 'npm';
    case 'python': return 'PyPI';
    case 'java':
    case 'kotlin':
    case 'scala':
    case 'groovy': return 'Maven';
    case 'go': return 'Go';
    case 'rust': return 'crates.io';
    case 'ruby': return 'RubyGems';
    case 'php': return 'Packagist';
    case 'dotnet': return 'NuGet';
    case 'dart': return 'Pub';
    case 'swift': return 'SwiftURL';
    case 'elixir': return 'Hex';
    default: return null;
  }
}

/**
 * The newest in-range update still open to this dependency — `latestSatisfying`
 * when it is a real step up from the resolved version, else null. Sized as
 * `minor`/`patch` so the label can name the step honestly.
 */
function inRangeStep(dep: DependencyRow): { version: string; size: 'minor' | 'patch' } | null {
  const target = dep.latestSatisfying;
  if (!target || !dep.resolvedVersion) return null;
  if (!semver.valid(target) || !semver.valid(dep.resolvedVersion)) return null;
  if (!semver.gt(target, dep.resolvedVersion)) return null;
  const diff = semver.diff(dep.resolvedVersion, target);
  return { version: target, size: diff === 'patch' || diff === 'prepatch' ? 'patch' : 'minor' };
}

/** The end-of-line decoration text. Terse: it sits in the user's code. */
function inlineLabel(dep: DependencyRow): string {
  const bits: string[] = [];
  if (dep.drift === 'major-behind') {
    // A range anchored below the latest major can still have room inside it:
    // name the in-range target first (what an install alone can reach), then
    // the major journey — never a "minor behind" label next to a new-major
    // version number.
    const step = inRangeStep(dep);
    if (step) bits.push(`${step.size} behind`, step.version);
    const n = dep.majorsBehind ?? 1;
    bits.push(`${n} major behind`);
  } else if (dep.drift === 'minor-behind') {
    bits.push('minor behind');
  }
  if (dep.latestStable) bits.push(dep.latestStable);
  // ageDays is fractional off the wire — round it. "1,896.836d stale" in the
  // margin of someone's package.json is the kind of detail that reads as sloppy.
  if (dep.ageDays != null && dep.ageDays >= 1) {
    bits.push(`${Math.round(dep.ageDays).toLocaleString('en-US')}d stale`);
  }
  return bits.join(' · ');
}

/** `command:` URI for a `MarkdownString` link — one JSON-encoded arg object, matching `executeCommand`. */
function commandUri(command: string, args: unknown): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([args]))}`;
}

/** "2 majors behind" / "minor behind" — the hover card's badge text. Mirrors `inlineLabel`'s drift wording. */
function driftBadge(dep: DependencyRow): string | null {
  if (dep.drift === 'major-behind') {
    const n = dep.majorsBehind ?? 1;
    return `${n} major${n === 1 ? '' : 's'} behind`;
  }
  if (dep.drift === 'minor-behind') return 'minor behind';
  return null;
}

/**
 * "17.x → 18.x → 19.x" — a plain-text stand-in for the wireframe's version
 * ladder graphic (hover markdown can't draw one). Built only from the real
 * major-version numbers in `yours`/`latest`; long jumps are truncated with
 * `…` rather than listing every major, so a package that is a decade behind
 * doesn't produce a wall of numbers. Returns null when either version isn't
 * a parseable `<major>.x` (so nothing is shown rather than something wrong).
 */
function versionJourney(yours: string, latest: string): string | null {
  const from = Number(/^(\d+)/.exec(yours)?.[1]);
  const to = Number(/^(\d+)/.exec(latest)?.[1]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;

  const majors: number[] = [];
  for (let m = from; m <= to; m++) majors.push(m);
  const shown = majors.length > 5 ? [majors[0], majors[1], -1, majors[majors.length - 2], majors[majors.length - 1]] : majors;
  return shown.map((m) => (m === -1 ? '…' : `${m}.x`)).join(' → ');
}

/**
 * The hover card (docs/ide-integration/wireframes/02-hover-card.svg). Shows
 * the facts we actually have: version currency, this dependency's real
 * contribution to the score, and real maintenance flags (`unsupported`/
 * `abandoned`).
 *
 * The wireframe also lists upstream release cadence, a last-commit date, a
 * breaking-change count, and transitive blast radius. None of those are
 * backed by real data today — no release-history or changelog source is
 * scanned, and the graph does not track per-npm-package import edges — so
 * they are left out rather than approximated. Fabricating them would violate
 * the same rule that keeps marketing visuals honest (no invented product
 * output); a hover card is not exempt.
 *
 * Two links, both real, not aspirational: "Fix →" opens the
 * existing ranked, vendor-neutral remediation menu (`routeFix.ts`) — per the
 * wireframe's own design notes, that is explicitly not a "Fix" button, so it
 * does not conflict with "no fix affordance" (plan §0.1). "Explain this
 * drift" focuses the Dependencies panel and expands this package's row,
 * which already carries the full explanation (guards, floors, age).
 */
function hoverMarkdown(dep: DependencyRow, contribution: number | null): string {
  const lines: string[] = [];
  const badge = driftBadge(dep);
  const contributionText = contribution != null ? ` · contributes +${Math.round(contribution)} to drift` : '';
  lines.push(badge ? `**${dep.package}**  \`${badge}\`${contributionText}` : `**${dep.package}**`);
  lines.push('');

  const yours = dep.resolvedVersion ?? dep.currentSpec;
  const drifted = dep.drift === 'major-behind' || dep.drift === 'minor-behind';

  if (dep.latestStable && dep.latestStable !== yours) {
    lines.push('**Currency**');
    lines.push(`| | |`);
    lines.push(`|---|---|`);
    lines.push(`| yours | \`${yours}\` |`);
    const step = inRangeStep(dep);
    if (step && step.version !== dep.latestStable) {
      lines.push(`| latest in range | \`${step.version}\` |`);
    }
    lines.push(`| latest | \`${dep.latestStable}\` |`);
    const journey = versionJourney(yours, dep.latestStable);
    if (journey) lines.push(`| journey | ${journey} |`);
    if (dep.majorsBehind) lines.push(`| majors behind | ${dep.majorsBehind} |`);
    if (dep.ageDays != null && dep.ageDays >= 1) {
      lines.push(`| age | ${Math.round(dep.ageDays).toLocaleString('en-US')} days |`);
    }
    if (dep.libyears != null && dep.libyears >= 0.01) {
      lines.push(`| libyears | ${dep.libyears.toFixed(2)} |`);
    }
    const license = dep.license?.spdxId ?? dep.license?.raw;
    if (license) lines.push(`| license | ${license} |`);
  } else {
    lines.push(`\`${yours}\` — current.`);
  }

  if (dep.unsupported || dep.abandoned) {
    lines.push('');
    lines.push('**Maintenance**');
    if (dep.unsupported) lines.push('$(warning) Unsupported / deprecated — floored at 70.');
    if (dep.abandoned) lines.push('$(warning) Abandoned — no recent releases — floored at 50.');
  }

  if (drifted) {
    lines.push('');
    lines.push('---');
    const routeFixUri = commandUri('vibgrate.routeFix', {
      package: dep.package,
      from: yours,
      to: dep.latestStable ?? yours,
      majorsBehind: dep.majorsBehind ?? 0,
    });
    const explainUri = commandUri('vibgrate.explain', { package: dep.package });
    lines.push(`[Fix →](${routeFixUri}) · [Explain this drift](${explainUri})`);
  }

  lines.push('');
  lines.push('---');
  lines.push('$(shield) Resolved locally from your lockfile. No source uploaded.');
  return lines.join('\n');
}

// ── Entry point ────────────────────────────────────────────────────────────

export function startLanguageServer(opts: ServerOptions): void {
  if (!fs.existsSync(opts.root)) {
    process.stderr.write(`vg lsp: root does not exist: ${opts.root}\n`);
    process.exit(1);
  }

  /*
   * stdout is the protocol channel, and nothing else may touch it.
   *
   * A single stray `console.log` from anywhere in the scanner tree — a debug
   * line, a deprecation warning, a progress spinner — lands in the middle of a
   * framed message, desynchronises the reader, and the editor reports the
   * server as crashed. This is the most common way an LSP integration fails,
   * and it fails intermittently, which is worse.
   *
   * So we take the real stdout writer for ourselves, hand it to the protocol,
   * and then redirect `process.stdout` to stderr for the rest of the process.
   * After this point it is not possible for anything else to write to the
   * protocol stream, however deep in the call tree it lives.
   */
  const realWrite = process.stdout.write.bind(process.stdout);

  const protocolOut = {
    write(chunk: string | Uint8Array): boolean {
      return realWrite(chunk as never);
    },
  } as NodeJS.WritableStream;

  process.stdout.write = ((chunk: never, ...rest: never[]) =>
    process.stderr.write(chunk, ...rest)) as typeof process.stdout.write;

  process.stderr.write(
    `vg lsp ${VERSION} — serving ${pathToFileURL(opts.root).href}` +
      `${opts.offline ? ' (offline)' : ''}\n`,
  );

  new VibgrateLanguageServer(opts, protocolOut);
}
