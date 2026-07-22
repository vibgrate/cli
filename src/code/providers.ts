/**
 * Model backends for `vg code` (VG-CLI-CODE §5).
 *
 * Every backend implements the same {@link Provider} contract, so the router and
 * session are provider-agnostic. Three families:
 *   - **local HTTP** — Ollama and LM Studio, reached over `fetch` on localhost;
 *     no package, no key, no egress. Selected under `--local`.
 *   - **hosted HTTP** — any OpenAI-compatible endpoint (OpenRouter, LiteLLM,
 *     Together, a self-hosted gateway, …). One shape covers the "best in breed
 *     router" story: an ordered model list with automatic fallback lives in the
 *     router, not here. Keys come from the environment only and are never logged.
 *   - **local inference** — a llama.cpp binding loaded on demand via
 *     {@link ensurePackage}; this is the one path that may install a package on
 *     first use, and only with consent. Model weights are never auto-downloaded.
 *
 * A deterministic {@link MockProvider} backs the tests, the offline benchmark,
 * and the `--mock` flag, so the whole loop runs end-to-end with no network.
 */

import { ensurePackage, ensureUnavailableMessage } from './ensure.js';
import type { ChatMessage, ChatOptions, Provider, ProviderResult, ToolCall, ToolSpec } from './types.js';

/* ------------------------------------------------------------------ *\
 *  Tool-calling wire helpers (shared by the HTTP providers)
\* ------------------------------------------------------------------ */

/** Map our ChatMessage union to OpenAI-compatible wire messages (tool calls included). */
function openAiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments) } })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** OpenAI-compatible `tools` array from our specs. */
function openAiTools(tools: ToolSpec[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Parse OpenAI-shaped tool_calls, tolerating a malformed arguments string. */
function parseToolCalls(raw: unknown, synthesizePrefix = 'call'): ToolCall[] {
  const calls = raw as { id?: string; function?: { name?: string; arguments?: unknown } }[] | undefined;
  if (!Array.isArray(calls)) return [];
  return calls.map((c, i) => ({
    id: typeof c.id === 'string' && c.id ? c.id : `${synthesizePrefix}_${i}`,
    name: c.function?.name ?? 'unknown',
    arguments: coerceArgs(c.function?.arguments),
  }));
}

function coerceArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Redact anything that looks like a credential before it can reach a log/error. */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(sk|xoxb|ghp|gho|glpat|AKIA)[-_][A-Za-z0-9-_]{6,}/g, '$1-***redacted***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***redacted***');
}

/** Common HTTP-completion error shaping: actionable, internals-free (GUARDRAILS §1.3). */
function httpError(label: string, status: number, hint: string): Error {
  return new Error(`${label} returned HTTP ${status} — ${hint}`);
}

/** Yield newline-delimited lines from a streamed response body. */
async function* streamLines(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

/** Accumulate an OpenAI-compatible SSE stream into text + tool calls + usage. */
export function accumulateOpenAiDelta(
  acc: { text: string; tools: Map<number, { id?: string; name?: string; args: string }>; usage: { promptTokens?: number; completionTokens?: number } },
  chunk: unknown,
  onToken?: (t: string) => void,
): void {
  const c = chunk as { choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const delta = c.choices?.[0]?.delta;
  if (delta?.content) {
    acc.text += delta.content;
    onToken?.(delta.content);
  }
  for (const tc of delta?.tool_calls ?? []) {
    const idx = tc.index ?? 0;
    const e = acc.tools.get(idx) ?? { args: '' };
    if (tc.id) e.id = tc.id;
    if (tc.function?.name) e.name = tc.function.name;
    if (tc.function?.arguments) e.args += tc.function.arguments;
    acc.tools.set(idx, e);
  }
  if (c.usage) {
    acc.usage.promptTokens = c.usage.prompt_tokens;
    acc.usage.completionTokens = c.usage.completion_tokens;
  }
}

/** Turn accumulated OpenAI tool-call fragments into ToolCalls. */
function finalizeTools(tools: Map<number, { id?: string; name?: string; args: string }>): ToolCall[] {
  return [...tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, e]) => ({ id: e.id ?? `call_${i}`, name: e.name ?? 'unknown', arguments: coerceArgs(e.args) }));
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *\
 *  Deterministic mock (tests / offline / --mock)
\* ------------------------------------------------------------------ */

/**
 * A provider that returns a fixed, scripted reply — the deterministic floor that
 * lets the entire `vg code` loop run offline. Used by tests, the benchmark, and
 * the `--mock` flag (which reads the scripted edit blocks from a file).
 */
export class MockProvider implements Provider {
  readonly id = 'mock';
  readonly label = 'Mock (deterministic)';
  readonly local = true;
  constructor(
    readonly model: string,
    private readonly reply: string,
  ) {}
  async chat(_messages?: ChatMessage[], _opts?: ChatOptions): Promise<ProviderResult> {
    return { text: this.reply, model: this.model, provider: this.id };
  }
}

/* ------------------------------------------------------------------ *\
 *  Ollama (local, no key)
\* ------------------------------------------------------------------ */

export class OllamaProvider implements Provider {
  readonly id = 'ollama';
  readonly label = 'Ollama (local)';
  readonly local = true;
  constructor(
    readonly model: string,
    private readonly host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  ) {}
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ProviderResult> {
    const streaming = !!(opts.stream && opts.onToken);
    let res: Response;
    try {
      res = await postJson(
        `${this.host.replace(/\/$/, '')}/api/chat`,
        { model: this.model, messages: openAiMessages(messages), stream: streaming, tools: openAiTools(opts.tools), options: { temperature: opts.temperature ?? 0 } },
        {},
        opts.timeoutMs ?? 120_000,
      );
    } catch {
      throw new Error(`couldn't reach Ollama at ${this.host} — is \`ollama serve\` running? (start it, or pass --provider to use a different backend)`);
    }
    if (!res.ok) throw httpError('Ollama', res.status, res.status === 404 ? `model "${this.model}" isn't pulled — run \`ollama pull ${this.model}\` or pick another with --model` : 'check `ollama serve` and the model name');

    if (streaming) {
      let text = '';
      let toolCallsRaw: unknown;
      const usage: { promptTokens?: number; completionTokens?: number } = {};
      for await (const line of streamLines(res)) {
        try {
          const obj = JSON.parse(line) as { message?: { content?: string; tool_calls?: unknown }; prompt_eval_count?: number; eval_count?: number };
          const delta = obj.message?.content;
          if (delta) {
            text += delta;
            opts.onToken?.(delta);
          }
          if (obj.message?.tool_calls) toolCallsRaw = obj.message.tool_calls;
          if (typeof obj.prompt_eval_count === 'number') usage.promptTokens = obj.prompt_eval_count;
          if (typeof obj.eval_count === 'number') usage.completionTokens = obj.eval_count;
        } catch {
          /* skip a malformed line */
        }
      }
      return { text, model: this.model, provider: this.id, toolCalls: parseToolCalls(toolCallsRaw), usage };
    }

    const data = (await res.json()) as { message?: { content?: string; tool_calls?: unknown }; prompt_eval_count?: number; eval_count?: number };
    return {
      text: data.message?.content ?? '',
      model: this.model,
      provider: this.id,
      toolCalls: parseToolCalls(data.message?.tool_calls),
      usage: { promptTokens: data.prompt_eval_count, completionTokens: data.eval_count },
    };
  }
}

/* ------------------------------------------------------------------ *\
 *  OpenAI-compatible (LM Studio, OpenRouter, LiteLLM, …)
\* ------------------------------------------------------------------ */

export interface OpenAiCompatibleConfig {
  /** Base URL, e.g. `https://openrouter.ai/api/v1` or `http://127.0.0.1:1234/v1`. */
  baseUrl: string;
  /** Env var name holding the API key (never the key itself). Absent for local. */
  apiKeyEnv?: string;
  /** Whether this endpoint is on-device (LM Studio) vs hosted. */
  local: boolean;
  /** Display label. */
  label: string;
  id: string;
}

export class OpenAiCompatibleProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly local: boolean;
  constructor(
    readonly model: string,
    private readonly config: OpenAiCompatibleConfig,
  ) {
    this.id = config.id;
    this.label = config.label;
    this.local = config.local;
  }
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ProviderResult> {
    const headers: Record<string, string> = {};
    if (this.config.apiKeyEnv) {
      const key = process.env[this.config.apiKeyEnv];
      if (!key) {
        throw new Error(`${this.label} needs an API key in ${this.config.apiKeyEnv} — set it in your environment (never pass keys as flags), or use --local for an on-device backend.`);
      }
      headers.authorization = `Bearer ${key}`;
    }
    const streaming = !!(opts.stream && opts.onToken);
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: this.model,
      messages: openAiMessages(messages),
      tools: openAiTools(opts.tools),
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens,
      stream: streaming,
      ...(streaming ? { stream_options: { include_usage: true } } : {}),
    };
    let res: Response;
    try {
      res = await postJson(url, body, headers, opts.timeoutMs ?? 120_000);
    } catch {
      throw new Error(`couldn't reach ${this.label} at ${this.config.baseUrl} — check the endpoint is up (or use --local).`);
    }
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? `the key in ${this.config.apiKeyEnv ?? '(none)'} was rejected — check it has access to "${this.model}"` : `check the model id "${this.model}" and the endpoint`;
      throw httpError(this.label, res.status, hint);
    }

    if (streaming) {
      const acc = { text: '', tools: new Map<number, { id?: string; name?: string; args: string }>(), usage: {} as { promptTokens?: number; completionTokens?: number } };
      for await (const line of streamLines(res)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') break;
        try {
          accumulateOpenAiDelta(acc, JSON.parse(payload), opts.onToken);
        } catch {
          /* skip a malformed chunk */
        }
      }
      const tools = finalizeTools(acc.tools);
      return { text: acc.text, model: this.model, provider: this.id, toolCalls: tools.length ? tools : undefined, usage: acc.usage };
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string; tool_calls?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const message = data.choices?.[0]?.message;
    return {
      text: message?.content ?? '',
      model: this.model,
      provider: this.id,
      toolCalls: parseToolCalls(message?.tool_calls),
      usage: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens },
    };
  }
}

/* ------------------------------------------------------------------ *\
 *  Scripted provider (agent-loop tests / offline demos)
\* ------------------------------------------------------------------ */

/**
 * Returns a queued sequence of {@link ProviderResult}s — one per turn — so the
 * agentic loop can be driven deterministically offline: script the tool calls
 * the "model" makes (read → search → edit → run → finish) and assert what the
 * agent did. Ignores the incoming messages by design.
 */
export class ScriptedProvider implements Provider {
  readonly id = 'scripted';
  readonly label = 'Scripted (deterministic)';
  readonly local = true;
  private turn = 0;
  constructor(
    readonly model: string,
    private readonly steps: Array<{ text?: string; toolCalls?: ToolCall[] }>,
  ) {}
  async chat(): Promise<ProviderResult> {
    const step = this.steps[Math.min(this.turn, this.steps.length - 1)];
    this.turn++;
    return { text: step.text ?? '', model: this.model, provider: this.id, toolCalls: step.toolCalls };
  }
}

/** The catalogue of known OpenAI-compatible endpoints, keyed by short id. */
export const OPENAI_COMPATIBLE: Record<string, Omit<OpenAiCompatibleConfig, 'label' | 'id'> & { label: string }> = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', local: false, label: 'OpenRouter' },
  litellm: { baseUrl: process.env.LITELLM_BASE_URL || 'http://127.0.0.1:4000', apiKeyEnv: 'LITELLM_API_KEY', local: false, label: 'LiteLLM' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', local: false, label: 'OpenAI' },
  together: { baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY', local: false, label: 'Together' },
  lmstudio: { baseUrl: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1', local: true, label: 'LM Studio (local)' },
};

/* ------------------------------------------------------------------ *\
 *  Local llama.cpp (installs a package on first use, with consent)
\* ------------------------------------------------------------------ */

/**
 * A fully-local inference backend backed by `node-llama-cpp`. This is the one
 * provider that may install a package on first use — and only through
 * {@link ensurePackage} (consent-gated, never under `--local`/offline, never
 * bundled). Model *weights* are never fetched automatically: `modelPath` must
 * point at a gguf the user already has (see `vg models`). When the runtime
 * isn't available it degrades with an actionable note rather than throwing.
 */
export class LocalLlamaProvider implements Provider {
  readonly id = 'llama-cpp';
  readonly label = 'llama.cpp (local)';
  readonly local = true;
  private session: unknown | null = null;
  constructor(
    readonly model: string,
    private readonly modelPath: string,
    private readonly ensure: typeof ensurePackage = ensurePackage,
    private readonly consent = false,
  ) {}
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ProviderResult> {
    const res = await this.ensure('node-llama-cpp@^3', { consent: this.consent, onUnavailable: () => {} });
    if (!res.module) {
      throw new Error(ensureUnavailableMessage(res.reason ?? 'no-consent', 'node-llama-cpp'));
    }
    // The concrete llama binding call is intentionally isolated here; the rest of
    // the subsystem never depends on it. Kept minimal and defensive.
    const lib: any = res.module;
    try {
      const llama = await lib.getLlama();
      const model = await llama.loadModel({ modelPath: this.modelPath });
      const ctx = await model.createContext();
      const { LlamaChatSession } = lib;
      const chat = new LlamaChatSession({ contextSequence: ctx.getSequence() });
      const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
      const text: string = await chat.prompt(prompt, { temperature: opts.temperature ?? 0, maxTokens: opts.maxTokens });
      return { text, model: this.model, provider: this.id };
    } catch (e) {
      throw new Error(`local llama.cpp inference failed for ${this.modelPath} — ${redactSecrets((e as Error).message)}`);
    }
  }
}
