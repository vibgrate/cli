/**
 * Loop detection — the highest-value pattern `vg install --learn` can catch, because
 * the waste scales with repetition.
 *
 *  - error-loop:   the same call fails ≥ 3× in a session (all repetitions wasted);
 *  - refetch-loop: output-limited variants of one shell command re-run ≥ 3×
 *                  (`grep foo | head -50`, `| head -100`, …) — all but the
 *                  largest fetch wasted;
 *  - edit-cycle:   the same file edited/written ≥ 3× in a session (all
 *                  repetitions counted as waste);
 *  - same-error:   the same error text (integers collapsed) returned ≥ 3× by
 *                  different calls.
 *
 * Signatures collapse pagination fragments and bare integers so variants map
 * together. Loops are detected per session (a loop is a within-conversation
 * phenomenon) and merged by signature across sessions.
 */

import { inputSummary, truncateHeadTail } from './shared.js';
import type { Loop, LoopKind, Session, ToolCall } from './types.js';

export const DEFAULT_MIN_OCCURRENCES = 3;
export const BYTES_PER_TOKEN = 4;

// Order-independent, applied globally; each alternative is anchored to a
// keyword so the expression stays linear.
const PAGINATION_RE = /\|\s*head\s+-n?\s*\d+|\|\s*tail\s+-n?\s*\d+|-n\s*\d+|--max-count[= ]\d+|--lines[= ]\d+|\bhead\s+-\d+|\b(?:limit|offset)[= ]\d+|\bLIMIT\s+\d+|\bOFFSET\s+\d+/gi;
const INT_RE = /\b\d+\b/g;
const WS_RE = /\s+/g;

/** `tool::normalised input` — stable across re-fetch variants. */
export function canonicalSignature(tc: ToolCall): string {
  let raw = inputSummary(tc.name, tc.input).trim();
  const lower = tc.name.toLowerCase();
  if (lower === 'bash' || lower === 'shell') {
    raw = raw.replace(PAGINATION_RE, ' ');
    raw = raw.replace(INT_RE, 'N');
  }
  raw = raw.replace(WS_RE, ' ').trim().toLowerCase();
  return `${lower}::${raw}`;
}

/** First line of an error, integers collapsed, for same-error grouping. */
export function errorSignature(tc: ToolCall): string {
  const first = tc.output.split('\n').find((l) => l.trim()) ?? '';
  return `${tc.errorCategory}::${first.replace(INT_RE, 'N').replace(WS_RE, ' ').trim().toLowerCase().slice(0, 160)}`;
}

function tokensOf(tc: ToolCall): number {
  return Math.floor((tc.outputBytes || Buffer.byteLength(tc.output, 'utf8')) / BYTES_PER_TOKEN);
}

interface Group {
  kind: LoopKind;
  tool: string;
  signature: string;
  sample: string;
  calls: Array<{ tc: ToolCall; index: number }>;
  sessions: Set<string>;
}

function toolCalls(session: Session): Array<{ tc: ToolCall; index: number }> {
  const out: Array<{ tc: ToolCall; index: number }> = [];
  for (const t of session.turns) if (t.kind === 'tool_call' && t.toolCall) out.push({ tc: t.toolCall, index: t.index });
  return out;
}

function groupsFor(session: Session, minOccurrences: number): Group[] {
  const calls = toolCalls(session);
  const bySig = new Map<string, Array<{ tc: ToolCall; index: number }>>();
  const byErr = new Map<string, Array<{ tc: ToolCall; index: number }>>();
  for (const c of calls) {
    const sig = canonicalSignature(c.tc);
    (bySig.get(sig) ?? bySig.set(sig, []).get(sig))?.push(c);
    if (c.tc.isError) {
      const key = errorSignature(c.tc);
      (byErr.get(key) ?? byErr.set(key, []).get(key))?.push(c);
    }
  }
  const groups: Group[] = [];
  const covered = new Set<string>();
  for (const [sig, list] of bySig) {
    if (list.length < minOccurrences) continue;
    const errors = list.filter((c) => c.tc.isError).length;
    const isError = errors >= list.length / 2;
    const name = list[0].tc.name;
    // An Edit/Write signature is the file path: repeating it is an edit cycle, not a re-fetch.
    const kind: LoopKind = isError ? 'error-loop' : name === 'Edit' || name === 'Write' ? 'edit-cycle' : 'refetch-loop';
    groups.push({ kind, tool: name, signature: sig, sample: inputSummary(name, list[0].tc.input).slice(0, 120), calls: list, sessions: new Set([session.id]) });
    covered.add(sig);
  }
  for (const [key, list] of byErr) {
    if (list.length < minOccurrences) continue;
    // Skip when every occurrence is already an error-loop of one signature.
    const sigs = new Set(list.map((c) => canonicalSignature(c.tc)));
    if (sigs.size === 1 && covered.has([...sigs][0])) continue;
    groups.push({ kind: 'same-error', tool: list[0].tc.name, signature: key, sample: truncateHeadTail(list[0].tc.output, 120), calls: list, sessions: new Set([session.id]) });
  }
  return groups;
}

function finish(g: Group): Loop {
  const tokens = g.calls.map((c) => tokensOf(c.tc));
  let wasted: number;
  if (g.kind === 'refetch-loop') {
    const sorted = [...tokens].sort((a, b) => b - a);
    wasted = sorted.slice(1).reduce((a, b) => a + b, 0);
  } else wasted = tokens.reduce((a, b) => a + b, 0);
  return {
    kind: g.kind,
    tool: g.tool,
    signature: g.signature,
    sample: g.sample,
    count: g.calls.length,
    wastedTokens: wasted,
    indices: g.calls.map((c) => c.index).sort((a, b) => a - b),
    sessions: [...g.sessions].sort(),
  };
}

export function compareLoops(a: Loop, b: Loop): number {
  if (b.wastedTokens !== a.wastedTokens) return b.wastedTokens - a.wastedTokens;
  if (b.count !== a.count) return b.count - a.count;
  return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
}

/** Loops within one session, most waste first. */
export function detectLoops(session: Session, opts: { minOccurrences?: number } = {}): Loop[] {
  const min = opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  return groupsFor(session, min).map(finish).sort(compareLoops);
}

/** Loops across sessions, merged by kind + signature so recurring loops accumulate. */
export function detectLoopsAcross(sessions: readonly Session[], opts: { minOccurrences?: number } = {}): Loop[] {
  const min = opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const merged = new Map<string, Group>();
  for (const s of sessions) {
    for (const g of groupsFor(s, min)) {
      const key = `${g.kind}|${g.signature}`;
      const cur = merged.get(key);
      if (cur) {
        cur.calls.push(...g.calls);
        for (const id of g.sessions) cur.sessions.add(id);
      } else merged.set(key, g);
    }
  }
  return [...merged.values()].map(finish).sort(compareLoops);
}

export const LOOPS_DIGEST_HEADER = '=== Detected Loops (HIGHEST PRIORITY) ===';

/** The digest section handed to an analyzer; '' when there are no loops. */
export function formatLoopsForDigest(loops: readonly Loop[]): string {
  if (loops.length === 0) return '';
  const lines = [
    LOOPS_DIGEST_HEADER,
    'These tool-call patterns REPEATED within a session — the most expensive kind of waste, since cost scales with repetition. A rule that prevents a loop is worth far more than one that prevents a one-off error. Emit a guardrail for EACH loop below and set its estimated_tokens_saved to at least the measured wasted tokens shown.',
    '',
  ];
  for (const lp of loops) lines.push(`- [${lp.kind}] ${lp.tool}: "${lp.sample}" repeated ${lp.count}x, ~${lp.wastedTokens.toLocaleString('en-US')} tokens wasted (messages [${lp.indices.join(', ')}])`);
  lines.push('');
  return lines.join('\n');
}

/** Word tokens (> 2 chars) of a signature body, for fuzzy rule ↔ loop matching. */
export function signatureTokens(signature: string): Set<string> {
  const body = signature.includes('::') ? signature.slice(signature.indexOf('::') + 2) : signature;
  return new Set(body.split(/[^a-z0-9]+/).filter((t) => t.length > 2));
}
