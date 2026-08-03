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
    // Multimodal user turn → OpenAI content-part array (text + data-URI images).
    if (m.role === 'user' && m.images?.length) {
      return {
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          ...m.images.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` },
          })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** Ollama's chat shape: images ride as a base64 array on the message itself. */
function ollamaMessages(messages: ChatMessage[]): unknown[] {
  return openAiMessages(messages).map((wire, i) => {
    const m = messages[i];
    if (m.role === 'user' && m.images?.length) {
      return { role: 'user', content: m.content, images: m.images.map((img) => img.dataBase64) };
    }
    return wire;
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

/**
 * The server's own account of what went wrong, when it gave one. An
 * OpenAI-compatible error body is `{ error: { message } }` or `{ error: '…' }`;
 * the Vibgrate Relay adds `detail` (the upstream's verbatim reason) and
 * `correlation_id`. Guessing a hint from the status code alone turns an
 * actionable "insufficient credits" or "no endpoints match your data policy"
 * into "check the model id" — so prefer the body whenever it carries text.
 * Total and defensive: any parse failure just yields null and the caller
 * falls back to its hint.
 */
/**
 * A `detail` is the upstream's verbatim reason, and upstream reasons are JSON
 * envelopes more often than sentences. Rendered as-is one fills the panel with
 * braces and then gets cut mid-token by the 400-char cap
 * (`"requested_providers":["goo`), burying the sentence that explains the
 * failure. Lift that sentence out, and spell out the provider lists a routing
 * refusal carries. Total — a non-envelope string comes back untouched, so a
 * plain-prose detail is never mangled.
 */
export function unwrapNestedErrorJson(text: string): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('{')) return trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  const obj = (parsed ?? {}) as { error?: unknown; message?: unknown };
  const err = obj.error;
  const errObj = (typeof err === 'object' && err ? err : {}) as { message?: unknown; metadata?: unknown };
  const message =
    typeof err === 'string' ? err : typeof errObj.message === 'string' ? errObj.message : typeof obj.message === 'string' ? obj.message : null;
  if (!message?.trim()) return trimmed;
  const metadata = (typeof errObj.metadata === 'object' && errObj.metadata ? errObj.metadata : {}) as {
    requested_providers?: unknown;
    available_providers?: unknown;
  };
  const names = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [];
  const requested = names(metadata.requested_providers);
  const available = names(metadata.available_providers);
  const parts = [message.trim()];
  if (requested.length) parts.push(`requested provider(s): ${requested.join(', ')}`);
  if (available.length) parts.push(`permitted provider(s): ${available.join(', ')}`);
  return parts.join(' — ');
}

export function relayErrorDetail(body: string): string | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return nonJsonErrorDetail(body);
  }
  const obj = parsed as { error?: unknown; detail?: unknown; message?: unknown; correlation_id?: unknown };
  const err = obj?.error;
  const errObj = (typeof err === 'object' && err ? err : {}) as { message?: unknown; detail?: unknown; correlation_id?: unknown };
  const message =
    typeof err === 'string'
      ? err
      : typeof errObj.message === 'string'
        ? errObj.message
        : typeof obj?.message === 'string'
          ? obj.message
          : null;
  const detailValue = typeof obj?.detail === 'string' ? obj.detail : typeof errObj.detail === 'string' ? errObj.detail : null;
  const detail = detailValue && detailValue.trim() ? unwrapNestedErrorJson(detailValue) : null;
  const parts = [message, detail].filter((p): p is string => !!p && p.trim().length > 0);
  if (!parts.length) return null;
  const correlationId = typeof obj?.correlation_id === 'string' && obj.correlation_id
    ? obj.correlation_id
    : typeof errObj.correlation_id === 'string' && errObj.correlation_id
      ? errObj.correlation_id
      : null;
  const id = correlationId ? ` (correlation id ${correlationId})` : '';
  return `${[...new Set(parts)].join(' — ').slice(0, 400)}${id}`;
}

/**
 * A non-JSON body — an HTML error page from a CDN or proxy sitting in front of
 * the endpoint, a plain-text proxy notice. A short one is still more
 * informative than nothing; a long one is noise EXCEPT for its `<title>`
 * ("502 Bad Gateway", "Worker threw exception"), which is the whole story.
 * Without that salvage the caller falls back to a status-code guess and blames
 * the model id for what is really an infrastructure failure.
 */
function nonJsonErrorDetail(body: string): string | null {
  const text = body.trim();
  if (!text) return null;
  if (text.length <= 200) return text;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.replace(/\s+/g, ' ').trim();
  if (title) return title.slice(0, 200);
  // Cloudflare renders its worker/gateway failures as "Error 1101"-style codes.
  const code = /\bError\s+\d{3,4}\b/.exec(text)?.[0];
  return code ?? null;
}

/**
 * What to suggest for a failing status when the server said nothing useful.
 * A gateway status (502/503/504) means the request never reached the model, or
 * never came back from it — the model id is not the suspect there, and saying
 * it is sends people editing a `--model` flag that was correct all along.
 */
export function statusHint(status: number, model: string, apiKeyEnv: string | undefined): string {
  if (status === 401 || status === 403) return `the key in ${apiKeyEnv ?? '(none)'} was rejected — check it has access to "${model}"`;
  if (status === 402) return 'the account behind this endpoint is out of credit — top it up, or switch backend with --provider / --local';
  if (status === 404) return `this endpoint has no model "${model}" — check the id (\`vg models catalog\`) and the base URL`;
  if (status === 408 || status === 504) return 'the request timed out before the model replied — retry, shorten the task, or use --local';
  if (status === 429) return 'rate limited — wait and retry, or switch backend with --provider / --local';
  if (status >= 500) return `the endpoint failed to serve the request — this is an upstream/gateway failure, not the model id "${model}"; retry, or use --provider / --local if it persists`;
  return `check the model id "${model}" and the endpoint`;
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
  acc: {
    text: string;
    tools: Map<number, { id?: string; name?: string; args: string }>;
    usage: { promptTokens?: number; completionTokens?: number };
    /** Last non-null `finish_reason` seen — 'length' means the cap cut the reply. */
    finishReason?: string;
  },
  chunk: unknown,
  onToken?: (t: string) => void,
): void {
  const c = chunk as { choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const reason = c.choices?.[0]?.finish_reason;
  if (typeof reason === 'string' && reason) acc.finishReason = reason;
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
        { model: this.model, messages: ollamaMessages(messages), stream: streaming, tools: openAiTools(opts.tools), options: { temperature: opts.temperature ?? 0 } },
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
      let truncated = false;
      const usage: { promptTokens?: number; completionTokens?: number } = {};
      for await (const line of streamLines(res)) {
        try {
          const obj = JSON.parse(line) as { message?: { content?: string; tool_calls?: unknown }; prompt_eval_count?: number; eval_count?: number; done_reason?: string };
          const delta = obj.message?.content;
          if (delta) {
            text += delta;
            opts.onToken?.(delta);
          }
          if (obj.message?.tool_calls) toolCallsRaw = obj.message.tool_calls;
          if (typeof obj.prompt_eval_count === 'number') usage.promptTokens = obj.prompt_eval_count;
          if (typeof obj.eval_count === 'number') usage.completionTokens = obj.eval_count;
          // Ollama's spelling of finish_reason: 'length' means num_predict cut it.
          if (obj.done_reason === 'length') truncated = true;
        } catch {
          /* skip a malformed line */
        }
      }
      return { text, model: this.model, provider: this.id, toolCalls: parseToolCalls(toolCallsRaw), usage, truncated };
    }

    const data = (await res.json()) as { message?: { content?: string; tool_calls?: unknown }; prompt_eval_count?: number; eval_count?: number; done_reason?: string };
    return {
      text: data.message?.content ?? '',
      model: this.model,
      provider: this.id,
      toolCalls: parseToolCalls(data.message?.tool_calls),
      usage: { promptTokens: data.prompt_eval_count, completionTokens: data.eval_count },
      truncated: data.done_reason === 'length',
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
      const detail = relayErrorDetail(await res.text().catch(() => ''));
      const hint = detail ?? statusHint(res.status, this.model, this.config.apiKeyEnv);
      throw httpError(this.label, res.status, hint);
    }

    if (streaming) {
      const acc = { text: '', tools: new Map<number, { id?: string; name?: string; args: string }>(), usage: {} as { promptTokens?: number; completionTokens?: number }, finishReason: undefined as string | undefined };
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
      return { text: acc.text, model: this.model, provider: this.id, toolCalls: tools.length ? tools : undefined, usage: acc.usage, truncated: acc.finishReason === 'length' };
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string; tool_calls?: unknown }; finish_reason?: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const message = data.choices?.[0]?.message;
    return {
      text: message?.content ?? '',
      model: this.model,
      provider: this.id,
      toolCalls: parseToolCalls(message?.tool_calls),
      usage: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens },
      truncated: data.choices?.[0]?.finish_reason === 'length',
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
    private readonly steps: Array<{ text?: string; toolCalls?: ToolCall[]; truncated?: boolean }>,
  ) {}
  // Match Provider.chat so tests can wrap/spy with the full signature.
  async chat(_messages?: ChatMessage[], _opts?: ChatOptions): Promise<ProviderResult> {
    const step = this.steps[Math.min(this.turn, this.steps.length - 1)];
    this.turn++;
    return { text: step.text ?? '', model: this.model, provider: this.id, toolCalls: step.toolCalls, truncated: step.truncated };
  }
}

/** The catalogue of known OpenAI-compatible endpoints, keyed by short id. */
export const OPENAI_COMPATIBLE: Record<string, Omit<OpenAiCompatibleConfig, 'label' | 'id'> & { label: string }> = {
  /**
   * Vibgrate Relay — the first-party hosted router. OpenAI-compatible, so it
   * needs no bespoke client. Reached with a Vibgrate token rather than a
   * provider key; the base URL is overridable for staging and self-hosting.
   */
  'vibgrate-relay': {
    baseUrl: process.env.VIBGRATE_RELAY_URL || 'https://api.vibgrate.com/relay/v1',
    apiKeyEnv: 'VIBGRATE_RELAY_TOKEN',
    local: false,
    label: 'Vibgrate Relay',
  },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', local: false, label: 'OpenRouter' },
  litellm: { baseUrl: process.env.LITELLM_BASE_URL || 'http://127.0.0.1:4000', apiKeyEnv: 'LITELLM_API_KEY', local: false, label: 'LiteLLM' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', local: false, label: 'OpenAI' },
  together: { baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY', local: false, label: 'Together' },
  lmstudio: { baseUrl: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1', local: true, label: 'LM Studio (local)' },
  /**
   * Microsoft Foundry Local — OpenAI-compatible local endpoint (Windows NPU/GPU).
   * Default port matches current Foundry Local docs; override with FOUNDRY_LOCAL_BASE_URL.
   */
  'foundry-local': {
    baseUrl: process.env.FOUNDRY_LOCAL_BASE_URL || 'http://127.0.0.1:5272/v1',
    local: true,
    label: 'Foundry Local',
  },
};

/* ------------------------------------------------------------------ *\
 *  Local llama.cpp (installs a package on first use, with consent)
\* ------------------------------------------------------------------ */

/**
 * A fully-local inference backend backed by the dual-mode llm-host (ADR-005)
 * and `node-llama-cpp`. Install runtime deps via `vg models install` (or pass
 * consent so ensurePackage can run once). Model *weights* are never fetched
 * automatically: `modelPath` must point at a gguf the user already has.
 */
export class LocalLlamaProvider implements Provider {
  readonly id = 'llama-cpp';
  /** Surfaced as the Vibgrate model manager (embedded llama.cpp). */
  readonly label = 'Vibgrate (local)';
  readonly local = true;
  /**
   * The embedded host has no native function-calling API — the router wraps
   * this provider in the text tool protocol (text-tool-protocol.ts) so the
   * agent loop still gets structured tool calls.
   */
  readonly supportsTools = false;
  /** Process-wide warm binding + path (best-in-breed: no reload per turn). */
  private static warmBinding: unknown | null = null;
  private static warmHost: import('../runtime/llm-host/embedded.js').EmbeddedLlmHost | null = null;
  private static warmPath: string | null = null;

  constructor(
    readonly model: string,
    private readonly modelPath: string,
    private readonly ensure: typeof ensurePackage = ensurePackage,
    private readonly consent = false,
    /** Override isolation (default: env / embedded). */
    private readonly isolation: 'embedded' | 'process' = 'embedded',
    private readonly processEndpoint?: string,
  ) {}
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ProviderResult> {
    const {
      createLlmHost,
      EmbeddedLlmHost,
      resolveInferenceIsolation,
      acquireHostSession,
      generateOnSession,
      evictIdleSessions,
    } = await import('../runtime/llm-host/index.js');
    const isolation = resolveInferenceIsolation(this.isolation);
    try {
      const chatMessages = messages.map((m) => ({
        role: (m.role === 'tool' ? 'user' : m.role) as 'system' | 'user' | 'assistant',
        content: m.content,
      }));
      const genOpts = {
        temperature: opts.temperature ?? 0,
        maxTokens: opts.maxTokens,
        grammar: opts.grammar,
        requireGrammar: opts.requireGrammar,
        identifierTrie: opts.identifierTrie,
        annotateUnknownIdentifiers: !!opts.identifierTrie,
        draftCandidates: opts.draftCandidates,
        promptSegments: opts.promptSegments,
      };

      if (isolation === 'process') {
        const host = createLlmHost({ isolation: 'process', endpoint: this.processEndpoint });
        await host.load(this.modelPath);
        const out = await host.generate(chatMessages, genOpts);
        return { text: out.text, model: this.model, provider: this.id };
      }

      // Warm path: reuse binding + session across turns.
      if (!LocalLlamaProvider.warmBinding) {
        const res = await this.ensure('node-llama-cpp@^3', { consent: this.consent, onUnavailable: () => {} });
        if (!res.module) {
          throw new Error(ensureUnavailableMessage(res.reason ?? 'no-consent', 'node-llama-cpp', res.detail));
        }
        LocalLlamaProvider.warmBinding = res.module;
      }
      evictIdleSessions(2);

      // Prefer direct session API for metrics-rich generate.
      const session = await acquireHostSession(LocalLlamaProvider.warmBinding, this.modelPath);
      const report = await generateOnSession(session, chatMessages, genOpts);
      // Real-ish usage for the panel meter. Never report draftAcceptedChars as
      // tokens — that is a char count of a speculative draft, not model usage
      // (it produced footers like "56 tokens" for multi-paragraph answers).
      const promptTokens = report.kvPlan?.totalTokens;
      const completionTokens = report.text ? Math.max(1, Math.ceil(report.text.length / 4)) : undefined;
      return {
        text: report.text,
        model: this.model,
        provider: this.id,
        usage: {
          ...(typeof promptTokens === 'number' && promptTokens > 0 ? { promptTokens } : {}),
          ...(completionTokens != null ? { completionTokens } : {}),
        },
      };
    } catch (e) {
      // Fall back to EmbeddedLlmHost once if session path fails.
      try {
        if (LocalLlamaProvider.warmBinding) {
          if (
            !LocalLlamaProvider.warmHost ||
            LocalLlamaProvider.warmPath !== this.modelPath
          ) {
            const host = createLlmHost({
              isolation: 'embedded',
              binding: LocalLlamaProvider.warmBinding,
              preferGrammar: !!opts.grammar,
            });
            if (host instanceof EmbeddedLlmHost) {
              LocalLlamaProvider.warmHost = host;
              LocalLlamaProvider.warmPath = this.modelPath;
              await host.load(this.modelPath);
            }
          }
          if (LocalLlamaProvider.warmHost) {
            const out = await LocalLlamaProvider.warmHost.generate(
              messages.map((m) => ({
                role: (m.role === 'tool' ? 'user' : m.role) as 'system' | 'user' | 'assistant',
                content: m.content,
              })),
              {
                temperature: opts.temperature ?? 0,
                maxTokens: opts.maxTokens,
                grammar: opts.grammar,
                requireGrammar: opts.requireGrammar,
                identifierTrie: opts.identifierTrie,
                annotateUnknownIdentifiers: !!opts.identifierTrie,
                draftCandidates: opts.draftCandidates,
                promptSegments: opts.promptSegments,
              },
            );
            return { text: out.text, model: this.model, provider: this.id };
          }
        }
      } catch {
        /* rethrow outer */
      }
      throw new Error(`local llama.cpp inference failed for ${this.modelPath} — ${redactSecrets((e as Error).message)}`);
    }
  }
}
