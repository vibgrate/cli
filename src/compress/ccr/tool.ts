/**
 * The `vg_retrieve` tool: schemas per provider shape and the injection policy.
 *
 * Injection is sticky-friendly: once a session has advertised the tool the
 * caller keeps passing `sticky: true`, so the tool list (the head of the
 * provider's prompt-cache key) stops toggling between turns. A tool of the
 * same name already present (an MCP registration) always wins.
 */

import type { MessageFormat } from '../types.js';
import { extractHashes } from './markers.js';
import { walkTextBlocks } from '../format.js';
import type { Message } from '../types.js';

export const RETRIEVE_TOOL_NAME = 'vg_retrieve';

const DESCRIPTION =
  'Retrieve the original, uncompressed content behind a compression marker. Use it when a compressed tool result does not show enough. ' +
  'The hash appears in markers like <<vg-ccr:HASH …>> or "Retrieve original: hash=HASH". Narrow large originals with grep, lines, head or tail.';

const SHORT_DESCRIPTION = 'Retrieve the original, uncompressed content behind a compression marker when the compressed tool result does not show enough.';

function parameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      hash: { type: 'string', description: 'Hash from the compression marker (12 or 24 hex chars).' },
      grep: { type: 'string', description: 'Optional: return only lines containing this text (case-insensitive), prefixed with line numbers.' },
      lines: { type: 'string', description: 'Optional: 1-based inclusive line range, e.g. "120-180".' },
      head: { type: 'integer', description: 'Optional: return only the first N lines.' },
      tail: { type: 'integer', description: 'Optional: return only the last N lines.' },
      json_path: { type: 'string', description: 'Optional: dotted path into a JSON original, e.g. "items[3].name".' },
      max_tokens: { type: 'integer', description: 'Optional: cap the returned content at this many tokens.' },
    },
    required: ['hash'],
  };
}

/** OpenAI chat-completions function tool. */
export function retrieveToolOpenAI(): Record<string, unknown> {
  return { type: 'function', function: { name: RETRIEVE_TOOL_NAME, description: DESCRIPTION, parameters: parameters() } };
}

/** Anthropic messages tool. */
export function retrieveToolAnthropic(): Record<string, unknown> {
  return { name: RETRIEVE_TOOL_NAME, description: DESCRIPTION, input_schema: parameters() };
}

/** OpenAI Responses API function tool (flat shape). */
export function retrieveToolResponses(): Record<string, unknown> {
  return { type: 'function', name: RETRIEVE_TOOL_NAME, description: DESCRIPTION, parameters: parameters() };
}

/** Gemini function declaration (shorter description, no marker example). */
export function retrieveToolGemini(): Record<string, unknown> {
  const p = parameters() as { properties: Record<string, { type: string; description: string }>; required: string[]; type: string };
  p.properties.hash.description = 'Hash from the compression marker';
  return { name: RETRIEVE_TOOL_NAME, description: SHORT_DESCRIPTION, parameters: p };
}

export function retrieveToolFor(format: MessageFormat): Record<string, unknown> {
  switch (format) {
    case 'anthropic':
      return retrieveToolAnthropic();
    case 'responses':
      return retrieveToolResponses();
    case 'gemini':
      return retrieveToolGemini();
    default:
      return retrieveToolOpenAI();
  }
}

export function isRetrieveToolCall(name: string): boolean {
  return typeof name === 'string' && name === RETRIEVE_TOOL_NAME;
}

function toolNameOf(tool: unknown): string {
  if (!tool || typeof tool !== 'object') return '';
  const t = tool as Record<string, unknown>;
  if (typeof t.name === 'string') return t.name;
  const fn = t.function;
  if (fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string') return (fn as Record<string, unknown>).name as string;
  return '';
}

/** True when a tool list already advertises `vg_retrieve` (any shape, incl. Gemini functionDeclarations). */
export function hasRetrieveTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  for (const t of tools) {
    if (toolNameOf(t) === RETRIEVE_TOOL_NAME) return true;
    if (t && typeof t === 'object' && Array.isArray((t as Record<string, unknown>).functionDeclarations)) {
      for (const d of (t as Record<string, unknown>).functionDeclarations as unknown[]) if (toolNameOf(d) === RETRIEVE_TOOL_NAME) return true;
    }
  }
  return false;
}

/** Whether a request's messages carry any retrieval marker (`hasMarkers` input for `injectRetrieveTool`). */
export function messagesHaveMarkers(messages: Message[]): boolean {
  let found = false;
  walkTextBlocks(messages, (b) => {
    if (!found && extractHashes(b.text).length > 0) found = true;
  });
  return found;
}

/** Whether earlier turns already reference the retrieve tool (dropping it then is a provider 400). */
export function historyReferencesRetrieveTool(messages: Message[]): boolean {
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as Record<string, unknown>;
    if (Array.isArray(msg.tool_calls)) for (const tc of msg.tool_calls) if (toolNameOf(tc) === RETRIEVE_TOOL_NAME) return true;
    if (msg.type === 'function_call' && msg.name === RETRIEVE_TOOL_NAME) return true;
    if (Array.isArray(msg.content)) for (const b of msg.content) if (b && typeof b === 'object' && ((b as Record<string, unknown>).type === 'tool_use' || (b as Record<string, unknown>).type === 'tool-call') && toolNameOf(b) === RETRIEVE_TOOL_NAME) return true;
    if (Array.isArray(msg.parts)) for (const p of msg.parts) if (p && typeof p === 'object' && toolNameOf((p as Record<string, unknown>).functionCall) === RETRIEVE_TOOL_NAME) return true;
  }
  return false;
}

/**
 * Add the retrieve tool to a request body when markers are present (or the
 * session is sticky). Returns a new body; the input is never mutated.
 */
export function injectRetrieveTool(body: Record<string, unknown>, format: MessageFormat, opts: { sticky?: boolean; hasMarkers: boolean } = { hasMarkers: false }): { body: Record<string, unknown>; injected: boolean } {
  if (hasRetrieveTool(body.tools)) return { body, injected: false };
  if (!opts.hasMarkers && !opts.sticky) return { body, injected: false };
  const tool = retrieveToolFor(format);
  if (format === 'gemini') {
    const tools = Array.isArray(body.tools) ? [...(body.tools as unknown[])] : [];
    const idx = tools.findIndex((t) => t && typeof t === 'object' && Array.isArray((t as Record<string, unknown>).functionDeclarations));
    if (idx >= 0) {
      const decl = tools[idx] as Record<string, unknown>;
      tools[idx] = { ...decl, functionDeclarations: [...(decl.functionDeclarations as unknown[]), tool] };
    } else tools.push({ functionDeclarations: [tool] });
    return { body: { ...body, tools }, injected: true };
  }
  const tools = Array.isArray(body.tools) ? [...(body.tools as unknown[]), tool] : [tool];
  return { body: { ...body, tools }, injected: true };
}

/**
 * Canonical bytes of the tool definition. Callers that pin the definition per
 * session replay these exact bytes so the provider cache key never drifts.
 */
export function retrieveToolGoldenBytes(format: MessageFormat): string {
  return JSON.stringify(retrieveToolFor(format));
}
