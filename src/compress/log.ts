/**
 * Log / build-output compressor. Typical input: thousands of lines with a
 * handful of real errors. Keeps errors (first, last, top-scoring), failures,
 * deduplicated warnings, up to three stack traces (runtime frames collapsed),
 * summary lines and ±context, under an adaptive line budget. Output lines are
 * verbatim; a trailing `[N lines omitted: …]` summary reports what was cut.
 */

import { computeOptimalK, simhash, hammingDistance, type SimHash } from './adaptive.js';
import type { CompressRequest, CompressResponse, Compressor } from './types.js';

export type LogFormat = 'pytest' | 'npm' | 'cargo' | 'jest' | 'make' | 'generic';
export type LogLevel = 'error' | 'fail' | 'warn' | 'info' | 'debug' | 'trace' | 'unknown';

export interface LogCompressorConfig {
  maxErrors: number;
  errorContextLines: number;
  keepFirstError: boolean;
  keepLastError: boolean;
  maxStackTraces: number;
  stackTraceMaxLines: number;
  maxWarnings: number;
  dedupeWarnings: boolean;
  keepSummaryLines: boolean;
  maxTotalLines: number;
  minLines: number;
  collapseRuntimeFrames: boolean;
  traceHeadFrames: number;
  traceAppFrames: number;
}

export const DEFAULT_LOG_CONFIG: Readonly<LogCompressorConfig> = {
  maxErrors: 10,
  errorContextLines: 3,
  keepFirstError: true,
  keepLastError: true,
  maxStackTraces: 3,
  stackTraceMaxLines: 20,
  maxWarnings: 5,
  dedupeWarnings: true,
  keepSummaryLines: true,
  maxTotalLines: 100,
  minLines: 50,
  collapseRuntimeFrames: true,
  traceHeadFrames: 3,
  traceAppFrames: 5,
};

export interface LogLine {
  lineNumber: number;
  content: string;
  level: LogLevel;
  isStackTrace: boolean;
  isSummary: boolean;
  score: number;
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

const FORMAT_MARKERS: ReadonlyArray<[LogFormat, readonly string[]]> = [
  ['pytest', ['=== FAILURES', '=== ERRORS', '=== test session', '=== short test summary', 'PASSED [', 'FAILED [', 'ERROR [', 'SKIPPED [', 'collected ']],
  ['npm', ['npm ERR!', 'npm WARN', 'npm info', 'npm http']],
  ['cargo', ['Compiling ', 'Finished ', 'Running ', 'warning: ', 'error[E']],
  ['jest', ['PASS ', 'FAIL ', 'Test Suites:']],
  ['make', ['make[', 'make:', 'gcc ', 'g++ ', 'clang ']],
];

export function detectLogFormat(lines: readonly string[]): LogFormat {
  const sample = lines.slice(0, 100);
  let best: LogFormat = 'generic';
  let bestScore = 0;
  for (const [fmt, markers] of FORMAT_MARKERS) {
    let score = 0;
    for (const line of sample) if (markers.some((m) => line.includes(m))) score++;
    if (score > bestScore) {
      bestScore = score;
      best = fmt;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Level classification
// ---------------------------------------------------------------------------

const LEVEL_RE = /\b(ERROR|error|Error|FATAL|fatal|Fatal|CRITICAL|critical|FAILED|failed|Failed|FAIL|fail|Fail|WARNING|warning|Warning|WARN|warn|Warn|INFO|info|Info|DEBUG|debug|Debug|TRACE|trace|Trace)\b/;

export function classifyLevel(line: string): LogLevel {
  const m = LEVEL_RE.exec(line);
  if (!m) return 'unknown';
  const w = m[1].toLowerCase();
  if (w === 'error' || w === 'fatal' || w === 'critical') return 'error';
  if (w === 'fail' || w === 'failed') return 'fail';
  if (w === 'warn' || w === 'warning') return 'warn';
  if (w === 'info') return 'info';
  if (w === 'debug') return 'debug';
  return 'trace';
}

// ---------------------------------------------------------------------------
// Stack traces
// ---------------------------------------------------------------------------

export type TraceFlavor = 'python' | 'js' | 'java' | 'rust_error' | 'rust_backtrace' | 'go_panic' | 'dotnet';

function hasLineColSuffix(s: string): boolean {
  return /:\d+:\d+/.test(s);
}
function isPythonFileFrame(t: string): boolean {
  return t.startsWith('File "') && t.includes('", line ') && /\d$/.test(t);
}
function isJsAtFrame(t: string): boolean {
  return t.startsWith('at ') && t.includes('(') && t.includes(')') && hasLineColSuffix(t);
}
function isJavaAtFrame(t: string): boolean {
  if (!t.startsWith('at ') || !t.includes('(')) return false;
  const body = t.slice(3, t.indexOf('('));
  return body.length > 0 && /^[A-Za-z0-9._$/]+$/.test(body);
}
function isRustPanicOpener(t: string): boolean {
  return t.startsWith("thread '") && t.includes('panicked at');
}
function isGoroutineHeader(line: string): boolean {
  return /^goroutine \d+ \[/.test(line);
}
function isGoPanicOpener(line: string): boolean {
  return line.startsWith('panic: ') || line.startsWith('fatal error: ') || isGoroutineHeader(line);
}
function isGoFileFrame(line: string): boolean {
  return line.startsWith('\t') && line.includes('.go:') && line.includes(' +0x');
}
function isGoCallFrame(line: string): boolean {
  if (line.startsWith('created by ')) return true;
  if (/^[ \t]/.test(line) || !line.endsWith(')')) return false;
  const open = line.indexOf('(');
  if (open <= 0) return false;
  const sym = line.slice(0, open);
  return sym.includes('.') && /^[A-Za-z0-9._/*]+$/.test(sym);
}
function isDotnetFrame(t: string): boolean {
  return t.startsWith('at ') && t.includes(') in ') && t.includes(':line ');
}
function isDotnetOpener(t: string): boolean {
  return t.startsWith('Unhandled exception.') || isDotnetFrame(t);
}
function isRustBacktraceFrame(line: string): boolean {
  return /^\s*\d+:\s*0x[0-9a-fA-F]+/.test(line);
}
function isDotnetExceptionHead(t: string): boolean {
  const colon = t.indexOf(':');
  if (colon < 0) return false;
  const head = t.slice(0, colon);
  return head.endsWith('Exception') && head.includes('.') && /^[A-Za-z0-9._`+]+$/.test(head);
}
function isJavaMoreSummary(t: string): boolean {
  return /^\.\.\. \d+ more$/.test(t.trim());
}

export function traceFlavorFor(line: string): TraceFlavor | null {
  const t = line.trimStart();
  if (t.startsWith('Traceback (most recent call last)') || isPythonFileFrame(t)) return 'python';
  if (isDotnetOpener(t)) return 'dotnet';
  if (isJsAtFrame(t)) return 'js';
  if (isJavaAtFrame(t)) return 'java';
  if (t.startsWith('--> ') && hasLineColSuffix(t)) return 'rust_error';
  if (isRustPanicOpener(t) || t.startsWith('stack backtrace:') || isRustBacktraceFrame(line)) return 'rust_backtrace';
  if (isGoPanicOpener(line)) return 'go_panic';
  return null;
}

export function traceTerminates(flavor: TraceFlavor, line: string, linesSoFar: number): boolean {
  const t = line.trimStart();
  switch (flavor) {
    case 'python': {
      const indentedOrBlank = /^[ \t]/.test(line) || line === '';
      const continuation = t.startsWith('Traceback') || t.startsWith('File ') || t.startsWith('During handling') || t.startsWith('The above exception');
      if (indentedOrBlank || continuation) return false;
      return !/^[A-Z]/.test(t);
    }
    case 'js':
      return !t.startsWith('at ') && line !== '';
    case 'java': {
      const chain = t.startsWith('Caused by:') || t.startsWith('Suppressed:') || isJavaMoreSummary(t);
      return !t.startsWith('at ') && !chain && line !== '';
    }
    case 'dotnet': {
      if (line === '') return false;
      return !(t.startsWith('at ') || t.startsWith('--->') || t.startsWith('--- End of') || isDotnetExceptionHead(t));
    }
    case 'rust_error':
      return !t.startsWith('--> ') && line !== '';
    case 'rust_backtrace': {
      if (line === '' || linesSoFar === 1) return false;
      const isFrame = /^\d/.test(t);
      const continuation = /^[ \t]/.test(line) || t.startsWith('stack backtrace:') || t.startsWith('note: run with');
      return !isFrame && !continuation;
    }
    case 'go_panic': {
      if (line === '') return false;
      return !(line.startsWith('\t') || isGoroutineHeader(line) || isGoCallFrame(line) || line.startsWith('panic: ') || line.startsWith('fatal error: ') || line.startsWith('[signal '));
    }
  }
}

function isFrameLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('at ') || (t.startsWith('File "') && t.includes('", line ')) || isRustBacktraceFrame(line) || isGoFileFrame(line) || isGoCallFrame(line);
}

function isChainHeadLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('Caused by:') || t.startsWith('Suppressed:') || t.startsWith('... ') || t.startsWith('--->') || t.startsWith('--- End of') || t.startsWith('During handling') || t.startsWith('The above exception');
}

const RUNTIME_PREFIXES = ['at java.', 'at jdk.', 'at sun.', 'at javax.', 'at scala.', 'at System.', 'at Microsoft.', 'runtime.', 'created by runtime.'];
const RUNTIME_MARKERS = ['site-packages/', '/usr/lib/python', 'lib/python3.', 'node:internal/', 'node_modules/', '(internal/', 'core::', 'std::', 'alloc::', 'rust_begin_unwind', '__rust_', '/rustc/', '/usr/local/go/src/', '/libexec/src/runtime/'];

export function isRuntimeFrame(line: string): boolean {
  const t = line.trimStart();
  return RUNTIME_PREFIXES.some((p) => t.startsWith(p)) || RUNTIME_MARKERS.some((m) => line.includes(m));
}

/** Keep messages/chain heads, the first `head` frames and up to `app` app frames; dropped runs → `[... N frames collapsed]`. */
export function collapseTraceFrames(stack: readonly LogLine[], head: number, app: number): { kept: LogLine[]; dropped: number[] } {
  const kept: LogLine[] = [];
  const dropped: number[] = [];
  let framesSeen = 0;
  let appKept = 0;
  let runStart: number | null = null;
  let runLen = 0;
  let prevDropped = false;
  const flush = (): void => {
    if (runStart !== null) {
      kept.push({ lineNumber: runStart, content: `      [... ${runLen} frames collapsed]`, level: 'unknown', isStackTrace: true, isSummary: false, score: 0.8 });
      runStart = null;
      runLen = 0;
    }
  };
  for (const line of stack) {
    if (isFrameLine(line.content) && !isChainHeadLine(line.content)) {
      framesSeen++;
      const runtime = isRuntimeFrame(line.content);
      const keep = framesSeen <= head || (!runtime && appKept < app);
      if (keep) {
        if (!runtime) appKept++;
        flush();
        kept.push(line);
        prevDropped = false;
      } else {
        if (runStart === null) runStart = line.lineNumber;
        runLen++;
        dropped.push(line.lineNumber);
        prevDropped = true;
      }
    } else if (prevDropped && /^[ \t]/.test(line.content) && !isChainHeadLine(line.content)) {
      runLen++;
      dropped.push(line.lineNumber);
    } else {
      flush();
      kept.push(line);
      prevDropped = false;
    }
  }
  flush();
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Summary lines
// ---------------------------------------------------------------------------

export function isSummaryLine(line: string): boolean {
  if (line.startsWith('===') || line.startsWith('---')) return true;
  const m = /^(\d+) (passed|failed|skipped|error|warning)/.exec(line);
  if (m) return true;
  for (const prefix of ['Test ', 'Tests ', 'Tests:', 'Test:', 'Suite ', 'Suites ', 'Suites:', 'Suite:']) {
    if (line.startsWith(prefix)) return /^\s*\d/.test(line.slice(prefix.length));
  }
  if (/^(TOTAL|Total|Summary)/.test(line)) return true;
  if (/^(Build|Compile|Test)/.test(line) && /(succeeded|failed|complete)/.test(line)) return true;
  return false;
}

export function scoreLogLine(line: Omit<LogLine, 'score'>, queryWords: readonly string[] = []): number {
  const level = line.level === 'error' || line.level === 'fail' ? 1.0 : line.level === 'warn' ? 0.5 : line.level === 'debug' ? 0.05 : line.level === 'trace' ? 0.02 : 0.1;
  let score = level + (line.isStackTrace ? 0.3 : 0) + (line.isSummary ? 0.4 : 0);
  if (queryWords.length) {
    const lower = line.content.toLowerCase();
    for (const w of queryWords) if (lower.includes(w)) score += 0.2;
  }
  return Math.min(1, score);
}

// ---------------------------------------------------------------------------
// Parse / select / format
// ---------------------------------------------------------------------------

export function parseLogLines(lines: readonly string[], cfg: LogCompressorConfig = DEFAULT_LOG_CONFIG, queryWords: readonly string[] = []): LogLine[] {
  const out: LogLine[] = [];
  let active: TraceFlavor | null = null;
  let traceLines = 0;
  lines.forEach((line, i) => {
    const entry: Omit<LogLine, 'score'> = { lineNumber: i, content: line, level: classifyLevel(line), isStackTrace: false, isSummary: isSummaryLine(line) };
    if (active) {
      if (traceLines >= cfg.stackTraceMaxLines || traceTerminates(active, line, traceLines)) {
        const capHit = traceLines >= cfg.stackTraceMaxLines;
        const prev = active;
        active = null;
        traceLines = 0;
        const fresh = traceFlavorFor(line);
        if (fresh) {
          active = fresh;
          traceLines = 1;
          entry.isStackTrace = true;
        } else if (capHit && !traceTerminates(prev, line, 2)) {
          active = prev;
          traceLines = 1;
          entry.isStackTrace = true;
        }
      } else {
        entry.isStackTrace = true;
        traceLines++;
      }
    } else {
      const flavor = traceFlavorFor(line);
      if (flavor) {
        active = flavor;
        traceLines = 1;
        entry.isStackTrace = true;
      }
    }
    out.push({ ...entry, score: scoreLogLine(entry, queryWords) });
  });
  return out;
}

const TIMESTAMP_PREFIX_RE = /^\s*\[?(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\]?\s*/;

/** Timestamp stripped, message prefix (before the first `:`/`=`) kept verbatim, suffix normalised (digits→N, hex→ADDR, paths→/PATH/). */
export function normalizeForDedupe(content: string): string {
  const s = content.replace(TIMESTAMP_PREFIX_RE, '');
  const idx = s.search(/[:=]/);
  const split = idx < 0 ? s.length : idx;
  const prefix = s.slice(0, split);
  const suffix = s
    .slice(split)
    .replace(/0x[0-9a-fA-F]+/g, 'ADDR')
    .replace(/\d+/g, 'N')
    .replace(/\/[\w/]+\//g, '/PATH/');
  return prefix + suffix;
}

/** Conservative exact-key dedupe followed by simhash near-duplicate collapse (Hamming ≤ 3). */
export function dedupeSimilar(lines: readonly LogLine[]): LogLine[] {
  const seen = new Set<string>();
  const reps: SimHash[] = [];
  const out: LogLine[] = [];
  for (const line of lines) {
    const key = normalizeForDedupe(line.content);
    if (seen.has(key)) continue;
    seen.add(key);
    const fp = simhash(key);
    if (reps.some((r) => hammingDistance(fp, r) <= 3)) continue;
    reps.push(fp);
    out.push(line);
  }
  return out;
}

function selectWithFirstLast(lines: readonly LogLine[], max: number, cfg: LogCompressorConfig): LogLine[] {
  if (lines.length <= max) return [...lines];
  const out: LogLine[] = [];
  const seen = new Set<number>();
  const push = (l: LogLine): void => {
    if (!seen.has(l.lineNumber)) {
      seen.add(l.lineNumber);
      out.push(l);
    }
  };
  if (cfg.keepFirstError) push(lines[0]);
  if (cfg.keepLastError) push(lines[lines.length - 1]);
  const byScore = [...lines].sort((a, b) => b.score - a.score || a.lineNumber - b.lineNumber);
  for (const l of byScore) {
    if (out.length >= max) break;
    push(l);
  }
  return out;
}

export interface LogSelection {
  selected: LogLine[];
  adaptiveMax: number;
  stackTracesSeen: number;
}

export function selectLogLines(logLines: readonly LogLine[], bias = 1, cfg: LogCompressorConfig = DEFAULT_LOG_CONFIG): LogSelection {
  const adaptiveMax = computeOptimalK(
    logLines.map((l) => l.content),
    bias,
    10,
    cfg.maxTotalLines,
  );
  const errors: LogLine[] = [];
  const fails: LogLine[] = [];
  const warnings: LogLine[] = [];
  const summaries: LogLine[] = [];
  const traces: LogLine[][] = [];
  let current: LogLine[] = [];
  for (const line of logLines) {
    if (line.level === 'error') errors.push(line);
    else if (line.level === 'fail') fails.push(line);
    else if (line.level === 'warn') warnings.push(line);
    if (line.isStackTrace) current.push(line);
    else if (current.length) {
      traces.push(current);
      current = [];
    }
    if (line.isSummary) summaries.push(line);
  }
  if (current.length) traces.push(current);

  const selected = new Map<number, LogLine>();
  const add = (l: LogLine): void => {
    if (!selected.has(l.lineNumber)) selected.set(l.lineNumber, l);
  };
  for (const l of selectWithFirstLast(errors, cfg.maxErrors, cfg)) add(l);
  for (const l of selectWithFirstLast(fails, cfg.maxErrors, cfg)) add(l);
  const warns = cfg.dedupeWarnings ? dedupeSimilar(warnings) : warnings;
  for (const l of warns.slice(0, cfg.maxWarnings)) add(l);
  const collapsed = new Set<number>();
  for (const stack of traces.slice(0, cfg.maxStackTraces)) {
    if (cfg.collapseRuntimeFrames && stack.length > cfg.stackTraceMaxLines) {
      const c = collapseTraceFrames(stack, cfg.traceHeadFrames, cfg.traceAppFrames);
      for (const d of c.dropped) collapsed.add(d);
      for (const l of c.kept.slice(0, cfg.stackTraceMaxLines)) add(l);
    } else for (const l of stack.slice(0, cfg.stackTraceMaxLines)) add(l);
  }
  if (cfg.keepSummaryLines) for (const l of summaries) add(l);

  const selectedIdx = new Set(selected.keys());
  const context = new Set<number>();
  for (const idx of selectedIdx) {
    const lo = Math.max(0, idx - cfg.errorContextLines);
    const hi = Math.min(logLines.length, idx + cfg.errorContextLines + 1);
    for (let i = lo; i < hi; i++) if (i !== idx) context.add(i);
  }
  for (const idx of context) if (!selectedIdx.has(idx) && idx < logLines.length && !collapsed.has(idx)) add(logLines[idx]);

  let ordered = [...selected.values()].sort((a, b) => a.lineNumber - b.lineNumber);
  if (ordered.length > adaptiveMax) {
    ordered.sort((a, b) => b.score - a.score || a.lineNumber - b.lineNumber);
    ordered = ordered.slice(0, adaptiveMax).sort((a, b) => a.lineNumber - b.lineNumber);
  }
  return { selected: ordered, adaptiveMax, stackTracesSeen: traces.length };
}

export function formatLogOutput(selected: readonly LogLine[], all: readonly LogLine[]): string {
  const count = (level: LogLevel): number => all.filter((l) => l.level === level).length;
  const out = selected.map((l) => l.content);
  const omitted = all.length - selected.length;
  if (omitted > 0) {
    const parts: string[] = [];
    for (const [label, level] of [
      ['ERROR', 'error'],
      ['FAIL', 'fail'],
      ['WARN', 'warn'],
      ['INFO', 'info'],
    ] as Array<[string, LogLevel]>) {
      const n = count(level);
      if (n > 0) parts.push(`${n} ${label}`);
    }
    out.push(parts.length ? `[${omitted} lines omitted: ${parts.join(', ')}]` : `[${omitted} lines omitted]`);
  }
  return out.join('\n');
}

export class LogCompressor implements Compressor {
  readonly strategy = 'log' as const;
  readonly config: LogCompressorConfig;

  constructor(config: Partial<LogCompressorConfig> = {}) {
    this.config = { ...DEFAULT_LOG_CONFIG, ...config };
  }

  compress(req: CompressRequest): CompressResponse {
    const content = req.content;
    const passthrough = (info: string): CompressResponse => ({ content, strategy: 'passthrough', chain: ['log', 'passthrough'], ccrHashes: [], info });
    try {
      const lines = content.split('\n');
      if (lines.length < this.config.minLines) return passthrough('below_min_lines');
      const queryWords = (req.query ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 32);
      const format = detectLogFormat(lines);
      const parsed = parseLogLines(lines, this.config, queryWords);
      const { selected } = selectLogLines(parsed, req.bias ?? req.profile?.bias ?? 1, this.config);
      const out = formatLogOutput(selected, parsed);
      if (out.length >= content.length || selected.length >= lines.length) return passthrough('no_savings');
      return { content: out, strategy: 'log', chain: ['log'], ccrHashes: [], info: `log:${format}(${lines.length}->${selected.length} lines)`, itemCounts: { original: lines.length, kept: selected.length } };
    } catch {
      return passthrough('error');
    }
  }
}
