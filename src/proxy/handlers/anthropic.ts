/**
 * Anthropic Messages API adapter for the shared chat lifecycle.
 */

import type { Message } from '../../compress/types.js';
import type { ProviderUsage } from '../cost.js';
import type { ProxyDeps } from '../deps.js';
import type { FormatAdapter } from './chat.js';

function usageOf(json: Record<string, unknown> | null): ProviderUsage {
  const u = (json?.usage as Record<string, unknown>) ?? {};
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cache_read_input_tokens), cacheWriteTokens: num(u.cache_creation_input_tokens) };
}

export const anthropicAdapter: FormatAdapter = {
  format: 'anthropic',
  provider: 'anthropic',
  errorFormat: 'anthropic',
  getMessages: (body) => (Array.isArray(body.messages) ? (body.messages as Message[]) : []),
  setMessages: (body, m) => {
    body.messages = m;
  },
  getTools: (body) => (Array.isArray(body.tools) ? (body.tools as unknown[]) : undefined),
  setTools: (body, t) => {
    if (t && t.length) body.tools = t;
    else delete body.tools;
  },
  systemText: (body) => (typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? (body.system as Array<Record<string, unknown>>).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n') : ''),
  appendSystem: (body, text) => {
    if (body.system === undefined || body.system === null) body.system = [{ type: 'text', text }];
    else if (typeof body.system === 'string') body.system = [{ type: 'text', text: body.system }, { type: 'text', text }];
    else if (Array.isArray(body.system)) (body.system as unknown[]).push({ type: 'text', text });
  },
  appendToLatestUser: (messages, text) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string') m.content = `${m.content}\n\n${text}`;
      else if (Array.isArray(m.content)) (m.content as unknown[]).push({ type: 'text', text });
      else continue;
      return true;
    }
    return false;
  },
  latestUserText: (messages) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        const texts = (m.content as Array<Record<string, unknown>>).filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string);
        if (texts.length) return texts.join('\n');
      }
    }
    return '';
  },
  isStream: (body) => body.stream === true,
  setStream: (body, on) => {
    body.stream = on;
  },
  reconstruct: (deps: ProxyDeps, events) => deps.reconstructAnthropic(events),
  usageOf,
  outputText: (json) => {
    const content = json?.content;
    if (!Array.isArray(content)) return '';
    return (content as Array<Record<string, unknown>>).map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  },
  isErrorResponse: (json) => json?.type === 'error',
  historyReferencesTool: (messages, name) => {
    for (const m of messages) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      for (const b of m.content as Array<Record<string, unknown>>) if (b && b.type === 'tool_use' && b.name === name) return true;
    }
    return false;
  },
};
