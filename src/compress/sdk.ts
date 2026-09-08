/**
 * SDK wrappers: compress on the way out, resolve retrieval calls on the way
 * back. No provider SDK is imported — the wrappers are shape-based proxies
 * over objects that expose `messages.create` (Anthropic-like),
 * `chat.completions.create` (OpenAI-like) or `responses.create` (Responses).
 *
 * Streaming requests (`stream: true`) are a documented passthrough: the
 * messages are still compressed, but only with byte-reversible folds (no
 * markers, no retrieve tool), because the retrieval loop cannot run inside
 * a stream the caller consumes.
 */

import { runRetrieveLoop, MAX_RETRIEVE_ROUNDS } from './ccr/handler.js';
import { CompressionStore, defaultStore } from './ccr/store.js';
import { injectRetrieveTool, messagesHaveMarkers, historyReferencesRetrieveTool } from './ccr/tool.js';
import { appendSavingsEvent } from './ledger.js';
import { compressMessages, type PipelineDeps, CompressionSession } from './pipeline.js';
import type { CompressOptions, CompressResult, Compressor, Message, MessageFormat } from './types.js';

export interface SdkOptions extends CompressOptions {
  store?: CompressionStore;
  /** Router override (tests, custom compressors); default = the process router. */
  router?: Compressor;
  /** Record savings to the global ledger (default true). */
  ledger?: boolean;
  /** Client label for the ledger. */
  client?: string;
  project?: string;
  env?: NodeJS.ProcessEnv;
  /** Keep one session (frozen verdicts, tracker) across calls (default true). */
  session?: boolean;
  /** Advertise the retrieve tool on every call once a call carried markers (default true). */
  sticky?: boolean;
  maxRetrieveRounds?: number;
  /** Called after every compression with the result (observability). */
  onCompress?: (result: CompressResult) => void;
}

interface SdkState {
  session: CompressionSession | null;
  sticky: boolean;
  store: CompressionStore | null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function stateFor(options: SdkOptions): SdkState {
  const env = options.env ?? process.env;
  let store: CompressionStore | null = null;
  if (options.ccr?.enabled !== false) {
    try {
      store = options.store ?? defaultStore(env);
    } catch {
      store = null;
    }
  }
  return { session: options.session === false ? null : new CompressionSession({ now: options.now }), sticky: false, store };
}

async function compressFor(messages: Message[], options: SdkOptions, state: SdkState, params: Record<string, unknown>, streaming: boolean): Promise<CompressResult> {
  const { store: _s, router, ledger: _l, client: _c, project: _p, env: _e, session: _se, sticky: _st, maxRetrieveRounds: _m, onCompress: _o, ...compressOptions } = options;
  const opts: CompressOptions = { ...compressOptions, model: options.model ?? (typeof params.model === 'string' ? params.model : undefined) };
  if (streaming) opts.lossless = true;
  const deps: PipelineDeps = { env: options.env, now: options.now, store: state.store };
  if (router) deps.router = router;
  const result = state.session ? await state.session.compress(messages, opts, deps) : await compressMessages(messages, opts, deps);
  options.onCompress?.(result);
  if (options.ledger !== false && result.tokensSaved > 0) {
    appendSavingsEvent({ ts: (options.now ?? Date.now)(), source: 'sdk', model: opts.model ?? 'unknown', client: options.client ?? 'sdk', project: options.project, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter, tokensSaved: result.tokensSaved, usdSaved: 0, transforms: result.transformsApplied, ccrHashes: result.ccrHashes.length }, options.env);
  }
  return result;
}

function bodyWithTool(params: Record<string, unknown>, messages: Message[], format: MessageFormat, state: SdkState, options: SdkOptions): { body: Record<string, unknown>; injected: boolean } {
  if (!state.store) return { body: params, injected: false };
  const hasMarkers = messagesHaveMarkers(messages) || historyReferencesRetrieveTool(messages);
  const sticky = options.sticky !== false && state.sticky;
  const r = injectRetrieveTool(params, format, { sticky, hasMarkers });
  if (r.injected || hasMarkers) state.sticky = options.sticky !== false;
  return r;
}

async function callWithLoop(create: (p: Record<string, unknown>) => Promise<Record<string, unknown>>, params: Record<string, unknown>, messages: Message[], key: 'messages' | 'input', format: MessageFormat, state: SdkState, options: SdkOptions): Promise<Record<string, unknown>> {
  const { body } = bodyWithTool(params, messages, format, state, options);
  const first = await create({ ...body, [key]: messages });
  if (!state.store || !isObj(first)) return first;
  const loop = await runRetrieveLoop(first, messages, { store: state.store, format, maxRounds: options.maxRetrieveRounds ?? MAX_RETRIEVE_ROUNDS, call: (msgs) => create({ ...body, [key]: msgs }) });
  return loop.response;
}

/**
 * Wrap an Anthropic-, OpenAI- or Responses-shaped client. Every `create` call
 * compresses the conversation first; non-streaming calls then resolve
 * `vg_retrieve` tool calls transparently (max 3 rounds).
 */
export function withCompression<T>(client: T, options: SdkOptions = {}): T {
  const state = stateFor(options);
  const wrapCreate = (original: (p: Record<string, unknown>) => unknown, key: 'messages' | 'input', format: MessageFormat) => {
    return async (params: Record<string, unknown>): Promise<unknown> => {
      if (!isObj(params) || !Array.isArray(params[key]) || (params[key] as unknown[]).length === 0) return original(params);
      const streaming = params.stream === true;
      let messages = params[key] as Message[];
      try {
        const result = await compressFor(messages, options, state, params, streaming);
        if (result.compressed) messages = result.messages;
      } catch {
        /* fail open */
      }
      if (streaming) return original({ ...params, [key]: messages });
      return callWithLoop((p) => Promise.resolve(original(p) as Record<string, unknown>), params, messages, key, format, state, options);
    };
  };
  const proxyNamespace = <N extends object>(ns: N, method: string, key: 'messages' | 'input', format: MessageFormat): N => {
    const orig = (ns as Record<string, unknown>)[method];
    if (typeof orig !== 'function') return ns;
    const wrapped = wrapCreate(orig.bind(ns) as (p: Record<string, unknown>) => unknown, key, format);
    return new Proxy(ns, {
      get(target, prop, receiver) {
        if (prop === method) return wrapped;
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
  const c = client as unknown as Record<string, unknown>;
  const messagesNs = isObj(c.messages) && typeof c.messages.create === 'function' ? proxyNamespace(c.messages, 'create', 'messages', 'anthropic') : undefined;
  const chatNs = isObj(c.chat) && isObj(c.chat.completions) && typeof c.chat.completions.create === 'function' ? new Proxy(c.chat, { get: (t, p, r) => (p === 'completions' ? proxyNamespace(t.completions as object, 'create', 'messages', 'openai') : Reflect.get(t, p, r)) }) : undefined;
  const responsesNs = isObj(c.responses) && typeof c.responses.create === 'function' ? proxyNamespace(c.responses, 'create', 'input', 'responses') : undefined;
  return new Proxy(client as object, {
    get(target, prop, receiver) {
      if (prop === 'messages' && messagesNs) return messagesNs;
      if (prop === 'chat' && chatNs) return chatNs;
      if (prop === 'responses' && responsesNs) return responsesNs;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as T;
}

/**
 * Vercel AI SDK middleware shape (`wrapLanguageModel({ model, middleware })`).
 * `transformParams` compresses `params.prompt` (Vercel-format messages) and
 * returns the params unchanged when nothing was saved.
 */
export function compressionMiddleware(options: SdkOptions = {}): { transformParams: (args: { params: Record<string, unknown>; model?: unknown; type?: string }) => Promise<Record<string, unknown>> } {
  const state = stateFor(options);
  return {
    async transformParams({ params }): Promise<Record<string, unknown>> {
      if (!isObj(params) || !Array.isArray(params.prompt) || params.prompt.length === 0) return params;
      try {
        const modelId = typeof params.modelId === 'string' ? params.modelId : undefined;
        const result = await compressFor(params.prompt as Message[], { ...options, model: options.model ?? modelId }, state, params, true);
        if (!result.compressed) return params;
        return { ...params, prompt: result.messages };
      } catch {
        return params;
      }
    },
  };
}
