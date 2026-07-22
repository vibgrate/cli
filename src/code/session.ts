/**
 * The `vg code` governance session (VG-CLI-CODE §7).
 *
 * This is the load-bearing rule the whole platform is built on, applied to code
 * edits: a state-altering change goes **through** the lifecycle, never around it
 * (GUARDRAILS §5). One run walks inspect → assess → dry-run → approve → execute
 * → verify → log:
 *
 *   inspect  build the graph-grounded context for the instruction
 *   assess   ask the routed model for a terse edit; apply it deterministically
 *            (in memory); compute the diff and the blast radius
 *   dry-run  the DEFAULT terminal state — propose the change, write nothing
 *   approve  writing requires explicit consent; without it we stop at dry-run
 *   execute  write the approved changes to disk
 *   verify   confirm the files on disk match what was approved (+ optional cmd)
 *   log      append an immutable, secret-free audit record with a correlation id
 *
 * Everything is deterministic except the single model call, which is isolated
 * behind the provider list (tried in order, falling back on transport failure).
 * The filesystem and clock are injectable so the whole session is testable
 * offline with no writes escaping a temp dir.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildCodeContext } from './context.js';
import { recordCliCall, CLI_TOOL_ALIASES } from '../engine/savings.js';
import { parseEdits, applyEdits, type SymbolSpan } from './apply.js';
import { unifiedDiff } from './diff.js';
import { buildMessages } from './prompt.js';
import { redactSecrets } from './providers.js';
import type { ChatOptions, CodeSessionResult, FileChange, LifecyclePhase, Provider, ProviderResult } from './types.js';
import type { VgGraph } from '../schema.js';

/** Minimal filesystem seam so the session is testable without touching real disk. */
export interface CodeFs {
  read(file: string): string | null;
  write(file: string, content: string): void;
  remove(file: string): void;
  appendAudit(line: string): void;
}

export interface RunSessionOptions {
  graph: VgGraph;
  root: string;
  instruction: string;
  /** Providers to try in order (from the router); the first that answers wins. */
  providers: Provider[];
  /** Write to disk? Default false — dry-run is the safe default (GUARDRAILS §3.2). */
  apply?: boolean;
  /** Explicit consent for the write (`--yes`); without it, a requested apply stops at dry-run. */
  consent?: boolean;
  /** Restrict the edit surface to these files. */
  files?: string[];
  /** Context token budget. */
  budget?: number;
  chatOptions?: ChatOptions;
  /** Injectable filesystem (defaults to a real, root-scoped fs). */
  fsImpl?: CodeFs;
  /** Injectable clock (ms) for the audit timestamp. */
  now?: () => number;
  /** Injectable correlation id (defaults to a random short id). */
  correlationId?: string;
  /** Progress callback per phase. */
  onPhase?: (phase: LifecyclePhase, detail: string) => void;
  /** Skip appending to the audit log (used by tests/dry programmatic calls). */
  noAudit?: boolean;
  /**
   * Who is making the graph-backed call, for per-model savings auditing. When
   * `client` is set, the context-assembly step (a `query_graph`-equivalent) is
   * recorded to the local savings ledger tagged with the provider + model, so
   * `vg savings` can break usage down per model. VG Code always sets this.
   */
  attribution?: { client: string; provider?: string; model?: string };
}

export async function runCodeSession(options: RunSessionOptions): Promise<CodeSessionResult> {
  const {
    graph,
    root,
    instruction,
    providers,
    apply = false,
    consent = false,
    files,
    budget,
    chatOptions,
    now = () => 0,
    onPhase = () => {},
  } = options;
  const fsImpl = options.fsImpl ?? nodeCodeFs(root);
  const correlationId = options.correlationId ?? shortId();
  const phasesRun: LifecyclePhase[] = [];
  const phase = (p: LifecyclePhase, detail: string): void => {
    phasesRun.push(p);
    onPhase(p, detail);
  };

  // ── inspect ──────────────────────────────────────────────────────────────
  phase('inspect', 'building graph-grounded context');
  const context = buildCodeContext(graph, instruction, { budget, files });

  // Per-model savings: the context build is VG Code's `query_graph`-equivalent.
  // Record it (counts only — never code or the instruction) tagged with the
  // model, so `vg savings` audits usage per model. Local-only, best-effort.
  if (options.attribution?.client) {
    const seedFiles = new Set(context.seeds.map((s) => s.node.file).filter(Boolean));
    recordCliCall(
      root,
      {
        tool: CLI_TOOL_ALIASES.ask,
        client: options.attribution.client,
        provider: options.attribution.provider,
        model: options.attribution.model,
        outcome: context.seeds.length ? 'complete' : 'miss',
        vgTokens: context.tokensEstimate,
        baselineFiles: seedFiles.size,
      },
      now(),
    );
  }

  // ── assess ──────────────────────────────────────────────────────────────
  phase('assess', 'asking the routed model for a minimal edit');
  const messages = buildMessages(context);
  const { result, provider, fellBack } = await complete(providers, messages, chatOptions, correlationId);

  const edits = parseEdits(result.text);
  const spans = spanIndex(graph);
  const applied = applyEdits(
    edits,
    (file) => fsImpl.read(file),
    (file) => spans.get(normalize(file)) ?? [],
  );

  const changes: FileChange[] = [];
  for (const [file, entry] of [...applied.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    changes.push({
      file,
      before: entry.before,
      after: entry.after,
      outcomes: entry.outcomes,
      diff: unifiedDiff(entry.before, entry.after, file),
    });
  }

  // ── dry-run (always produced) ─────────────────────────────────────────────
  phase('dry-run', `${changes.length} file(s) would change`);

  const anyApplicable = changes.some((c) => c.diff !== '' && c.outcomes.some((o) => o.status === 'applied'));
  const base: CodeSessionResult = {
    instruction,
    provider: { id: provider.id, model: provider.model, local: provider.local, fellBack },
    phasesRun,
    changes,
    applied: false,
    verification: { ran: false, ok: false, detail: 'dry-run — no changes written' },
    correlationId,
  };

  // ── approve ───────────────────────────────────────────────────────────────
  // Writing is opt-in AND consent-gated. A requested apply without consent is
  // not an error — it degrades to a dry-run so the caller can review, then
  // re-run with --yes. This is the "never destructive-by-default" guardrail.
  if (!apply) {
    if (!options.noAudit) writeAudit(fsImpl, base, now());
    return base;
  }
  if (!consent) {
    const stopped = { ...base, verification: { ran: false, ok: false, detail: 'apply requested without consent — re-run with --yes to write these changes' } };
    if (!options.noAudit) writeAudit(fsImpl, stopped, now());
    return stopped;
  }
  if (!anyApplicable) {
    const nothing = { ...base, verification: { ran: false, ok: false, detail: 'nothing to write — no edit applied cleanly' } };
    if (!options.noAudit) writeAudit(fsImpl, nothing, now());
    return nothing;
  }
  phase('approve', 'consent given (--yes)');

  // ── execute ───────────────────────────────────────────────────────────────
  phase('execute', 'writing approved changes');
  for (const change of changes) {
    if (change.diff === '') continue; // no-op file
    if (!change.outcomes.some((o) => o.status === 'applied')) continue; // nothing applied cleanly here
    if (change.after === null) fsImpl.remove(change.file);
    else fsImpl.write(change.file, change.after);
  }

  // ── verify ────────────────────────────────────────────────────────────────
  phase('verify', 'confirming on-disk content matches the approved change');
  const verification = verifyWrites(fsImpl, changes);

  // ── log ───────────────────────────────────────────────────────────────────
  phase('log', 'recording an audit entry');
  const final: CodeSessionResult = { ...base, applied: true, verification };
  if (!options.noAudit) writeAudit(fsImpl, final, now());
  return final;
}

/**
 * Commit an already-computed dry-run result: write the cleanly-applied changes,
 * verify them on disk, and append the audit record — the "approve → execute →
 * verify → log" tail of the lifecycle, run against a proposal the caller has
 * already shown and had approved (the interactive REPL uses this so it never
 * calls the model twice or writes something different from what was reviewed).
 */
export function commitChanges(result: CodeSessionResult, fsImpl: CodeFs, now: () => number = () => 0): CodeSessionResult {
  const anyApplicable = result.changes.some((c) => c.diff !== '' && c.outcomes.some((o) => o.status === 'applied'));
  if (!anyApplicable) {
    return { ...result, applied: false, verification: { ran: false, ok: false, detail: 'nothing to write — no edit applied cleanly' } };
  }
  for (const change of result.changes) {
    if (change.diff === '' || !change.outcomes.some((o) => o.status === 'applied')) continue;
    if (change.after === null) fsImpl.remove(change.file);
    else fsImpl.write(change.file, change.after);
  }
  const verification = verifyWrites(fsImpl, result.changes);
  const final: CodeSessionResult = { ...result, applied: true, verification, phasesRun: [...result.phasesRun, 'approve', 'execute', 'verify', 'log'] };
  writeAudit(fsImpl, final, now());
  return final;
}

/**
 * Undo a set of applied changes by restoring each file's prior content — the
 * `/undo` command. A created file (before === null) is removed; an edited or
 * deleted file is restored to its `before`. Only cleanly-applied changes are
 * reverted. Returns the files it restored.
 */
export function undoChanges(changes: FileChange[], fsImpl: CodeFs): string[] {
  const restored: string[] = [];
  for (const ch of changes) {
    if (!ch.outcomes.some((o) => o.status === 'applied')) continue;
    if (ch.before === null) fsImpl.remove(ch.file);
    else fsImpl.write(ch.file, ch.before);
    restored.push(ch.file);
  }
  return restored;
}

/** Try each provider in order; fall back on transport failure. Throws the last actionable error. */
async function complete(
  providers: Provider[],
  messages: ReturnType<typeof buildMessages>,
  chatOptions: ChatOptions | undefined,
  correlationId: string,
): Promise<{ result: ProviderResult; provider: Provider; fellBack: boolean }> {
  if (providers.length === 0) throw new Error(`no model provider available (ref ${correlationId})`);
  let lastErr: unknown;
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      const result = await provider.chat(messages, { temperature: 0, ...chatOptions });
      return { result, provider, fellBack: i > 0 };
    } catch (e) {
      lastErr = e;
    }
  }
  const message = lastErr instanceof Error ? redactSecrets(lastErr.message) : String(lastErr);
  throw new Error(`${message} (ref ${correlationId})`);
}

/** Confirm each written file's on-disk content equals what we approved. */
function verifyWrites(fsImpl: CodeFs, changes: FileChange[]): { ran: boolean; ok: boolean; detail: string } {
  let checked = 0;
  const mismatches: string[] = [];
  for (const change of changes) {
    if (change.diff === '' || !change.outcomes.some((o) => o.status === 'applied')) continue;
    checked++;
    const onDisk = fsImpl.read(change.file);
    if (onDisk !== change.after) mismatches.push(change.file);
  }
  if (mismatches.length) return { ran: true, ok: false, detail: `on-disk content differs for: ${mismatches.join(', ')}` };
  return { ran: true, ok: true, detail: `wrote and verified ${checked} file(s)` };
}

/** An append-only, secret-free audit record (GUARDRAILS §2.6 / §5). No file contents, no keys. */
function writeAudit(fsImpl: CodeFs, r: CodeSessionResult, ts: number): void {
  const record = {
    ts,
    correlationId: r.correlationId,
    instruction: r.instruction.slice(0, 500),
    provider: r.provider.id,
    model: r.provider.model,
    local: r.provider.local,
    applied: r.applied,
    files: r.changes.map((c) => ({ file: c.file, statuses: c.outcomes.map((o) => o.status) })),
    verification: r.verification,
    phases: r.phasesRun,
  };
  try {
    fsImpl.appendAudit(JSON.stringify(record));
  } catch {
    /* audit is best-effort; never fail the run on a logging problem */
  }
}

/** Build a per-file map of symbol spans for graph-scoped edit disambiguation. */
function spanIndex(graph: VgGraph): Map<string, SymbolSpan[]> {
  const map = new Map<string, SymbolSpan[]>();
  for (const n of graph.nodes) {
    if (n.kind === 'file' || n.kind === 'external') continue;
    const file = normalize(n.file);
    const list = map.get(file) ?? [];
    list.push({ qualifiedName: n.qualifiedName, file, start: n.span.start, end: n.span.end });
    map.set(file, list);
  }
  return map;
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Default filesystem impl, scoped to `root`. Refuses paths that escape the root. */
export function nodeCodeFs(root: string): CodeFs {
  const resolve = (file: string): string => {
    const abs = path.resolve(root, file);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`edit path escapes the project root: ${file} — refusing to touch files outside ${root}`);
    }
    return abs;
  };
  return {
    read(file) {
      try {
        return fs.readFileSync(resolve(file), 'utf8');
      } catch {
        return null;
      }
    },
    write(file, content) {
      const abs = resolve(file);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    },
    remove(file) {
      try {
        fs.rmSync(resolve(file));
      } catch {
        /* already gone */
      }
    },
    appendAudit(line) {
      const dir = path.join(root, '.vibgrate');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'code-audit.jsonl'), line + '\n');
    },
  };
}

/** Short, URL-safe correlation id. Not a graph artifact, so runtime randomness is fine here. */
function shortId(): string {
  let s = '';
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
