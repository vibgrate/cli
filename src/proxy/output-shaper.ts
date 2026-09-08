/**
 * Output shaper: verbosity steering (L1–L4, byte-stable text) and the
 * clamp-only effort routing invariant.
 *
 * Rules that must never be broken:
 *  - the steering block is idempotent and byte-stable per level (editing the
 *    text is a cache-busting change);
 *  - steering is applied only outside cache mode (it writes into the provider
 *    prefix-cache key);
 *  - effort is *never injected* where the client did not send it, *never
 *    raised*, and `thinking.type` is never toggled; a legacy
 *    `thinking.budget_tokens` is clamped to the API floor instead;
 *  - effort is lowered only on structurally mechanical continuations.
 */

import type { MessageFormat, Message } from '../compress/types.js';

export const STEERING_SENTINEL = '<vg_output_shaping>';
export const STEERING_SUFFIX = '</vg_output_shaping>';

export const VERBOSITY_LEVELS: Readonly<Record<1 | 2 | 3 | 4, string>> = {
  1: 'Skip preamble and postamble. Do not announce what you are about to do or recap what you just did; start with the substance.',
  2: 'Skip preamble and postamble; start with the substance. Never restate code, file contents, diffs, or tool output that already appear in this conversation — reference them by path and line instead. After a tool call succeeds, continue without narrating the result.',
  3: 'Skip preamble and postamble. Never restate code, file contents, diffs, or tool output already in this conversation — cite the exact file path and line or symbol instead, always; a reference that omits the location is not a reference. Give conclusions only; omit rationale unless the user asks why. Prefer the smallest edit over rewriting whole files. Keep prose to the minimum needed to be unambiguous. Never drop anything the turn or task needs to be correct, including negations (not, never, no, only, except) — shorten how you say it, not what you say. Use full prose for destructive or irreversible actions, security warnings, and any multi-step sequence where brevity would create ambiguity.',
  4: 'Minimum tokens. Fragments fine. No preamble, no postamble, no restating context, no rationale. Answer, smallest-possible edits, nothing else. Never drop anything the turn or task needs to be correct, including negations (not, never, no, only, except). Use full prose for destructive or irreversible actions, security warnings, and any multi-step sequence where brevity would create ambiguity.',
};

export type VerbosityLevel = 0 | 1 | 2 | 3 | 4;

export function clampLevel(level: number): VerbosityLevel {
  if (!Number.isFinite(level)) return 2;
  return Math.min(4, Math.max(0, Math.round(level))) as VerbosityLevel;
}

/** The full block, or null for level 0. */
export function steeringText(level: VerbosityLevel): string | null {
  if (level === 0) return null;
  return `${STEERING_SENTINEL}\n${VERBOSITY_LEVELS[level]}\n${STEERING_SUFFIX}`;
}

/** Find the sentinel; replace through the suffix (or to the end); else append. */
export function replaceOrAppendSteeringBlock(existing: string, block: string): string {
  const start = existing.indexOf(STEERING_SENTINEL);
  if (start >= 0) {
    const suffixAt = existing.indexOf(STEERING_SUFFIX, start);
    const end = suffixAt >= 0 ? suffixAt + STEERING_SUFFIX.length : existing.length;
    const before = existing.slice(0, start).replace(/\s+$/, '');
    const after = existing.slice(end).replace(/^\n+/, '');
    return [before, block, after].filter((p) => p.length > 0).join('\n\n');
  }
  const trimmed = existing.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

// ---------------------------------------------------------------------------
// Turn classification (structural only)
// ---------------------------------------------------------------------------

export type TurnKind = 'new_user_ask' | 'mechanical_continuation' | 'error_continuation' | 'unknown';

export function classifyTurn(messages: Message[]): TurnKind {
  if (!messages.length) return 'unknown';
  const last = messages[messages.length - 1];
  if (!last || typeof last !== 'object' || last.role !== 'user') return 'unknown';
  const content = last.content;
  if (typeof content === 'string') return content.trim() ? 'new_user_ask' : 'unknown';
  if (!Array.isArray(content) || !content.length) return 'unknown';
  let sawToolResult = false;
  let sawError = false;
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== 'object') return 'unknown';
    const t = block.type;
    if (t === 'tool_result') {
      sawToolResult = true;
      if (block.is_error === true) sawError = true;
    } else if (t === 'text' || t === 'image' || t === 'document') return 'new_user_ask';
  }
  if (sawError) return 'error_continuation';
  if (sawToolResult) return 'mechanical_continuation';
  return 'unknown';
}

/** OpenAI chat: last message user with content → ask; tool messages at the tail → mechanical. */
export function classifyOpenAIChatTurn(messages: Message[]): TurnKind {
  if (!messages.length) return 'unknown';
  const last = messages[messages.length - 1];
  if (last.role === 'user') {
    const c = last.content;
    if (typeof c === 'string') return c.trim() ? 'new_user_ask' : 'unknown';
    if (Array.isArray(c) && c.length) return 'new_user_ask';
    return 'unknown';
  }
  if (last.role === 'tool') {
    const text = typeof last.content === 'string' ? last.content : '';
    return toolOutputIsError(text) ? 'error_continuation' : 'mechanical_continuation';
  }
  return 'unknown';
}

const RESPONSES_OUTPUT_ITEM_TYPES = new Set(['custom_tool_call_output', 'function_call_output', 'local_shell_call_output', 'apply_patch_call_output']);

function partText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return (value as unknown[]).map((p) => (typeof p === 'string' ? p : p && typeof (p as Record<string, unknown>).text === 'string' ? ((p as Record<string, unknown>).text as string) : '')).filter(Boolean).join('\n');
  return '';
}

function responsesUserSignal(item: Record<string, unknown>): boolean {
  if (item.role === 'user') {
    if (Array.isArray(item.content)) for (const p of item.content as Array<Record<string, unknown>>) if (p && (p.type === 'input_file' || p.type === 'input_image')) return true;
    return partText(item.content).trim().length > 0;
  }
  if (item.type === 'input_text') return partText(item.text).trim().length > 0;
  return item.type === 'input_image';
}

/** Only JSON fields are sniffed for an error signal — never prose. */
export function toolOutputIsError(output: unknown): boolean {
  let obj: Record<string, unknown> | null = null;
  if (typeof output === 'string') {
    const t = output.trim();
    if (!t.startsWith('{')) return false;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      return false;
    }
  } else if (output && typeof output === 'object') obj = output as Record<string, unknown>;
  if (!obj) return false;
  const check = (o: Record<string, unknown>): boolean => {
    if (typeof o.exit_code === 'number' && o.exit_code !== 0) return true;
    if (o.success === false) return true;
    return Boolean(o.error);
  };
  if (check(obj)) return true;
  const meta = obj.metadata;
  return !!meta && typeof meta === 'object' && check(meta as Record<string, unknown>);
}

export function classifyResponsesInput(input: unknown): TurnKind {
  if (typeof input === 'string') return input.trim() ? 'new_user_ask' : 'unknown';
  if (!Array.isArray(input) || !input.length) return 'unknown';
  let sawToolOutput = false;
  let sawError = false;
  let sawUnknown = false;
  for (const item of input as unknown[]) {
    if (!item || typeof item !== 'object') {
      sawUnknown = true;
      continue;
    }
    const it = item as Record<string, unknown>;
    if (typeof it.type === 'string' && RESPONSES_OUTPUT_ITEM_TYPES.has(it.type)) {
      sawToolOutput = true;
      if (toolOutputIsError(it.output)) sawError = true;
      continue;
    }
    if (responsesUserSignal(it)) return 'new_user_ask';
    if (it.type === 'message' || it.type === 'function_call' || it.type === 'reasoning') continue;
    sawUnknown = true;
  }
  if (sawToolOutput && !sawUnknown) return sawError ? 'error_continuation' : 'mechanical_continuation';
  return 'unknown';
}

export function classifyForFormat(body: Record<string, unknown>, format: MessageFormat): TurnKind {
  if (format === 'responses') return classifyResponsesInput(body.input);
  const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : [];
  return format === 'anthropic' ? classifyTurn(messages) : classifyOpenAIChatTurn(messages);
}

// ---------------------------------------------------------------------------
// Steering injection sites
// ---------------------------------------------------------------------------

/** Anthropic `system`: null → new list; string → two blocks; list → replace/append. Returns whether the body changed. */
export function applyAnthropicSteering(body: Record<string, unknown>, block: string): boolean {
  const system = body.system;
  if (system === undefined || system === null) {
    body.system = [{ type: 'text', text: block }];
    return true;
  }
  if (typeof system === 'string') {
    body.system = [{ type: 'text', text: system }, { type: 'text', text: block }];
    return true;
  }
  if (Array.isArray(system)) {
    for (const b of system as Array<Record<string, unknown>>) {
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text.startsWith(STEERING_SENTINEL)) {
        if (b.text === block) return false;
        b.text = block;
        return true;
      }
    }
    (system as unknown[]).push({ type: 'text', text: block });
    return true;
  }
  return false;
}

/** OpenAI chat: the last system/developer message; none → insert at index 0. */
export function applyOpenAIChatSteering(body: Record<string, unknown>, block: string): boolean {
  const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : null;
  if (!messages) return false;
  let target: Message | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'system' || messages[i].role === 'developer') {
      target = messages[i];
      break;
    }
  }
  if (!target) {
    messages.unshift({ role: 'system', content: block });
    return true;
  }
  const content = target.content;
  if (content === null || content === undefined) {
    target.content = block;
    return true;
  }
  if (typeof content === 'string') {
    const next = replaceOrAppendSteeringBlock(content, block);
    if (next === content) return false;
    target.content = next;
    return true;
  }
  if (Array.isArray(content)) {
    for (const p of content as Array<Record<string, unknown>>) {
      if (p && typeof p.text === 'string' && p.text.startsWith(STEERING_SENTINEL)) {
        if (p.text === block) return false;
        p.text = block;
        return true;
      }
    }
    (content as unknown[]).push({ type: 'text', text: block });
    return true;
  }
  return false;
}

/** OpenAI Responses: the `instructions` string. */
export function applyResponsesSteering(body: Record<string, unknown>, block: string): boolean {
  const ins = body.instructions;
  if (ins === undefined || ins === null) {
    body.instructions = block;
    return true;
  }
  if (typeof ins !== 'string') return false;
  const next = replaceOrAppendSteeringBlock(ins, block);
  if (next === ins) return false;
  body.instructions = next;
  return true;
}

export function applySteering(body: Record<string, unknown>, format: MessageFormat, level: VerbosityLevel): boolean {
  const block = steeringText(level);
  if (!block) return false;
  if (format === 'anthropic') return applyAnthropicSteering(body, block);
  if (format === 'responses') return applyResponsesSteering(body, block);
  return applyOpenAIChatSteering(body, block);
}

// ---------------------------------------------------------------------------
// Effort routing (clamp only)
// ---------------------------------------------------------------------------

const EFFORT_ORDER = ['low', 'medium', 'high', 'max', 'xhigh'];
export const THINKING_BUDGET_FLOOR = 1024;

/**
 * Lower an *explicitly present* effort on a mechanical continuation. Never
 * injects, never raises, never toggles thinking. Returns the labels applied.
 */
export function clampEffort(body: Record<string, unknown>, format: MessageFormat, turn: TurnKind): string[] {
  if (turn !== 'mechanical_continuation') return [];
  const labels: string[] = [];
  if (format === 'anthropic') {
    const oc = body.output_config as Record<string, unknown> | undefined;
    if (oc && typeof oc.effort === 'string' && EFFORT_ORDER.indexOf(oc.effort) > 0) {
      oc.effort = 'low';
      labels.push('output_shaper:effort:low');
    }
    const thinking = body.thinking as Record<string, unknown> | undefined;
    if (thinking && typeof thinking.budget_tokens === 'number' && thinking.budget_tokens > THINKING_BUDGET_FLOOR) {
      thinking.budget_tokens = THINKING_BUDGET_FLOOR;
      labels.push(`output_shaper:thinking_budget:${THINKING_BUDGET_FLOOR}`);
    }
  } else if (format === 'responses') {
    const reasoning = body.reasoning as Record<string, unknown> | undefined;
    if (reasoning && typeof reasoning.effort === 'string' && EFFORT_ORDER.indexOf(reasoning.effort) > 0) {
      reasoning.effort = 'low';
      labels.push('output_shaper:effort:low');
    }
  } else if (typeof body.reasoning_effort === 'string' && EFFORT_ORDER.indexOf(body.reasoning_effort) > 0) {
    body.reasoning_effort = 'low';
    labels.push('output_shaper:effort:low');
  }
  return labels;
}

export interface ShapeOptions {
  level: VerbosityLevel;
  effortRouting: boolean;
  /** Steering is only allowed outside cache mode. */
  steeringAllowed: boolean;
}

/** Apply steering + effort clamp; returns the transform labels. */
export function shapeRequest(body: Record<string, unknown>, format: MessageFormat, opts: ShapeOptions): string[] {
  const labels: string[] = [];
  if (opts.steeringAllowed && opts.level > 0 && applySteering(body, format, opts.level)) labels.push(`output_shaper:verbosity:L${opts.level}`);
  if (opts.effortRouting) labels.push(...clampEffort(body, format, classifyForFormat(body, format)));
  return labels;
}

/** Precedence: cache mode → 0; explicit env → env; learned profile → learned; default. */
export function resolveVerbosityLevel(opts: { steeringAllowed: boolean; envLevel?: number; envExplicit: boolean; learnedLevel?: number; defaultLevel: number }): { level: VerbosityLevel; source: 'cache_mode' | 'env' | 'learned' | 'default' } {
  if (!opts.steeringAllowed) return { level: 0, source: 'cache_mode' };
  if (opts.envExplicit && opts.envLevel !== undefined) return { level: clampLevel(opts.envLevel), source: 'env' };
  if (opts.learnedLevel !== undefined && opts.learnedLevel >= 0 && opts.learnedLevel <= 4) return { level: clampLevel(opts.learnedLevel), source: 'learned' };
  return { level: clampLevel(opts.defaultLevel), source: 'default' };
}
