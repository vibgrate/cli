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

import { runCoreScan } from '../core-open/index.js';
import type { ScanArtifact, ScanOptions, DependencyRow, ProjectScan, DriftScore } from '../core-open/index.js';
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
import { writeArtifacts } from '../engine/artifacts.js';
import { writeSnapshot } from '../engine/freshness.js';
import { refreshIfStale } from '../engine/refresh.js';
import { manifestHash, loadScanCache, writeScanCache } from './scan-cache.js';
import { runGraphQuery, type GraphQueryParams, type GraphQueryResult } from './graph-query.js';
import { enrichVulns, type EnrichResult } from './enrich.js';
import type { VgGraph } from '../schema.js';

// ── Wire types (the contract every client renders) ─────────────────────────

/** DriftScore band. Mirrors the engine — clients must never re-derive it. */
export type Band = 'low' | 'moderate' | 'high';

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
   * Per-package contribution breakdown for the panel accordion — the packages
   * actually driving the score (drift > 0), ranked worst-first. Built from the
   * driftscore-3.0 envelope (`drift.dependencyDrift.top`) enriched with the row
   * detail. Absent when nothing is drifting (e.g. an offline scan that can't
   * resolve latest versions). Vulnerability + registry enrichment is fetched
   * lazily on expand, not carried here.
   */
  breakdown?: BreakdownItem[];
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

    this.conn.onNotification('textDocument/didClose', (_m, params) => {
      const p = params as { textDocument?: { uri?: string } };
      if (p.textDocument?.uri) this.docs.delete(p.textDocument.uri);
    });

    this.conn.onRequest('textDocument/hover', (_m, params) => this.onHover(params));
    this.conn.onRequest('textDocument/codeLens', (_m, params) => this.onCodeLens(params));

    this.conn.onRequest('vibgrate/graph/query', (_m, params) => this.onGraphQuery(params));
    this.conn.onRequest('vibgrate/score/forFile', (_m, params) => this.onScoreForFile(params));
    this.conn.onRequest('vibgrate/enrich', (_m, params) => this.onEnrich(params));

    this.conn.onRequest('workspace/executeCommand', (_m, params) => {
      const p = params as { command?: string };
      if (p.command === 'vibgrate.rescan') {
        this.scheduleScan(0);
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

  private scheduleScan(delayMs: number): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.scan(), delayMs);
  }

  private async scan(): Promise<void> {
    if (this.scanning) {
      this.queued = true;
      return;
    }
    this.scanning = true;

    try {
      // The expensive part of a scan is the per-package registry lookups, not
      // reading the manifest/lockfile — so hash just those first (cheap: no
      // network) and skip `runCoreScan` entirely when nothing a scan cares
      // about has changed since the last successful scan on this machine.
      // `toolVersion`/`offline` are part of the key too: an engine upgrade or a
      // flip of `vibgrate.offline` must not replay a scan from before it.
      const cacheKey = { manifestHash: manifestHash(this.opts.root), toolVersion: VERSION, offline: this.opts.offline };
      const cached = loadScanCache(this.opts.root, cacheKey);

      if (cached) {
        this.artifact = cached.artifact;
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
        const advanced = await loadAdvancedScanHook();
        this.artifact = await runCoreScan(this.opts.root, scanOpts, advanced);
        writeScanCache(this.opts.root, cacheKey, this.artifact);
      }

      this.publishScore();
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
        this.scheduleScan(0);
      }
    }
  }

  // ── Publishing ───────────────────────────────────────────────────────────

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

    const payload: ScoreNotification = {
      score: a.drift.score,
      band,
      // v3 §2.4: `estimated` means "no timestamps at all" — it is NOT an
      // offline marker. An air-gapped scan against a dated snapshot is Verified.
      // The score now carries the authoritative provenance (driftscore-3.0
      // envelope); fall back to the artifact heuristic for pre-v3 engines.
      mode: a.drift.mode ?? (hasReleaseDates(a) ? 'verified' : 'estimated'),
      methodology: a.drift.methodologyVersion ?? 'unknown',
      scale: '0 best, 100 worst',
      counts: { behind, eol, unmaintained, total },
      rootPath: a.rootPath,
      scannedAt: a.timestamp,
      ...(buildBreakdown(a.drift, a.projects ?? []) ? { breakdown: buildBreakdown(a.drift, a.projects ?? []) } : {}),
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
    const refreshed = await refreshIfStale(this.opts.root);
    if (refreshed.status === 'refreshed' && refreshed.wrote) {
      const reloaded = loadGraph(this.opts.root);
      if (reloaded) this.graph = reloaded;
    }
    return this.graph;
  }

  private async onGraphQuery(params: unknown): Promise<GraphQueryResult> {
    const p = params as GraphQueryParams;
    if (!this.opts.graph) {
      return { ok: false, mode: p.mode, error: 'disabled', message: 'the local Vibgrate Graph is turned off' };
    }
    const graph = await this.graphForQuery();
    if (!graph) {
      return { ok: false, mode: p.mode, error: 'not-found', message: 'no code map yet — it is still building' };
    }
    return runGraphQuery(graph, p, { root: this.opts.root, offline: this.opts.offline, semantic: this.opts.semantic });
  }

  /**
   * `vibgrate/enrich` — lazy vulnerability enrichment for one expanded package,
   * straight from OSV.dev (never our API). Honours the server's offline flag.
   */
  private onEnrich(params: unknown): Promise<EnrichResult> {
    const p = (params ?? {}) as { ecosystem?: string | null; package?: string; version?: string | null };
    return enrichVulns(p.ecosystem ?? null, p.package ?? '', p.version ?? null, { offline: this.opts.offline });
  }

  private onScoreForFile(params: unknown): ScoreNotification | null {
    const p = params as { uri?: string };
    const a = this.artifact;
    if (!a || !p.uri) return null;
    const project = projectForFile(this.opts.root, a, uriToPath(p.uri));
    return project ? scoreForProject(a, project) : null;
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
function scoreForProject(a: ScanArtifact, proj: ProjectScan): ScoreNotification | null {
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
    rootPath: proj.path,
    scannedAt: a.timestamp,
    ...(buildBreakdown(proj.drift, [proj]) ? { breakdown: buildBreakdown(proj.drift, [proj]) } : {}),
  };
}

/** Band for a 0–100 drift number — the reconciled score bands (§6.5). The
 *  server sends the band; the client never re-derives one. */
function bandForScore(n: number): Band {
  if (n <= 30) return 'low';
  if (n <= 60) return 'moderate';
  return 'high';
}

/**
 * The per-package contribution breakdown for the panel accordion. Built from the
 * driftscore-3.0 envelope's ranked `top` (authoritative — the same per-dependency
 * drift the aggregate used), enriched with the row detail (spec, resolved,
 * latest, age). Only contributing packages (drift > 0); empty when nothing
 * drifts (e.g. offline, where latest versions can't be resolved).
 */
function buildBreakdown(drift: DriftScore, projects: ProjectScan[]): BreakdownItem[] | undefined {
  const top = drift.dependencyDrift?.top;
  if (!top || top.length === 0) return undefined;

  const byPkg = new Map<string, { row: DependencyRow; ecosystem: string | null }>();
  for (const p of projects) {
    const ecosystem = osvEcosystem(p.type);
    for (const d of p.dependencies ?? []) if (!byPkg.has(d.package)) byPkg.set(d.package, { row: d, ecosystem });
  }

  const items = top
    .filter((t) => t.drift > 0)
    .map((t): BreakdownItem => {
      const found = byPkg.get(t.package);
      const row = found?.row;
      return {
        package: t.package,
        section: row?.section ?? 'dependencies',
        ecosystem: found?.ecosystem ?? null,
        drift: t.drift,
        band: bandForScore(t.drift),
        currentSpec: row?.currentSpec ?? '',
        resolvedVersion: row?.resolvedVersion ?? null,
        latestStable: row?.latestStable ?? null,
        majorsBehind: row?.majorsBehind ?? null,
        ageDays: row?.ageDays ?? null,
        mode: t.mode,
        unsupported: t.unsupported,
        abandoned: t.flags.includes('abandoned-floor'),
        flags: t.flags,
      };
    });

  return items.length > 0 ? items : undefined;
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

/** The end-of-line decoration text. Terse: it sits in the user's code. */
function inlineLabel(dep: DependencyRow): string {
  const bits: string[] = [];
  if (dep.drift === 'major-behind') {
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
 * Two links, both real, not aspirational: "Route this fix →" opens the
 * existing ranked, vendor-neutral remediation menu (`routeFix.ts`) — per the
 * wireframe's own design notes, that is explicitly not a "Fix" button, so it
 * does not conflict with "no fix affordance" (plan §0.1). "Explain this
 * drift" focuses the panel and expands this dependency's breakdown row,
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
    lines.push(`[Route this fix →](${routeFixUri}) · [Explain this drift](${explainUri})`);
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
