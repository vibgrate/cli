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
const CALL_SYNTAX_RE = /^([A-Za-z_][\w]*)\s*\(([\s\S]*)\)\s*;?$/;

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
  const [, name, rawArgs] = m;
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

/** Parse one candidate JSON blob into a ToolCall, or null when it isn't one. */
function toToolCall(blob: string, index: number): ToolCall | null {
  let parsed: RawCall;
  try {
    parsed = JSON.parse(blob) as RawCall;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string' || !parsed.name) return null;
  const args = parsed.arguments ?? parsed.parameters ?? parsed.input ?? {};
  return {
    id: `text_${index}`,
    name: parsed.name,
    arguments: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
  };
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
    const call = toToolCall(body, calls.length);
    if (!call) return whole;
    calls.push(call);
    return '';
  });

  if (calls.length === 0) {
    cleaned = cleaned.replace(FENCE_RE, (whole, body: string) => {
      const blob = body.trim();
      const call = toToolCall(blob, calls.length) ?? toCallSyntaxToolCall(blob, calls.length, tools);
      if (!call) return whole;
      calls.push(call);
      return '';
    });
  }

  if (calls.length === 0) {
    const t = cleaned.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      const call = toToolCall(t, 0);
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
 *   - native backends: call through unchanged; when the model returned no
 *     native tool calls but its text contains parseable tool markup, rescue it.
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
        if ((!result.toolCalls || result.toolCalls.length === 0) && result.text) {
          const rescued = parseTextToolCalls(result.text, opts.tools ?? []);
          if (rescued.calls.length) return { ...result, text: rescued.text, toolCalls: rescued.calls };
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
