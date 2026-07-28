/**
 * The VG Code agent tool set (VG-CLI-CODE §12).
 *
 * These are the tools the model calls during a coding session — the same shape
 * as any coding agent (read a file, list files, search, edit, run a command),
 * but with two Vibgrate differences: **search is the code graph** (a deterministic
 * `query_graph`, not a grep), and **every mutating tool is governed** — edits and
 * shell commands go through an approval gate, never applied silently. Read-only
 * tools (read/list/search/impact) are side-effect-free and auto-approved.
 *
 * The executor is pure over an injected {@link ToolContext} (filesystem, graph,
 * shell runner, approval callback), so the whole tool layer is unit-tested with
 * no real disk, model, or shell.
 */

import { loadCatalog, resolveLib, readDoc, localPackageDocs, resolveVersion } from '../engine/lib.js';
import { searchSymbols } from '../engine/search.js';
import { applyEdit, type SymbolSpan } from './apply.js';
import { applyPatchIR, locatorsFromGraph } from './apply-patch-ir.js';
import { PATCH_IR_SCHEMA_VERSION, validatePatchIR, type PatchIR } from './patch-ir.js';
import { unifiedDiff } from './diff.js';
import { isSecretPath, secretRefusal, redactText, secretEgressRefusal } from './secrets.js';
import { dangerousCommand } from './safety.js';
import { networkCommandRefusal } from './network-policy.js';
import { buildFailureCapsule } from './failure-capsule.js';
import { compileVerificationLadder, runVerificationLadder } from './verify-ladder.js';
import { summarizeCapsule, type TaskCapsule } from './capsule.js';
import { localGraphBackend, type GraphBackend } from './graph-backend.js';
import { inspectChange } from './inspect-change.js';
import { enforceIdentifiersInPatch, enforceIdentifiersInText } from './identifier-enforce.js';
import { extractIdentifiers } from '../runtime/identifier-mask.js';
import type { TrieNode } from '../runtime/identifier-trie.js';
import type { CodeFs } from './session.js';
import type { ToolCall, ToolSpec, FileChange } from './types.js';
import type { VgGraph } from '../schema.js';

/** One file entry inside a multi-file {@link MutatingAction} of kind `patch`. */
export type PatchFileAction = {
  file: string;
  op: 'edit' | 'create' | 'delete';
  /** Unified diff for edits (and creates/deletes when available). */
  diff?: string;
  /** Byte size for creates. */
  bytes?: number;
};

/** A state-changing action the agent wants to take — shown to the gate for approval. */
export type MutatingAction =
  | { kind: 'edit'; file: string; diff: string }
  | { kind: 'create'; file: string; bytes: number }
  | { kind: 'delete'; file: string }
  | { kind: 'run'; command: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  /** Atomic multi-file PatchIR apply — one decision for the whole transaction. */
  | { kind: 'patch'; files: PatchFileAction[] };

export interface ShellResult {
  stdout: string;
  exitCode: number;
}

/** Clarifying question for the human (Claude Code / Codex-style follow-up). */
export interface AskUserRequest {
  question: string;
  /** Optional multiple-choice labels (free text always allowed in the host). */
  options?: string[];
}

export interface ToolContext {
  root: string;
  graph: VgGraph;
  fsImpl: CodeFs;
  spans: Map<string, SymbolSpan[]>;
  /** Run a shell command (injected; tests pass a fake). */
  run: (command: string) => ShellResult;
  /** Approval gate for a mutating action. Resolve false to refuse. */
  approve: (action: MutatingAction) => Promise<boolean>;
  /**
   * Ask the human a clarifying question and wait for their answer.
   * Host UIs (VS Code) surface a prompt card; CLI may use stdin / auto default.
   */
  askUser?: (req: AskUserRequest) => Promise<string>;
  /** Autonomous mode — enforce the command denylist since no human reviews each call. */
  auto?: boolean;
  /** Project-configured extra denylist rules for autonomous commands. */
  denyCommands?: string[];
  /** Active Task Capsule when the run used source-bearing context. */
  capsule?: TaskCapsule | null;
  /** Live capsule accessor (session may refresh). */
  getTaskCapsule?: () => TaskCapsule | null;
  /**
   * Graph query backend (vgd when attached, else in-process). When omitted,
   * tools use {@link localGraphBackend} over {@link graph}.
   */
  graphBackend?: GraphBackend;
  /** Session overlay dirty paths (for inspect_change without explicit files). */
  dirtyFiles?: () => string[];
  /** Transcript file changes this run (inspect_change default surface). */
  changedFiles?: () => string[];
  /**
   * Enforce default-deny network policy on `run_command` (Phase 7).
   * Defaults to true under `--auto`; hosts may set true whenever there is no
   * human reviewing each shell line (or when the sandbox cannot deny net).
   */
  enforceNetworkPolicy?: boolean;
  /**
   * Graph identifier trie for Approach B enforce-before-apply (B3).
   * When set, inventing symbols in edit/create/apply_patch bodies is blocked.
   */
  identifierTrie?: TrieNode | null;
  /** When false, skip identifier enforcement (tests / explicit escape). Default true when trie set. */
  enforceIdentifiers?: boolean;
}

export interface ToolResult {
  /** Text handed back to the model as the tool result. */
  content: string;
  /** True if the action changed workspace state (write/delete/command). */
  mutated: boolean;
  /** Set by `finish` — the loop stops. */
  finished?: boolean;
  finalSummary?: string;
  /** The file change produced by an approved edit/create/delete (for the transcript). */
  change?: FileChange;
}

/** Max characters of file/command output we feed back, to protect the context window. */
const MAX_OUTPUT = 12_000;

/** The tools advertised to the model. Names are stable — they are the wire contract. */
export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: 'search_code',
    description:
      'Search the codebase by identifier, concept, or exact string/URL. Uses the deterministic code graph for symbols, plus a literal text sweep for phrases, quoted strings, and URLs (preferred over reading files blindly). For "find every occurrence of …", pass the exact needle (optionally quoted).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to find, e.g. "scanDir", "where auth failures are handled", or a URL / "exact phrase"',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file (optionally a line range). Use after search_code to see the exact code.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, required: ['path'] },
  },
  {
    name: 'list_files',
    description: 'List files known to the code map, optionally filtered by directory prefix and a simple substring/extension pattern.',
    parameters: { type: 'object', properties: { dir: { type: 'string' }, pattern: { type: 'string' } } },
  },
  {
    name: 'graph_impact',
    description: 'What depends on a symbol — the blast radius of changing it (callers/importers/subtypes). Use before editing shared code.',
    parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  },
  {
    name: 'library_docs',
    description: "Get version-correct documentation for a dependency this project actually uses (from the installed package), so you use the right API for the installed version. Prefer this over guessing a library's API.",
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'package name, e.g. "react" or "zod"' } }, required: ['name'] },
  },
  {
    name: 'edit_file',
    description: 'Edit a file by replacing an exact snippet. The SEARCH text must match current file contents (whitespace-flexible). Requires approval.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'search', 'replace'] },
  },
  {
    name: 'create_file',
    description: 'Create a new file with the given contents. Requires approval.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'delete_file',
    description: 'Delete a file. Requires approval.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'apply_patch',
    description:
      'Apply a validated PatchIR (patch-ir/0) multi-op edit transactionally. Prefer for multi-file changes with assumptions. JSON object with operations[], optional assumptions[]. Requires approval per file change.',
    parameters: {
      type: 'object',
      properties: {
        patch: {
          type: 'object',
          description: 'PatchIR document: { operations: [...], assumptions?: [...] } (schemaVersion optional, defaults to patch-ir/0)',
        },
      },
      required: ['patch'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command (e.g. the test or build command) and read its output. Requires approval.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'inspect_task',
    description:
      'Return (or refresh) the current Task Capsule summary — primary symbols, source files, and verification plan. Prefer this over re-searching when capsule context is already available.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'inspect_change',
    description:
      'Blast radius of a proposed change before (or after) editing — what depends on the symbols/files you will touch. Prefer before multi-file edits. Does not write files.',
    parameters: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Symbol ids or qualified names under change',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relative file paths under change (defaults to session dirty/changed files)',
        },
        depth: { type: 'number', description: 'Impact depth (default 3)' },
      },
    },
  },
  {
    name: 'verify_change',
    description:
      'Run the graph-derived verification ladder (syntax + optional test command). On failure returns a Failure Capsule for focused repair. Read-only regarding files; may run the project test command.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Optional verify command override (default: project test command from capsule plan)' },
      },
    },
  },
  {
    name: 'ask_user',
    description:
      'Ask the human a clarifying question when intent, scope, or preferred approach is ambiguous. Prefer this over guessing. The host shows the question and returns their answer. Do not use for pure code facts you can look up with search_code/read_file.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Clear question for the user' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional short multiple-choice options (user may still type free text)',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'finish',
    description:
      'Finish the task. Pass a user-facing summary in Markdown: what changed (or what you found), key file:line refs, and any follow-ups. For Q&A / locate tasks, the summary IS the answer.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Markdown summary or answer shown in the VG Code panel',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'abort',
    description:
      'Stop without further edits when the request is impossible. Prefer ask_user when intent is merely unclear.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why the task is aborted' } },
      required: ['reason'],
    },
  },
];

/** Execute one tool call against the workspace. Never throws — errors come back as tool content. */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const a = call.arguments;
  try {
    switch (call.name) {
      case 'search_code':
        return await search(ctx, str(a.query));
      case 'read_file':
        return readFile(ctx, str(a.path), num(a.start_line), num(a.end_line));
      case 'list_files':
        return listFiles(ctx, str(a.dir), str(a.pattern));
      case 'graph_impact':
        return await graphImpact(ctx, str(a.symbol));
      case 'library_docs':
        return libraryDocs(ctx, str(a.name));
      case 'edit_file':
        return editFile(ctx, str(a.path), str(a.search), str(a.replace));
      case 'create_file':
        return createFile(ctx, str(a.path), str(a.content));
      case 'delete_file':
        return deleteFile(ctx, str(a.path));
      case 'apply_patch':
        return applyPatchTool(ctx, a.patch);
      case 'run_command':
        return runCommand(ctx, str(a.command));
      case 'inspect_task':
        return inspectTask(ctx);
      case 'inspect_change':
        return inspectChangeTool(ctx, a);
      case 'verify_change':
        return verifyChange(ctx, str(a.command) || undefined);
      case 'ask_user':
        return askUser(ctx, str(a.question), arrStr(a.options));
      case 'finish':
        return { content: 'done', mutated: false, finished: true, finalSummary: str(a.summary) || 'done' };
      case 'abort':
        return {
          content: `aborted: ${str(a.reason) || 'no reason given'}`,
          mutated: false,
          finished: true,
          finalSummary: `aborted: ${str(a.reason) || 'no reason given'}`,
        };
      default:
        return { content: `unknown tool "${call.name}". Available: ${AGENT_TOOLS.map((t) => t.name).join(', ')}`, mutated: false };
    }
  } catch (e) {
    return { content: `tool ${call.name} failed: ${(e as Error).message}`, mutated: false };
  }
}

/* ── read-only tools (auto-approved) ─────────────────────────────────────── */

async function askUser(ctx: ToolContext, question: string, options?: string[]): Promise<ToolResult> {
  if (!question.trim()) return { content: 'ask_user needs a question', mutated: false };
  if (!ctx.askUser) {
    return {
      content:
        'No interactive host for ask_user (headless). Proceed with your best judgment, state assumptions, and call finish — or abort if you cannot continue safely.',
      mutated: false,
    };
  }
  if (ctx.auto) {
    return {
      content:
        'Autonomous mode: no human available. Proceed with the safest default, state assumptions clearly in finish, and do not block on clarification.',
      mutated: false,
    };
  }
  try {
    const answer = await ctx.askUser({
      question: question.trim(),
      options: options?.map((o) => o.trim()).filter(Boolean).slice(0, 8),
    });
    const text = (answer ?? '').trim();
    if (!text) {
      return {
        content: 'User dismissed the question without answering. Ask once more only if essential; otherwise finish with open questions listed.',
        mutated: false,
      };
    }
    return { content: `User answered:\n${text}`, mutated: false };
  } catch (e) {
    return { content: `ask_user failed: ${(e as Error).message}`, mutated: false };
  }
}

function arrStr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => (typeof x === 'string' ? x : String(x ?? ''))).filter(Boolean);
}

async function search(ctx: ToolContext, query: string): Promise<ToolResult> {
  if (!query) return { content: 'search_code needs a query', mutated: false };

  // Hybrid path (same engine as MCP `search_symbols`): graph name index +
  // literal phrase/URL sweep. Without this, a URL occurrence search only ran
  // lexical symbol ranking and returned confidently wrong hubs (field report).
  if (ctx.root) {
    try {
      const hybrid = await searchSymbols(ctx.graph, ctx.root, query, 20);
      if (hybrid.matches.length > 0) {
        const lines = hybrid.matches.map((m) => {
          if ('preview' in m) {
            return `- text ${m.file}:${m.line}  ${m.preview}`;
          }
          return `- ${m.name} (${m.kind}) ${m.file}:${m.line}  score ${m.score}`;
        });
        const parts = [`Matches for "${query}":`, ...lines];
        if (hybrid.totalTextMatches !== undefined) {
          parts.push(
            `(${hybrid.totalTextMatches} literal match(es) in tree${hybrid.moreAvailable ? '; list truncated — raise limit or narrow the needle' : ''})`,
          );
        }
        if (hybrid.hint) parts.push(hybrid.hint);
        return { content: parts.join('\n'), mutated: false };
      }
      // Honest empty for a pure string locate (prefer this over graph false positives).
      if (hybrid.totalTextMatches === 0 || /\s|https?:\/\//i.test(query) || /^["'`]/.test(query.trim())) {
        const hint = hybrid.hint ? `\n${hybrid.hint}` : '';
        return {
          content: `no symbol or text match for "${query}".${hint}`,
          mutated: false,
        };
      }
    } catch {
      // Fall through to graph-only backend (e.g. root not a real tree in unit tests).
    }
  }

  const backend = ctx.graphBackend ?? localGraphBackend(ctx.graph);
  const res = await backend.search(query, { limit: 10 });
  if (res.matches.length === 0) return { content: `no symbols matched "${query}"`, mutated: false };
  const lines = res.matches.map(
    (m) =>
      `- ${m.qualifiedName} (${m.kind}) ${m.file}:${m.line}${m.signature ? `  ${m.signature}` : ''}`,
  );
  const via = res.source === 'vgd' ? ' via vgd' : '';
  return { content: `Matches for "${query}"${via}:\n${lines.join('\n')}`, mutated: false };
}

function readFile(ctx: ToolContext, path: string, start?: number, end?: number): ToolResult {
  // Never send a secrets file to the model (GUARDRAILS §1.1).
  if (isSecretPath(path)) return { content: secretRefusal(path), mutated: false };
  const content = ctx.fsImpl.read(path);
  if (content === null) return { content: `${path} not found`, mutated: false };
  const lines = content.split('\n');
  const from = start && start > 0 ? start - 1 : 0;
  const to = end && end > 0 ? end : lines.length;
  const slice = lines.slice(from, to).join('\n');
  // Redact any stray credential shapes before the content reaches the model.
  const shown = truncate(redactText(slice));
  const header = start || end ? `${path} (lines ${from + 1}-${Math.min(to, lines.length)} of ${lines.length})` : `${path} (${lines.length} lines)`;
  return { content: `${header}:\n${shown}`, mutated: false };
}

function listFiles(ctx: ToolContext, dir?: string, pattern?: string): ToolResult {
  const prefix = dir ? dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') : '';
  const files = [...new Set(ctx.graph.nodes.filter((n) => n.kind === 'file').map((n) => n.file))]
    .filter((f) => !isSecretPath(f)) // don't surface secret files to the model
    .filter((f) => (prefix ? f === prefix || f.startsWith(prefix + '/') : true))
    .filter((f) => (pattern ? f.includes(pattern) || f.endsWith(pattern) : true))
    .sort();
  if (files.length === 0) return { content: `no files${dir ? ` under ${dir}` : ''}${pattern ? ` matching "${pattern}"` : ''}`, mutated: false };
  return { content: `${files.length} file(s):\n${files.slice(0, 200).join('\n')}`, mutated: false };
}

/** Version-correct docs for an installed dependency — the Vibgrate differentiator, as a tool. */
function libraryDocs(ctx: ToolContext, name: string): ToolResult {
  if (!name) return { content: 'library_docs needs a package name', mutated: false };
  // Committed catalog first (curated/pinned docs), then the installed package on disk.
  const entry = resolveLib(loadCatalog(ctx.root), name);
  if (entry) {
    const doc = readDoc(ctx.root, entry);
    if (doc.trim()) return { content: `Docs for ${name}${entry.version && entry.version !== '*' ? ` @ ${entry.version}` : ''} (${entry.source.type}):\n${truncate(redactText(doc))}`, mutated: false };
  }
  const local = localPackageDocs(ctx.root, name);
  if (local?.docs.trim()) {
    return { content: `Docs for ${name}${local.version ? ` @ ${local.version}` : ''} (${local.source}):\n${truncate(redactText(local.docs))}`, mutated: false };
  }
  const v = resolveVersion(ctx.root, name);
  return {
    content: `no bundled docs for ${name}${v.served ? ` (installed ${v.served})` : ' (not found in this project)'}. Read its source under node_modules/${name}, or add curated docs with \`vg lib add\`.`,
    mutated: false,
  };
}

async function graphImpact(ctx: ToolContext, symbol: string): Promise<ToolResult> {
  const backend = ctx.graphBackend ?? localGraphBackend(ctx.graph);
  const impact = await backend.impact(symbol, { depth: 3 });
  if (!impact) return { content: `no symbol named "${symbol}" in the map`, mutated: false };
  if (impact.affected.length === 0) {
    return {
      content: `nothing depends on ${impact.root.name} (safe to change in isolation)`,
      mutated: false,
    };
  }
  const lines = impact.affected.slice(0, 20).map((i) => `- ${i.name} (${i.file}:${i.line})`);
  const via = impact.source === 'vgd' ? ' via vgd' : '';
  return {
    content: `${impact.affected.length} symbol(s) depend on ${impact.root.name}${via}:\n${lines.join('\n')}`,
    mutated: false,
  };
}

/* ── mutating tools (gated) ──────────────────────────────────────────────── */

async function editFile(ctx: ToolContext, path: string, search: string, replace: string): Promise<ToolResult> {
  const before = ctx.fsImpl.read(path);
  if (ctx.enforceIdentifiers !== false && ctx.identifierTrie) {
    // Reusing locals / symbols already in the file (or the search span) is fine;
    // only inventing graph-unknown identifiers is blocked (B3).
    const allow = new Set([
      ...extractIdentifiers(before ?? ''),
      ...extractIdentifiers(search),
    ]);
    const idCheck = enforceIdentifiersInText(replace, ctx.identifierTrie, { allow });
    if (!idCheck.ok) {
      return { content: idCheck.reason ?? 'blocked: unknown identifiers in edit', mutated: false };
    }
  }
  const { content: after, outcome } = applyEdit(before, { op: 'replace', file: path, search, replace }, ctx.spans.get(normalize(path)) ?? []);
  if (outcome.status !== 'applied') {
    return { content: `edit not applied (${outcome.status}): ${outcome.reason ?? ''}`, mutated: false };
  }
  const diff = unifiedDiff(before, after, path);
  if (!(await ctx.approve({ kind: 'edit', file: path, diff }))) {
    return { content: `edit to ${path} was declined by the user`, mutated: false };
  }
  ctx.fsImpl.write(path, after ?? '');
  return { content: `edited ${path}`, mutated: true, change: { file: path, before, after, outcomes: [outcome], diff } };
}

async function createFile(ctx: ToolContext, path: string, content: string): Promise<ToolResult> {
  if (ctx.enforceIdentifiers !== false && ctx.identifierTrie) {
    const idCheck = enforceIdentifiersInText(content, ctx.identifierTrie);
    if (!idCheck.ok) {
      return { content: idCheck.reason ?? 'blocked: unknown identifiers in create', mutated: false };
    }
  }
  const existing = ctx.fsImpl.read(path);
  if (existing !== null) return { content: `${path} already exists — use edit_file`, mutated: false };
  if (!(await ctx.approve({ kind: 'create', file: path, bytes: Buffer.byteLength(content) }))) {
    return { content: `creating ${path} was declined by the user`, mutated: false };
  }
  ctx.fsImpl.write(path, content);
  return { content: `created ${path}`, mutated: true, change: { file: path, before: null, after: content, outcomes: [{ edit: { op: 'create', file: path, content }, status: 'applied' }], diff: unifiedDiff(null, content, path) } };
}

async function deleteFile(ctx: ToolContext, path: string): Promise<ToolResult> {
  const before = ctx.fsImpl.read(path);
  if (before === null) return { content: `${path} does not exist`, mutated: false };
  if (!(await ctx.approve({ kind: 'delete', file: path }))) {
    return { content: `deleting ${path} was declined by the user`, mutated: false };
  }
  ctx.fsImpl.remove(path);
  return { content: `deleted ${path}`, mutated: true, change: { file: path, before, after: null, outcomes: [{ edit: { op: 'delete', file: path }, status: 'applied' }], diff: unifiedDiff(before, null, path) } };
}

/**
 * Apply a multi-op PatchIR transactionally. Each touched file is approved with
 * a unified diff before any write (all-or-nothing after dry-run validation).
 */
async function applyPatchTool(ctx: ToolContext, raw: unknown): Promise<ToolResult> {
  const patch = coercePatchIR(raw);
  if (!patch) {
    return { content: 'apply_patch needs a patch object with operations[] (patch-ir/0)', mutated: false };
  }
  const structural = validatePatchIR(patch);
  if (!structural.ok) {
    return { content: `invalid PatchIR: ${structural.errors.join('; ')}`, mutated: false };
  }

  // B3: block patches that invent identifiers not present in the graph
  // (existing file locals + search spans are allowlisted).
  if (ctx.enforceIdentifiers !== false && ctx.identifierTrie) {
    const idCheck = enforceIdentifiersInPatch(patch, ctx.identifierTrie, {
      readFile: (f) => ctx.fsImpl.read(f),
    });
    if (!idCheck.ok) {
      return { content: idCheck.reason ?? 'blocked: unknown identifiers', mutated: false };
    }
  }

  const locate = locatorsFromGraph(ctx.graph.nodes);
  const dry = applyPatchIR(patch, {
    readFile: (f) => ctx.fsImpl.read(f),
    spansForFile: (f) => ctx.spans.get(normalize(f)) ?? [],
    locateSymbol: locate,
    transactional: true,
  });
  if (!dry.ok) {
    const detail = dry.errors.length ? dry.errors.join('; ') : dry.ops.map((o) => `${o.op}@${o.file}:${o.status}`).join('; ');
    return { content: `patch not applied: ${detail}`, mutated: false };
  }

  // Build the full multi-file plan first, then one atomic approval. Hosts (VS Code
  // multi-file tray, stream-json) show every file + diff together — no per-file
  // round-trip that would leave a half-approved transaction.
  const planned: Array<{
    file: string;
    op: PatchFileAction['op'];
    before: string | null;
    after: string | null;
    diff: string;
  }> = [];
  for (const [file, entry] of [...dry.files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (entry.before === entry.after) continue;
    if (isSecretPath(file)) return { content: secretRefusal(file), mutated: false };
    const op: PatchFileAction['op'] =
      entry.after === null ? 'delete' : entry.before === null ? 'create' : 'edit';
    planned.push({
      file,
      op,
      before: entry.before,
      after: entry.after,
      diff: unifiedDiff(entry.before, entry.after, file),
    });
  }

  if (planned.length === 0) {
    return { content: 'patch applied with no content changes (no-op)', mutated: false };
  }

  const files: PatchFileAction[] = planned.map((p) => {
    if (p.op === 'delete') return { file: p.file, op: 'delete', diff: p.diff };
    if (p.op === 'create') {
      return { file: p.file, op: 'create', bytes: Buffer.byteLength(p.after ?? ''), diff: p.diff };
    }
    return { file: p.file, op: 'edit', diff: p.diff };
  });

  if (!(await ctx.approve({ kind: 'patch', files }))) {
    return {
      content: `patch declined — ${planned.length} file change(s) refused (nothing written)`,
      mutated: false,
    };
  }

  const changes: FileChange[] = [];
  for (const p of planned) {
    const edit =
      p.after === null
        ? ({ op: 'delete' as const, file: p.file })
        : p.before === null
          ? ({ op: 'create' as const, file: p.file, content: p.after })
          : ({ op: 'replace' as const, file: p.file, search: '', replace: p.after });
    changes.push({
      file: p.file,
      before: p.before,
      after: p.after,
      outcomes: [{ edit, status: 'applied' }],
      diff: p.diff,
    });
    if (p.after === null) ctx.fsImpl.remove(p.file);
    else ctx.fsImpl.write(p.file, p.after);
  }

  const summary = changes.map((c) => c.file).join(', ');
  // Surface the first change for the agent transcript accumulator; multi-file
  // details are in the content string and the patch approval payload.
  return {
    content: `applied patch to ${changes.length} file(s): ${summary}`,
    mutated: true,
    change: changes[0],
  };
}

function coercePatchIR(raw: unknown): PatchIR | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.operations)) return null;
  return {
    schemaVersion: PATCH_IR_SCHEMA_VERSION,
    operations: o.operations as PatchIR['operations'],
    assumptions: Array.isArray(o.assumptions) ? (o.assumptions as PatchIR['assumptions']) : [],
    requestedVerification: Array.isArray(o.requestedVerification)
      ? (o.requestedVerification as PatchIR['requestedVerification'])
      : [],
    provenance: { format: 'structured-json', modelId: null, raw: null },
  };
}

async function runCommand(ctx: ToolContext, command: string): Promise<ToolResult> {
  if (!command) return { content: 'run_command needs a command', mutated: false };
  // In autonomous mode there is no human reviewing each command, so the denylist
  // blocks the catastrophic/exfiltrating shapes outright. Interactively, the
  // human sees the exact command at the approval prompt, so we don't pre-block.
  if (ctx.auto) {
    const reason = dangerousCommand(command, ctx.denyCommands);
    if (reason) return { content: `refused to run \`${command}\` autonomously — ${reason}. Run it yourself if you intend to, or re-run without --auto to approve it interactively.`, mutated: false };
  }
  // Phase 7 network policy: default-deny outbound from agent shell when
  // enforceNetworkPolicy is set (defaults on under --auto).
  const enforceNet = ctx.enforceNetworkPolicy ?? !!ctx.auto;
  const netReason = networkCommandRefusal(command, { enforce: enforceNet });
  if (netReason) {
    return { content: `refused to run \`${command}\` — ${netReason}`, mutated: false };
  }
  // Scan the command line for credential shapes before any shell (and before
  // approval) so secrets never ride out on a curl/header line.
  const secretReason = secretEgressRefusal(command, 'shell command');
  if (secretReason) {
    return { content: `refused to run \`${command}\` — ${secretReason}`, mutated: false };
  }
  if (!(await ctx.approve({ kind: 'run', command }))) {
    return { content: `running \`${command}\` was declined by the user`, mutated: false };
  }
  const res = ctx.run(command);
  return { content: `$ ${command}\nexit ${res.exitCode}\n${truncate(res.stdout)}`, mutated: true };
}

function inspectTask(ctx: ToolContext): ToolResult {
  const capsule = ctx.getTaskCapsule?.() ?? ctx.capsule ?? null;
  if (!capsule) {
    return {
      content:
        'No Task Capsule for this run (metadata-only context). Re-run with --capsule, or use search_code / read_file to gather evidence.',
      mutated: false,
    };
  }
  const summary = summarizeCapsule(capsule);
  const lines = [
    `Task Capsule ${summary.schemaVersion} · ranking ${summary.rankingVersion} · ~${summary.tokensEstimate} tokens`,
    `Instruction: ${summary.instruction}`,
    `Primary (${summary.primary.length}):`,
    ...summary.primary.map((p) => `  - ${p.qualifiedName} (${p.kind}) ${p.file}`),
    `Supporting (${summary.supporting.length}):`,
    ...summary.supporting.slice(0, 8).map((p) => `  - ${p.qualifiedName} ${p.file}`),
    `Source slices: ${summary.sourceSliceCount} across ${summary.sourceFiles.join(', ') || '(none)'}`,
    `Verification files: ${capsule.verificationPlan.syntaxFiles.slice(0, 8).join(', ') || '(none)'}`,
  ];
  if (capsule.provenance.modelProfileId) lines.push(`Model profile: ${capsule.provenance.modelProfileId}`);
  if (capsule.provenance.securityTier) lines.push(`Security tier: ${capsule.provenance.securityTier}`);
  return { content: lines.join('\n'), mutated: false };
}

function inspectChangeTool(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const symbols = Array.isArray(args.symbols)
    ? args.symbols.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  let files = Array.isArray(args.files)
    ? args.files.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  if (!files.length) {
    const dirty = ctx.dirtyFiles?.() ?? [];
    const changed = ctx.changedFiles?.() ?? [];
    files = [...new Set([...dirty, ...changed])];
  }
  if (!symbols.length && !files.length) {
    return {
      content:
        'inspect_change needs symbols[] or files[] (or session dirty/changed files). Example: { "files": ["src/auth.ts"] }',
      mutated: false,
    };
  }
  const depth = typeof args.depth === 'number' && args.depth > 0 ? args.depth : 3;
  const report = inspectChange(ctx.graph, { symbols, files, depth });
  return { content: report.rendered, mutated: false };
}

function verifyChange(ctx: ToolContext, commandOverride?: string): ToolResult {
  const capsule = ctx.getTaskCapsule?.() ?? ctx.capsule ?? null;
  if (!capsule) {
    if (commandOverride) {
      const res = ctx.run(commandOverride);
      if (res.exitCode === 0) return { content: `verify ok — \`${commandOverride}\` exit 0`, mutated: false };
      const fc = buildFailureCapsule({
        verify: { command: commandOverride, exitCode: res.exitCode, stdout: res.stdout },
        changedFiles: [],
      });
      return { content: fc.rendered, mutated: false };
    }
    return { content: 'verify_change needs a Task Capsule or an explicit command', mutated: false };
  }
  const steps = compileVerificationLadder(capsule.verificationPlan, {
    testCommand: commandOverride,
  });
  const ladder = runVerificationLadder(steps, {
    readFile: (f) => ctx.fsImpl.read(f),
    run: ctx.run,
    runCommands: true,
  });
  if (ladder.ok) {
    return {
      content: `verification ladder passed:\n${ladder.steps.map((s) => `✔ ${s.message}`).join('\n')}`,
      mutated: false,
    };
  }
  const fc = buildFailureCapsule({
    ladderSteps: ladder.steps,
    capsule,
    changedFiles: [],
  });
  return { content: fc.rendered, mutated: false };
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n… (truncated ${s.length - MAX_OUTPUT} chars)`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}
function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}
