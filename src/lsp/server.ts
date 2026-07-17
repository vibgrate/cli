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
import type { ScanArtifact, ScanOptions, DependencyRow, ProjectScan } from '../core-open/index.js';
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
}

export class VibgrateLanguageServer {
  private readonly conn: Connection;
  private readonly docs = new Map<string, string>(); // uri → text
  private artifact: ScanArtifact | null = null;
  private scanning = false;
  private queued = false;
  private debounce: NodeJS.Timeout | null = null;
  private shuttingDown = false;

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

    this.conn.onNotification('initialized', () => this.scheduleScan(0));

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
      mode: hasReleaseDates(a) ? 'verified' : 'estimated',
      methodology: a.drift.methodologyVersion ?? 'unknown',
      scale: '0 best, 100 worst',
      counts: { behind, eol, unmaintained, total },
      rootPath: a.rootPath,
      scannedAt: a.timestamp,
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

    return {
      contents: { kind: 'markdown', value: hoverMarkdown(dep) },
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

    const mode = hasReleaseDates(a) ? '' : '~';
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

/**
 * The hover card. Facts, in a fixed order — and no fix affordance, ever.
 * `vg fix` is a paid product; the thing that computes the number does not get
 * to advertise the thing that sells the fix (plan §0.1).
 */
function hoverMarkdown(dep: DependencyRow): string {
  const lines: string[] = [];
  lines.push(`**${dep.package}**`);
  lines.push('');

  const yours = dep.resolvedVersion ?? dep.currentSpec;
  if (dep.latestStable && dep.latestStable !== yours) {
    lines.push(`| | |`);
    lines.push(`|---|---|`);
    lines.push(`| yours | \`${yours}\` |`);
    lines.push(`| latest | \`${dep.latestStable}\` |`);
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

  lines.push('');
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
