/**
 * OpenAI Responses API adapter for the shared chat lifecycle. The `input`
 * field is normalized to an item list (a bare string becomes one user
 * message) so the pipeline sees a message array; `instructions` plays the
 * role of the system prompt.
 */

import type { Message } from '../../compress/types.js';
import type { ProviderUsage } from '../cost.js';
import type { ProxyDeps } from '../deps.js';
import type { FormatAdapter } from './chat.js';

function usageOf(json: Record<string, unknown> | null): ProviderUsage {
  const u = (json?.usage as Record<string, unknown>) ?? {};
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const details = (u.input_tokens_details as Record<string, unknown>) ?? {};
  const input = num(u.input_tokens);
  const cached = num(details.cached_tokens);
  return { inputTokens: input !== undefined && cached !== undefined ? Math.max(0, input - cached) : input, outputTokens: num(u.output_tokens), cacheReadTokens: cached, cacheWriteTokens: input !== undefined && cached !== undefined ? Math.max(0, input - cached) : undefined, cacheInferred: true };
}

export const openAIResponsesAdapter: FormatAdapter = {
  format: 'responses',
  provider: 'openai',
  errorFormat: 'openai',
  getMessages: (body) => {
    const input = body.input;
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    return Array.isArray(input) ? (input as Message[]) : [];
  },
  setMessages: (body, m) => {
    body.input = m;
  },
  getTools: (body) => (Array.isArray(body.tools) ? (body.tools as unknown[]) : undefined),
  setTools: (body, t) => {
    if (t && t.length) body.tools = t;
    else delete body.tools;
  },
  systemText: (body) => (typeof body.instructions === 'string' ? body.instructions : ''),
  appendSystem: (body, text) => {
    body.instructions = typeof body.instructions === 'string' && body.instructions ? `${body.instructions}\n\n${text}` : text;
  },
  appendToLatestUser: (messages, text) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string') m.content = `${m.content}\n\n${text}`;
      else if (Array.isArray(m.content)) (m.content as unknown[]).push({ type: 'input_text', text });
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
  },
  reconstruct: (deps: ProxyDeps, events) => deps.reconstructOpenAIResponses(events),
  usageOf,
  outputText: (json) => {
    const output = json?.output;
    if (!Array.isArray(output)) return typeof json?.output_text === 'string' ? json.output_text : '';
    let text = '';
    for (const it of output as Array<Record<string, unknown>>) {
      if (it?.type !== 'message' || !Array.isArray(it.content)) continue;
      for (const p of it.content as Array<Record<string, unknown>>) if (p && typeof p.text === 'string') text += p.text;
    }
    return text;
  },
  isErrorResponse: (json) => !!json && typeof json === 'object' && 'error' in json && json.error !== null && !('output' in json),
  historyReferencesTool: (messages, name) => messages.some((m) => m.type === 'function_call' && m.name === name),
};
