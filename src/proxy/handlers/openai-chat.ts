/**
 * OpenAI Chat Completions adapter for the shared chat lifecycle.
 */

import type { Message } from '../../compress/types.js';
import type { ProviderUsage } from '../cost.js';
import type { ProxyDeps } from '../deps.js';
import type { FormatAdapter } from './chat.js';

function usageOf(json: Record<string, unknown> | null): ProviderUsage {
  const u = (json?.usage as Record<string, unknown>) ?? {};
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const details = (u.prompt_tokens_details as Record<string, unknown>) ?? {};
  const prompt = num(u.prompt_tokens);
  const cached = num(details.cached_tokens);
  // OpenAI reports no write counter; the uncached slice stands in (inferred).
  return { inputTokens: prompt !== undefined && cached !== undefined ? Math.max(0, prompt - cached) : prompt, outputTokens: num(u.completion_tokens), cacheReadTokens: cached, cacheWriteTokens: prompt !== undefined && cached !== undefined ? Math.max(0, prompt - cached) : undefined, cacheInferred: true };
}

export const openAIChatAdapter: FormatAdapter = {
  format: 'openai',
  provider: 'openai',
  errorFormat: 'openai',
  getMessages: (body) => (Array.isArray(body.messages) ? (body.messages as Message[]) : []),
  setMessages: (body, m) => {
    body.messages = m;
  },
  getTools: (body) => (Array.isArray(body.tools) ? (body.tools as unknown[]) : undefined),
  setTools: (body, t) => {
    if (t && t.length) body.tools = t;
    else delete body.tools;
  },
  systemText: (body) => (Array.isArray(body.messages) ? (body.messages as Message[]).filter((m) => m.role === 'system' || m.role === 'developer').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n') : ''),
  appendSystem: (body, text) => {
    const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : (body.messages = []);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'system' || m.role === 'developer') {
        if (typeof m.content === 'string') m.content = `${m.content}\n\n${text}`;
        else if (Array.isArray(m.content)) (m.content as unknown[]).push({ type: 'text', text });
        else m.content = text;
        return;
      }
    }
    (messages as Message[]).unshift({ role: 'system', content: text });
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
      if (Array.isArray(m.content)) return (m.content as Array<Record<string, unknown>>).map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
    }
    return '';
  },
  isStream: (body) => body.stream === true,
  setStream: (body, on) => {
    body.stream = on;
    if (!on) delete body.stream_options;
  },
  reconstruct: (deps: ProxyDeps, events) => deps.reconstructOpenAIChat(events),
  usageOf,
  outputText: (json) => {
    const choices = json?.choices;
    if (!Array.isArray(choices)) return '';
    return (choices as Array<Record<string, unknown>>).map((c) => {
      const msg = c.message as Record<string, unknown> | undefined;
      return typeof msg?.content === 'string' ? msg.content : '';
    }).join('');
  },
  isErrorResponse: (json) => !!json && typeof json === 'object' && 'error' in json && !('choices' in json),
  historyReferencesTool: (messages, name) => {
    for (const m of messages) {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn?.name === name) return true;
      }
    }
    return false;
  },
};
