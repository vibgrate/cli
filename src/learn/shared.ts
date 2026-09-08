/**
 * Shared helpers for scanners and analyzers: error classification, tool-name
 * normalisation, input summaries, tolerant file/JSON readers.
 *
 * Every regex here is anchored to a bounded slice (first 1–2 KB) and free of
 * nested quantifiers, so classification is linear in the slice length.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ErrorCategory, ToolCall } from './types.js';

// ---------------------------------------------------------------------------
// Error classification (first match wins; specific before generic)
// ---------------------------------------------------------------------------

const ERROR_PATTERNS: ReadonlyArray<readonly [RegExp, ErrorCategory]> = [
  [/No such file or directory|ENOENT|FileNotFoundError|does not exist|file or directory not found/i, 'file_not_found'],
  [/ModuleNotFoundError|ImportError|No module named/i, 'module_not_found'],
  [/command not found/i, 'command_not_found'],
  [/Permission denied|EACCES|EPERM|auto-denied/i, 'permission_denied'],
  [/file is too large|too many lines|exceeds[^\n]{0,80}limit/i, 'file_too_large'],
  [/EISDIR|Is a directory/i, 'is_directory'],
  [/SyntaxError|IndentationError/i, 'syntax_error'],
  [/timed? ?out|TimeoutError|deadline exceeded/i, 'timeout'],
  [/ConnectionError|ConnectionRefused|ECONNREFUSED|network/i, 'connection_error'],
  [/Traceback \(most recent|Exception:|Error:/i, 'runtime_error'],
  [/No (?:matches|files|results) found|0 matches/i, 'no_matches'],
  [/user[^\n]{0,40}reject|user[^\n]{0,40}denied|declined|didn't want to proceed/i, 'user_rejected'],
  [/[Ss]ibling tool call errored/, 'sibling_error'],
  [/exit code|non-zero|exited with/i, 'exit_code'],
  [/BUILD FAILED|compilation error|compile error/i, 'build_failure'],
];

/** Classify an error message (first 2 KB only). */
export function classifyError(content: string): ErrorCategory {
  const snippet = content.slice(0, 2000);
  for (const [re, cat] of ERROR_PATTERNS) if (re.test(snippet)) return cat;
  return 'unknown';
}

const ERROR_INDICATORS = [
  'Error:',
  'error:',
  'ENOENT',
  'No such file',
  'command not found',
  'Permission denied',
  'ModuleNotFoundError',
  'Traceback (most recent',
  'FAILED',
  'EISDIR',
  'auto-denied',
  'Sibling tool call errored',
  'timed out',
  'FileNotFoundError',
];
// "exit code" only signals an error for a NONZERO code — harnesses append
// "exit code 0" to every successful shell command.
const NONZERO_EXIT_RE = /exit code:?\s*(?!0\b)\d/i;

/** Heuristic: does this tool result look like an error? (≥ 10 chars, first 1 KB.) */
export function isErrorContent(content: string): boolean {
  if (!content || content.length < 10) return false;
  const snippet = content.slice(0, 1000);
  for (const ind of ERROR_INDICATORS) if (snippet.includes(ind)) return true;
  return NONZERO_EXIT_RE.test(snippet);
}

// ---------------------------------------------------------------------------
// Tool-name normalisation
// ---------------------------------------------------------------------------

const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  shell: 'Bash',
  run_shell_command: 'Bash',
  execute_command: 'Bash',
  exec_command: 'Bash',
  terminal: 'Bash',
  run_command: 'Bash',
  run_terminal_command: 'Bash',
  run_terminal_cmd: 'Bash',
  bash: 'Bash',
  read_file: 'Read',
  read_many_files: 'Read',
  readfile: 'Read',
  view_file: 'Read',
  cat: 'Read',
  view: 'Read',
  read: 'Read',
  write_file: 'Write',
  write_new_file: 'Write',
  create_file: 'Write',
  writefile: 'Write',
  write: 'Write',
  edit_file: 'Edit',
  replace_in_file: 'Edit',
  editfile: 'Edit',
  apply_diff: 'Edit',
  apply_patch: 'Edit',
  str_replace_editor: 'Edit',
  edit: 'Edit',
  multiedit: 'Edit',
  search_files: 'Glob',
  find_files: 'Glob',
  glob: 'Glob',
  list_directory: 'Glob',
  list_dir: 'Glob',
  grep: 'Grep',
  search_text: 'Grep',
  search_code: 'Grep',
  codebase_search: 'Grep',
  browser: 'WebFetch',
  web_search: 'WebSearch',
};

/** Map agent-specific tool names onto the cross-agent schema (case-insensitive). */
export function normalizeToolName(name: string): string {
  if (!name) return name;
  return TOOL_NAME_MAP[name.toLowerCase()] ?? TOOL_NAME_MAP[name] ?? name;
}

/** Short summary of a tool call's input for display / signatures. */
export function inputSummary(name: string, input: Record<string, unknown>): string {
  const n = name.toLowerCase();
  const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
  if (n === 'bash') {
    const cmd = str(input.command ?? input.cmd);
    return cmd.length > 100 ? `${cmd.slice(0, 100)}...` : cmd;
  }
  if (n === 'read') return str(input.file_path ?? input.path ?? input.absolute_path ?? input.target_file) || '?';
  if (n === 'grep' || n === 'glob') return str(input.pattern ?? input.query ?? input.regex) || '?';
  if (n === 'edit' || n === 'write') return str(input.file_path ?? input.path ?? input.target_file) || '?';
  let s = '';
  try {
    s = JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return s.slice(0, 80);
}

/** Build a normalised ToolCall from raw parts (classifies errors). */
export function makeToolCall(name: string, id: string, input: unknown, output: unknown, explicitError = false): ToolCall {
  const inp = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out = stringifyOutput(output);
  const isError = explicitError || isErrorContent(out);
  return {
    name: normalizeToolName(name),
    id,
    input: inp,
    output: out,
    isError,
    errorCategory: isError ? classifyError(out) : 'unknown',
    outputBytes: Buffer.byteLength(out, 'utf8'),
  };
}

/** Tool output → string: strings pass, text blocks join, anything else JSON. */
export function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const b of output as unknown[]) {
      if (typeof b === 'string') parts.push(b);
      else if (b && typeof b === 'object') {
        const r = b as Record<string, unknown>;
        if (typeof r.text === 'string') parts.push(r.text);
        else if (typeof r.content === 'string') parts.push(r.content);
      }
    }
    if (parts.length) return parts.join('\n');
  }
  if (typeof output === 'object') {
    const r = output as Record<string, unknown>;
    for (const key of ['output', 'result', 'content', 'text', 'stdout']) {
      const v = r[key];
      if (typeof v === 'string') return v;
    }
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

// ---------------------------------------------------------------------------
// Tolerant I/O
// ---------------------------------------------------------------------------

export function homeDir(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  if (home) return home;
  const h = env.HOME ?? env.USERPROFILE;
  return h && h.trim() ? h : os.homedir();
}

/** Read a UTF-8 file; '' when missing or unreadable (never throws). */
export function readTextTolerant(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Parse every valid JSON object line; junk lines are skipped. */
export function readJsonl(file: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of readTextTolerant(file).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function readJson(file: string): unknown {
  const raw = readTextTolerant(file);
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Sorted child names of a directory ('' when unreadable). */
export function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Recursively list files under `dir` matching `pred` (sorted, absolute,
 * depth-limited, symlinks not followed). Unreadable subtrees are skipped.
 */
export function walkFiles(dir: string, pred: (name: string, full: string) => boolean, maxDepth = 8): string[] {
  const out: string[] = [];
  const visit = (d: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) visit(full, depth + 1);
      else if (e.isFile() && pred(e.name, full)) out.push(full);
    }
  };
  visit(dir, 0);
  return out;
}

export function fileMtimeMs(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** ISO-8601 / epoch (s or ms) → ms; undefined when unparseable. */
export function parseTimestamp(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === 'string' && v.trim()) {
    const t = v.trim();
    if (/^\d+(\.\d+)?$/.test(t)) return parseTimestamp(Number(t));
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

export function countWords(text: string): number {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** Collapse newlines and keep both the head and the tail of long text. */
export function truncateHeadTail(text: string, maxChars = 200): string {
  const t = text.replace(/\s*\n\s*/g, ' ').trim();
  if (t.length <= maxChars) return t;
  const sep = ' … ';
  const keep = maxChars - sep.length;
  const head = Math.floor(keep / 2);
  const tail = keep - head;
  return `${t.slice(0, head).trimEnd()}${sep}${t.slice(t.length - tail).trimStart()}`;
}

/** Text of an Anthropic / OpenAI content value (string, parts or blocks). */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as unknown[]) {
    if (typeof b === 'string') parts.push(b);
    else if (b && typeof b === 'object') {
      const r = b as Record<string, unknown>;
      if ((r.type === 'text' || r.type === 'input_text' || r.type === 'output_text' || r.type === undefined) && typeof r.text === 'string') parts.push(r.text);
    }
  }
  return parts.join('\n');
}
