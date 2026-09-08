/**
 * Shared session assembly for scanners: a `SessionBuilder` that numbers
 * turns, tracks timestamps and pending tool calls, and a generic parser for
 * chat-shaped JSONL (Anthropic `type`/`message` records and OpenAI
 * `role`/`content` records) that several agents emit.
 */

import * as path from 'node:path';
import { contentText, countWords, fileMtimeMs, makeToolCall, parseTimestamp, stringifyOutput } from '../shared.js';
import type { AgentId, Session, SessionSource, ToolCall, Turn } from '../types.js';

export const USER_TEXT_KEEP = 500;
export const ASSISTANT_TEXT_KEEP = 2000;
export const INTERRUPT_MARKER = '[Request interrupted by user';

export class SessionBuilder {
  readonly turns: Turn[] = [];
  project?: string;
  inputTokens = 0;
  outputTokens = 0;
  private index = 0;
  private first?: number;
  private last?: number;
  private readonly pending = new Map<string, { name: string; input: unknown; ts?: number }>();

  constructor(
    readonly agent: AgentId,
    public id: string,
    readonly file: string,
  ) {}

  private next(ts?: number): number {
    if (ts !== undefined) {
      if (this.first === undefined || ts < this.first) this.first = ts;
      if (this.last === undefined || ts > this.last) this.last = ts;
    }
    return ++this.index;
  }

  noteTime(ts?: number): void {
    if (ts === undefined) return;
    if (this.first === undefined || ts < this.first) this.first = ts;
    if (this.last === undefined || ts > this.last) this.last = ts;
  }

  toolUse(id: string, name: string, input: unknown, ts?: number): void {
    if (!id || !name) return;
    this.pending.set(id, { name, input, ts });
  }

  /** Pair a result with its pending call; unknown ids are ignored. */
  toolResult(id: string, output: unknown, explicitError: boolean, ts?: number): ToolCall | null {
    const call = this.pending.get(id);
    if (!call) return null;
    this.pending.delete(id);
    const tc = makeToolCall(call.name, id, call.input, output, explicitError);
    this.turns.push({ index: this.next(ts), kind: 'tool_call', ts, toolCall: tc });
    return tc;
  }

  /** A complete call+result in one go (formats that store both together). */
  toolCall(id: string, name: string, input: unknown, output: unknown, explicitError: boolean, ts?: number): ToolCall {
    const tc = makeToolCall(name, id, input, output, explicitError);
    this.turns.push({ index: this.next(ts), kind: 'tool_call', ts, toolCall: tc });
    return tc;
  }

  user(text: string, ts?: number): void {
    const t = text.trim();
    if (!t) return;
    if (t.includes(INTERRUPT_MARKER)) {
      this.turns.push({ index: this.next(ts), kind: 'interruption', ts, text: t.slice(0, 200) });
      return;
    }
    this.turns.push({ index: this.next(ts), kind: 'user', ts, text: t.slice(0, USER_TEXT_KEEP) });
  }

  assistant(text: string, opts: { ts?: number; inputTokens?: number; outputTokens?: number; hasToolUse?: boolean } = {}): void {
    const t = text.trim();
    const words = countWords(t);
    if (!t && !(opts.outputTokens && opts.outputTokens > 0) && !opts.hasToolUse) return;
    const turn: Turn = { index: this.next(opts.ts), kind: 'assistant', ts: opts.ts, text: t.slice(0, ASSISTANT_TEXT_KEEP), words };
    if (opts.inputTokens !== undefined) turn.inputTokens = opts.inputTokens;
    if (opts.outputTokens !== undefined) turn.outputTokens = opts.outputTokens;
    if (opts.hasToolUse) turn.hasToolUse = true;
    this.turns.push(turn);
    this.inputTokens += opts.inputTokens ?? 0;
    this.outputTokens += opts.outputTokens ?? 0;
  }

  agentSummary(meta: Record<string, unknown>, ts?: number): void {
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    this.turns.push({
      index: this.next(ts),
      kind: 'agent_summary',
      ts,
      agent: {
        id: typeof meta.agentId === 'string' ? meta.agentId : '',
        toolCalls: num(meta.totalToolUseCount),
        tokens: num(meta.totalTokens),
        durationMs: num(meta.totalDurationMs),
        prompt: typeof meta.prompt === 'string' ? meta.prompt.slice(0, 200) : '',
      },
    });
  }

  get hasToolCalls(): boolean {
    return this.turns.some((t) => t.kind === 'tool_call');
  }

  build(source: SessionSource = 'main'): Session {
    const mtime = fileMtimeMs(this.file) ?? 0;
    const startedAt = this.first ?? mtime;
    const endedAt = this.last ?? mtime;
    const s: Session = { id: this.id, agent: this.agent, startedAt, endedAt, turns: this.turns, path: this.file, source, inputTokens: this.inputTokens, outputTokens: this.outputTokens };
    if (this.project) s.project = this.project;
    return s;
  }
}

function usageTokens(usage: unknown): { input: number; output: number } {
  if (!usage || typeof usage !== 'object') return { input: 0, output: 0 };
  const u = usage as Record<string, unknown>;
  const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return { input: n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens') + n('prompt_tokens'), output: n('output_tokens') + n('completion_tokens') };
}

/**
 * Feed one chat-shaped record into the builder. Handles
 *  - Anthropic transcript lines `{type:'assistant'|'user', message:{content, usage}, timestamp, cwd, toolUseResult}`
 *  - OpenAI lines `{role:'user'|'assistant'|'tool', content, tool_calls, tool_call_id}`
 *  - either shape nested under `message`.
 */
export function feedChatRecord(b: SessionBuilder, rec: Record<string, unknown>): void {
  const ts = parseTimestamp(rec.timestamp ?? rec.ts ?? rec.created_at ?? rec.time);
  b.noteTime(ts);
  const cwd = rec.cwd ?? rec.workspace ?? rec.workspacePath ?? rec.project_path ?? rec.projectPath;
  if (!b.project && typeof cwd === 'string' && cwd && path.isAbsolute(cwd)) b.project = cwd;

  const msg = rec.message && typeof rec.message === 'object' ? (rec.message as Record<string, unknown>) : rec;
  const role = typeof rec.type === 'string' && (rec.type === 'assistant' || rec.type === 'user') ? rec.type : typeof msg.role === 'string' ? msg.role : typeof rec.role === 'string' ? rec.role : '';
  const content = msg.content;

  if (role === 'assistant') {
    let hasToolUse = false;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block && block.type === 'tool_use') {
          hasToolUse = true;
          if (typeof block.id === 'string' && typeof block.name === 'string') b.toolUse(block.id, block.name, block.input, ts);
        }
      }
    }
    const calls = msg.tool_calls;
    if (Array.isArray(calls)) {
      for (const c of calls as Array<Record<string, unknown>>) {
        const fn = c?.function as Record<string, unknown> | undefined;
        if (typeof c?.id === 'string' && typeof fn?.name === 'string') {
          hasToolUse = true;
          b.toolUse(c.id, fn.name, fn.arguments, ts);
        }
      }
    }
    const usage = usageTokens(msg.usage ?? rec.usage);
    b.assistant(contentText(content), { ts, inputTokens: usage.input, outputTokens: usage.output, hasToolUse });
    return;
  }

  if (role === 'user') {
    if (Array.isArray(content)) {
      let sawResult = false;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          sawResult = true;
          const tc = b.toolResult(block.tool_use_id, block.content, block.is_error === true, ts);
          if (tc && (tc.name === 'Agent' || tc.name === 'Task') && rec.toolUseResult && typeof rec.toolUseResult === 'object') b.agentSummary(rec.toolUseResult as Record<string, unknown>, ts);
        }
      }
      const text = contentText(content);
      if (text.trim() && (!sawResult || text.includes(INTERRUPT_MARKER))) b.user(text, ts);
      return;
    }
    if (typeof content === 'string') b.user(content, ts);
    return;
  }

  if (role === 'tool') {
    const id = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : typeof rec.tool_call_id === 'string' ? rec.tool_call_id : '';
    if (id) b.toolResult(id, stringifyOutput(content), false, ts);
  }
}

/** Parse a whole chat-shaped JSONL transcript into a Session. */
export function sessionFromChatRecords(agent: AgentId, id: string, file: string, records: Record<string, unknown>[], source: SessionSource = 'main'): Session {
  const b = new SessionBuilder(agent, id, file);
  for (const rec of records) feedChatRecord(b, rec);
  return b.build(source);
}

export function stem(file: string): string {
  return path.basename(file).replace(/\.[^.]+$/, '');
}
