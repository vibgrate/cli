/**
 * Session analyzer — deterministic heuristics, no model.
 *
 * `analyze(sessions)` produces a `Digest`: measured loops, failing commands,
 * missing paths, error→recovery pairs, user corrections, verbosity stats and
 * the `Rule`s the writer turns into a learn block. Every number is measured
 * from transcripts (bytes / 4 → tokens), never guessed.
 *
 * `renderAnalyzerPrompt(sessions)` + `ANALYZER_OUTPUT_SCHEMA` let an optional
 * local CLI (`VG_LEARN_CLI`) produce the rules instead; `parseAnalyzerOutput`
 * validates what comes back against the schema (see `cli-analyzer.ts`).
 */

import { buildRecovery, extractPreference, type ToolObservation } from '../memory/extract.js';
import { detectLoopsAcross, formatLoopsForDigest, signatureTokens } from './loops.js';
import { inputSummary, truncateHeadTail } from './shared.js';
import type { Digest, ErrorCategory, FailingCommand, Loop, Recovery, Rule, RuleTarget, Session, ToolCall, Turn } from './types.js';
import { verbosityStats } from './verbosity.js';

export const DEFAULT_MIN_EVIDENCE = 2;
export const MAX_DIGEST_TOKENS = 80_000;
const CHARS_PER_TOKEN = 4;
const CONTEXT_CONFIDENCE = 0.9;
const MEMORY_CONFIDENCE = 0.7;

export const SECTION_LOOPS = 'Loop Guardrails';
export const SECTION_ENVIRONMENT = 'Environment';
export const SECTION_PATHS = 'File Path Corrections';
export const SECTION_SEARCH = 'Search Scope';
export const SECTION_COMMANDS = 'Command Patterns';
export const SECTION_PREFERENCES = 'User Preferences';
export const SECTION_RETRIES = 'Retry Patterns';
export const SECTION_PERMISSIONS = 'Permissions';

/** Fixed order sections render in (stable output). */
export const SECTION_ORDER: readonly string[] = [SECTION_LOOPS, SECTION_ENVIRONMENT, SECTION_PATHS, SECTION_SEARCH, SECTION_COMMANDS, SECTION_PREFERENCES, SECTION_RETRIES, SECTION_PERMISSIONS];

function calls(session: Session): Array<{ tc: ToolCall; turn: Turn }> {
  const out: Array<{ tc: ToolCall; turn: Turn }> = [];
  for (const t of session.turns) if (t.kind === 'tool_call' && t.toolCall) out.push({ tc: t.toolCall, turn: t });
  return out;
}

function toObservation(tc: ToolCall, index: number): ToolObservation {
  return { name: tc.name, id: tc.id, input: tc.input, output: tc.output, isError: tc.isError, errorCategory: tc.errorCategory, messageIndex: index };
}

function tokensOf(tc: ToolCall): number {
  return Math.floor(tc.outputBytes / CHARS_PER_TOKEN);
}

function pathOf(tc: ToolCall): string {
  const v = tc.input.file_path ?? tc.input.path ?? tc.input.absolute_path ?? tc.input.target_file;
  return typeof v === 'string' ? v : '';
}

function commandOf(tc: ToolCall): string {
  const v = tc.input.command ?? tc.input.cmd;
  return typeof v === 'string' ? v : '';
}

function byCount<T extends { count: number }>(key: (x: T) => string): (a: T, b: T) => number {
  return (a, b) => b.count - a.count || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

interface Acc {
  failingCommands: Map<string, FailingCommand & { tokens: number; categories: Map<ErrorCategory, number>; recovered: boolean }>;
  missingPaths: Map<string, { path: string; count: number; tokens: number }>;
  recoveries: Map<string, Recovery & { text: string; tokens: number }>;
  corrections: Map<string, { text: string; count: number }>;
  permissions: Map<string, { summary: string; count: number; tokens: number }>;
}

function accumulate(sessions: readonly Session[], recoveryWindow: number): Acc {
  const acc: Acc = { failingCommands: new Map(), missingPaths: new Map(), recoveries: new Map(), corrections: new Map(), permissions: new Map() };
  for (const s of sessions) {
    const cs = calls(s);
    cs.forEach(({ tc, turn }, i) => {
      if (tc.isError) {
        if (tc.name === 'Bash') {
          const cmd = commandOf(tc);
          if (cmd) {
            const key = cmd.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
            const cur = acc.failingCommands.get(key);
            if (cur) {
              cur.count++;
              cur.tokens += tokensOf(tc);
              cur.categories.set(tc.errorCategory, (cur.categories.get(tc.errorCategory) ?? 0) + 1);
            } else acc.failingCommands.set(key, { command: cmd.slice(0, 200), count: 1, category: tc.errorCategory, sample: truncateHeadTail(tc.output, 160), tokens: tokensOf(tc), categories: new Map([[tc.errorCategory, 1]]), recovered: false });
          }
        }
        if (tc.errorCategory === 'file_not_found' && (tc.name === 'Read' || tc.name === 'Edit' || tc.name === 'Write')) {
          const p = pathOf(tc);
          if (p) {
            const cur = acc.missingPaths.get(p);
            if (cur) {
              cur.count++;
              cur.tokens += tokensOf(tc);
            } else acc.missingPaths.set(p, { path: p, count: 1, tokens: tokensOf(tc) });
          }
        }
        if (tc.errorCategory === 'permission_denied') {
          const summary = `${tc.name}: ${inputSummary(tc.name, tc.input)}`.slice(0, 160);
          const cur = acc.permissions.get(summary);
          if (cur) {
            cur.count++;
            cur.tokens += tokensOf(tc);
          } else acc.permissions.set(summary, { summary, count: 1, tokens: tokensOf(tc) });
        }
        return;
      }
      for (let j = i - 1; j >= Math.max(0, i - recoveryWindow); j--) {
        const prev = cs[j].tc;
        if (!prev.isError || prev.name !== tc.name) continue;
        const rec = buildRecovery(toObservation(prev, cs[j].turn.index), toObservation(tc, turn.index));
        if (rec) {
          const cur = acc.recoveries.get(rec.key);
          const failed = prev.name === 'Bash' ? commandOf(prev) : prev.name === 'Read' ? pathOf(prev) : String(prev.input.pattern ?? '');
          const success = tc.name === 'Bash' ? commandOf(tc) : tc.name === 'Read' ? pathOf(tc) : String(tc.input.pattern ?? '');
          if (cur) {
            cur.count++;
            cur.tokens += tokensOf(prev);
          } else acc.recoveries.set(rec.key, { tool: prev.name, failed: failed.slice(0, 200), success: success.slice(0, 200), category: prev.errorCategory, count: 1, text: rec.text, tokens: tokensOf(prev) });
          if (prev.name === 'Bash') {
            const key = commandOf(prev).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
            const fc = acc.failingCommands.get(key);
            if (fc) fc.recovered = true;
          }
        }
        break;
      }
    });
    for (const t of s.turns) {
      if (t.kind !== 'user' || !t.text) continue;
      const pref = extractPreference(t.text);
      if (!pref) continue;
      const cur = acc.corrections.get(pref.text);
      if (cur) cur.count++;
      else acc.corrections.set(pref.text, { text: pref.text, count: 1 });
    }
  }
  for (const fc of acc.failingCommands.values()) {
    let best: ErrorCategory = fc.category;
    let bestN = -1;
    for (const [cat, n] of [...fc.categories.entries()].sort()) if (n > bestN) [best, bestN] = [cat, n];
    fc.category = best;
  }
  return acc;
}

function loopBullet(lp: Loop): string {
  const waste = `~${fmt(lp.wastedTokens)} tokens wasted`;
  switch (lp.kind) {
    case 'refetch-loop':
      return `- \`${lp.sample}\` was re-run ${lp.count}x with different output limits (${waste}). Fetch the complete output once — read the whole file or raise the limit — instead of paging through variants.`;
    case 'error-loop':
      return `- \`${lp.tool}: ${lp.sample}\` failed ${lp.count}x in a row (${waste}). Verify the target exists (Glob/Grep first) and change the call before retrying; never repeat a failing call unchanged.`;
    case 'edit-cycle':
      return `- \`${lp.sample}\` was edited ${lp.count}x in one session (${waste}). Plan the change, re-read the file once, and apply it in a single edit.`;
    default:
      return `- The error \`${lp.sample}\` recurred ${lp.count}x across calls (${waste}). Fix the root cause before continuing instead of working around it call by call.`;
  }
}

interface SectionAcc {
  section: string;
  target: RuleTarget;
  bullets: string[];
  evidence: number;
  tokens: number;
  loop?: Loop;
}

function section(map: Map<string, SectionAcc>, name: string, target: RuleTarget): SectionAcc {
  let s = map.get(name);
  if (!s) {
    s = { section: name, target, bullets: [], evidence: 0, tokens: 0 };
    map.set(name, s);
  }
  return s;
}

/** Boost rules whose text overlaps a detected loop's signature (majority of salient tokens). */
export function applyLoopWeighting(rules: Rule[], loops: readonly Loop[]): void {
  if (loops.length === 0) return;
  for (const rule of rules) {
    const hay = `${rule.section} ${rule.content}`.toLowerCase();
    let best: Loop | null = null;
    for (const lp of loops) {
      const toks = signatureTokens(lp.signature);
      if (toks.size === 0) continue;
      let overlap = 0;
      for (const t of toks) if (hay.includes(t)) overlap++;
      if (overlap >= Math.max(1, Math.floor((toks.size + 1) / 2)) && (!best || lp.wastedTokens > best.wastedTokens)) best = lp;
    }
    if (best) {
      rule.estimatedTokensSaved = Math.max(rule.estimatedTokensSaved, best.wastedTokens);
      rule.isLoopGuardrail = true;
      rule.loopOccurrences = best.count;
    }
  }
}

export function compareRules(a: Rule, b: Rule): number {
  if (b.estimatedTokensSaved !== a.estimatedTokensSaved) return b.estimatedTokensSaved - a.estimatedTokensSaved;
  const ia = SECTION_ORDER.indexOf(a.section);
  const ib = SECTION_ORDER.indexOf(b.section);
  if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  return a.section < b.section ? -1 : a.section > b.section ? 1 : 0;
}

export interface AnalyzeOptions {
  /** Occurrences before a non-loop pattern becomes a rule (default 2). */
  minEvidence?: number;
  /** Look-back (tool calls) when pairing an error with its recovery (default 5). */
  recoveryWindow?: number;
  /** Cap on loops surfaced (default 20). */
  maxLoops?: number;
}

/** Deterministic heuristic analysis → Digest with rules. Pure over `sessions`. */
export function analyze(sessions: readonly Session[], opts: AnalyzeOptions = {}): Digest {
  const minEvidence = Math.max(1, opts.minEvidence ?? DEFAULT_MIN_EVIDENCE);
  const loops = detectLoopsAcross(sessions).slice(0, opts.maxLoops ?? 20);
  const acc = accumulate(sessions, opts.recoveryWindow ?? 5);
  let toolCalls = 0;
  let failures = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const s of sessions) {
    for (const { tc } of calls(s)) {
      toolCalls++;
      if (tc.isError) failures++;
    }
    tokensIn += s.inputTokens ?? 0;
    tokensOut += s.outputTokens ?? 0;
  }

  const sections = new Map<string, SectionAcc>();
  for (const lp of loops) {
    const s = section(sections, SECTION_LOOPS, 'context');
    s.bullets.push(loopBullet(lp));
    s.evidence += lp.count;
    s.tokens += lp.wastedTokens;
    if (!s.loop || lp.wastedTokens > s.loop.wastedTokens) s.loop = lp;
  }

  const recoveries = [...acc.recoveries.values()].sort(byCount((r) => r.text));
  for (const r of recoveries) {
    if (r.count < minEvidence) continue;
    let name = SECTION_COMMANDS;
    if (r.tool === 'Read') name = SECTION_PATHS;
    else if (r.tool === 'Grep' || r.tool === 'Glob') name = SECTION_SEARCH;
    else if (r.category === 'command_not_found' || r.category === 'module_not_found') name = SECTION_ENVIRONMENT;
    const s = section(sections, name, 'context');
    s.bullets.push(`- ${r.text}`);
    s.evidence += r.count;
    s.tokens += r.tokens;
  }

  const missingPaths = [...acc.missingPaths.values()].sort(byCount((m) => m.path));
  const recoveredPaths = new Set(recoveries.filter((r) => r.tool === 'Read').map((r) => r.failed));
  for (const m of missingPaths) {
    if (m.count < minEvidence || recoveredPaths.has(m.path)) continue;
    const s = section(sections, SECTION_PATHS, 'context');
    s.bullets.push(`- \`${m.path}\` does not exist (tried ${m.count}x). Locate the file with Glob/Grep before reading it.`);
    s.evidence += m.count;
    s.tokens += m.tokens;
  }

  const failingCommands = [...acc.failingCommands.values()].sort(byCount((f) => f.command));
  for (const f of failingCommands) {
    if (f.count < minEvidence || f.recovered) continue;
    const s = section(sections, SECTION_RETRIES, 'memory');
    s.bullets.push(`- \`${f.command}\` failed ${f.count}x (${f.category}): ${f.sample}`);
    s.evidence += f.count;
    s.tokens += f.tokens;
  }

  const corrections = [...acc.corrections.values()].sort(byCount((c) => c.text));
  for (const c of corrections) {
    const s = section(sections, SECTION_PREFERENCES, 'memory');
    s.bullets.push(`- ${c.text}`);
    s.evidence += c.count;
  }

  for (const p of [...acc.permissions.values()].sort(byCount((x) => x.summary))) {
    if (p.count < minEvidence) continue;
    const s = section(sections, SECTION_PERMISSIONS, 'memory');
    s.bullets.push(`- \`${p.summary}\` was denied ${p.count}x. Ask before retrying, or use an allowed alternative.`);
    s.evidence += p.count;
    s.tokens += p.tokens;
  }

  const rules: Rule[] = [...sections.values()].map((s) => ({
    target: s.target,
    section: s.section,
    content: s.bullets.join('\n'),
    confidence: s.target === 'context' ? CONTEXT_CONFIDENCE : MEMORY_CONFIDENCE,
    evidenceCount: s.evidence,
    estimatedTokensSaved: s.tokens,
    isLoopGuardrail: s.loop !== undefined,
    loopOccurrences: s.loop?.count ?? 0,
  }));
  applyLoopWeighting(rules, loops);
  rules.sort(compareRules);

  return {
    sessions: sessions.length,
    toolCalls,
    failures,
    failureRate: toolCalls ? Math.round((failures / toolCalls) * 1000) / 1000 : 0,
    tokensIn,
    tokensOut,
    loops,
    failingCommands: failingCommands.map(({ command, count, category, sample }) => ({ command, count, category, sample })),
    missingPaths: missingPaths.map(({ path: p, count }) => ({ path: p, count })),
    recoveries: recoveries.map(({ tool, failed, success, category, count }) => ({ tool, failed, success, category, count })),
    corrections: corrections.map(({ text, count }) => ({ text, count })),
    verbosity: verbosityStats(sessions),
    rules,
    analyzer: 'heuristic',
  };
}

// ---------------------------------------------------------------------------
// Digest text + prompt for an external analyzer CLI
// ---------------------------------------------------------------------------

function formatTurn(t: Turn): string | null {
  if (t.kind === 'tool_call' && t.toolCall) {
    const tc = t.toolCall;
    const input = inputSummary(tc.name, tc.input).slice(0, 120);
    if (tc.isError) return `  [${t.index}] ${tc.name}: ${input} → ERROR(${tc.errorCategory}): ${truncateHeadTail(tc.output)}`;
    const size = tc.outputBytes > 0 ? ` (${tc.outputBytes} bytes)` : '';
    return `  [${t.index}] ${tc.name}: ${input} → OK${size}`;
  }
  if (t.kind === 'user' && t.text?.trim()) return `  [${t.index}] USER: "${t.text.trim().slice(0, 300)}"`;
  if (t.kind === 'interruption') return `  [${t.index}] INTERRUPTED: ${(t.text ?? '').slice(0, 150)}`;
  if (t.kind === 'agent_summary' && t.agent) return `  [${t.index}] SUBAGENT: ${t.agent.toolCalls} tool calls, ${fmt(t.agent.tokens)} tokens, ${(t.agent.durationMs / 1000).toFixed(1)}s — prompt: "${t.agent.prompt.slice(0, 100)}"`;
  return null;
}

/** Token-efficient digest of all sessions (loops first, then per-session events, budgeted). */
export function renderDigestText(sessions: readonly Session[], opts: { project?: string; loops?: readonly Loop[]; maxTokens?: number } = {}): string {
  const loops = opts.loops ?? detectLoopsAcross(sessions);
  const lines: string[] = [];
  const project = opts.project ?? sessions.find((s) => s.project)?.project ?? '(unknown)';
  lines.push(`Project: ${project}`);
  let totalCalls = 0;
  let totalFailures = 0;
  let tin = 0;
  let tout = 0;
  for (const s of sessions) {
    for (const { tc } of calls(s)) {
      totalCalls++;
      if (tc.isError) totalFailures++;
    }
    tin += s.inputTokens ?? 0;
    tout += s.outputTokens ?? 0;
  }
  lines.push(totalCalls ? `Total: ${sessions.length} sessions, ${totalCalls} tool calls, ${totalFailures} failures (${((totalFailures / totalCalls) * 100).toFixed(1)}%)` : `Total: ${sessions.length} sessions, 0 tool calls`);
  if (tin) lines.push(`Tokens used: ${fmt(tin)} in / ${fmt(tout)} out`);
  lines.push('');
  const loopSection = formatLoopsForDigest(loops);
  if (loopSection) lines.push(loopSection);

  const budget = (opts.maxTokens ?? MAX_DIGEST_TOKENS) * CHARS_PER_TOKEN;
  let used = lines.reduce((a, l) => a + l.length, 0);
  for (let si = 0; si < sessions.length; si++) {
    const s = sessions[si];
    if (used > budget) {
      lines.push(`... (remaining ${sessions.length - si} sessions truncated)`);
      break;
    }
    const cs = calls(s);
    const fails = cs.filter((c) => c.tc.isError).length;
    let header = `=== Session ${s.id.slice(0, 12)} (${cs.length} calls, ${fails} failures`;
    if (s.inputTokens) header += `, ${fmt(s.inputTokens)} input tokens`;
    header += ') ===';
    lines.push(header);
    used += header.length;
    for (const t of s.turns) {
      if (used > budget) {
        lines.push('  ... (remaining events truncated)');
        break;
      }
      const line = formatTurn(t);
      if (line) {
        lines.push(line);
        used += line.length;
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

export const ANALYZER_USER_PREFIX = 'Analyze these coding agent sessions and return JSON recommendations:\n\n';

export const ANALYZER_SYSTEM_PROMPT = `You are an expert at analyzing coding agent sessions to extract actionable patterns.

You will receive a digest of tool call sessions from a coding agent (Claude Code, Codex, etc.).
Your job is to identify patterns that, if documented, would PREVENT TOKEN WASTE in future sessions.

Focus on (in priority order):
1. **Loops (HIGHEST PRIORITY)** — patterns that REPEATED within a session. If the
   digest has a "Detected Loops" section, every loop there MUST get a guardrail
   rule, because loop waste scales with repetition. This includes re-fetch
   loops: a command whose output was truncated, so the agent re-ran variants of
   it to fetch more. The fix names the command and prescribes getting the full
   output up front (e.g., "read the whole file" / "raise the output limit for X").
2. **Environment rules** — what runtime commands work vs fail (e.g., "use uv run python, not python3")
3. **File structure facts** — known large files, correct paths, search scopes
4. **User preferences** — things the user corrected, rejected, or explicitly requested
5. **Failure patterns** — repeated failures that could be prevented with upfront knowledge
6. **Workflow rules** — subagent guidance, command execution preferences
7. **Token waste hotspots** — patterns that waste the most tokens (re-reads, wrong paths, retries)

Rules:
- A loop in the "Detected Loops" section is sufficient evidence on its own — emit
  its guardrail even if it appears only once as a loop, and set its
  estimated_tokens_saved to at least the measured wasted tokens reported there.
- Only include patterns with CLEAR evidence from the data (2+ occurrences or explicit user direction)
- Every recommendation must be specific and actionable (not "be careful" but "use X instead of Y")
- Estimate tokens saved per recommendation (how many tokens would be saved per session if this rule existed)
- Separate stable project facts (CONTEXT_FILE) from evolving preferences (MEMORY_FILE)
- CONTEXT_FILE rules go in the project instructions file — they are project-level, stable facts
- MEMORY_FILE rules are session-level, evolving preferences
- Keep recommendations concise — each should be 1-3 lines of markdown
- Do NOT produce tautological rules (e.g., "use python3 not python3")
- Do NOT produce rules about things that only happened once (transient errors)

Prior Learned Patterns:
- The input may contain a "Prior Learned Patterns" section showing what is
  already written to the project's instructions file. Treat those as the
  starting baseline for your analysis.
- When you re-emit a section heading that appears in the prior block, your
  output REPLACES that prior section wholesale — so your section must be the
  COMPLETE updated version:
    * Preserve prior bullets that remain accurate (copy them forward)
    * Revise bullets when new evidence refines them (merge, don't duplicate)
    * Drop a prior bullet only when contradicted by clear new evidence
- Sections from prior runs that you do NOT re-emit are preserved automatically
  by the writer, so focus only on sections where you have something to add or
  change. Do NOT re-emit a prior section just to echo it verbatim — that wastes
  output tokens without changing the outcome.
- Do NOT write bullets that reference prior siblings you are about to drop
  (e.g., "X is ALSO large — same rule as Y, Z") unless Y and Z are also present
  in your current output or preserved in the prior block.

Return ONLY valid JSON matching this schema — no other text:
{
  "context_file_rules": [
    {
      "section": "string — section heading (e.g., 'Environment', 'File Paths', 'Commands')",
      "content": "string — markdown content, 1-3 bullet points",
      "estimated_tokens_saved": "integer — tokens saved per session if rule existed",
      "evidence_count": "integer — number of occurrences supporting this rule"
    }
  ],
  "memory_file_rules": [
    {
      "section": "string — section heading",
      "content": "string — markdown content, 1-3 bullet points",
      "estimated_tokens_saved": "integer",
      "evidence_count": "integer"
    }
  ]
}`;

/** JSON schema the analyzer CLI output must satisfy. */
export const ANALYZER_OUTPUT_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    context_file_rules: { type: 'array', items: { $ref: '#/definitions/rule' } },
    memory_file_rules: { type: 'array', items: { $ref: '#/definitions/rule' } },
  },
  additionalProperties: true,
  definitions: {
    rule: {
      type: 'object',
      properties: {
        section: { type: 'string', minLength: 1 },
        content: { type: 'string', minLength: 1 },
        estimated_tokens_saved: { type: 'integer', minimum: 0 },
        evidence_count: { type: 'integer', minimum: 0 },
      },
      required: ['section', 'content'],
      additionalProperties: true,
    },
  },
};

/** Prior learn block (from the target file) rendered for the analyzer, or ''. */
export function renderPriorPatterns(projectName: string, block: string | null): string {
  if (!block) return '';
  return ['=== Prior Learned Patterns ===', `These patterns are currently written to ${projectName}'s instructions file. They are your starting baseline — see the 'Prior Learned Patterns' rule in the system prompt for how to integrate them.`, '', '--- From instructions file (CONTEXT_FILE, project-level stable facts) ---', block, ''].join('\n');
}

/** System prompt + user prefix + digest, ready to pipe into a CLI via stdin. */
export function renderAnalyzerPrompt(sessions: readonly Session[], opts: { project?: string; priorBlock?: string | null; maxTokens?: number } = {}): string {
  const loops = detectLoopsAcross(sessions);
  let digest = renderDigestText(sessions, { project: opts.project, loops, maxTokens: opts.maxTokens });
  const prior = renderPriorPatterns(opts.project ?? 'this project', opts.priorBlock ?? null);
  if (prior) {
    // Insert after the loop section (before per-session streams).
    const marker = '=== Session ';
    const i = digest.indexOf(marker);
    digest = i >= 0 ? `${digest.slice(0, i)}${prior}\n${digest.slice(i)}` : `${digest}\n${prior}`;
  }
  return `${ANALYZER_SYSTEM_PROMPT}\n\n${ANALYZER_USER_PREFIX}${digest}`;
}

/** Strip optional markdown fences and parse the first JSON object found. */
export function stripFencedJson(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  const candidates: string[] = [];
  const lines = text.split('\n');
  const fences = lines.map((l, i) => (l.trim().startsWith('```') ? i : -1)).filter((i) => i >= 0);
  if (fences.length >= 2) candidates.push(lines.slice(fences[0] + 1, fences[fences.length - 1]).join('\n'));
  else if (fences.length === 1) candidates.push(lines.slice(fences[0] + 1).join('\n'));
  candidates.push(text);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* next */
    }
  }
  return null;
}

function safeInt(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Math.max(0, Math.floor(Number(v)));
  return 0;
}

/** Validate parsed analyzer output against `ANALYZER_OUTPUT_SCHEMA` (hand-rolled, no deps). */
export function validateAnalyzerOutput(obj: unknown): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, problems: ['output is not a JSON object'] };
  const o = obj as Record<string, unknown>;
  for (const key of ['context_file_rules', 'memory_file_rules']) {
    const arr = o[key];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) {
      problems.push(`${key}: expected an array`);
      continue;
    }
    arr.forEach((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        problems.push(`${key}[${i}]: expected an object`);
        return;
      }
      const rr = r as Record<string, unknown>;
      if (typeof rr.section !== 'string' || !rr.section.trim()) problems.push(`${key}[${i}].section: expected a non-empty string`);
      if (typeof rr.content !== 'string' || !rr.content.trim()) problems.push(`${key}[${i}].content: expected a non-empty string`);
      for (const n of ['estimated_tokens_saved', 'evidence_count']) {
        const v = rr[n];
        if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0) && !(typeof v === 'string' && /^\d+$/.test(v))) problems.push(`${key}[${i}].${n}: expected a non-negative integer`);
      }
    });
  }
  if (!Array.isArray(o.context_file_rules) && !Array.isArray(o.memory_file_rules)) problems.push('neither context_file_rules nor memory_file_rules present');
  return { ok: problems.length === 0, problems };
}

/** Raw CLI text → validated Rules (sorted by savings); throws on invalid output. */
export function parseAnalyzerOutput(raw: string, loops: readonly Loop[] = []): Rule[] {
  const parsed = stripFencedJson(raw);
  if (!parsed) throw new Error('analyzer returned no JSON object');
  const v = validateAnalyzerOutput(parsed);
  if (!v.ok) throw new Error(`analyzer output failed validation: ${v.problems.join('; ')}`);
  const rules: Rule[] = [];
  const take = (key: string, target: RuleTarget, confidence: number): void => {
    const arr = parsed[key];
    if (!Array.isArray(arr)) return;
    for (const r of arr as Array<Record<string, unknown>>) {
      const sec = String(r.section).trim();
      const content = String(r.content).trim();
      if (!sec || !content) continue;
      rules.push({ target, section: sec, content, confidence, evidenceCount: safeInt(r.evidence_count ?? 1), estimatedTokensSaved: safeInt(r.estimated_tokens_saved), isLoopGuardrail: false, loopOccurrences: 0 });
    }
  };
  take('context_file_rules', 'context', CONTEXT_CONFIDENCE);
  take('memory_file_rules', 'memory', MEMORY_CONFIDENCE);
  applyLoopWeighting(rules, loops);
  rules.sort(compareRules);
  return rules;
}
