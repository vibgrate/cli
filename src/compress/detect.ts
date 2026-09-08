/**
 * Content-type detection. A strict chain with per-type confidence floors:
 *
 *   json (any) → git_diff ≥0.7 → html ≥0.7 → search_results ≥0.6 → build_output ≥0.5
 *   → tabular ≥0.6 → structured_config ≥0.6 → source_code ≥0.5 → plain_text 0.5
 *
 * Tool-name hints lower the floor of the matching detector (a `Grep` result is
 * search-shaped even when only a few lines match; a `WebFetch` body is HTML even
 * without a doctype). Post-hoc overrides: HTML that positively looks like a log
 * or search result is routed there; code that parses as config is config.
 *
 * Every regex here is anchored or otherwise linear on a single line; inputs
 * are always scanned line by line with a bounded window (first N lines).
 */

import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import type { ContentType, DetectionResult } from './types.js';

export interface DetectHint {
  toolName?: string;
  language?: string;
}

// ---------------------------------------------------------------------------
// Tool-name hints
// ---------------------------------------------------------------------------

export type ToolKind = 'search' | 'paths' | 'read' | 'html' | 'shell' | 'web_search' | 'unknown';

const TOOL_KINDS: Array<[RegExp, ToolKind]> = [
  [/^(grep|rg|ripgrep|ag|ack|search_files|grep_search|codebase_search|file_search|greptool|search_in_files)$/i, 'search'],
  [/^(glob|ls|find|list_dir|list_directory|list_files|listfiles|tree|globtool)$/i, 'paths'],
  [/^(read|read_file|cat|head|tail|view_file|open_file|str_replace_editor|readfile|view)$/i, 'read'],
  [/^(webfetch|web_fetch|fetch|fetch_url|browser|browse|curl|http_get|read_url)$/i, 'html'],
  [/^(websearch|web_search|search_web|tavily|serp|brave_search)$/i, 'web_search'],
  [/^(bash|shell|sh|zsh|run_command|execute_command|local_shell|terminal|exec|run_terminal_cmd)$/i, 'shell'],
];

export function toolKind(toolName?: string): ToolKind {
  if (!toolName) return 'unknown';
  const name = toolName.trim();
  for (const [re, kind] of TOOL_KINDS) if (re.test(name)) return kind;
  const lower = name.toLowerCase();
  if (/grep|search/.test(lower) && !/web/.test(lower)) return 'search';
  if (/glob|list/.test(lower)) return 'paths';
  if (/fetch|browser/.test(lower)) return 'html';
  if (/read|cat/.test(lower)) return 'read';
  if (/bash|shell|command/.test(lower)) return 'shell';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Language aliases (fence tags, extensions)
// ---------------------------------------------------------------------------

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  typescript: 'typescript',
  py: 'python',
  pyi: 'python',
  python: 'python',
  python3: 'python',
  go: 'go',
  golang: 'go',
  rs: 'rust',
  rust: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  kotlin: 'kotlin',
  cs: 'csharp',
  csharp: 'csharp',
  'c#': 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  'c++': 'cpp',
  php: 'php',
  phtml: 'php',
  php5: 'php',
  php7: 'php',
  php8: 'php',
  rb: 'ruby',
  ruby: 'ruby',
  swift: 'swift',
  scala: 'scala',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  lua: 'lua',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  elixir: 'elixir',
  zig: 'zig',
  sql: 'sql',
  m: 'objc',
  mm: 'objc',
  objc: 'objc',
  ml: 'ocaml',
  mli: 'ocaml',
  ocaml: 'ocaml',
  sol: 'solidity',
  solidity: 'solidity',
  res: 'rescript',
  rescript: 'rescript',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  pl: 'perl',
  perl: 'perl',
};

/** Normalise a fence tag / extension / file name to a canonical language name. */
export function canonicalLanguage(hint?: string): string | undefined {
  if (!hint) return undefined;
  let s = hint.trim().toLowerCase();
  if (!s) return undefined;
  // a path or file name → extension
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (slash >= 0) s = s.slice(slash + 1);
  if (s.includes('.') && !LANGUAGE_ALIASES[s]) s = s.slice(s.lastIndexOf('.') + 1);
  if (s.startsWith('.')) s = s.slice(1);
  return LANGUAGE_ALIASES[s];
}

// ---------------------------------------------------------------------------
// Envelope stripping
// ---------------------------------------------------------------------------

const ENVELOPE_TAGS = ['output', 'stdout', 'stderr', 'tool_result', 'result'];

/** `<returncode>N</returncode><output>…</output>` (and stdout/stderr/tool_result/result wrappers) → inner body. */
export function stripEnvelope(text: string): { inner: string; envelope?: string } {
  const t = text.trim();
  if (!t.startsWith('<')) return { inner: text };
  let rest = t;
  let envelope: string | undefined;
  const rc = /^<returncode>\s*-?\d+\s*<\/returncode>\s*/.exec(rest);
  if (rc) {
    rest = rest.slice(rc[0].length);
    envelope = 'returncode';
  }
  for (const tag of ENVELOPE_TAGS) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    if (rest.startsWith(open) && rest.endsWith(close) && rest.length >= open.length + close.length) {
      const inner = rest.slice(open.length, rest.length - close.length);
      if (inner.indexOf(open) === -1) return { inner, envelope: envelope ? `${envelope}+${tag}` : tag };
    }
  }
  return envelope ? { inner: rest, envelope } : { inner: text };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Index just past the balanced JSON value that starts at `start` (`{` or `[`),
 * honouring strings and escapes. -1 when unbalanced. Linear.
 */
export function findJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === 92) escaped = true;
      else if (ch === 34) inString = false;
      continue;
    }
    if (ch === 34) inString = true;
    else if (ch === 123 || ch === 91) depth++;
    else if (ch === 125 || ch === 93) {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function parseJsonSafe(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const JSON_MIN_BULK_FRACTION = 0.6;

/** Decode a run of whitespace-separated top-level JSON objects (`{…} {…}`); null when it isn't one. */
export function decodeConcatenatedJson(text: string): unknown[] | null {
  const items: unknown[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    const ch = text[i];
    if (ch !== '{' && ch !== '[') return null;
    const end = findJsonEnd(text, i);
    if (end < 0) return null;
    const v = parseJsonSafe(text.slice(i, end));
    if (v === undefined) return null;
    items.push(v);
    i = end;
  }
  return items.length ? items : null;
}

/** Rewrite `{…} {…}` into a real JSON array; null unless ≥2 whitespace-separated objects. */
export function normalizeConcatenatedJson(text: string): string | null {
  const stripped = text.trim();
  if (!stripped.startsWith('{')) return null;
  const items = decodeConcatenatedJson(stripped);
  if (items && items.length >= 2 && items.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))) return JSON.stringify(items);
  return null;
}

export interface JsonParseResult {
  value: unknown;
  /** Character span of the decoded value inside the trimmed text. */
  span: [number, number];
  concatenated: boolean;
  /** True when the JSON was wrapped in a small non-JSON shell. */
  wrapped: boolean;
}

/** Detect JSON by parsing: pure → concatenated objects → one wrapped value that is ≥60% of the text. */
export function parseJsonLoose(text: string): JsonParseResult | null {
  const stripped = text.trim();
  if (!stripped) return null;
  const first = stripped[0];
  if (first !== '{' && first !== '[' && first !== '"' && !/[-\dtfn]/.test(first)) {
    // may still be a wrapped payload
  } else {
    const v = parseJsonSafe(stripped);
    if (v !== undefined) {
      if (v === null || typeof v !== 'object') return null; // bare scalar
      return { value: v, span: [0, stripped.length], concatenated: false, wrapped: false };
    }
    if (first === '{') {
      const items = decodeConcatenatedJson(stripped);
      if (items && items.length >= 2 && items.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))) {
        return { value: items, span: [0, stripped.length], concatenated: true, wrapped: false };
      }
    }
  }
  const a = stripped.indexOf('{');
  const b = stripped.indexOf('[');
  const start = a < 0 ? b : b < 0 ? a : Math.min(a, b);
  if (start < 0) return null;
  const end = findJsonEnd(stripped, start);
  if (end < 0) return null;
  if (end - start < stripped.length * JSON_MIN_BULK_FRACTION) return null;
  const v = parseJsonSafe(stripped.slice(start, end));
  if (v === undefined || v === null || typeof v !== 'object') return null;
  return { value: v, span: [start, end], concatenated: false, wrapped: true };
}

function tryDetectJson(text: string): DetectionResult | null {
  const parsed = parseJsonLoose(text);
  if (!parsed) return null;
  const v = parsed.value;
  if (Array.isArray(v)) {
    const isDictArray = v.length > 0 && v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
    return {
      type: 'json',
      confidence: isDictArray ? 1 : 0.8,
      metadata: { itemCount: v.length, isDictArray, isObject: false, concatenated: parsed.concatenated, wrapped: parsed.wrapped },
    };
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj);
  let arrayKey: string | undefined;
  for (const k of ['items', 'results', 'data', 'records', 'rows', 'entries', 'hits', 'matches', 'messages', 'files']) {
    if (Array.isArray(obj[k]) && (obj[k] as unknown[]).length >= 2) {
      arrayKey = k;
      break;
    }
  }
  return { type: 'json', confidence: 0.9, metadata: { isDictArray: false, isObject: true, keys: keys.length, arrayKey, wrapped: parsed.wrapped } };
}

// ---------------------------------------------------------------------------
// ripgrep --json
// ---------------------------------------------------------------------------

interface RgJsonLine {
  type?: string;
  data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number | null };
}

/** Convert `rg --json` output to `path:line:content` rows; null when it is not that shape. */
export function ripgrepJsonToGrep(text: string): { rows: string; matches: number; files: number } | null {
  const lines = text.split('\n');
  let seen = 0;
  const out: string[] = [];
  const files = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('{')) return null;
    const v = parseJsonSafe(line) as RgJsonLine | undefined;
    if (!v || typeof v !== 'object' || typeof v.type !== 'string') return null;
    seen++;
    if (v.type === 'match' || v.type === 'context') {
      const path = v.data?.path?.text ?? '';
      const body = (v.data?.lines?.text ?? '').replace(/\r?\n$/, '');
      const ln = v.data?.line_number ?? 0;
      files.add(path);
      out.push(`${path}${v.type === 'match' ? ':' : '-'}${ln}${v.type === 'match' ? ':' : '-'}${body}`);
    } else if (!['begin', 'end', 'summary'].includes(v.type)) return null;
  }
  if (seen === 0 || out.length === 0) return null;
  return { rows: out.join('\n'), matches: out.length, files: files.size };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

const DIFF_HEADER = /^(diff --git|diff --combined |diff --cc |--- a\/|@@ -\d+,\d+ \+\d+,\d+ @@|@@@+ -\d+(?:,\d+)? (?:-\d+(?:,\d+)? )+\+\d+(?:,\d+)? @@@+)/;
const DIFF_CHANGE = /^[+-][^+-]/;

export function tryDetectDiff(text: string): DetectionResult | null {
  const lines = firstLines(text, 500);
  let headers = 0;
  let changes = 0;
  for (const line of lines) {
    if (DIFF_HEADER.test(line)) headers++;
    if (DIFF_CHANGE.test(line)) changes++;
  }
  if (headers === 0) return null;
  const confidence = Math.min(1, 0.5 + headers * 0.2 + changes * 0.05);
  return { type: 'git_diff', confidence, metadata: { headerMatches: headers, changeLines: changes } };
}

/** Structural sniff used as a lossy-guard (never hand a diff to a lossy pass). */
export function looksLikeDiff(text: string): boolean {
  const r = tryDetectDiff(text);
  return r !== null && r.confidence >= 0.7;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const HTML_DOCTYPE = /^\s*<!doctype\s+html/i;
const HTML_TAG = /<html[\s>]/i;
const HTML_HEAD = /<head[\s>]/i;
const HTML_BODY = /<body[\s>]/i;
const HTML_STRUCTURAL = /<(?:div|span|script|style|link|meta|nav|header|footer|aside|article|section|main)[\s>]/gi;

export function tryDetectHtml(text: string, opts: { lenient?: boolean } = {}): DetectionResult | null {
  const sample = text.slice(0, 3000);
  const hasDoctype = HTML_DOCTYPE.test(sample);
  const hasHtml = HTML_TAG.test(sample);
  const hasHead = HTML_HEAD.test(sample);
  const hasBody = HTML_BODY.test(sample);
  HTML_STRUCTURAL.lastIndex = 0;
  let structural = 0;
  while (HTML_STRUCTURAL.exec(sample) !== null) structural++;
  if (!hasDoctype && !hasHtml && structural < 3) return null;
  let confidence = 0;
  if (hasDoctype) confidence += 0.5;
  if (hasHtml) confidence += 0.3;
  if (hasHead) confidence += 0.1;
  if (hasBody) confidence += 0.1;
  confidence += Math.min(0.3, structural * 0.03);
  confidence = Math.min(1, confidence);
  // a fetch tool told us this is a page: a fragment with structural tags is enough
  if (opts.lenient) confidence = Math.max(confidence, 0.5);
  if (confidence < 0.5) return null;
  return { type: 'html', confidence, metadata: { hasDoctype, hasHtml, structuralTags: structural } };
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

const SEARCH_ROW = /^[^\s:]+:\d+:/;
const SEARCH_CONTEXT_ROW = /^[^\s:]+-\d+-/;

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/** `path:line:` grep shape whose path part looks like a path (no `<`, `>`, `=`; not a bare date; has a letter, `.` or `/`). */
export function isSearchResultLine(line: string): boolean {
  if (!SEARCH_ROW.test(line)) return false;
  const prefix = line.slice(0, line.indexOf(':'));
  if (prefix.includes('<') || prefix.includes('>') || prefix.includes('=')) return false;
  if (DATE_PREFIX.test(prefix)) return false;
  return /[A-Za-z./\\]/.test(prefix);
}

export function tryDetectSearch(text: string, opts: { minLines?: number; minRatio?: number } = {}): DetectionResult | null {
  const lines = firstLines(text, 100);
  const minLines = opts.minLines ?? 2;
  const minRatio = opts.minRatio ?? 0.3;
  let matching = 0;
  let context = 0;
  let nonEmpty = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    nonEmpty++;
    if (isSearchResultLine(line)) matching++;
    else if (SEARCH_CONTEXT_ROW.test(line)) context++;
  }
  if (matching < minLines) return null;
  if (nonEmpty === 0) return null;
  const ratio = (matching + context) / nonEmpty;
  if (ratio < minRatio) return null;
  const confidence = Math.min(1, 0.4 + ratio * 0.6);
  return { type: 'search_results', confidence, metadata: { matchingLines: matching, contextLines: context, totalLines: nonEmpty, format: 'grep' } };
}

// ---------------------------------------------------------------------------
// Logs / build output
// ---------------------------------------------------------------------------

export const LOG_PATTERNS: readonly RegExp[] = [
  /\b(ERROR|FAIL|FAILED|FATAL|CRITICAL)\b/i,
  /\b(WARN|WARNING)\b/i,
  /\b(INFO|DEBUG|TRACE)\b/i,
  /^\s*\d{4}-\d{2}-\d{2}/,
  /^\s*\[\d{2}:\d{2}:\d{2}\]/,
  /^={3,}|^-{3,}/,
  /^\s*PASSED|^\s*FAILED|^\s*SKIPPED/,
  /^npm ERR!|^yarn error|^cargo error/,
  /Traceback \(most recent call last\)/,
  /^\w*(Error|Exception):/,
  /^\s*at\s+[\w.$/]+\(/,
  /^\s*at async \S/,
  /^(panic|fatal error): /,
  /^goroutine \d+ \[/,
  /^\t\S+\.go:\d+ \+0x/,
  /^thread '[^']*' panicked at/,
  /^stack backtrace:/,
  /^\s+\d+: \S/,
  /^\s+at \S+:\d+:\d+$/,
  /^Unhandled exception\./,
  /^\s*at .+\) in .+:line \d+/,
  /^Caused by: /,
  /^\s*\.\.\. \d+ more$/,
  // test runners / build tools (verbose forms not anchored at line start)
  /\b(PASSED|FAILED|SKIPPED|XFAIL|XPASS)\b\s*(?:\[|$)/,
  /^(PASS|FAIL)\s+\S+/,
  /^\s*[✓✔√×✗✘]\s/,
  /^(ok|not ok)\s+\d+/,
  /^\s*(Compiling|Finished|Running|Downloading|Installing|Building|Linking)\s+\S/,
  /^\s*(warning|error)(?:\[E\d+\])?:\s/,
  /^\S+\.(?:py|js|ts|go|rs|java|rb|php|cs)::\S+/,
  /^\s*\[\s*\d+\/\d+\]/,
  /^npm (WARN|notice|info)\b/,
];

export function tryDetectLog(text: string): DetectionResult | null {
  const lines = firstLines(text, 200);
  let patternMatches = 0;
  let errorMatches = 0;
  let nonEmpty = 0;
  for (const line of lines) {
    if (line.trim()) nonEmpty++;
    for (let i = 0; i < LOG_PATTERNS.length; i++) {
      if (LOG_PATTERNS[i].test(line)) {
        patternMatches++;
        if (i < 2) errorMatches++;
        break;
      }
    }
  }
  if (patternMatches === 0 || nonEmpty === 0) return null;
  const ratio = patternMatches / nonEmpty;
  if (ratio < 0.1) return null;
  const confidence = Math.min(1, 0.3 + ratio * 0.5 + errorMatches * 0.05);
  return { type: 'build_output', confidence, metadata: { patternMatches, errorMatches, totalLines: nonEmpty } };
}

// ---------------------------------------------------------------------------
// Tabular
// ---------------------------------------------------------------------------

const MD_SEP_CELL = /^:?-{2,}:?$/;

function mdCells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|');
}

export function isMarkdownSeparator(row: string): boolean {
  const cells = mdCells(row)
    .map((c) => c.trim())
    .filter((c) => c !== '');
  return cells.length >= 2 && cells.every((c) => MD_SEP_CELL.test(c));
}

function tryDetectMarkdownTable(lines: string[]): DetectionResult | null {
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].includes('|') && isMarkdownSeparator(lines[i + 1])) {
      const cols = mdCells(lines[i]).length;
      if (cols >= 2) return { type: 'tabular', confidence: 0.95, metadata: { format: 'markdown', columns: cols } };
    }
  }
  return null;
}

function looksLikeProse(sample: string[], delim: string): boolean {
  let enders = 0;
  for (const r of sample) if (/[.!?]$/.test(r.trimEnd())) enders++;
  if (enders / sample.length >= 0.5) return true;
  let cells = 0;
  let words = 0;
  for (const r of sample) {
    for (const c of r.split(delim)) {
      cells++;
      words += c.trim().split(/\s+/).filter(Boolean).length;
    }
  }
  return cells > 0 && words / cells > 3;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

function tryDetectDelimited(lines: string[]): DetectionResult | null {
  const sample = lines.slice(0, 20);
  if (sample.length < 3) return null;
  let best: DetectionResult | null = null;
  for (const [delim, minConsistency] of [
    [',', 0.85],
    ['\t', 0.7],
    [';', 0.85],
    ['|', 0.85],
  ] as Array<[string, number]>) {
    const counts = sample.map((r) => countChar(r, delim));
    if (counts[0] === 0) continue;
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let common = 0;
    let commonFreq = -1;
    for (const [c, f] of freq) {
      if (f > commonFreq) {
        commonFreq = f;
        common = c;
      }
    }
    if (common === 0) continue;
    const consistency = commonFreq / sample.length;
    const ncols = common + 1;
    if (ncols < 2 || consistency < minConsistency) continue;
    if (looksLikeProse(sample, delim)) continue;
    const confidence = Math.min(0.95, 0.5 + consistency * 0.3 + Math.min(ncols, 5) * 0.03);
    if (!best || confidence > best.confidence) best = { type: 'tabular', confidence, metadata: { format: 'csv', delimiter: delim, columns: ncols } };
  }
  return best;
}

export function tryDetectTabular(text: string): DetectionResult | null {
  const lines = text
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, 50);
  if (lines.length < 3) return null;
  return tryDetectMarkdownTable(lines) ?? tryDetectDelimited(lines);
}

// ---------------------------------------------------------------------------
// Structured config
// ---------------------------------------------------------------------------

const CONFIG_SECTION = /^\s*\[\[?[\w.\-"' ]+\]\]?\s*$/;
const TOML_ASSIGN = /^\s*(?:[\w.\-]+|"[^"]*"|'[^']*')\s*=\s*\S/;
const INI_ASSIGN = /^\s*[\w.\-@ ]+?\s*[=:]\s*/;
const YAML_KEY = /^\s*(?:-\s+)?(?:[\w.\-/]+|"[^"]*"|'[^']*')\s*:(?:\s|$)/;
const YAML_LIST = /^\s*-\s+\S/;
const YAML_DOC = /^---\s*$|^\.\.\.\s*$/;
const CONFIG_COMMENT = /^\s*[#;]/;
const CONFIG_PARSE_CAP = 1_000_000;

/** Which parser accepts a `[section]`-shaped payload: `toml` (smol-toml) or `ini` (line shape), else null. */
export function parseConfigFlavor(text: string): 'toml' | 'ini' | null {
  if (text.length > CONFIG_PARSE_CAP) return null;
  try {
    parseToml(text);
    return 'toml';
  } catch {
    /* not TOML */
  }
  let sections = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || CONFIG_COMMENT.test(t)) continue;
    if (CONFIG_SECTION.test(t)) {
      sections++;
      continue;
    }
    if (INI_ASSIGN.test(line)) continue;
    if (/^\s+\S/.test(line)) continue; // continuation line
    return null;
  }
  return sections > 0 ? 'ini' : null;
}

function yamlParses(text: string): boolean {
  if (text.length > CONFIG_PARSE_CAP) return true;
  try {
    const v = parseYaml(text, { strict: false, logLevel: 'silent' }) as unknown;
    return v !== null && typeof v === 'object';
  } catch {
    return false;
  }
}

export function tryDetectStructuredConfig(text: string): DetectionResult | null {
  const head = text.trimStart()[0];
  if (!head || head === '{' || head === '<') return null;
  const lines = firstLines(text, 200);
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length < 3) return null;
  const body = nonEmpty.filter((l) => !CONFIG_COMMENT.test(l));
  if (body.length < 3) return null;

  const sections = body.filter((l) => CONFIG_SECTION.test(l)).length;
  if (sections >= 1) {
    const assigns = body.filter((l) => TOML_ASSIGN.test(l) || INI_ASSIGN.test(l)).length;
    if (assigns >= 2 && (sections + assigns) / body.length >= 0.6) {
      const flavor = parseConfigFlavor(text);
      if (flavor) {
        const share = (sections + assigns) / body.length;
        return { type: 'structured_config', confidence: Math.min(0.95, 0.7 + share * 0.25), metadata: { flavor, sections, assignments: assigns } };
      }
    }
  }

  // markdown front-matter guard
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < Math.min(lines.length, 60); i++) {
      const t = lines[i].trim();
      if (t === '---' || t === '...') {
        const tail = lines.slice(i + 1).filter((l) => l.trim());
        const tailYaml = tail.filter((l) => YAML_KEY.test(l) || YAML_LIST.test(l)).length;
        if (tail.length && tailYaml / tail.length < 0.3) return null;
        break;
      }
    }
  }

  const yamlKeys = body.filter((l) => YAML_KEY.test(l)).length;
  const yamlLists = body.filter((l) => YAML_LIST.test(l) && !YAML_KEY.test(l)).length;
  const docMarks = body.filter((l) => YAML_DOC.test(l.trim())).length;
  if (yamlKeys < 3) return null;
  const share = (yamlKeys + yamlLists + docMarks) / body.length;
  if (share < 0.6) return null;
  let enders = 0;
  let words = 0;
  for (const l of body) {
    if (/[.!?]$/.test(l.trimEnd())) enders++;
    words += l.trim().split(/\s+/).filter(Boolean).length;
  }
  if (enders / body.length >= 0.5) return null;
  if (words / body.length > 8) return null;
  const indents = new Set<number>();
  for (const l of body) if (YAML_KEY.test(l) || YAML_LIST.test(l)) indents.add(l.length - l.replace(/^ +/, '').length);
  if (indents.size < 2 && docMarks === 0 && yamlLists < 3) return null;
  if (!yamlParses(text)) return null;
  return { type: 'structured_config', confidence: Math.min(0.9, 0.55 + share * 0.35), metadata: { flavor: 'yaml', keys: yamlKeys, listItems: yamlLists } };
}

// ---------------------------------------------------------------------------
// Source code
// ---------------------------------------------------------------------------

const CODE_PATTERNS: ReadonlyArray<[string, readonly RegExp[]]> = [
  ['python', [/^\s*(def|class|import|from|async def)\s+\w+/, /^\s*@\w+/, /^\s*"""/, /^\s*if __name__\s*==/]],
  ['javascript', [/^\s*(function|const|let|var|class|import|export)\s+/, /^\s*(async\s+function|=>\s*\{)/, /^\s*module\.exports/]],
  ['typescript', [/^\s*(interface|type|enum|namespace)\s+\w+/, /:\s*(string|number|boolean|any|void)\b/]],
  ['go', [/^\s*(func|type|package|import)\s+/, /^\s*func\s+\([^)]+\)\s+\w+/]],
  ['rust', [/^\s*(fn|struct|enum|impl|mod|use|pub)\s+/, /^\s*#\[/]],
  ['java', [/^\s*(public|private|protected)\s+(class|interface|enum)/, /^\s*@\w+/, /^\s*package\s+[\w.]+;/]],
  ['csharp', [/^\s*using\s+[\w.]+\s*;/, /^\s*namespace\s+[\w.]+/, /^\s*(public|private|protected|internal|sealed|static|abstract|partial)\s+(class|struct|record|interface|enum)\b/, /^.*\b(get|set|init);/]],
  ['php', [/<\?php\b/, /^\s*namespace\s+[\w\\]+\s*;/, /^\s*use\s+[\w\\]+(\s+as\s+\w+)?\s*;/, /^\s*(public|private|protected|static|abstract|final)?\s*function\s+\w+\s*\(/, /\$this->/]],
  ['ruby', [/^\s*(def|class|module|require|require_relative|attr_accessor|attr_reader)\s+\S/, /^\s*end\s*$/, /\bdo \|[^|]*\|/]],
  ['cpp', [/^\s*#include\s*[<"]/, /^\s*(class|struct|namespace)\s+\w+/, /^\s*(?:static\s+|inline\s+|const\s+)*(?:int|void|char|bool|double|float|auto|std::\w+)\s+[\w:]+\s*\(/, /^\s*template\s*</]],
  ['kotlin', [/^\s*(fun|val|var|data class|object|sealed class)\s+\w+/, /^\s*import\s+[\w.]+$/]],
  ['swift', [/^\s*(func|let|var|struct|enum|protocol|extension)\s+\w+/, /^\s*import\s+\w+$/, /^\s*@objc/]],
  ['bash', [/^#!\s*\/(?:usr\/)?bin\/(?:env\s+)?(?:ba|z)?sh/, /^\s*(if|then|else|elif|fi|for|do|done|case|esac|while)\b\s*(?:\[|$|;)/, /^\s*\w+\(\)\s*\{/, /\$\{?\w+\}?/]],
];

export function tryDetectCode(text: string, hintLanguage?: string): DetectionResult | null {
  const lines = firstLines(text, 100);
  const scores = new Map<string, number>();
  for (const line of lines) {
    for (const [lang, patterns] of CODE_PATTERNS) {
      for (const p of patterns) {
        if (p.test(line)) {
          scores.set(lang, (scores.get(lang) ?? 0) + 1);
          break;
        }
      }
    }
  }
  let bestLang: string | undefined;
  let bestScore = 0;
  // deterministic: iterate in pattern-table order, strict > wins → first inserted wins ties
  for (const [lang] of CODE_PATTERNS) {
    const s = scores.get(lang) ?? 0;
    if (s > bestScore) {
      bestScore = s;
      bestLang = lang;
    }
  }
  // TypeScript is a superset of JavaScript: any real TS signal on a JS-shaped file means TS
  if (bestLang === 'javascript' && (scores.get('typescript') ?? 0) >= 2) bestLang = 'typescript';
  if (hintLanguage && scores.has(hintLanguage)) {
    // a hint resolves ties and near-ties in its favour (js vs ts, c vs cpp)
    const hs = scores.get(hintLanguage) ?? 0;
    if (hs >= bestScore * 0.5) {
      bestLang = hintLanguage;
      bestScore = hs;
    }
  }
  if (!bestLang) return null;
  const minMatches = hintLanguage ? 1 : 3;
  if (bestScore < minMatches) return null;
  const nonEmpty = lines.filter((l) => l.trim()).length;
  const ratio = bestScore / Math.max(nonEmpty, 1);
  let confidence = Math.min(1, 0.4 + ratio * 0.4 + bestScore * 0.02);
  if (hintLanguage) confidence = Math.min(1, confidence + 0.2);
  return { type: 'source_code', confidence, metadata: { language: hintLanguage ?? bestLang, patternMatches: bestScore } };
}

/** `{ isCode, language, confidence }` — the code detector alone. */
export function looksLikeCode(text: string): { isCode: boolean; language?: string; confidence: number } {
  const r = tryDetectCode(text);
  if (!r) return { isCode: false, confidence: 0 };
  return { isCode: r.confidence >= 0.5, language: r.metadata.language as string | undefined, confidence: r.confidence };
}

// ---------------------------------------------------------------------------
// Paths (Glob / ls / find listings)
// ---------------------------------------------------------------------------

const PATH_LINE = /^(?:\.{0,2}\/)?(?:[^/\s:]+\/)*[^/\s:]+\/?$/;

export function looksLikePathListing(text: string): { isListing: boolean; lines: number } {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return { isListing: false, lines: lines.length };
  let withSlash = 0;
  for (const l of lines.slice(0, 200)) {
    const t = l.trim();
    if (!PATH_LINE.test(t)) return { isListing: false, lines: lines.length };
    if (t.includes('/')) withSlash++;
  }
  return { isListing: withSlash >= Math.min(2, lines.length), lines: lines.length };
}

// ---------------------------------------------------------------------------
// Mixed content
// ---------------------------------------------------------------------------

const FENCE_OPEN = /^```(\w*)\s*$/;
const JSON_LINE = /^\s*[[{]/;
const PROSE = /[A-Z][a-z]+\s+\w+\s+\w+/g;
const SEARCH_LINE = /^\S+:\d+:/;

/** ≥2 of: code fences, JSON blocks, embedded JSON with text, prose, search rows. */
export function isMixedContent(text: string): boolean {
  const lines = text.split('\n');
  let fences = 0;
  let jsonBlocks = 0;
  let searchRows = 0;
  let textLines = 0;
  for (const line of lines) {
    if (FENCE_OPEN.test(line)) fences++;
    else if (JSON_LINE.test(line)) jsonBlocks++;
    else if (SEARCH_LINE.test(line)) searchRows++;
    else if (line.trim()) textLines++;
  }
  PROSE.lastIndex = 0;
  let prose = 0;
  while (PROSE.exec(text) !== null) {
    prose++;
    if (prose > 5) break;
  }
  const indicators = [fences >= 2, jsonBlocks > 0, jsonBlocks > 0 && textLines > 0, prose > 5, searchRows > 0];
  return indicators.filter(Boolean).length >= 2;
}

export interface Section {
  kind: 'text' | 'fence' | 'json' | 'search';
  text: string;
  lang?: string;
}

/**
 * Line-driven split into fenced code, balanced JSON blocks, search-row runs and
 * text. Adjacent text sections are coalesced with `\n`; `sections.map(s => s.text).join('\n')`
 * is not guaranteed byte-exact (the router re-joins with `\n\n`).
 */
export function splitIntoSections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length) {
      sections.push({ kind: 'text', text: buf.join('\n') });
      buf = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      let j = i + 1;
      while (j < lines.length && !/^```\s*$/.test(lines[j])) j++;
      if (j < lines.length) {
        flush();
        sections.push({ kind: 'fence', text: lines.slice(i + 1, j).join('\n'), lang: fence[1] || undefined });
        i = j + 1;
        continue;
      }
    }
    if (JSON_LINE.test(line)) {
      const rest = lines.slice(i).join('\n');
      const start = rest.search(/[[{]/);
      const end = findJsonEnd(rest, start);
      if (end > 0) {
        const block = rest.slice(start, end);
        if (parseJsonSafe(block) !== undefined) {
          const consumed = rest.slice(0, end).split('\n').length;
          const lead = rest.slice(0, start);
          flush();
          sections.push({ kind: 'json', text: lead + block });
          const tail = rest.slice(end).split('\n')[0];
          if (tail.trim()) buf.push(tail);
          i += consumed;
          continue;
        }
      }
    }
    if (isSearchResultLine(line)) {
      let j = i;
      while (j < lines.length && isSearchResultLine(lines[j])) j++;
      if (j - i >= 2) {
        flush();
        sections.push({ kind: 'search', text: lines.slice(i, j).join('\n') });
        i = j;
        continue;
      }
    }
    buf.push(line);
    i++;
  }
  flush();
  return sections;
}

// ---------------------------------------------------------------------------
// Main chain
// ---------------------------------------------------------------------------

function firstLines(text: string, n: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (out.length < n && start <= text.length) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) {
      out.push(text.slice(start));
      break;
    }
    out.push(text.slice(start, nl));
    start = nl + 1;
  }
  return out;
}

export function detectContentType(text: string, hint: DetectHint = {}): DetectionResult {
  if (!text || !text.trim()) return { type: 'plain_text', confidence: 0, metadata: {} };
  const kind = toolKind(hint.toolName);
  const language = canonicalLanguage(hint.language);
  const { inner, envelope } = stripEnvelope(text);
  const result = detectInner(inner, kind, language);
  if (envelope) result.metadata.envelope = envelope;
  if (kind !== 'unknown') result.metadata.toolKind = kind;
  return result;
}

function detectInner(text: string, kind: ToolKind, language: string | undefined): DetectionResult {
  // `rg --json` is a stream of typed objects — it must win over generic concatenated-JSON detection
  if (/^\s*\{"type":"(?:begin|match|context|end|summary)"/.test(text)) {
    const rg = ripgrepJsonToGrep(text);
    if (rg) return { type: 'search_results', confidence: 1, metadata: { format: 'ripgrep-json', matchingLines: rg.matches, files: rg.files } };
  }

  const json = tryDetectJson(text);
  if (json) return json;

  const diff = tryDetectDiff(text);
  if (diff && diff.confidence >= 0.7) return diff;

  const html = tryDetectHtml(text, { lenient: kind === 'html' });
  if (html && html.confidence >= (kind === 'html' ? 0.5 : 0.7)) {
    const log = tryDetectLog(text);
    if (log && log.confidence >= 0.5 && kind !== 'html') return log;
    const search = tryDetectSearch(text);
    if (search && search.confidence >= 0.6 && kind !== 'html') return search;
    return html;
  }

  const search = kind === 'search' ? tryDetectSearch(text, { minLines: 1, minRatio: 0.2 }) : tryDetectSearch(text);
  if (search && search.confidence >= (kind === 'search' ? 0.45 : 0.6)) return search;

  const log = tryDetectLog(text);
  if (log && log.confidence >= 0.5) return log;

  const tabular = tryDetectTabular(text);
  if (tabular && tabular.confidence >= 0.6) return tabular;

  const config = tryDetectStructuredConfig(text);
  if (config && config.confidence >= 0.6) return config;

  const code = tryDetectCode(text, language);
  if (code && code.confidence >= 0.5) {
    if (!language && config && config.confidence >= 0.7) return config;
    return code;
  }
  if (language && !['bash'].includes(language)) {
    // the caller told us what it is (Read of a .rb file) and nothing else claimed it
    return { type: 'source_code', confidence: 0.6, metadata: { language, patternMatches: 0, hinted: true } };
  }

  if (kind === 'paths') {
    const listing = looksLikePathListing(text);
    if (listing.isListing) return { type: 'plain_text', confidence: 0.9, metadata: { paths: true, lines: listing.lines } };
  } else {
    const listing = looksLikePathListing(text);
    if (listing.isListing && listing.lines >= 5) return { type: 'plain_text', confidence: 0.7, metadata: { paths: true, lines: listing.lines } };
  }

  const mixed = isMixedContent(text);
  return { type: 'plain_text', confidence: 0.5, metadata: mixed ? { mixed: true } : {} };
}

/** Whether a positively-claimed type could be handed to the lossy path (used by read protection). */
export const RELEASABLE_TYPES: ReadonlySet<ContentType> = new Set<ContentType>(['json', 'search_results', 'build_output', 'git_diff', 'html', 'tabular']);
