/**
 * Message-format detection, block enumeration and lossless conversion.
 *
 * Five wire shapes are understood:
 *   openai     `{ role, content: string | parts[], tool_calls?, tool_call_id? }`
 *   anthropic  `{ role, content: string | blocks[] }` with tool_use / tool_result
 *   responses  Responses API `input` items: message | function_call | function_call_output | reasoning
 *   vercel     AI SDK `{ role, content: string | parts[] }` with tool-call / tool-result
 *   gemini     `{ role: user|model, parts: [{ text } | { functionCall } | { functionResponse }] }`
 *
 * The pipeline never converts a conversation: it walks the native shape via
 * `walkTextBlocks` and rewrites text in place, so `cache_control`, tool ids,
 * `is_error`, images, documents and thinking blocks are never touched.
 * `toOpenAI` / `fromOpenAI` exist for callers that need one canonical view
 * (the SDK wrappers, the proxy); `fromOpenAI` restores the original shape from
 * the untouched `original` messages and only carries the rewritten text over.
 */

import type { Message, MessageFormat } from './types.js';

export type BlockKind = 'text' | 'tool_result' | 'other';

/** One addressable unit of a conversation (a message's string content or one block/part). */
export interface EnumeratedBlock {
  messageIndex: number;
  /** undefined for string-shaped message content. */
  blockIndex?: number;
  /** Normalised: system | developer | user | assistant | tool. */
  role: string;
  /** Wire block type: `text`, `tool_result`, `tool_use`, `thinking`, `image`, … (`string` for bare string content). */
  blockType: string;
  kind: BlockKind;
  toolName?: string;
  toolCallId?: string;
  /** Text of a `text`/`tool_result` block; for `other` blocks the countable text (tool inputs, thinking). */
  text: string;
  /** True when the block (or its wrapping message) carries a provider cache breakpoint. */
  cacheControl: boolean;
  isError: boolean;
  /** Only meaningful for `kind !== 'other'`: rewrite the text in place. */
  set(next: string): void;
}

export interface TextBlockVisit {
  messageIndex: number;
  blockIndex?: number;
  role: string;
  blockType: string;
  toolName?: string;
  toolCallId?: string;
  text: string;
  cacheControl?: boolean;
  isError?: boolean;
  set(next: string): void;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const RESPONSES_ITEM_TYPES = new Set(['function_call', 'function_call_output', 'reasoning', 'computer_call', 'computer_call_output', 'file_search_call', 'web_search_call', 'item_reference']);
const RESPONSES_PART_TYPES = new Set(['input_text', 'output_text', 'input_image', 'input_file', 'refusal']);

/** Structural first-match detection (never heuristic on prose). Plain `{role, content: string}` is OpenAI. */
export function detectFormat(messages: Message[]): MessageFormat {
  for (const msg of messages) {
    if (!isObj(msg)) continue;
    if (Array.isArray(msg.parts) && msg.content === undefined) return 'gemini';
    if (msg.role === 'model') return 'gemini';
    if (typeof msg.type === 'string' && RESPONSES_ITEM_TYPES.has(msg.type)) return 'responses';
    if (msg.type === 'message' && Array.isArray(msg.content)) {
      for (const p of msg.content) if (isObj(p) && typeof p.type === 'string' && RESPONSES_PART_TYPES.has(p.type)) return 'responses';
    }
    if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (!isObj(p)) continue;
        if (typeof p.type === 'string' && RESPONSES_PART_TYPES.has(p.type)) return 'responses';
        if (p.type === 'tool-call' || p.type === 'tool-result') return 'vercel';
        if (p.type === 'tool_use' || p.type === 'tool_result' || p.type === 'thinking' || p.type === 'redacted_thinking') return 'anthropic';
        if (p.type === 'image' && isObj(p.source) && typeof p.source.type === 'string') return 'anthropic';
        if (p.type === 'image' && 'image' in p) return 'vercel';
        if (p.type === 'file' && 'data' in p && 'mediaType' in p) return 'vercel';
      }
    }
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) return 'openai';
    if (msg.role === 'tool' && typeof msg.tool_call_id === 'string') return 'openai';
  }
  return 'openai';
}

// ---------------------------------------------------------------------------
// Tool-call id → name resolution
// ---------------------------------------------------------------------------

/** Map every tool-call id in the conversation to its tool name (all formats). */
export function toolNameIndex(messages: Message[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const msg of messages) {
    if (!isObj(msg)) continue;
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!isObj(tc)) continue;
        const fn = isObj(tc.function) ? tc.function : undefined;
        const name = str(fn?.name) || str(tc.name);
        if (typeof tc.id === 'string' && name) out.set(tc.id, name);
      }
    }
    if (msg.type === 'function_call' && typeof msg.name === 'string') {
      const id = str(msg.call_id) || str(msg.id);
      if (id) out.set(id, msg.name);
    }
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!isObj(b)) continue;
        if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') out.set(b.id, b.name);
        if (b.type === 'tool-call' && typeof b.toolCallId === 'string' && typeof b.toolName === 'string') out.set(b.toolCallId, b.toolName);
        if (b.type === 'tool-result' && typeof b.toolCallId === 'string' && typeof b.toolName === 'string' && !out.has(b.toolCallId)) out.set(b.toolCallId, b.toolName);
      }
    }
    if (Array.isArray(msg.parts)) {
      for (const p of msg.parts) {
        if (!isObj(p)) continue;
        const fc = isObj(p.functionCall) ? p.functionCall : undefined;
        if (fc && typeof fc.name === 'string') out.set(str(fc.id) || fc.name, fc.name);
      }
    }
  }
  return out;
}

/** Tool-call arguments keyed by id (parsed objects when possible). */
export function toolArgsIndex(messages: Message[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const parse = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  for (const msg of messages) {
    if (!isObj(msg)) continue;
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!isObj(tc) || typeof tc.id !== 'string') continue;
        const fn = isObj(tc.function) ? tc.function : undefined;
        out.set(tc.id, parse(fn?.arguments ?? tc.arguments));
      }
    }
    if (msg.type === 'function_call') {
      const id = str(msg.call_id) || str(msg.id);
      if (id) out.set(id, parse(msg.arguments));
    }
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!isObj(b)) continue;
        if (b.type === 'tool_use' && typeof b.id === 'string') out.set(b.id, b.input);
        if (b.type === 'tool-call' && typeof b.toolCallId === 'string') out.set(b.toolCallId, b.input ?? b.args);
      }
    }
    if (Array.isArray(msg.parts)) {
      for (const p of msg.parts) {
        if (!isObj(p)) continue;
        const fc = isObj(p.functionCall) ? p.functionCall : undefined;
        if (fc && typeof fc.name === 'string') out.set(str(fc.id) || fc.name, fc.args);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block enumeration
// ---------------------------------------------------------------------------

function normRole(msg: Record<string, unknown>): string {
  const r = str(msg.role);
  if (r === 'model') return 'assistant';
  if (r === 'function') return 'tool';
  if (r) return r;
  const t = str(msg.type);
  if (t === 'function_call_output' || t === 'computer_call_output') return 'tool';
  if (t === 'function_call' || t === 'reasoning' || t === 'computer_call') return 'assistant';
  return 'user';
}

function hasCacheControl(v: unknown): boolean {
  return isObj(v) && isObj(v.cache_control);
}

function textOfInnerBlocks(inner: unknown[]): string | null {
  const parts: string[] = [];
  for (const b of inner) {
    if (!isObj(b)) return null;
    const t = b.type;
    if ((t === 'text' || t === 'input_text' || t === 'output_text') && typeof b.text === 'string') parts.push(b.text);
    else return null;
  }
  return parts.join('\n');
}

function anyInnerCacheControl(inner: unknown[]): boolean {
  for (const b of inner) if (hasCacheControl(b)) return true;
  return false;
}

function countableOther(b: Record<string, unknown>): string {
  const t = str(b.type);
  if (t === 'tool_use') return `${str(b.name)} ${safeJson(b.input)}`;
  if (t === 'tool-call') return `${str(b.toolName)} ${safeJson(b.input ?? b.args)}`;
  if (t === 'thinking') return str(b.thinking);
  if (t === 'redacted_thinking') return '';
  if (t === 'image' || t === 'image_url' || t === 'input_image' || t === 'document' || t === 'file' || t === 'input_file') return '';
  if (t === 'reasoning') {
    const summary = Array.isArray(b.summary) ? b.summary.map((s) => (isObj(s) ? str(s.text) : '')).join('\n') : '';
    return summary;
  }
  if (t === 'function_call') return `${str(b.name)} ${str(b.arguments)}`;
  if (typeof b.text === 'string') return b.text;
  return '';
}

function safeJson(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/**
 * Enumerate every block of every message in document order, with in-place
 * `set()` mutators for text-bearing blocks. `messages` is mutated by `set`.
 */
export function enumerateBlocks(messages: Message[], format: MessageFormat = detectFormat(messages)): EnumeratedBlock[] {
  const names = toolNameIndex(messages);
  const out: EnumeratedBlock[] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (!isObj(msg)) continue;
    const role = normRole(msg);
    if (format === 'gemini') {
      enumerateGemini(msg, mi, role, names, out);
      continue;
    }
    if (format === 'responses') {
      enumerateResponsesItem(msg, mi, role, names, out);
      continue;
    }
    const content = msg.content;
    const msgCache = hasCacheControl(msg);
    if (typeof content === 'string') {
      const isTool = role === 'tool';
      const toolCallId = str(msg.tool_call_id) || undefined;
      out.push({
        messageIndex: mi,
        role,
        blockType: isTool ? 'tool_result' : 'string',
        kind: isTool ? 'tool_result' : 'text',
        toolName: isTool ? (toolCallId ? names.get(toolCallId) : undefined) ?? (str(msg.name) || undefined) : undefined,
        toolCallId,
        text: content,
        cacheControl: msgCache,
        isError: false,
        set: (next) => {
          msg.content = next;
        },
      });
    } else if (Array.isArray(content)) {
      for (let bi = 0; bi < content.length; bi++) {
        const b = content[bi];
        if (!isObj(b)) continue;
        const t = str(b.type);
        const bCache = msgCache || hasCacheControl(b);
        if (t === 'text' && typeof b.text === 'string') {
          const isTool = role === 'tool';
          const toolCallId = str(msg.tool_call_id) || undefined;
          out.push({
            messageIndex: mi,
            blockIndex: bi,
            role,
            blockType: isTool ? 'tool_result' : 'text',
            kind: isTool ? 'tool_result' : 'text',
            toolName: isTool && toolCallId ? names.get(toolCallId) : undefined,
            toolCallId,
            text: b.text,
            cacheControl: bCache,
            isError: false,
            set: (next) => {
              b.text = next;
            },
          });
        } else if (t === 'tool_result') {
          const toolCallId = str(b.tool_use_id) || undefined;
          const inner = b.content;
          const isError = b.is_error === true;
          if (typeof inner === 'string') {
            out.push({
              messageIndex: mi,
              blockIndex: bi,
              role,
              blockType: 'tool_result',
              kind: 'tool_result',
              toolName: toolCallId ? names.get(toolCallId) : undefined,
              toolCallId,
              text: inner,
              cacheControl: bCache,
              isError,
              set: (next) => {
                b.content = next;
              },
            });
          } else if (Array.isArray(inner)) {
            const joined = textOfInnerBlocks(inner);
            if (joined === null) {
              out.push({ messageIndex: mi, blockIndex: bi, role, blockType: 'tool_result', kind: 'other', toolCallId, toolName: toolCallId ? names.get(toolCallId) : undefined, text: '', cacheControl: bCache, isError, set: () => undefined });
            } else {
              const innerCache = anyInnerCacheControl(inner);
              const first = inner[0];
              out.push({
                messageIndex: mi,
                blockIndex: bi,
                role,
                blockType: 'tool_result',
                kind: 'tool_result',
                toolName: toolCallId ? names.get(toolCallId) : undefined,
                toolCallId,
                text: joined,
                cacheControl: bCache || innerCache,
                isError,
                set: (next) => {
                  if (inner.length === 1 && isObj(first)) first.text = next;
                  else {
                    const block: Record<string, unknown> = { type: 'text', text: next };
                    const cc = inner.find((x) => hasCacheControl(x));
                    if (isObj(cc)) block.cache_control = cc.cache_control;
                    b.content = [block];
                  }
                },
              });
            }
          } else {
            out.push({ messageIndex: mi, blockIndex: bi, role, blockType: 'tool_result', kind: 'other', toolCallId, text: '', cacheControl: bCache, isError, set: () => undefined });
          }
        } else if (t === 'tool-result') {
          const toolCallId = str(b.toolCallId) || undefined;
          const toolName = str(b.toolName) || (toolCallId ? names.get(toolCallId) : undefined);
          const view = vercelResultText(b);
          if (view === null) {
            out.push({ messageIndex: mi, blockIndex: bi, role, blockType: 'tool_result', kind: 'other', toolCallId, toolName, text: '', cacheControl: bCache, isError: false, set: () => undefined });
          } else {
            out.push({
              messageIndex: mi,
              blockIndex: bi,
              role,
              blockType: 'tool_result',
              kind: 'tool_result',
              toolName,
              toolCallId,
              text: view.text,
              cacheControl: bCache,
              isError: view.isError,
              set: (next) => vercelResultWrite(b, view.shape, next),
            });
          }
        } else {
          out.push({ messageIndex: mi, blockIndex: bi, role, blockType: t || 'unknown', kind: 'other', toolCallId: str(b.id) || undefined, toolName: str(b.name) || str(b.toolName) || undefined, text: countableOther(b), cacheControl: bCache, isError: false, set: () => undefined });
        }
      }
    }
    // OpenAI assistant tool_calls count toward tokens but are never rewritten.
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!isObj(tc)) continue;
        const fn = isObj(tc.function) ? tc.function : undefined;
        out.push({ messageIndex: mi, role, blockType: 'tool_call', kind: 'other', toolCallId: str(tc.id) || undefined, toolName: str(fn?.name) || undefined, text: `${str(fn?.name)} ${str(fn?.arguments)}`, cacheControl: msgCache, isError: false, set: () => undefined });
      }
    }
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
      out.push({ messageIndex: mi, role, blockType: 'reasoning_content', kind: 'other', text: msg.reasoning_content, cacheControl: msgCache, isError: false, set: () => undefined });
    }
  }
  return out;
}

function vercelResultText(b: Record<string, unknown>): { text: string; shape: 'output-text' | 'output-json' | 'output-error' | 'result-string' | 'result-json'; isError: boolean } | null {
  const output = b.output;
  if (isObj(output) && typeof output.type === 'string') {
    if (output.type === 'text' && typeof output.value === 'string') return { text: output.value, shape: 'output-text', isError: false };
    if (output.type === 'error-text' && typeof output.value === 'string') return { text: output.value, shape: 'output-error', isError: true };
    if (output.type === 'json' || output.type === 'error-json') return { text: safeJson(output.value), shape: output.type === 'json' ? 'output-json' : 'output-error', isError: output.type === 'error-json' };
    return null;
  }
  if (output !== undefined) {
    return typeof output === 'string' ? { text: output, shape: 'result-string', isError: false } : { text: safeJson(output), shape: 'result-json', isError: false };
  }
  if (b.result !== undefined) {
    return typeof b.result === 'string' ? { text: b.result, shape: 'result-string', isError: false } : { text: safeJson(b.result), shape: 'result-json', isError: false };
  }
  return null;
}

function vercelResultWrite(b: Record<string, unknown>, shape: 'output-text' | 'output-json' | 'output-error' | 'result-string' | 'result-json', next: string): void {
  const parsed = tryParse(next);
  if (shape === 'output-text' || shape === 'output-error') {
    (b.output as Record<string, unknown>).value = next;
    return;
  }
  if (shape === 'output-json') {
    b.output = parsed.ok ? { type: 'json', value: parsed.value } : { type: 'text', value: next };
    return;
  }
  const key = b.output !== undefined ? 'output' : 'result';
  if (shape === 'result-string') b[key] = next;
  else b[key] = parsed.ok ? parsed.value : next;
}

function tryParse(text: string): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: undefined };
  }
}

/** Text view of a Gemini functionResponse.response plus the shape needed to write it back. */
function geminiResponseText(resp: unknown): { text: string; shape: 'string' | 'wrapped' | 'json'; wrapKey: string } {
  if (typeof resp === 'string') return { text: resp, shape: 'string', wrapKey: 'content' };
  if (isObj(resp)) {
    const keys = Object.keys(resp);
    if (keys.length === 1 && typeof resp[keys[0]] === 'string' && ['content', 'result', 'output', 'text'].includes(keys[0])) return { text: resp[keys[0]] as string, shape: 'wrapped', wrapKey: keys[0] };
  }
  return { text: safeJson(resp), shape: 'json', wrapKey: 'content' };
}

function enumerateGemini(msg: Record<string, unknown>, mi: number, role: string, names: Map<string, string>, out: EnumeratedBlock[]): void {
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  for (let pi = 0; pi < parts.length; pi++) {
    const p = parts[pi];
    if (!isObj(p)) continue;
    if (typeof p.text === 'string') {
      out.push({ messageIndex: mi, blockIndex: pi, role, blockType: 'text', kind: 'text', text: p.text, cacheControl: false, isError: false, set: (next) => void (p.text = next) });
    } else if (isObj(p.functionResponse)) {
      const fr = p.functionResponse;
      const name = str(fr.name);
      const id = str(fr.id) || name;
      const { text, shape, wrapKey } = geminiResponseText(fr.response);
      out.push({
        messageIndex: mi,
        blockIndex: pi,
        role: 'tool',
        blockType: 'tool_result',
        kind: 'tool_result',
        toolName: names.get(id) ?? (name || undefined),
        toolCallId: id || undefined,
        text,
        cacheControl: false,
        isError: false,
        set: (next) => {
          if (shape === 'string') fr.response = next;
          else if (shape === 'wrapped') fr.response = { [wrapKey]: next };
          else {
            const parsed = tryParse(next);
            fr.response = parsed.ok && isObj(parsed.value) ? parsed.value : { content: next };
          }
        },
      });
    } else if (isObj(p.functionCall)) {
      const fc = p.functionCall;
      out.push({ messageIndex: mi, blockIndex: pi, role, blockType: 'tool_use', kind: 'other', toolCallId: str(fc.id) || str(fc.name) || undefined, toolName: str(fc.name) || undefined, text: `${str(fc.name)} ${safeJson(fc.args)}`, cacheControl: false, isError: false, set: () => undefined });
    } else {
      out.push({ messageIndex: mi, blockIndex: pi, role, blockType: isObj(p.inlineData) ? 'image' : 'unknown', kind: 'other', text: '', cacheControl: false, isError: false, set: () => undefined });
    }
  }
}

function enumerateResponsesItem(msg: Record<string, unknown>, mi: number, role: string, names: Map<string, string>, out: EnumeratedBlock[]): void {
  const t = str(msg.type);
  if (t === 'function_call_output' || t === 'computer_call_output') {
    const id = str(msg.call_id) || str(msg.id) || undefined;
    const output = msg.output;
    if (typeof output === 'string') {
      out.push({ messageIndex: mi, role: 'tool', blockType: 'tool_result', kind: 'tool_result', toolName: id ? names.get(id) : undefined, toolCallId: id, text: output, cacheControl: false, isError: false, set: (next) => void (msg.output = next) });
    } else if (Array.isArray(output)) {
      const joined = textOfInnerBlocks(output);
      if (joined === null) out.push({ messageIndex: mi, role: 'tool', blockType: 'tool_result', kind: 'other', toolCallId: id, text: '', cacheControl: false, isError: false, set: () => undefined });
      else
        out.push({
          messageIndex: mi,
          role: 'tool',
          blockType: 'tool_result',
          kind: 'tool_result',
          toolName: id ? names.get(id) : undefined,
          toolCallId: id,
          text: joined,
          cacheControl: false,
          isError: false,
          set: (next) => {
            if (output.length === 1 && isObj(output[0])) output[0].text = next;
            else msg.output = [{ type: 'input_text', text: next }];
          },
        });
    } else {
      out.push({ messageIndex: mi, role: 'tool', blockType: 'tool_result', kind: 'other', toolCallId: id, text: '', cacheControl: false, isError: false, set: () => undefined });
    }
    return;
  }
  if (t === 'function_call' || t === 'reasoning' || (t && t !== 'message')) {
    out.push({ messageIndex: mi, role, blockType: t, kind: 'other', toolCallId: str(msg.call_id) || str(msg.id) || undefined, toolName: str(msg.name) || undefined, text: countableOther(msg), cacheControl: false, isError: false, set: () => undefined });
    return;
  }
  const content = msg.content;
  if (typeof content === 'string') {
    out.push({ messageIndex: mi, role, blockType: 'string', kind: 'text', text: content, cacheControl: false, isError: false, set: (next) => void (msg.content = next) });
  } else if (Array.isArray(content)) {
    for (let bi = 0; bi < content.length; bi++) {
      const b = content[bi];
      if (!isObj(b)) continue;
      const bt = str(b.type);
      if ((bt === 'input_text' || bt === 'output_text' || bt === 'text') && typeof b.text === 'string') {
        out.push({ messageIndex: mi, blockIndex: bi, role, blockType: 'text', kind: 'text', text: b.text, cacheControl: false, isError: false, set: (next) => void (b.text = next) });
      } else {
        out.push({ messageIndex: mi, blockIndex: bi, role, blockType: bt || 'unknown', kind: 'other', text: countableOther(b), cacheControl: false, isError: false, set: () => undefined });
      }
    }
  }
}

/** Visit every text-bearing block (text + tool results) with an in-place mutator. */
export function walkTextBlocks(messages: Message[], visit: (b: TextBlockVisit) => void): void {
  for (const b of enumerateBlocks(messages)) {
    if (b.kind === 'other') continue;
    const v: TextBlockVisit = { messageIndex: b.messageIndex, role: b.role, blockType: b.blockType, text: b.text, cacheControl: b.cacheControl, isError: b.isError, set: b.set };
    if (b.blockIndex !== undefined) v.blockIndex = b.blockIndex;
    if (b.toolName !== undefined) v.toolName = b.toolName;
    if (b.toolCallId !== undefined) v.toolCallId = b.toolCallId;
    visit(v);
  }
}

/** Index of the last user-role message (null when none). */
export function latestUserMessageIndex(messages: Message[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isObj(m) && normRole(m) === 'user' && m.type !== 'function_call_output') return i;
  }
  return null;
}

/** Index of the last assistant-role message (-1 when none). */
export function lastAssistantIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isObj(m) && normRole(m) === 'assistant') return i;
  }
  return -1;
}

/** Most recent user text (the relevance query). */
export function extractUserQuery(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isObj(m) || normRole(m) !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string' && c.trim()) return c.trim();
    if (Array.isArray(c)) {
      for (const b of c) {
        if (isObj(b) && (b.type === 'text' || b.type === 'input_text') && typeof b.text === 'string' && b.text.trim()) return b.text.trim();
      }
    }
    if (Array.isArray(m.parts)) {
      for (const p of m.parts) if (isObj(p) && typeof p.text === 'string' && p.text.trim()) return p.text.trim();
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Conversion to / from the OpenAI view
// ---------------------------------------------------------------------------

function textSlotsOpenAI(messages: Message[]): string[] {
  const out: string[] = [];
  walkTextBlocks(messages, (b) => out.push(b.text));
  return out;
}

/**
 * Lossless-by-construction conversion to the OpenAI chat shape. Text blocks
 * keep their `cache_control`; tool ids are preserved; images/thinking become
 * opaque parts (`image_url` / `_vg_opaque`) so nothing is dropped.
 */
export function toOpenAI(messages: Message[], format: MessageFormat = detectFormat(messages)): Message[] {
  switch (format) {
    case 'openai':
      return messages;
    case 'anthropic':
      return anthropicToOpenAI(messages);
    case 'vercel':
      return vercelToOpenAI(messages);
    case 'gemini':
      return geminiToOpenAI(messages);
    case 'responses':
      return responsesToOpenAI(messages);
    default:
      return messages;
  }
}

/**
 * Restore the original shape. When `original` is supplied and its text-slot
 * count matches the rewritten OpenAI view, only the texts are carried over
 * (everything else is byte-identical to `original`). Otherwise a structural
 * conversion is performed.
 */
export function fromOpenAI(messages: Message[], format: MessageFormat, original?: Message[]): Message[] {
  if (format === 'openai') return messages;
  if (original) {
    const reference = toOpenAI(original, format);
    const refSlots = textSlotsOpenAI(reference);
    const newSlots = textSlotsOpenAI(messages);
    if (refSlots.length === newSlots.length && reference.length === messages.length) {
      const clone = structuredClone(original);
      let i = 0;
      walkTextBlocks(clone, (b) => {
        const next = newSlots[i++];
        if (next !== undefined && next !== b.text) b.set(next);
      });
      return clone;
    }
  }
  switch (format) {
    case 'anthropic':
      return openAIToAnthropic(messages);
    case 'vercel':
      return openAIToVercel(messages);
    case 'gemini':
      return openAIToGemini(messages);
    case 'responses':
      return openAIToResponses(messages);
    default:
      return messages;
  }
}

function withCache(target: Record<string, unknown>, source: unknown): Record<string, unknown> {
  if (isObj(source) && isObj(source.cache_control)) target.cache_control = source.cache_control;
  return target;
}

export function anthropicToOpenAI(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const msg of messages) {
    if (!isObj(msg)) continue;
    const role = normRole(msg);
    const content = msg.content;
    if (typeof content === 'string' || !Array.isArray(content)) {
      out.push({ ...msg, role, content: typeof content === 'string' ? content : content === undefined ? '' : safeJson(content) });
      continue;
    }
    if (role === 'assistant') {
      const parts: Record<string, unknown>[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      for (const b of content) {
        if (!isObj(b)) continue;
        if (b.type === 'text') parts.push(withCache({ type: 'text', text: str(b.text) }, b));
        else if (b.type === 'tool_use') toolCalls.push({ id: str(b.id), type: 'function', function: { name: str(b.name), arguments: typeof b.input === 'string' ? b.input : safeJson(b.input ?? {}) } });
        else parts.push({ type: '_vg_opaque', block: b });
      }
      const m: Record<string, unknown> = { role: 'assistant', content: parts.length === 0 ? null : parts.length === 1 && parts[0].type === 'text' && !parts[0].cache_control ? parts[0].text : parts };
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
      continue;
    }
    // user: text parts stay together; each tool_result becomes a tool message (order preserved).
    let pending: Record<string, unknown>[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      out.push({ role: 'user', content: pending.length === 1 && pending[0].type === 'text' && !pending[0].cache_control ? pending[0].text : pending });
      pending = [];
    };
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === 'tool_result') {
        flush();
        const inner = b.content;
        const m: Record<string, unknown> = { role: 'tool', tool_call_id: str(b.tool_use_id) };
        if (typeof inner === 'string') m.content = inner;
        else if (Array.isArray(inner)) m.content = inner.map((x) => (isObj(x) && x.type === 'text' ? withCache({ type: 'text', text: str(x.text) }, x) : { type: '_vg_opaque', block: x }));
        else m.content = inner === undefined ? '' : safeJson(inner);
        if (b.is_error === true) m._vg_is_error = true;
        withCache(m, b);
        out.push(m);
      } else if (b.type === 'text') pending.push(withCache({ type: 'text', text: str(b.text) }, b));
      else if (b.type === 'image' && isObj(b.source)) {
        const src = b.source;
        const url = src.type === 'base64' ? `data:${str(src.media_type)};base64,${str(src.data)}` : str(src.url);
        pending.push(withCache({ type: 'image_url', image_url: { url }, _vg_block: b }, b));
      } else pending.push({ type: '_vg_opaque', block: b });
    }
    flush();
  }
  return out;
}

export function openAIToAnthropic(messages: Message[]): Message[] {
  const out: Message[] = [];
  const push = (role: string, blocks: Record<string, unknown>[]): void => {
    const last = out[out.length - 1];
    if (isObj(last) && last.role === role && Array.isArray(last.content)) {
      (last.content as unknown[]).push(...blocks);
      return;
    }
    out.push({ role, content: blocks });
  };
  for (const msg of messages) {
    if (!isObj(msg)) continue;
    const role = normRole(msg);
    if (role === 'system' || role === 'developer') {
      out.push({ ...msg });
      continue;
    }
    if (role === 'tool') {
      const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: str(msg.tool_call_id) };
      const c = msg.content;
      if (typeof c === 'string') block.content = c;
      else if (Array.isArray(c)) block.content = c.map((p) => (isObj(p) && p.type === '_vg_opaque' ? p.block : withCache({ type: 'text', text: isObj(p) ? str(p.text) : '' }, p)));
      else block.content = '';
      if (msg._vg_is_error === true) block.is_error = true;
      withCache(block, msg);
      push('user', [block]);
      continue;
    }
    if (role === 'assistant') {
      const blocks: Record<string, unknown>[] = [];
      const c = msg.content;
      if (typeof c === 'string' && c) blocks.push({ type: 'text', text: c });
      else if (Array.isArray(c)) for (const p of c) blocks.push(partToAnthropic(p));
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!isObj(tc)) continue;
          const fn = isObj(tc.function) ? tc.function : {};
          const parsed = tryParse(str(fn.arguments));
          blocks.push({ type: 'tool_use', id: str(tc.id), name: str(fn.name), input: parsed.ok ? parsed.value : {} });
        }
      }
      out.push({ role: 'assistant', content: blocks.length === 1 && blocks[0].type === 'text' && !blocks[0].cache_control ? blocks[0].text : blocks });
      continue;
    }
    const c = msg.content;
    if (typeof c === 'string') {
      const last = out[out.length - 1];
      if (isObj(last) && last.role === 'user' && Array.isArray(last.content)) (last.content as unknown[]).push({ type: 'text', text: c });
      else out.push({ role: 'user', content: c });
    } else if (Array.isArray(c)) push('user', c.map(partToAnthropic));
  }
  return out;
}

function partToAnthropic(p: unknown): Record<string, unknown> {
  if (!isObj(p)) return { type: 'text', text: '' };
  if (p.type === '_vg_opaque' && isObj(p.block)) return p.block;
  if (p.type === 'image_url' && isObj(p._vg_block)) return p._vg_block;
  if (p.type === 'image_url' && isObj(p.image_url)) {
    const url = str(p.image_url.url);
    const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
    return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'url', url } };
  }
  return withCache({ type: 'text', text: str(p.text) }, p);
}

export function vercelToOpenAI(messages: Message[]): Message[] {
  const out: Message[] = [];
  const names = toolNameIndex(messages);
  for (const msg of messages) {
    if (!isObj(msg)) continue;
    const role = normRole(msg);
    const c = msg.content;
    if (typeof c === 'string') {
      out.push({ role, content: c });
      continue;
    }
    const parts = Array.isArray(c) ? c : [];
    if (role === 'tool') {
      for (const p of parts) {
        if (!isObj(p) || p.type !== 'tool-result') continue;
        const view = vercelResultText(p);
        const m: Record<string, unknown> = { role: 'tool', tool_call_id: str(p.toolCallId), content: view ? view.text : '', _vg_vercel: { toolName: str(p.toolName) || names.get(str(p.toolCallId)) || '', shape: view?.shape ?? 'result-string' } };
        if (view?.isError) m._vg_is_error = true;
        out.push(m);
      }
      continue;
    }
    if (role === 'assistant') {
      const outParts: Record<string, unknown>[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      for (const p of parts) {
        if (!isObj(p)) continue;
        if (p.type === 'text') outParts.push(withCache({ type: 'text', text: str(p.text) }, p));
        else if (p.type === 'tool-call') toolCalls.push({ id: str(p.toolCallId), type: 'function', function: { name: str(p.toolName), arguments: safeJson(p.input ?? p.args ?? {}) } });
        else outParts.push({ type: '_vg_opaque', block: p });
      }
      const m: Record<string, unknown> = { role: 'assistant', content: outParts.length === 0 ? null : outParts.length === 1 && outParts[0].type === 'text' ? outParts[0].text : outParts };
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
      continue;
    }
    const outParts: Record<string, unknown>[] = [];
    for (const p of parts) {
      if (!isObj(p)) continue;
      if (p.type === 'text') outParts.push(withCache({ type: 'text', text: str(p.text) }, p));
      else if (p.type === 'image') outParts.push({ type: 'image_url', image_url: { url: p.image instanceof URL ? p.image.toString() : typeof p.image === 'string' ? p.image : '' }, _vg_block: p });
      else outParts.push({ type: '_vg_opaque', block: p });
    }
    out.push({ role, content: outParts.length === 1 && outParts[0].type === 'text' ? outParts[0].text : outParts });
  }
  return out;
}

export function openAIToVercel(messages: Message[]): Message[] {
  const out: Message[] = [];
  const names = toolNameIndex(messages);
  for (const msg of messages) {
    if (!isObj(msg)) continue;
    const role = normRole(msg);
    if (role === 'tool') {
      const meta = isObj(msg._vg_vercel) ? msg._vg_vercel : {};
      const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? (textOfInnerBlocks(msg.content) ?? '') : '';
      const parsed = tryParse(text);
      const shape = str(meta.shape);
      const isError = msg._vg_is_error === true;
      let output: unknown;
      if (shape === 'output-json' && parsed.ok) output = { type: 'json', value: parsed.value };
      else if (shape === 'result-json' && parsed.ok) output = { type: 'json', value: parsed.value };
      else output = { type: isError ? 'error-text' : 'text', value: text };
      out.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: str(msg.tool_call_id), toolName: str(meta.toolName) || names.get(str(msg.tool_call_id)) || '', output }] });
      continue;
    }
    if (role === 'assistant') {
      const parts: Record<string, unknown>[] = [];
      const c = msg.content;
      if (typeof c === 'string' && c) parts.push({ type: 'text', text: c });
      else if (Array.isArray(c)) for (const p of c) parts.push(isObj(p) && p.type === '_vg_opaque' && isObj(p.block) ? p.block : withCache({ type: 'text', text: isObj(p) ? str(p.text) : '' }, p));
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!isObj(tc)) continue;
          const fn = isObj(tc.function) ? tc.function : {};
          const parsed = tryParse(str(fn.arguments));
          parts.push({ type: 'tool-call', toolCallId: str(tc.id), toolName: str(fn.name), input: parsed.ok ? parsed.value : {} });
        }
      }
      out.push({ role: 'assistant', content: parts });
      continue;
    }
    const c = msg.content;
    if (typeof c === 'string') out.push({ role, content: role === 'system' ? c : [{ type: 'text', text: c }] });
    else if (Array.isArray(c)) {
      out.push({
        role,
        content: c.map((p) => {
          if (!isObj(p)) return { type: 'text', text: '' };
          if (p.type === '_vg_opaque' && isObj(p.block)) return p.block;
          if (p.type === 'image_url' && isObj(p._vg_block)) return p._vg_block;
          if (p.type === 'image_url' && isObj(p.image_url)) return { type: 'image', image: str(p.image_url.url) };
          return withCache({ type: 'text', text: str(p.text) }, p);
        }),
      });
    }
  }
  return out;
}

export function geminiToOpenAI(messages: Message[]): Message[] {
  const out: Message[] = [];
  let callSeq = 0;
  for (const msg of messages) {
    if (!isObj(msg)) continue;
    const role = normRole(msg);
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    if (role === 'assistant') {
      const texts: Record<string, unknown>[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      for (const p of parts) {
        if (!isObj(p)) continue;
        if (typeof p.text === 'string') texts.push({ type: 'text', text: p.text });
        else if (isObj(p.functionCall)) {
          callSeq += 1;
          const fc = p.functionCall;
          toolCalls.push({ id: str(fc.id) || `gemini_${str(fc.name)}_${callSeq}`, type: 'function', function: { name: str(fc.name), arguments: safeJson(fc.args ?? {}) } });
        } else texts.push({ type: '_vg_opaque', block: p });
      }
      const m: Record<string, unknown> = { role: 'assistant', content: texts.length === 0 ? null : texts.length === 1 && texts[0].type === 'text' ? texts[0].text : texts };
      if (toolCalls.length) m.tool_calls = toolCalls;
      out.push(m);
      continue;
    }
    let pending: Record<string, unknown>[] = [];
    const flush = (): void => {
      if (!pending.length) return;
      out.push({ role: 'user', content: pending.length === 1 && pending[0].type === 'text' ? pending[0].text : pending });
      pending = [];
    };
    for (const p of parts) {
      if (!isObj(p)) continue;
      if (typeof p.text === 'string') pending.push({ type: 'text', text: p.text });
      else if (isObj(p.functionResponse)) {
        flush();
        const fr = p.functionResponse;
        const view = geminiResponseText(fr.response);
        out.push({ role: 'tool', tool_call_id: str(fr.id) || str(fr.name), content: view.text, _vg_gemini: { name: str(fr.name), id: str(fr.id), shape: view.shape, wrapKey: view.wrapKey } });
      } else pending.push({ type: '_vg_opaque', block: p });
    }
    flush();
  }
  return out;
}

export function openAIToGemini(messages: Message[]): Message[] {
  const out: Message[] = [];
  const names = toolNameIndex(messages);
  for (const msg of messages) {
    if (!isObj(msg)) continue;
    const role = normRole(msg);
    if (role === 'tool') {
      const meta = isObj(msg._vg_gemini) ? msg._vg_gemini : {};
      const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? (textOfInnerBlocks(msg.content) ?? '') : '';
      const parsed = tryParse(text);
      const shape = str(meta.shape);
      let response: unknown;
      if (shape === 'string') response = text;
      else if (shape === 'wrapped') response = { [str(meta.wrapKey) || 'content']: text };
      else response = parsed.ok && isObj(parsed.value) ? parsed.value : { content: text };
      const fr: Record<string, unknown> = { name: str(meta.name) || names.get(str(msg.tool_call_id)) || str(msg.tool_call_id).replace(/^gemini_/, '').replace(/_\d+$/, ''), response };
      if (str(meta.id)) fr.id = meta.id;
      out.push({ role: 'user', parts: [{ functionResponse: fr }] });
      continue;
    }
    const parts: Record<string, unknown>[] = [];
    const c = msg.content;
    if (typeof c === 'string') parts.push({ text: c });
    else if (Array.isArray(c)) for (const p of c) parts.push(isObj(p) && p.type === '_vg_opaque' && isObj(p.block) ? p.block : { text: isObj(p) ? str(p.text) : '' });
    if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!isObj(tc)) continue;
        const fn = isObj(tc.function) ? tc.function : {};
        const parsed = tryParse(str(fn.arguments));
        const fc: Record<string, unknown> = { name: str(fn.name), args: parsed.ok ? parsed.value : {} };
        if (typeof tc.id === 'string' && !tc.id.startsWith('gemini_')) fc.id = tc.id;
        parts.push({ functionCall: fc });
      }
    }
    out.push({ role: role === 'assistant' ? 'model' : 'user', parts });
  }
  return out;
}

export function responsesToOpenAI(items: Message[]): Message[] {
  const out: Message[] = [];
  for (const item of items) {
    if (!isObj(item)) continue;
    const t = str(item.type);
    if (t === 'function_call') {
      const call = { id: str(item.call_id) || str(item.id), type: 'function', function: { name: str(item.name), arguments: str(item.arguments) } };
      const last = out[out.length - 1];
      if (isObj(last) && last.role === 'assistant' && Array.isArray(last.tool_calls) && last._vg_responses_calls === true) (last.tool_calls as unknown[]).push(call);
      else out.push({ role: 'assistant', content: null, tool_calls: [call], _vg_responses_calls: true });
      continue;
    }
    if (t === 'function_call_output') {
      const o = item.output;
      out.push({ role: 'tool', tool_call_id: str(item.call_id), content: typeof o === 'string' ? o : Array.isArray(o) ? o.map((x) => (isObj(x) && typeof x.text === 'string' ? { type: 'text', text: x.text } : { type: '_vg_opaque', block: x })) : safeJson(o) });
      continue;
    }
    if (t && t !== 'message') {
      out.push({ role: 'assistant', content: [{ type: '_vg_opaque', block: item }], _vg_responses_item: true });
      continue;
    }
    const role = normRole(item);
    const c = item.content;
    if (typeof c === 'string') out.push({ role, content: c });
    else if (Array.isArray(c)) out.push({ role, content: c.map((p) => (isObj(p) && typeof p.text === 'string' ? { type: 'text', text: p.text, _vg_part_type: str(p.type) } : { type: '_vg_opaque', block: p })) });
  }
  return out;
}

export function openAIToResponses(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const msg of messages) {
    if (!isObj(msg)) continue;
    const role = normRole(msg);
    if (role === 'tool') {
      const c = msg.content;
      out.push({ type: 'function_call_output', call_id: str(msg.tool_call_id), output: typeof c === 'string' ? c : Array.isArray(c) ? (textOfInnerBlocks(c) ?? safeJson(c)) : '' });
      continue;
    }
    if (msg._vg_responses_item === true && Array.isArray(msg.content) && isObj(msg.content[0]) && isObj((msg.content[0] as Record<string, unknown>).block)) {
      out.push((msg.content[0] as Record<string, unknown>).block as Message);
      continue;
    }
    const c = msg.content;
    if (typeof c === 'string' && c) out.push({ type: 'message', role, content: role === 'assistant' ? [{ type: 'output_text', text: c }] : c });
    else if (Array.isArray(c) && c.length) {
      out.push({
        type: 'message',
        role,
        content: c.map((p) => {
          if (!isObj(p)) return { type: role === 'assistant' ? 'output_text' : 'input_text', text: '' };
          if (p.type === '_vg_opaque' && isObj(p.block)) return p.block;
          return { type: str(p._vg_part_type) || (role === 'assistant' ? 'output_text' : 'input_text'), text: str(p.text) };
        }),
      });
    }
    if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!isObj(tc)) continue;
        const fn = isObj(tc.function) ? tc.function : {};
        out.push({ type: 'function_call', call_id: str(tc.id), name: str(fn.name), arguments: str(fn.arguments) });
      }
    }
  }
  return out;
}
