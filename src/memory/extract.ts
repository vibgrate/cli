/**
 * Deterministic memory extraction from conversations — no model, no regex
 * backtracking, no clock.
 *
 * Signals (mirroring the reference traffic learner, typed and single-pass):
 *  - preferences: user corrections ("don't …", "never …", "… instead") in the
 *    last few user turns, after stripping `<system-reminder>` blocks and
 *    harness-authored user messages;
 *  - decisions: "we decided …", "let's go with …", "use X instead of Y";
 *  - gotchas: a failing tool call followed (≤ 5 calls later) by a successful
 *    call of the same tool that is plausibly a corrected retry — Read path
 *    typos, Grep/Glob pattern changes, Bash command fixes;
 *  - commands: environment facts revealed by successful shell commands
 *    (virtualenv activation, a passing test command).
 *
 * Each extracted memory carries a `key` — the normalised identity the
 * traffic learner counts evidence against (e.g. two Bash recoveries that
 * differ only in `| head -N` share one key).
 */

import type { Message } from '../compress/types.js';
import { classifyError, contentText, isErrorContent, normalizeToolName, stringifyOutput } from '../learn/shared.js';
import type { ErrorCategory } from '../learn/types.js';
import type { MemoryKind } from './types.js';

export interface ExtractedMemory {
  kind: MemoryKind;
  text: string;
  tags: string[];
  /** Normalised identity used for evidence accumulation. */
  key: string;
  /** 0..1 — how much a single observation is worth. */
  importance: number;
}

export interface ToolObservation {
  name: string;
  id: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  errorCategory: ErrorCategory;
  messageIndex: number;
}

// ---------------------------------------------------------------------------
// Conversation walking
// ---------------------------------------------------------------------------

const OUTPUT_KEEP = 2000;

/**
 * Pair tool calls with their results across Anthropic (`tool_use` /
 * `tool_result` blocks) and OpenAI (`tool_calls` / `role: tool`) shapes.
 * `response` (an assistant reply not yet in `messages`) contributes pending
 * calls whose results may arrive in a later turn.
 */
export function extractToolCalls(messages: readonly Message[], response?: Record<string, unknown>): ToolObservation[] {
  const pending = new Map<string, { name: string; input: Record<string, unknown> }>();
  const out: ToolObservation[] = [];
  const noteUse = (id: unknown, name: unknown, input: unknown): void => {
    if (typeof id !== 'string' || typeof name !== 'string' || !id || !name) return;
    let inp: Record<string, unknown> = {};
    if (typeof input === 'string') {
      try {
        const parsed = JSON.parse(input) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) inp = parsed as Record<string, unknown>;
        else inp = { raw: input };
      } catch {
        inp = { raw: input };
      }
    } else if (input && typeof input === 'object' && !Array.isArray(input)) inp = input as Record<string, unknown>;
    pending.set(id, { name: normalizeToolName(name), input: inp });
  };
  const noteResult = (id: unknown, content: unknown, explicitError: boolean, messageIndex: number): void => {
    if (typeof id !== 'string') return;
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    const output = stringifyOutput(content).slice(0, OUTPUT_KEEP);
    const isError = explicitError || isErrorContent(output);
    out.push({
      name: call.name,
      id,
      input: call.input,
      output,
      isError,
      errorCategory: isError ? classifyError(output) : 'unknown',
      messageIndex,
    });
  };

  messages.forEach((msg, i) => {
    const role = typeof msg.role === 'string' ? msg.role : '';
    const content = msg.content;
    if (role === 'assistant') {
      if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) if (b && b.type === 'tool_use') noteUse(b.id, b.name, b.input);
      }
      const calls = msg.tool_calls;
      if (Array.isArray(calls)) {
        for (const c of calls as Array<Record<string, unknown>>) {
          const fn = c?.function as Record<string, unknown> | undefined;
          noteUse(c?.id, fn?.name, fn?.arguments);
        }
      }
    } else if (role === 'user') {
      if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) if (b && b.type === 'tool_result') noteResult(b.tool_use_id, b.content, b.is_error === true, i);
      }
    } else if (role === 'tool') {
      noteResult(msg.tool_call_id, content, false, i);
    }
  });

  if (response) {
    const content = response.content;
    if (Array.isArray(content)) for (const b of content as Array<Record<string, unknown>>) if (b && b.type === 'tool_use') noteUse(b.id, b.name, b.input);
    const choices = response.choices;
    if (Array.isArray(choices)) {
      const msg = (choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined;
      const calls = msg?.tool_calls;
      if (Array.isArray(calls)) {
        for (const c of calls as Array<Record<string, unknown>>) {
          const fn = c?.function as Record<string, unknown> | undefined;
          noteUse(c?.id, fn?.name, fn?.arguments);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// User text hygiene
// ---------------------------------------------------------------------------

const HARNESS_USER_PREFIXES = [
  'another language model started to solve this problem and produced a summary',
  '<app-context>',
  '<codex_delegation>',
  '<environment_context>',
  '<heartbeat>',
  '<permissions instructions>',
  '<skills_instructions>',
  '# agents.md instructions for ',
  'you are in a fork of an existing codex thread',
  '<command-name>',
  '<local-command-stdout>',
];
const MEMORY_CONTEXT_MARKERS = ['\n\n## relevant memories', '\n## relevant memories'];
const AMBIENT_MARKERS = ['<in-app-browser-context'];

/** Remove `<system-reminder>…</system-reminder>` blocks (literal scan, case-insensitive). */
export function stripSystemReminders(text: string): string {
  if (!text || !text.includes('<')) return text;
  const open = '<system-reminder';
  const close = '</system-reminder>';
  const lower = text.toLowerCase();
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = lower.indexOf(open, cursor);
    if (start < 0) {
      parts.push(text.slice(cursor));
      break;
    }
    parts.push(text.slice(cursor, start));
    const tagEnd = text.indexOf('>', start);
    if (tagEnd < 0) break;
    const closeStart = lower.indexOf(close, tagEnd + 1);
    if (closeStart < 0) break;
    cursor = closeStart + close.length;
  }
  return parts.join('');
}

/** Drop proxy- or client-appended context from a user turn. */
export function canonicalizeUserText(text: string): string {
  let canonical = text ?? '';
  const folded = canonical.toLowerCase();
  if (folded.trimStart().startsWith('## relevant memories')) return '';
  let cut = -1;
  for (const marker of [...MEMORY_CONTEXT_MARKERS, ...AMBIENT_MARKERS]) {
    const i = folded.indexOf(marker);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  if (cut >= 0) canonical = canonical.slice(0, cut);
  return canonical.trim();
}

export function isLearnableUserText(text: string): boolean {
  const canonical = canonicalizeUserText(text);
  if (!canonical) return false;
  const folded = canonical.trimStart().toLowerCase();
  return !HARNESS_USER_PREFIXES.some((p) => folded.startsWith(p));
}

// ---------------------------------------------------------------------------
// Trigger scanner (regex-free, single pass)
// ---------------------------------------------------------------------------

type Trigger = readonly [readonly string[], number];

const PREFERENCE_TRIGGERS: readonly Trigger[] = [
  [["don't"], 98],
  [['dont'], 98],
  [['do', 'not'], 98],
  [['stop'], 98],
  [['never'], 98],
  [['avoid'], 98],
  [['always'], 98],
  [['no', 'use'], 98],
  [['no', 'try'], 98],
  [['no', 'do'], 98],
  [['instead'], 78],
];

const DECISION_TRIGGERS: readonly Trigger[] = [
  [['we', 'decided'], 120],
  [['decided', 'to'], 120],
  [['decision:'], 120],
  [["let's", 'go', 'with'], 120],
  [['lets', 'go', 'with'], 120],
  [["we'll", 'go', 'with'], 120],
  [['going', 'with'], 120],
  [["let's", 'use'], 120],
  [['we', 'chose'], 120],
  [['we', 'will', 'use'], 120],
];

const SENTENCE_TERMINATORS = new Set(['.', '!', '?', '\n']);
const PRE_CAPTURE_PUNCT = new Set([',', ';', ':']);
const TOKEN_STRIP = new Set([',', '.', ';', ':', '!', '?', '"', "'", '(', ')', '[', ']', '{', '}']);
const MIN_CAPTURE = 10;

interface Tok {
  t: string;
  start: number;
  end: number;
}

function tokenizeWs(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    const start = i;
    while (i < n && !/\s/.test(text[i])) i++;
    if (i > start) out.push({ t: text.slice(start, i).toLowerCase(), start, end: i });
  }
  return out;
}

function stripToken(t: string): string {
  let s = 0;
  let e = t.length;
  while (s < e && TOKEN_STRIP.has(t[s])) s++;
  while (e > s && TOKEN_STRIP.has(t[e - 1])) e--;
  return t.slice(s, e);
}

function captureAfter(text: string, from: number, maxChars: number): string | null {
  const n = text.length;
  let s = from;
  while (s < n && (/\s/.test(text[s]) || PRE_CAPTURE_PUNCT.has(text[s]))) s++;
  let e = s;
  while (e < n && e - s < maxChars && !SENTENCE_TERMINATORS.has(text[e])) e++;
  const len = e - s;
  if (len < MIN_CAPTURE) return null;
  if (len >= maxChars && e < n && !SENTENCE_TERMINATORS.has(text[e])) return null; // rambling fragment
  let captured = text.slice(s, e).trim();
  while (captured.length && SENTENCE_TERMINATORS.has(captured[captured.length - 1])) captured = captured.slice(0, -1);
  captured = captured.trim();
  return captured || null;
}

/**
 * Find the first trigger sequence and capture the sentence that follows it.
 * Returns the captured text (without the trigger) plus the trigger words.
 */
export function findTriggered(text: string, triggers: readonly Trigger[]): { captured: string; trigger: string } | null {
  const tokens = tokenizeWs(text);
  for (let i = 0; i < tokens.length; i++) {
    for (const [seq, maxChars] of triggers) {
      if (i + seq.length > tokens.length) continue;
      let ok = true;
      for (let k = 0; k < seq.length; k++) {
        if (stripToken(tokens[i + k].t) !== seq[k]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const captured = captureAfter(text, tokens[i + seq.length - 1].end, maxChars);
      if (captured === null) continue;
      return { captured, trigger: seq.join(' ') };
    }
  }
  return null;
}

/** "User preference: …" from a user turn, or null. */
export function extractPreference(userText: string): ExtractedMemory | null {
  const cleaned = canonicalizeUserText(stripSystemReminders(userText)).slice(0, 500);
  if (!isLearnableUserText(cleaned)) return null;
  const hit = findTriggered(cleaned, PREFERENCE_TRIGGERS);
  if (!hit) return null;
  const text = `User preference: ${hit.trigger} ${hit.captured}`;
  return { kind: 'preference', text, tags: ['correction'], key: `preference|${text.toLowerCase()}`, importance: 0.75 };
}

/** "Decision: …" from a user or assistant turn, or null. */
export function extractDecision(text: string): ExtractedMemory | null {
  const cleaned = canonicalizeUserText(stripSystemReminders(text)).slice(0, 800);
  if (!cleaned) return null;
  const hit = findTriggered(cleaned, DECISION_TRIGGERS);
  if (!hit) return null;
  const statement = `Decision: ${hit.trigger} ${hit.captured}`;
  return { kind: 'decision', text: statement, tags: ['decision'], key: `decision|${statement.toLowerCase()}`, importance: 0.6 };
}

// ---------------------------------------------------------------------------
// Error → recovery pairing gates
// ---------------------------------------------------------------------------

/** Iterative Levenshtein distance (bounded inputs only). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  if (a.length > b.length) [a, b] = [b, a];
  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    const curr = [j];
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(curr[i - 1] + 1, prev[i] + 1, prev[i - 1] + cost);
    }
    prev = curr;
  }
  return prev[a.length];
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Same basename, or basenames within max(2, len/3) edits. */
export function pathsRelatedAsTypo(failed: string, success: string): boolean {
  if (!failed || !success || failed === success) return false;
  const a = basename(failed);
  const b = basename(success);
  if (!a || !b) return false;
  if (a === b) return true;
  const threshold = Math.max(2, Math.floor(Math.max(a.length, b.length) / 3));
  return levenshtein(a, b) <= threshold;
}

const COMMAND_NOISE = new Set(['head', 'tail', 'cat', 'grep', 'awk', 'sed', 'sort', 'uniq', 'wc', 'xargs', 'find']);

export function bashFirstBinary(cmd: string): string | null {
  let s = cmd.trim();
  const m = /^source\s+\S+\s*&&\s*/i.exec(s);
  if (m) s = s.slice(m[0].length);
  for (const tok of s.split(/\s+/)) {
    if (!tok) continue;
    const eq = tok.indexOf('=');
    if (eq > 0 && /^[A-Za-z0-9_]+$/.test(tok.slice(0, eq))) continue;
    return tok;
  }
  return null;
}

export function bashBinariesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const ab = basename(a);
  const bb = basename(b);
  if (ab === bb) return true;
  if ((ab.startsWith(bb) || bb.startsWith(ab)) && levenshtein(ab, bb) <= 2) return true;
  // One-character variants (`npm` ↔ `pnpm`, `python` ↔ `pythn`) are the same tool retried.
  return levenshtein(ab, bb) <= 1;
}

/** Same binary AND (normalised edit distance ≤ 0.40 OR a shared substantive token). */
export function commandsRelatedAsRetry(failed: string, success: string): boolean {
  if (!failed || !success || failed === success) return false;
  const ba = bashFirstBinary(failed);
  const bb = bashFirstBinary(success);
  if (!ba || !bb || !bashBinariesMatch(ba, bb)) return false;
  const maxLen = Math.max(failed.length, success.length);
  if (maxLen > 0 && maxLen <= 400 && levenshtein(failed, success) / maxLen <= 0.4) return true;
  const substantive = (cmd: string, bin: string): Set<string> => {
    const out = new Set<string>();
    for (const tok of cmd.split(/\s+/)) {
      if (tok.length < 5 || tok.startsWith('-') || tok === bin) continue;
      if (COMMAND_NOISE.has(tok.toLowerCase())) continue;
      out.add(tok);
    }
    return out;
  };
  const sa = substantive(failed, ba);
  for (const t of substantive(success, bb)) if (sa.has(t)) return true;
  return false;
}

/** Strip volatile suffixes (`| head -N`, `-A N`, `2>&1`) and cut at the first `|`/`&&`. */
export function normalizeBashForKey(cmd: string): string {
  if (!cmd) return '';
  let trimmed = cmd.replace(/(?:\s*\|\s*(?:head|tail)\s+-n?\s*\d+|\s+-[ABC]\s*\d+|\s+2>&1|\s+2>\/dev\/null)+\s*$/, '').trim();
  for (const sep of [' | ', ' && ']) {
    const i = trimmed.indexOf(sep);
    if (i !== -1) {
      trimmed = trimmed.slice(0, i).trimEnd();
      break;
    }
  }
  return trimmed;
}

const MODULE_RE = /No module named ['"]?([A-Za-z0-9_][\w.]*)/;
const COMMAND_NF_RE = /([A-Za-z0-9_][\w-]*): command not found/;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Build the recovery memory for an error → success pair of the same tool, or null. */
export function buildRecovery(error: ToolObservation, success: ToolObservation): ExtractedMemory | null {
  const tool = error.name;
  if (tool === 'Bash') {
    const failed = str(error.input.command ?? error.input.cmd);
    const ok = str(success.input.command ?? success.input.cmd);
    if (!failed || !ok || failed === ok) return null;
    if (!commandsRelatedAsRetry(failed, ok)) return null;
    let importance = 0.7;
    if (error.errorCategory === 'command_not_found') importance = 0.85;
    else if (error.errorCategory === 'module_not_found') importance = 0.8;
    const f = failed.slice(0, 200);
    const s = ok.slice(0, 200);
    const tags = ['bash', error.errorCategory];
    const mod = MODULE_RE.exec(error.output);
    if (mod) tags.push(mod[1]);
    const cnf = COMMAND_NF_RE.exec(error.output);
    if (cnf) tags.push(cnf[1]);
    return {
      kind: 'gotcha',
      text: `Command \`${f}\` fails (${error.errorCategory}). Use \`${s}\` instead.`,
      tags,
      key: `error_recovery|Bash|${normalizeBashForKey(f)}|${normalizeBashForKey(s)}`,
      importance,
    };
  }
  if (tool === 'Read') {
    const ep = str(error.input.file_path ?? error.input.path);
    const sp = str(success.input.file_path ?? success.input.path);
    if (!pathsRelatedAsTypo(ep, sp)) return null;
    return {
      kind: 'gotcha',
      text: `File \`${ep}\` does not exist. The correct path is \`${sp}\`.`,
      tags: ['read', 'file_not_found', sp],
      key: `error_recovery|Read|${basename(ep)}|${basename(sp)}`,
      importance: 0.7,
    };
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const ep = str(error.input.pattern);
    const sp = str(success.input.pattern);
    if (!ep || !sp || ep === sp) return null;
    return {
      kind: 'gotcha',
      text: `Search pattern \`${ep}\` found no results. Use \`${sp}\` instead.`,
      tags: [tool.toLowerCase(), 'no_matches'],
      key: `error_recovery|${tool}|${ep}|${sp}`,
      importance: 0.5,
    };
  }
  return null;
}

const TEST_RUNNERS = ['pytest', 'vitest', 'jest', 'npm test', 'pnpm test', 'yarn test', 'cargo test', 'go test', 'mvn test', 'gradle test', 'dotnet test', 'rspec', 'phpunit'];
const TEST_SUCCESS = ['PASSED', 'passed', 'ok', 'Tests:', 'test result: ok', '✓'];

/** Environment facts from a successful Bash call. */
export function extractEnvironment(obs: ToolObservation): ExtractedMemory[] {
  if (obs.name !== 'Bash' || obs.isError) return [];
  const cmd = str(obs.input.command ?? obs.input.cmd);
  const out: ExtractedMemory[] = [];
  if (cmd.includes('activate') && cmd.includes('source')) {
    const m = /source\s+(\S+\/activate)/.exec(cmd);
    if (m) {
      out.push({
        kind: 'command',
        text: `Python virtual environment: \`source ${m[1]}\` before running Python tools.`,
        tags: ['environment', 'venv', m[1]],
        key: `environment|venv|${m[1]}`,
        importance: 0.8,
      });
    }
  }
  const lower = cmd.toLowerCase();
  if (TEST_RUNNERS.some((r) => lower.includes(r)) && TEST_SUCCESS.some((s) => obs.output.includes(s))) {
    const c = cmd.slice(0, 200);
    out.push({ kind: 'command', text: `Working test command: \`${c}\``, tags: ['environment', 'test'], key: `environment|test|${normalizeBashForKey(c)}`, importance: 0.6 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whole-conversation extraction
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /** Assistant reply not yet appended to `messages`. */
  response?: Record<string, unknown>;
  /** How many trailing user turns to mine for preferences (default 3). */
  lastUserTurns?: number;
  /** Look-back window (tool calls) when pairing an error with its recovery (default 5). */
  recoveryWindow?: number;
}

/** Recoveries, environment facts, preferences and decisions from one conversation. */
export function extractMemories(messages: readonly Message[], opts: ExtractOptions = {}): ExtractedMemory[] {
  const out: ExtractedMemory[] = [];
  const seen = new Set<string>();
  const push = (m: ExtractedMemory | null): void => {
    if (!m || seen.has(m.key)) return;
    seen.add(m.key);
    out.push(m);
  };

  const calls = extractToolCalls(messages, opts.response);
  const window = opts.recoveryWindow ?? 5;
  calls.forEach((call, i) => {
    if (call.isError) return;
    for (let j = i - 1; j >= Math.max(0, i - window); j--) {
      const prev = calls[j];
      if (!prev.isError) continue;
      if (prev.name === call.name) {
        push(buildRecovery(prev, call));
        break; // only the most recent error of the same tool
      }
    }
    for (const env of extractEnvironment(call)) push(env);
  });

  const userTurns: string[] = [];
  const assistantTurns: string[] = [];
  for (const msg of messages) {
    const role = msg.role;
    if (role === 'user') {
      const text = contentText(msg.content);
      if (text.trim()) userTurns.push(text);
    } else if (role === 'assistant') {
      const text = contentText(msg.content);
      if (text.trim()) assistantTurns.push(text);
    }
  }
  const lastN = opts.lastUserTurns ?? 3;
  for (const text of userTurns.slice(-lastN)) {
    push(extractPreference(text));
    push(extractDecision(text));
  }
  for (const text of assistantTurns.slice(-2)) push(extractDecision(text));
  return out;
}

const FILE_RULE_RE = /^File `([^`]+)` does not exist\. The correct path is `([^`]+)`\.$/;

/** Drop A→B and B→A path corrections (opposite-direction typos, not a truth). */
export function dropContradictions<T extends { text: string }>(items: readonly T[]): T[] {
  const forward = new Map<string, number>();
  items.forEach((it, i) => {
    const m = FILE_RULE_RE.exec(it.text);
    if (m) forward.set(`${m[1]}\u0000${m[2]}`, i);
  });
  const drop = new Set<number>();
  for (const [key, idx] of forward) {
    const [a, b] = key.split('\u0000');
    const back = forward.get(`${b}\u0000${a}`);
    if (back !== undefined) {
      drop.add(idx);
      drop.add(back);
    }
  }
  if (drop.size === 0) return [...items];
  return items.filter((_, i) => !drop.has(i));
}
