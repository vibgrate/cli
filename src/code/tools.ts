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

import { queryGraph } from '../engine/query.js';
import { impactOf } from '../engine/impact.js';
import { resolveOne } from '../engine/lookup.js';
import { loadCatalog, resolveLib, readDoc, localPackageDocs, resolveVersion } from '../engine/lib.js';
import { applyEdit, type SymbolSpan } from './apply.js';
import { unifiedDiff } from './diff.js';
import { isSecretPath, secretRefusal, redactText } from './secrets.js';
import { dangerousCommand } from './safety.js';
import type { CodeFs } from './session.js';
import type { ToolCall, ToolSpec, FileChange } from './types.js';
import type { VgGraph } from '../schema.js';

/** A state-changing action the agent wants to take — shown to the gate for approval. */
export type MutatingAction =
  | { kind: 'edit'; file: string; diff: string }
  | { kind: 'create'; file: string; bytes: number }
  | { kind: 'delete'; file: string }
  | { kind: 'run'; command: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown> };

export interface ShellResult {
  stdout: string;
  exitCode: number;
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
  /** Autonomous mode — enforce the command denylist since no human reviews each call. */
  auto?: boolean;
  /** Project-configured extra denylist rules for autonomous commands. */
  denyCommands?: string[];
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
    description: 'Search the codebase by concept or identifier using the deterministic code graph (preferred over reading files blindly). Returns the most relevant symbols with file:line.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to find, e.g. "where auth failures are handled"' } }, required: ['query'] },
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
    name: 'run_command',
    description: 'Run a shell command (e.g. the test or build command) and read its output. Requires approval.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'finish',
    description: 'Finish the task. Call this when the change is complete, with a short summary of what you did.',
    parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
];

/** Execute one tool call against the workspace. Never throws — errors come back as tool content. */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const a = call.arguments;
  try {
    switch (call.name) {
      case 'search_code':
        return search(ctx, str(a.query));
      case 'read_file':
        return readFile(ctx, str(a.path), num(a.start_line), num(a.end_line));
      case 'list_files':
        return listFiles(ctx, str(a.dir), str(a.pattern));
      case 'graph_impact':
        return graphImpact(ctx, str(a.symbol));
      case 'library_docs':
        return libraryDocs(ctx, str(a.name));
      case 'edit_file':
        return editFile(ctx, str(a.path), str(a.search), str(a.replace));
      case 'create_file':
        return createFile(ctx, str(a.path), str(a.content));
      case 'delete_file':
        return deleteFile(ctx, str(a.path));
      case 'run_command':
        return runCommand(ctx, str(a.command));
      case 'finish':
        return { content: 'done', mutated: false, finished: true, finalSummary: str(a.summary) || 'done' };
      default:
        return { content: `unknown tool "${call.name}". Available: ${AGENT_TOOLS.map((t) => t.name).join(', ')}`, mutated: false };
    }
  } catch (e) {
    return { content: `tool ${call.name} failed: ${(e as Error).message}`, mutated: false };
  }
}

/* ── read-only tools (auto-approved) ─────────────────────────────────────── */

function search(ctx: ToolContext, query: string): ToolResult {
  if (!query) return { content: 'search_code needs a query', mutated: false };
  const res = queryGraph(ctx.graph, query, { budget: 1500, limit: 10 });
  if (res.matches.length === 0) return { content: `no symbols matched "${query}"`, mutated: false };
  const lines = res.matches.map((m) => `- ${m.node.qualifiedName} (${m.node.kind}) ${m.node.file}:${m.node.span.start}${m.node.signature ? `  ${m.node.signature}` : ''}`);
  return { content: `Matches for "${query}":\n${lines.join('\n')}`, mutated: false };
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

function graphImpact(ctx: ToolContext, symbol: string): ToolResult {
  const { node } = resolveOne(ctx.graph, symbol);
  if (!node) return { content: `no symbol named "${symbol}" in the map`, mutated: false };
  const impact = impactOf(ctx.graph, node.id, { depth: 3 });
  if (impact.affected.length === 0) return { content: `nothing depends on ${node.qualifiedName} (safe to change in isolation)`, mutated: false };
  const lines = impact.affected.slice(0, 20).map((i) => `- ${i.name} (${i.file}:${i.line})`);
  return { content: `${impact.affected.length} symbol(s) depend on ${node.qualifiedName}:\n${lines.join('\n')}`, mutated: false };
}

/* ── mutating tools (gated) ──────────────────────────────────────────────── */

async function editFile(ctx: ToolContext, path: string, search: string, replace: string): Promise<ToolResult> {
  const before = ctx.fsImpl.read(path);
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

async function runCommand(ctx: ToolContext, command: string): Promise<ToolResult> {
  if (!command) return { content: 'run_command needs a command', mutated: false };
  // In autonomous mode there is no human reviewing each command, so the denylist
  // blocks the catastrophic/exfiltrating shapes outright. Interactively, the
  // human sees the exact command at the approval prompt, so we don't pre-block.
  if (ctx.auto) {
    const reason = dangerousCommand(command, ctx.denyCommands);
    if (reason) return { content: `refused to run \`${command}\` autonomously — ${reason}. Run it yourself if you intend to, or re-run without --auto to approve it interactively.`, mutated: false };
  }
  if (!(await ctx.approve({ kind: 'run', command }))) {
    return { content: `running \`${command}\` was declined by the user`, mutated: false };
  }
  const res = ctx.run(command);
  return { content: `$ ${command}\nexit ${res.exitCode}\n${truncate(res.stdout)}`, mutated: true };
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
