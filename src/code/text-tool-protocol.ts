/**
 * Text-based tool-call protocol fallback (model-agnostic agent robustness).
 *
 * The agent loop speaks native (OpenAI-shaped) function calling, but many
 * backends can't: the embedded llama.cpp host has no tool API at all, and a
 * large share of local models served by Ollama / LM Studio either ignore the
 * native `tools` field or emit their chat-template tool markup — Hermes/Qwen
 * `<tool_call>{…}</tool_call>` tags — as plain assistant text. Leading OSS
 * agents (Cline, Roo Code, Aider) solve this with a *prompt-described* tool
 * protocol parsed from text; this module gives `vg code` the same floor, so the
 * core agent works with whatever model is picked underneath.
 *
 * Two layers, both provider-neutral and unit-tested:
 *   - {@link parseTextToolCalls} — recover tool calls a model wrote as text
 *     (`<tool_call>` tags, fenced ```tool_call blocks, or a bare JSON object
 *     with `name` + `arguments`). Used as a *rescue* on every provider, so a
 *     model that ignores native function calling still drives the loop.
 *   - {@link withToolCallFallback} — a Provider decorator. For backends that
 *     declare `supportsTools: false` it renders the tool list into the system
 *     prompt, serializes prior tool rounds as text the model can read, and
 *     parses the reply. For native backends it passes through and only rescues.
 */

import type { ChatMessage, ChatOptions, Provider, ProviderResult, ToolCall, ToolSpec } from './types.js';

/** Formats we can recover a tool call from, in order of specificity. */
const TAG_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const FENCE_RE = /```(?:tool_call|tool|json)?\s*\n?([\s\S]*?)```/g;

interface RawCall {
  name?: unknown;
  arguments?: unknown;
  parameters?: unknown;
  input?: unknown;
}

/**
 * A whole fence that is nothing but one call written in source syntax:
 * `finish("…")`, `finish('…')`, or `finish({ "summary": "…" })`. Weaker models
 * routinely answer this way instead of emitting a tool call or the JSON form
 * above, and the result is that the user is shown a code block containing
 * their own answer rather than the answer.
 */
const CALL_SYNTAX_RE = /^([A-Za-z_][\w-]*)\s*\(([\s\S]*)\)\s*;?$/;

/**
 * Recover a call written in source syntax, using the tool's schema to place a
 * bare positional argument. Deliberately narrow — a call is only recovered
 * when the tool is one we actually offer, the whole block is the call, and
 * either the argument is a JSON object or the tool takes exactly one required
 * parameter for a bare string to belong to. Anything looser would turn a model
 * *discussing* `edit_file(...)` in prose into a real edit.
 */
function toCallSyntaxToolCall(blob: string, index: number, tools: ToolSpec[]): ToolCall | null {
  if (!tools.length) return null;
  const m = CALL_SYNTAX_RE.exec(blob.trim());
  if (!m) return null;
  const [, rawName, rawArgs] = m;
  const name = normalizeToolName(rawName, tools);
  const spec = tools.find((t) => t.name === name);
  if (!spec) return null;

  const args = rawArgs.trim();
  if (!args) return { id: `text_${index}`, name, arguments: {} };

  if (args.startsWith('{')) {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { id: `text_${index}`, name, arguments: parsed as Record<string, unknown> };
      }
    } catch {
      return null; // object-ish but not parseable — do not guess
    }
    return null;
  }

  // A bare positional argument only has an unambiguous home when the schema
  // has exactly one required parameter.
  const required = Array.isArray(spec.parameters?.required) ? (spec.parameters.required as string[]) : [];
  if (required.length !== 1) return null;
  const literal = parseStringLiteral(args);
  if (literal === null) return null;
  return { id: `text_${index}`, name, arguments: { [required[0]!]: literal } };
}

/** A single quoted string literal, or null for anything else (expressions, multiple args). */
function parseStringLiteral(src: string): string | null {
  const s = src.trim();
  if (s.length < 2) return null;
  const quote = s[0];
  if ((quote !== '"' && quote !== "'" && quote !== '`') || s[s.length - 1] !== quote) return null;
  const inner = s.slice(1, -1);
  // A second unescaped quote of the same kind means this was not one literal
  // (e.g. two positional args) — refuse rather than truncate the user's answer.
  if (new RegExp(`(?<!\\\\)${quote === '`' ? '`' : quote}`).test(inner)) return null;
  if (quote === '"') {
    try {
      return JSON.parse(s) as string;
    } catch {
      return null;
    }
  }
  return inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(new RegExp(`\\\\${quote}`, 'g'), quote);
}

/** Trim object keys (and nested object keys). Weak models pad `" name"` / `" path"`. */
function trimKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k.trim()] = v && typeof v === 'object' && !Array.isArray(v) ? trimKeys(v) : v;
  }
  return out;
}

/**
 * Collapse separators a model invents (`edit-file`, `read file`, `apply patch`,
 * `Read  File`, `read__file`) so we can match the advertised tool list. Any
 * whitespace or hyphen run becomes `_`, then `_` runs collapse (`read___file`
 * → `read_file`). Prefer an exact advertised name; a cheap near-miss is the
 * same letters once separators are gone (`readfile` → `read_file`).
 */
export function normalizeToolName(raw: string, tools: ToolSpec[] = []): string {
  const trimmed = raw.trim();
  const underscored = trimmed.replace(/[\s-]+/g, '_').replace(/_+/g, '_');
  const compact = underscored.replace(/_/g, '').toLowerCase();
  const match = tools.find((t) => {
    if (t.name === trimmed || t.name === underscored) return true;
    const advertised = t.name.toLowerCase();
    if (advertised === trimmed.toLowerCase() || advertised === underscored.toLowerCase()) return true;
    return t.name.replace(/_/g, '').toLowerCase() === compact;
  });
  return match?.name ?? underscored;
}

/** Rewrite every call name through {@link normalizeToolName} before dispatch. */
export function normalizeToolCalls(calls: ToolCall[] | undefined, tools: ToolSpec[] = []): ToolCall[] {
  if (!calls?.length) return calls ?? [];
  return calls.map((c) => {
    const name = normalizeToolName(c.name, tools);
    return name === c.name ? c : { ...c, name };
  });
}

/** Parse one candidate JSON blob into a ToolCall, or null when it isn't one. */
function toToolCall(blob: string, index: number, tools: ToolSpec[] = []): ToolCall | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = trimKeys(parsed) as RawCall;
  if (typeof obj.name !== 'string' || !obj.name.trim()) return null;
  const args = obj.arguments ?? obj.parameters ?? obj.input ?? {};
  return {
    id: `text_${index}`,
    name: normalizeToolName(obj.name, tools),
    arguments: args && typeof args === 'object' && !Array.isArray(args) ? (trimKeys(args) as Record<string, unknown>) : {},
  };
}

/**
 * True when a `"name"` value is a tool id — snake, kebab, or space-separated
 * (`read_file`, `edit-file`, `inspect task`), including a bare `{name}` object.
 */
function looksLikeToolId(raw: string): boolean {
  const t = raw.trim();
  if (!t || t.length > 48) return false;
  return /^[A-Za-z][\w]*(?:[\s_-]+[A-Za-z][\w]*){0,3}$/.test(t);
}

/** Known VG Code tools, written with `_`, `-`, or spaces between the words. */
const KNOWN_TOOL_NAME_RE =
  /(?:edit|read|create|delete)[_\s-]*file|apply[_\s-]*patch|run[_\s-]*command|search[_\s-]*code|inspect[_\s-]*task|inspect[_\s-]*change|verify[_\s-]*change|list[_\s-]*files|graph[_\s-]*impact|library[_\s-]*docs|set[_\s-]*progress|ask[_\s-]*user|spawn[_\s-]*subagent|web[_\s-]*fetch|web[_\s-]*search|finish|abort/i;

/** PatchIR / SEARCH-REPLACE op tokens a weak model prints as the "answer". */
const PATCH_OP_VALUE_RE =
  /^(?:REPLACED|REPLACE|CREATE|DELETE|replace(?:-text|-range|-symbol)?|create-file|delete-file|replace|create|delete)$/i;
const PATCH_OP_FIELD_RE =
  /"\s*op\s*"\s*:\s*"\s*(?:REPLACED|REPLACE|CREATE|DELETE|replace(?:-text|-range|-symbol)?|create-file|delete-file|replace|create|delete)\s*"/i;

function stripDumpFence(text: string): string {
  return text.replace(/^```(?:json|tool_call|tool)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

/** Bare / fenced JSON object (any keys) — used after a failed mutation. */
export function looksLikeBareJsonObject(text: string): boolean {
  const stripped = stripDumpFence((text ?? '').trim());
  if (!stripped.startsWith('{') || !stripped.endsWith('}')) return false;
  try {
    const parsed = JSON.parse(stripped) as unknown;
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function looksLikePatchOpDump(obj: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(obj).map((k) => k.trim().toLowerCase()));
  const op = typeof obj.op === 'string' ? obj.op.trim() : '';
  if (op && PATCH_OP_VALUE_RE.test(op)) return true;
  const hasTarget = keys.has('id') || keys.has('file') || keys.has('path');
  const hasBody = keys.has('replacement') || keys.has('replace') || keys.has('content') || keys.has('search');
  if (hasTarget && hasBody && (op || keys.has('search'))) return true;
  return false;
}

/**
 * True when assistant text is a printed tool-call dump (fenced JSON, Hermes
 * tags, a `{name}` object, or a PatchIR / `{id, op, replacement}` op-dump)
 * rather than a user-facing answer. Used so `isUserFacingProse` cannot treat
 * a failed dump as a solve.
 */
export function looksLikeToolCallDump(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  if (/<tool_call>/i.test(t)) return true;
  const stripped = stripDumpFence(t);

  // `"name":"inspect task"` / `"name":"read_file"` — args optional.
  const named = /"\s*name\s*"\s*:\s*"\s*([^"]+?)\s*"/i.exec(stripped);
  if (named && (KNOWN_TOOL_NAME_RE.test(named[1]) || looksLikeToolId(named[1]))) return true;

  if (/"\s*name\s*"\s*:/i.test(stripped) && /"\s*(arguments|parameters|input)\s*"\s*:/i.test(stripped)) {
    return true;
  }

  // `{..."op":"REPLACED"...}` / create-file / SEARCH-REPLACE payload dumps.
  if (PATCH_OP_FIELD_RE.test(stripped)) return true;

  // Bare / fenced JSON whose `name` looks like a tool id, or a PatchIR-ish op.
  if (stripped.startsWith('{') && stripped.endsWith('}')) {
    try {
      const parsed = JSON.parse(stripped) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = trimKeys(parsed) as RawCall & Record<string, unknown>;
        if (typeof obj.name === 'string' && (KNOWN_TOOL_NAME_RE.test(obj.name) || looksLikeToolId(obj.name))) {
          return true;
        }
        if (looksLikePatchOpDump(obj)) return true;
      }
    } catch {
      /* unparseable — the `"name":"…"` / `"op":"…"` paths above already ran */
    }
  }
  return false;
}

/**
 * True when assistant text mixes prose with a truncated or unquoted `{…}`
 * dump (Flow: "Sorry…" then `{name: read_file, path: …` with no close).
 * Valid JSON objects belong to {@link looksLikeBareJsonObject} /
 * {@link looksLikeToolCallDump}; this catches the broken remainder so a
 * no-tools streak cannot fake-finish as prose.
 */
export function looksLikeBrokenJsonDump(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t.includes('{')) return false;
  if (looksLikeBareJsonObject(t)) return false;
  const after = t.slice(t.indexOf('{'));
  // Unquoted object keys (`{name: read_file` / `{ op: REPLACED`).
  if (/\{\s*[A-Za-z_]\w*\s*:/.test(after)) return true;
  // Quoted tool/op keys in a fragment that never parsed as a full object.
  if (/"\s*(name|op|arguments|path|file|search|replace|id)\s*"\s*:/i.test(after)) return true;
  // A lone / unclosed `{` after other text.
  if (t.indexOf('{') > 0 && !after.includes('}')) return true;
  return false;
}

/**
 * Extract tool calls a model emitted as plain text, returning the calls plus
 * the text with the call markup removed (what remains is the user-facing
 * prose, if any). Order of attempts: `<tool_call>` tags, then fenced blocks,
 * then one bare top-level JSON object. Anything that doesn't parse into a
 * `{name, arguments}` shape is left in the text untouched.
 */
export function parseTextToolCalls(text: string, tools: ToolSpec[] = []): { calls: ToolCall[]; text: string } {
  const calls: ToolCall[] = [];
  let cleaned = text ?? '';

  cleaned = cleaned.replace(TAG_RE, (whole, body: string) => {
    const call = toToolCall(body, calls.length, tools);
    if (!call) return whole;
    calls.push(call);
    return '';
  });

  if (calls.length === 0) {
    cleaned = cleaned.replace(FENCE_RE, (whole, body: string) => {
      const blob = body.trim();
      const call = toToolCall(blob, calls.length, tools) ?? toCallSyntaxToolCall(blob, calls.length, tools);
      if (!call) return whole;
      calls.push(call);
      return '';
    });
  }

  if (calls.length === 0) {
    const t = cleaned.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      const call = toToolCall(t, 0, tools);
      if (call) {
        calls.push(call);
        cleaned = '';
      }
    } else {
      // Unfenced source syntax as the entire reply — same narrow rules.
      const call = toCallSyntaxToolCall(t, 0, tools);
      if (call) {
        calls.push(call);
        cleaned = '';
      }
    }
  }

  return { calls, text: cleaned.trim() };
}

/** The prompt block that teaches a non-tool-calling model the call format. */
export function textToolProtocolInstruction(tools: ToolSpec[]): string {
  const lines = tools.map((t) => {
    const params = JSON.stringify(t.parameters?.properties ?? {});
    return `- ${t.name}: ${t.description.split('\n')[0]} · arguments schema: ${params}`;
  });
  return [
    '',
    '## Tool calling (text protocol)',
    'This runtime has no native function-calling. To use a tool, reply with ONLY:',
    '<tool_call>{"name": "<tool name>", "arguments": { … }}</tool_call>',
    'One tool call per reply. Wait for the tool result before the next call.',
    'When the task is complete, call the `finish` tool with your Markdown summary.',
    'Available tools:',
    ...lines,
  ].join('\n');
}

/** Serialize a tool round into text for backends that lack tool roles. */
function flattenToolRounds(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m): ChatMessage => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const rendered = m.toolCalls
        .map((c) => `<tool_call>${JSON.stringify({ name: c.name, arguments: c.arguments })}</tool_call>`)
        .join('\n');
      return { role: 'assistant', content: [m.content, rendered].filter(Boolean).join('\n') };
    }
    if (m.role === 'tool') {
      return { role: 'user', content: `Tool result for ${m.name}:\n${m.content}` };
    }
    return m;
  });
}

/**
 * Wrap a provider so the agent loop's tool calling works regardless of the
 * backend's native capability:
 *   - `supportsTools === false` (embedded llama.cpp), or a model the
 *     capability registry knows cannot tool-call natively: inject the text
 *     protocol into the system prompt, flatten tool rounds to text, parse the
 *     reply.
 *   - native backends: call through; rewrite spaced/hyphenated names on any
 *     native toolCalls; when the model returned no native tool calls but its
 *     text contains parseable tool markup, rescue it.
 * Idempotent-safe: wrapping a wrapped provider changes nothing observable.
 */
export function withToolCallFallback(
  provider: Provider,
  caps?: { nativeTools: boolean | null },
): Provider {
  return {
    id: provider.id,
    label: provider.label,
    local: provider.local,
    model: provider.model,
    supportsTools: provider.supportsTools,
    async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ProviderResult> {
      const native = provider.supportsTools !== false && caps?.nativeTools !== false;
      if (native || !opts.tools?.length) {
        const result = await provider.chat(messages, opts);
        const tools = opts.tools ?? [];
        if ((!result.toolCalls || result.toolCalls.length === 0) && result.text) {
          const rescued = parseTextToolCalls(result.text, tools);
          if (rescued.calls.length) return { ...result, text: rescued.text, toolCalls: rescued.calls };
        }
        // Native calls still go through the same name rewrite (`apply patch` →
        // `apply_patch`) so dispatch never sees the spaced form.
        if (result.toolCalls?.length) {
          return { ...result, toolCalls: normalizeToolCalls(result.toolCalls, tools) };
        }
        return result;
      }

      // Text-protocol path: teach the format, flatten history, parse the reply.
      const instruction = textToolProtocolInstruction(opts.tools);
      const flattened = flattenToolRounds(messages);
      const withProtocol: ChatMessage[] = flattened.map((m, i) =>
        i === 0 && m.role === 'system' ? { role: 'system', content: m.content + '\n' + instruction } : m,
      );
      if (withProtocol[0]?.role !== 'system') {
        withProtocol.unshift({ role: 'system', content: instruction });
      }
      const result = await provider.chat(withProtocol, { ...opts, tools: undefined });
      const parsed = parseTextToolCalls(result.text ?? '', opts.tools);
      if (parsed.calls.length) return { ...result, text: parsed.text, toolCalls: parsed.calls };
      return result;
    },
  };
}
