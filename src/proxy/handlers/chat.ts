/**
 * The shared request lifecycle for `/v1/messages`, `/v1/chat/completions`
 * and `/v1/responses`. Provider differences live in the `FormatAdapter`s.
 *
 * Phases (mirroring the reference P0–P27, collapsed where Node makes them
 * unnecessary):
 *   parse → gates (bypass, model routes, rate limit, budget) → response cache
 *   → session → memory → system compaction → tool compaction → compression
 *   (fail-open, deadline, inflation guard) → markers + sticky retrieve tool
 *   → tool-search deferral + history repairs → output shaper (holdout arm)
 *   → cache_control ttl guard → forward (stream relay | buffered retrieve
 *   turn | non-stream) → retrieve loop → memory tool loop → outcome funnel
 *   (cost, savings, output savings, metrics, request log, PERF line).
 *
 * Every transform is fail-open: an exception anywhere before the upstream
 * call forwards the client's original body.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Message, MessageFormat } from '../../compress/types.js';
import { countTokens } from '../../engine/tokens.js';
import type { ProxyContext } from '../context.js';
import { MAX_MESSAGE_ARRAY_LENGTH } from '../context.js';
import type { ProxyDeps } from '../deps.js';
import { countToolCalls } from '../fallbacks.js';
import type { ProviderUsage } from '../cost.js';
import { budgetDenialBody } from '../budget.js';
import { errorBody, sendJson } from '../http.js';
import { classifyClient, resolveProject } from '../identity.js';
import { rateLimitKey } from '../rate-limit.js';
import { resolveClientIp } from '../guards.js';
import { applyModelRoutes, ModelRouter, parseModelRoutes } from '../model-router.js';
import { semanticCacheKey } from '../semantic-cache.js';
import { clientUsesOneHour, enforceCacheControlTtlOrder, resolveSessionId, type Session } from '../session.js';
import { compactOpenAISystemMessages, compactSystemPrompt } from '../system-compact.js';
import { compactToolsCached, injectToolSearchDeferral, injectToolSearchDeferralOpenAI, stripUnsupportedToolSearchBlocks } from '../tool-schema.js';
import { classifyForFormat, resolveVerbosityLevel, shapeRequest } from '../output-shaper.js';
import { assignArm, conversationKey, stratumKey, stratumLabel } from '../output-savings.js';
import { clientResponseHeaders, fetchWithRetry, resolveUpstream, upstreamHeaders, UpstreamUnreachable } from '../upstream.js';
import { isFirstPartyAnthropic } from '../guards.js';
import { bufferedTurn, estimateOutputTokens, extractStreamText, RelayBuffer, type BufferedOutcome, type SseEvent } from '../sse.js';
import { perfLine, type RequestRecord } from '../request-log.js';

export interface FormatAdapter {
  format: MessageFormat;
  provider: 'anthropic' | 'openai';
  errorFormat: 'anthropic' | 'openai';
  getMessages(body: Record<string, unknown>): Message[];
  setMessages(body: Record<string, unknown>, messages: Message[]): void;
  getTools(body: Record<string, unknown>): unknown[] | undefined;
  setTools(body: Record<string, unknown>, tools: unknown[] | undefined): void;
  systemText(body: Record<string, unknown>): string;
  appendSystem(body: Record<string, unknown>, text: string): void;
  appendToLatestUser(messages: Message[], text: string): boolean;
  latestUserText(messages: Message[]): string;
  isStream(body: Record<string, unknown>): boolean;
  setStream(body: Record<string, unknown>, on: boolean): void;
  reconstruct(deps: ProxyDeps, events: SseEvent[]): Record<string, unknown> | null;
  usageOf(json: Record<string, unknown> | null): ProviderUsage;
  outputText(json: Record<string, unknown> | null): string;
  isErrorResponse(json: Record<string, unknown> | null): boolean;
  historyReferencesTool(messages: Message[], name: string): boolean;
}

interface Outcome {
  status: number;
  usage: ProviderUsage;
  outputTokens: number;
  outputTokensSource: string;
  ttfbMs?: number;
  cached: boolean;
  retrieveRounds: number;
  responseJson?: Record<string, unknown> | null;
}

const MEMORY_TOOL_NAMES = new Set(['memory_search', 'memory_save']);

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function nextRequestId(ctx: ProxyContext): string {
  ctx.requestCounter++;
  return `vg_${Math.floor(ctx.deps.now() / 1000)}_${String(ctx.requestCounter).padStart(6, '0')}`;
}

function textOfMessages(messages: Message[]): string {
  const parts: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) for (const x of v) visit(x);
    else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) visit(x);
  };
  visit(messages);
  return parts.join('\n');
}

/** Handle one chat-shaped request end to end. `rawBody` is the decoded request body. */
export async function handleChat(ctx: ProxyContext, req: IncomingMessage, res: ServerResponse, adapter: FormatAdapter, rawBody: Buffer, headers: Record<string, string>, path: string): Promise<void> {
  const start = ctx.deps.now();
  const requestId = nextRequestId(ctx);
  const knobs = ctx.runtime.snapshot();
  const cfg = ctx.config;
  const tokenizer = safeTokenizer(ctx.deps, undefined);
  const count = (text: string): number => tokenizer.count(text);

  // --- parse ------------------------------------------------------------------
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body is not an object');
    body = parsed as Record<string, unknown>;
  } catch (err) {
    sendJson(res, 400, errorBody(adapter.errorFormat, 'invalid_request_error', `invalid JSON body: ${(err as Error).message}`), { 'x-vg-request-id': requestId });
    return;
  }
  const originalBody = deepClone(body);
  const originalMessages = adapter.getMessages(body);
  if (originalMessages.length > MAX_MESSAGE_ARRAY_LENGTH) {
    sendJson(res, 400, errorBody(adapter.errorFormat, 'invalid_request_error', `messages array exceeds ${MAX_MESSAGE_ARRAY_LENGTH} entries`), { 'x-vg-request-id': requestId });
    return;
  }
  const requestedModel = String(body.model ?? '');
  const stream = adapter.isStream(body);
  const client = classifyClient(headers, cfg.agentType);
  const project = resolveProject(headers, cfg.project, cfg.workspace);
  const bypass = headers['x-vg-bypass']?.toLowerCase() === 'true' || headers['x-vg-mode']?.toLowerCase() === 'passthrough';
  const transforms: string[] = [];

  // --- gates ------------------------------------------------------------------
  let model = requestedModel;
  const routed = applyModelRoutes(model, { ...cfg.modelRoutes, ...knobs.modelRoutes });
  if (routed !== model) {
    transforms.push(`model_route:${model}→${routed}`);
    model = routed;
  }
  if (knobs.modelRouter && knobs.modelRouterRules) {
    const { routes } = parseModelRoutes(knobs.modelRouterRules);
    const decision = new ModelRouter(routes).select({ ...body, model });
    if (decision.changed) {
      transforms.push(`model_router:${decision.ruleName ?? 'rule'}:${model}→${decision.routedModel}`);
      model = decision.routedModel;
    }
  }
  if (model !== requestedModel) body.model = model;

  const clientIp = resolveClientIp(req, ctx.trustedGateways);
  // Flags pin the limits; otherwise the hot knobs apply on every request.
  ctx.rateLimiter.rpm = cfg.rpm ?? knobs.rpm;
  ctx.rateLimiter.tpm = cfg.tpm ?? knobs.tpm;
  const estimatedTokens = Math.floor(rawBody.length / 4);
  if (ctx.rateLimiter.enabled) {
    const verdict = ctx.rateLimiter.check(rateLimitKey(headers, clientIp), estimatedTokens);
    if (!verdict.allowed) {
      ctx.metrics.requestsRateLimited++;
      ctx.logger.warn('rate_limited', { requestId, kind: verdict.kind, waitSeconds: verdict.waitSeconds.toFixed(1) });
      sendJson(res, 429, errorBody(adapter.errorFormat, 'rate_limit_error', `Rate limited. Retry after ${verdict.waitSeconds.toFixed(1)}s`, { retry_after: verdict.retryAfter }), { 'retry-after': String(verdict.retryAfter), 'x-vg-request-id': requestId });
      return;
    }
  }
  const budgetLimit = cfg.budgetUsd ?? knobs.budgetUsd;
  if (budgetLimit > 0) {
    const verdict = ctx.budget.check(budgetLimit, knobs.budgetPeriod, knobs.budgetBasis);
    if (!verdict.allowed) {
      ctx.metrics.requestsBudgetDenied++;
      ctx.logger.warn('budget_denied', { requestId, period: verdict.period, spentUsd: verdict.spentUsd.toFixed(4), limitUsd: verdict.limitUsd });
      sendJson(res, 402, budgetDenialBody(verdict, adapter.errorFormat), { 'x-vg-request-id': requestId });
      return;
    }
  }

  // --- response cache (non-streaming only) ----------------------------------------
  const cacheKey = !stream && knobs.semanticCache ? semanticCacheKey(body) : null;
  if (cacheKey) {
    const hit = ctx.semanticCache.get(cacheKey);
    if (hit) {
      const before = count(JSON.stringify(originalMessages));
      finishOutcome(ctx, { requestId, adapter, model, client, project, stream: false, tokensBefore: before, tokensAfter: 0, tokensSaved: before, deferredTokens: 0, transforms: ['response_cache:hit'], ccrHashes: 0, outcome: { status: 200, usage: {}, outputTokens: 0, outputTokensSource: 'cached', cached: true, retrieveRounds: 0 }, start, optimizationMs: ctx.deps.now() - start, messages: originalMessages.length, originalBody, outbound: originalBody, responseJson: null });
      const text = hit.body;
      res.writeHead(200, { ...hit.headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), 'x-vg-cache': 'hit', 'x-vg-request-id': requestId });
      res.end(text);
      return;
    }
  }

  // --- session --------------------------------------------------------------------
  const session: Session | null = cfg.stateless ? null : ctx.sessions.resolve(resolveSessionId(headers, originalBody, adapter.format));
  if (session) {
    session.client = client;
    session.model = model;
  }
  let betaHeader: string | undefined = headers['anthropic-beta'];
  if (adapter.provider === 'anthropic' && session) betaHeader = ctx.sessions.stickyBeta(session, betaHeader, knobs.betaHeaderSticky);

  const optimizing = cfg.optimize && knobs.compress && !bypass;
  const tokensBeforeMessages = count(JSON.stringify(originalMessages)) + count(adapter.systemText(originalBody));
  let tokensBefore = tokensBeforeMessages;
  let tokensAfter = tokensBeforeMessages;
  let deferredTokens = 0;
  let ccrHashes = 0;
  let outboundMessages: Message[] = originalMessages;
  let retrieveInjected = false;
  let memoryToolsInjected = false;
  const optStart = ctx.deps.now();

  if (optimizing) {
    try {
      // --- memory ---------------------------------------------------------------
      if (knobs.memory && ctx.deps.memory) {
        const messages = adapter.getMessages(body);
        if (!knobs.memoryNoContext && knobs.memoryInjectionMode !== 'off') {
          const query = adapter.latestUserText(messages);
          const block = query ? ctx.deps.memory.injection(query, { topK: knobs.memoryTopK }) : '';
          if (block) {
            if (knobs.memoryInjectionMode === 'system' && knobs.mode !== 'cache') adapter.appendSystem(body, block);
            else if (adapter.appendToLatestUser(messages, block)) adapter.setMessages(body, messages);
            transforms.push('memory:inject');
          }
        }
        if (!knobs.memoryNoTools) {
          let tools = adapter.getTools(body) ?? [];
          for (const t of ctx.deps.memory.tools(adapter.format)) {
            const name = toolNameOf(t) ?? 'memory';
            const r = ctx.sessions.stickyTool(session, tools, t, name, true, knobs.toolInjectionSticky);
            tools = r.tools;
            if (r.injected) memoryToolsInjected = true;
          }
          if (memoryToolsInjected) adapter.setTools(body, tools);
        }
      }

      // --- system compaction ------------------------------------------------------
      if (knobs.systemCompact) {
        if (adapter.format === 'anthropic') {
          const r = compactSystemPrompt(body.system, { minChars: knobs.systemCompactMinChars, compress: ctx.deps.compressText });
          if (r.changed) {
            body.system = r.system;
            transforms.push('anthropic:system_prompt_compaction');
          }
        } else if (adapter.format === 'openai') {
          const r = compactOpenAISystemMessages(adapter.getMessages(body) as Array<Record<string, unknown>>, { minChars: knobs.systemCompactMinChars, compress: ctx.deps.compressText });
          if (r.changed) {
            adapter.setMessages(body, r.messages);
            transforms.push('openai:system_prompt_compaction');
          }
        } else {
          const r = compactSystemPrompt(body.instructions, { minChars: knobs.systemCompactMinChars, compress: ctx.deps.compressText });
          if (r.changed) {
            body.instructions = r.system;
            transforms.push('openai:system_prompt_compaction');
          }
        }
      }

      // --- tool schema compaction (folds into both endpoints) ------------------------
      const tools0 = adapter.getTools(body);
      if (tools0 && tools0.length) {
        const r = compactToolsCached(tools0, { maxChars: knobs.toolDescMaxChars, stripSemantic: knobs.toolDescStripSemantic });
        const before = count(JSON.stringify(tools0));
        if (r.modified) {
          adapter.setTools(body, r.tools);
          const after = count(JSON.stringify(r.tools));
          tokensBefore += before;
          tokensAfter += after;
          transforms.push(`${adapter.provider}:tool_schema_compaction`);
          if (knobs.toolDescMaxChars > 0 || knobs.toolDescStripSemantic) transforms.push(`${adapter.provider}:tool_desc_compaction`);
        } else {
          tokensBefore += before;
          tokensAfter += before;
        }
      }

      // --- compression ---------------------------------------------------------------
      const messages = adapter.getMessages(body);
      if (messages.length) {
        let input = messages;
        let frozen = 0;
        if (session && knobs.mode === 'cache') {
          const replay = ctx.sessions.replayForwarded(session, messages);
          input = replay.messages;
          frozen = replay.frozen;
          if (frozen > 0) transforms.push(`cache_mode:frozen_prefix:${frozen}`);
        }
        const deadline = Math.max(0, knobs.compressDeadlineMs);
        const compressPromise = ctx.deps.compressMessages(input, { model, mode: knobs.mode, profile: knobs.profile, lossless: cfg.lossless, ccr: { enabled: cfg.ccr && knobs.ccr }, frozenMessageCount: frozen, provider: adapter.provider, now: ctx.deps.now, optimize: true });
        let result: Awaited<ReturnType<ProxyDeps['compressMessages']>> | null = null;
        let timedOut = false;
        try {
          result = deadline > 0 ? await Promise.race([compressPromise, ctx.deps.sleep(deadline).then(() => (timedOut = true, null))]) : await compressPromise;
        } catch (err) {
          ctx.metrics.recordCompressionFailed('error');
          ctx.logger.warn('compression_failed', { requestId, reason: 'error', message: (err as Error).message });
          result = null;
        }
        if (timedOut) {
          ctx.metrics.recordCompressionFailed('timeout');
          ctx.logger.warn('compression_failed', { requestId, reason: 'timeout', deadlineMs: deadline });
          transforms.push('compression:timeout');
        }
        if (result && Array.isArray(result.messages) && (result.messages.length > 0 || messages.length === 0)) {
          const afterTokens = count(JSON.stringify(result.messages)) + count(adapter.systemText(body));
          const beforeTokens = count(JSON.stringify(messages)) + count(adapter.systemText(body));
          if (afterTokens > beforeTokens && knobs.mode !== 'cache' && frozen === 0) {
            transforms.push('inflation_guard:reverted');
          } else {
            outboundMessages = result.messages;
            adapter.setMessages(body, outboundMessages);
            tokensAfter += afterTokens - beforeTokens;
            transforms.push(...result.transformsApplied);
            ccrHashes = result.ccrHashes.length;
            if (session) ctx.sessions.rememberForwarded(session, messages, outboundMessages);
          }
        }
      }

      // --- markers + sticky retrieve tool -------------------------------------------------
      if (cfg.ccr && knobs.ccr) {
        const text = textOfMessages(adapter.getMessages(body));
        const owned = ctx.deps.findMarkers(text).map((m) => m.hash).filter((h) => ctx.deps.store?.exists(h) ?? false);
        const fresh = session ? ctx.sessions.newMarkers(session, owned) : owned;
        const messagesNow = adapter.getMessages(body);
        const historyRef = adapter.historyReferencesTool(messagesNow, ctx.deps.retrieveToolName);
        const r = ctx.sessions.stickyTool(session, adapter.getTools(body), ctx.deps.retrieveTool(adapter.format), ctx.deps.retrieveToolName, fresh.length > 0 || owned.length > 0 || historyRef, knobs.toolInjectionSticky);
        if (r.injected) {
          adapter.setTools(body, r.tools);
          retrieveInjected = true;
          transforms.push(`ccr:tool:${r.decision}`);
        } else if (r.decision === 'skip_present') retrieveInjected = true;
      }
      // Retrieve blocks in history without the tool declared → neutralize (never drop).
      if (!retrieveInjected) {
        const messagesNow = adapter.getMessages(body);
        if (adapter.historyReferencesTool(messagesNow, ctx.deps.retrieveToolName)) {
          const repaired = ctx.deps.neutralizeRetrieveHistory(messagesNow, adapter.format);
          if (repaired !== messagesNow) {
            adapter.setMessages(body, repaired);
            transforms.push('router:ccr_retrieve_repair');
          }
        }
      }

      // --- tool-search deferral + repairs (nothing after may touch tools) --------------------
      const tools1 = adapter.getTools(body);
      if (tools1 && tools1.length && knobs.toolSearch) {
        if (adapter.format === 'anthropic' && isFirstPartyAnthropic(cfg.anthropicUrl) && !cfg.upstreamUrl) {
          const d = injectToolSearchDeferral(tools1, { minTools: knobs.toolSearchMinTools, countTokens: count });
          if (d.changed) {
            adapter.setTools(body, d.tools);
            deferredTokens = d.deferredTokens;
            transforms.push(`router:tool_search_deferral:${d.deferred}tools:${d.deferredTokens}tok`);
          }
        } else if (adapter.format === 'responses') {
          const d = injectToolSearchDeferralOpenAI(tools1, { model, client, minTools: knobs.toolSearchMinTools, countTokens: count });
          if (d.changed) {
            adapter.setTools(body, d.tools);
            deferredTokens = d.deferredTokens;
            transforms.push(`router:tool_search_deferral:${d.deferred}tools:${d.deferredTokens}tok`);
          }
        }
      }
      if (adapter.format === 'anthropic') {
        const repaired = stripUnsupportedToolSearchBlocks(adapter.getMessages(body), adapter.getTools(body));
        if (repaired.removed > 0) {
          adapter.setMessages(body, repaired.messages);
          transforms.push(`router:tool_search_repair:${repaired.removed}blocks`);
        }
      }

      // --- output shaper --------------------------------------------------------------------
      if (knobs.outputShaper || cfg.outputShaper) {
        const key = conversationKey(originalBody, adapter.format);
        const arm = assignArm(key, knobs.holdout);
        const stratum = stratumKey({ turnKind: classifyForFormat(body, adapter.format), inputTokens: tokensBefore, model, hasTools: Boolean(adapter.getTools(body)?.length) });
        transforms.push(stratumLabel(arm, stratum));
        if (arm === 'treatment') {
          const level = resolveVerbosityLevel({ steeringAllowed: knobs.mode !== 'cache', envLevel: knobs.verbosityLevel, envExplicit: knobs.env.VG_OUTPUT_VERBOSITY_LEVEL !== undefined && knobs.env.VG_OUTPUT_VERBOSITY_LEVEL !== '', learnedLevel: knobs.verbosityAutotune ? ctx.learnedVerbosity : undefined, defaultLevel: knobs.verbosityLevel });
          transforms.push(...shapeRequest(body, adapter.format, { level: level.level, effortRouting: knobs.effortRouting, steeringAllowed: knobs.mode !== 'cache' }));
        }
      }

      // --- cache_control ttl guard ----------------------------------------------------------------
      if (adapter.format === 'anthropic' && knobs.cacheControlTtlGuard) {
        const repaired = enforceCacheControlTtlOrder(body, clientUsesOneHour(originalBody));
        if (repaired > 0) transforms.push(`cache_control_ttl_guard:${repaired}`);
      }
    } catch (err) {
      // Fail open: forward the client's original body.
      ctx.logger.warn('optimization_failed', { requestId, message: (err as Error).message });
      ctx.metrics.recordCompressionFailed('error');
      body = deepClone(originalBody);
      if (model !== requestedModel) body.model = model;
      transforms.length = 0;
      transforms.push('optimization:failed_open');
      tokensBefore = tokensBeforeMessages;
      tokensAfter = tokensBeforeMessages;
      deferredTokens = 0;
      ccrHashes = 0;
      retrieveInjected = false;
      memoryToolsInjected = false;
    }
  } else if (bypass) transforms.push('bypass');

  const tokensSaved = Math.max(0, tokensBefore - tokensAfter);
  const optimizationMs = ctx.deps.now() - optStart;
  const usdSaved = safePrice(ctx, model, tokensSaved + deferredTokens);
  const usageHeaders: Record<string, string> = {
    'x-vg-request-id': requestId,
    'x-vg-tokens-before': String(tokensBefore + deferredTokens),
    'x-vg-tokens-after': String(tokensAfter),
    'x-vg-tokens-saved': String(tokensSaved + deferredTokens),
    'x-vg-usd-saved': usdSaved.toFixed(6),
    'x-vg-transforms': transforms.length ? summarizeForHeader(transforms) : 'none',
  };

  // --- forward -----------------------------------------------------------------------------------
  const upstream = resolveUpstream(path, headers, cfg);
  const outHeaders = upstreamHeaders(headers, { stripInternal: ctx.stripInternalHeaders, contentType: 'application/json' });
  if (betaHeader && adapter.provider === 'anthropic') outHeaders['anthropic-beta'] = betaHeader;
  const inlineResolve = (retrieveInjected || memoryToolsInjected) && knobs.ccrInlineResolve;
  const messagesCount = adapter.getMessages(body).length;
  const common = { requestId, adapter, model, client, project, stream, tokensBefore, tokensAfter, tokensSaved, deferredTokens, transforms, ccrHashes, start, optimizationMs, messages: messagesCount, originalBody, outbound: body };

  if (stream && !inlineResolve) {
    await relayStream(ctx, res, adapter, upstream.url, outHeaders, body, usageHeaders, common);
    return;
  }
  if (stream && inlineResolve) {
    adapter.setStream(body, false);
    outHeaders.accept = 'application/json';
    const work = runBufferedExchange(ctx, adapter, upstream.url, outHeaders, body, knobs.ccrMaxRounds);
    const { outcome } = await bufferedTurn(res, adapter.format, work, { graceMs: ctx.limits.bufferedGraceMs, heartbeatMs: ctx.limits.heartbeatMs, sseHeaders: usageHeaders });
    const usage = outcome.json ? adapter.usageOf(outcome.json) : {};
    finishOutcome(ctx, { ...common, outcome: { status: outcome.json ? 200 : (outcome.passthrough?.status ?? outcome.error?.status ?? 502), usage, outputTokens: usage.outputTokens ?? 0, outputTokensSource: usage.outputTokens !== undefined ? 'provider' : 'none', cached: false, retrieveRounds: outcome.rounds ?? 0, responseJson: outcome.json ?? null }, responseJson: outcome.json ?? null });
    return;
  }

  // Non-streaming.
  outHeaders.accept = 'application/json';
  const work = await runBufferedExchange(ctx, adapter, upstream.url, outHeaders, body, knobs.ccrMaxRounds);
  if (work.json) {
    const text = JSON.stringify(work.json);
    const relayHeaders = { ...(work.headers ?? {}), ...usageHeaders, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) };
    if (cacheKey && !adapter.isErrorResponse(work.json)) ctx.semanticCache.set(cacheKey, text, work.headers ?? {}, tokensAfter, knobs.semanticCacheTtl);
    res.writeHead(200, relayHeaders);
    res.end(text);
    const usage = adapter.usageOf(work.json);
    finishOutcome(ctx, { ...common, outcome: { status: 200, usage, outputTokens: usage.outputTokens ?? Math.max(0, Math.floor(adapter.outputText(work.json).length / 4)), outputTokensSource: usage.outputTokens !== undefined ? 'provider' : 'estimated_text', cached: false, retrieveRounds: work.rounds ?? 0, responseJson: work.json }, responseJson: work.json });
    return;
  }
  if (work.passthrough) {
    res.writeHead(work.passthrough.status, { ...work.passthrough.headers, ...usageHeaders, 'content-length': String(Buffer.byteLength(work.passthrough.body)) });
    res.end(work.passthrough.body);
    if (work.passthrough.status >= 400) ctx.logger.warn('upstream_error', { requestId, status: work.passthrough.status, provider: upstream.provider });
    finishOutcome(ctx, { ...common, outcome: { status: work.passthrough.status, usage: {}, outputTokens: 0, outputTokensSource: 'none', cached: false, retrieveRounds: 0 }, responseJson: null });
    return;
  }
  const status = work.error?.status ?? 502;
  ctx.metrics.recordUpstreamError(upstream.provider);
  sendJson(res, status, errorBody(adapter.errorFormat, status === 504 ? 'timeout_error' : 'api_error', work.error?.message ?? 'upstream failure'), usageHeaders);
  finishOutcome(ctx, { ...common, outcome: { status, usage: {}, outputTokens: 0, outputTokensSource: 'none', cached: false, retrieveRounds: 0 }, responseJson: null });
}

// ---------------------------------------------------------------------------
// Upstream exchange (non-stream) with retrieve + memory tool loops
// ---------------------------------------------------------------------------

type ExchangeOutcome = BufferedOutcome & { headers?: Record<string, string>; rounds?: number };

async function runBufferedExchange(ctx: ProxyContext, adapter: FormatAdapter, url: string, outHeaders: Record<string, string>, body: Record<string, unknown>, maxRounds: number): Promise<ExchangeOutcome> {
  const send = async (payload: Record<string, unknown>): Promise<{ res: Response; text: string }> => {
    const text = JSON.stringify(payload);
    const res = await fetchWithRetry(url, { method: 'POST', headers: { ...outHeaders, 'content-length': String(Buffer.byteLength(text)) }, body: text }, { fetch: ctx.transport, sleep: ctx.deps.sleep, maxAttempts: ctx.limits.retryMaxAttempts, timeoutMs: ctx.limits.requestTimeoutMs, onRetry: (i) => ctx.logger.debug('upstream_retry', i) });
    return { res, text: await res.text() };
  };
  try {
    let { res, text } = await send(body);
    if (res.status !== 200) return { passthrough: { status: res.status, headers: clientResponseHeaders(res.headers), body: text } };
    let json = parseJsonSafe(text);
    if (!json) return { passthrough: { status: 200, headers: clientResponseHeaders(res.headers), body: text } };
    const headers = clientResponseHeaders(res.headers, ['content-type']);
    let rounds = 0;
    let messages = adapter.getMessages(body);
    const limit = Math.min(maxRounds, ctx.deps.maxRetrieveRounds);
    while (rounds < limit) {
      const retrieveCalls = ctx.deps.extractRetrieveCalls(json, adapter.format);
      const memoryCalls = ctx.deps.memory ? extractNamedCalls(json, adapter.format, (n) => MEMORY_TOOL_NAMES.has(n)) : [];
      const total = countToolCalls(json, adapter.format);
      if (!retrieveCalls.length && !memoryCalls.length) break;
      if (total > retrieveCalls.length + memoryCalls.length) {
        ctx.logger.info('retrieve_skipped_mixed_tools', { total, retrieve: retrieveCalls.length });
        break;
      }
      rounds++;
      ctx.metrics.retrieveRounds++;
      const calls = [...retrieveCalls, ...memoryCalls];
      const results = calls.map((c) => (MEMORY_TOOL_NAMES.has(c.name) ? { content: ctx.deps.memory!.handleTool(c.name, c.args).content } : { content: ctx.deps.executeRetrieve(c.args).content }));
      messages = [...messages, ...ctx.deps.buildRetrieveResultMessages(calls, results, adapter.format)];
      const next: Record<string, unknown> = { ...body };
      adapter.setMessages(next, messages);
      ({ res, text } = await send(next));
      if (res.status !== 200) return { passthrough: { status: res.status, headers: clientResponseHeaders(res.headers), body: text }, rounds };
      const parsed = parseJsonSafe(text);
      if (!parsed) return { passthrough: { status: 200, headers: clientResponseHeaders(res.headers), body: text }, rounds };
      json = parsed;
    }
    return { json, headers, rounds };
  } catch (err) {
    const status = err instanceof UpstreamUnreachable ? 502 : /timeout/i.test((err as Error).message ?? '') ? 504 : 502;
    return { error: { status, message: (err as Error).message ?? 'upstream failure' } };
  }
}

function extractNamedCalls(json: Record<string, unknown>, format: MessageFormat, match: (name: string) => boolean): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  const out: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  if (format === 'anthropic' && Array.isArray(json.content)) {
    for (const b of json.content as Array<Record<string, unknown>>) if (b?.type === 'tool_use' && typeof b.name === 'string' && match(b.name)) out.push({ id: String(b.id ?? ''), name: b.name, args: (b.input as Record<string, unknown>) ?? {} });
  } else if (format === 'responses' && Array.isArray(json.output)) {
    for (const it of json.output as Array<Record<string, unknown>>) if (it?.type === 'function_call' && typeof it.name === 'string' && match(it.name)) out.push({ id: String(it.call_id ?? it.id ?? ''), name: it.name, args: parseJsonSafe(String(it.arguments ?? '{}')) ?? {} });
  } else if (Array.isArray(json.choices)) {
    const msg = ((json.choices as Array<Record<string, unknown>>)[0]?.message as Record<string, unknown>) ?? {};
    if (Array.isArray(msg.tool_calls)) for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
      const fn = tc.function as Record<string, unknown> | undefined;
      if (fn && typeof fn.name === 'string' && match(fn.name)) out.push({ id: String(tc.id ?? ''), name: fn.name, args: parseJsonSafe(String(fn.arguments ?? '{}')) ?? {} });
    }
  }
  return out;
}

function parseJsonSafe(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Streaming relay
// ---------------------------------------------------------------------------

interface CommonOutcome {
  requestId: string;
  adapter: FormatAdapter;
  model: string;
  client: string;
  project?: string;
  stream: boolean;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  deferredTokens: number;
  transforms: string[];
  ccrHashes: number;
  start: number;
  optimizationMs: number;
  messages: number;
  originalBody: Record<string, unknown>;
  outbound: Record<string, unknown>;
}

async function relayStream(ctx: ProxyContext, res: ServerResponse, adapter: FormatAdapter, url: string, outHeaders: Record<string, string>, body: Record<string, unknown>, usageHeaders: Record<string, string>, common: CommonOutcome): Promise<void> {
  const text = JSON.stringify(body);
  let upstream: Response;
  try {
    upstream = await fetchWithRetry(url, { method: 'POST', headers: { ...outHeaders, 'content-length': String(Buffer.byteLength(text)) }, body: text }, { fetch: ctx.transport, sleep: ctx.deps.sleep, maxAttempts: ctx.limits.retryMaxAttempts, timeoutMs: ctx.limits.requestTimeoutMs });
  } catch (err) {
    ctx.metrics.recordUpstreamError(adapter.provider);
    sendJson(res, 502, errorBody(adapter.errorFormat, 'api_error', (err as Error).message ?? 'upstream failure'), usageHeaders);
    finishOutcome(ctx, { ...common, outcome: { status: 502, usage: {}, outputTokens: 0, outputTokensSource: 'none', cached: false, retrieveRounds: 0 }, responseJson: null });
    return;
  }
  const ttfbMs = ctx.deps.now() - common.start;
  const relayHeaders = { ...clientResponseHeaders(upstream.headers), ...usageHeaders };
  if (upstream.status !== 200 || !upstream.body) {
    const errText = await upstream.text();
    res.writeHead(upstream.status, { ...relayHeaders, 'content-length': String(Buffer.byteLength(errText)) });
    res.end(errText);
    if (upstream.status >= 400) ctx.logger.warn('upstream_error', { requestId: common.requestId, status: upstream.status });
    finishOutcome(ctx, { ...common, outcome: { status: upstream.status, usage: {}, outputTokens: 0, outputTokensSource: 'none', ttfbMs, cached: false, retrieveRounds: 0 }, responseJson: null });
    return;
  }
  res.writeHead(200, relayHeaders);
  res.flushHeaders?.();
  const buffer = new RelayBuffer(ctx.limits.sseBufferMaxBytes);
  const reader = upstream.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      buffer.push(value);
      if (!res.destroyed) res.write(Buffer.from(value));
    }
  } catch (err) {
    ctx.logger.warn('stream_interrupted', { requestId: common.requestId, message: (err as Error).message });
  } finally {
    if (!res.writableEnded) res.end();
  }
  const events = buffer.finish();
  let json: Record<string, unknown> | null = null;
  if (!buffer.overflowed && events.length) {
    try {
      json = adapter.reconstruct(ctx.deps, events);
    } catch {
      json = null;
    }
  }
  const usage = adapter.usageOf(json);
  let outputTokens = usage.outputTokens;
  let source = 'provider';
  if (outputTokens === undefined) {
    const est = estimateOutputTokens(extractStreamText(events), total);
    outputTokens = est.tokens;
    source = est.source;
  }
  finishOutcome(ctx, { ...common, outcome: { status: 200, usage, outputTokens, outputTokensSource: source, ttfbMs, cached: false, retrieveRounds: 0, responseJson: json }, responseJson: json });
}

// ---------------------------------------------------------------------------
// Outcome funnel
// ---------------------------------------------------------------------------

function finishOutcome(ctx: ProxyContext, o: CommonOutcome & { outcome: Outcome; responseJson: Record<string, unknown> | null }): void {
  try {
    const now = ctx.deps.now();
    const totalMs = now - o.start;
    const usage = o.outcome.usage;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheInferred ? 0 : (usage.cacheWriteTokens ?? 0);
    const priced = ctx.cost.record(o.model, { ...usage, outputTokens: o.outcome.outputTokens }, o.tokensAfter, o.tokensSaved + o.deferredTokens);
    let outputTokensSaved = 0;
    if (o.transforms.some((t) => t.startsWith('output_shaper:'))) {
      ctx.outputSavings.recordFromLabels(o.transforms, o.outcome.outputTokens);
      outputTokensSaved = ctx.outputSavings.estimateRequest(o.transforms, o.outcome.outputTokens);
    }
    if (o.outcome.status < 500 && !o.outcome.cached) {
      ctx.savings.record({ model: o.model, client: o.client, project: o.project, tokensBefore: o.tokensBefore, tokensAfter: o.tokensAfter, tokensSaved: o.tokensSaved, deferredTokens: o.deferredTokens, outputTokensSaved, cacheReadTokens: cacheRead, usd: priced.usd, usdSaved: priced.savingsUsd, transforms: o.transforms, ccrHashes: o.ccrHashes });
    }
    ctx.metrics.recordRequest({ provider: o.adapter.provider, model: o.model, client: o.client, status: o.outcome.status, inputTokens: o.tokensAfter, outputTokens: o.outcome.outputTokens, tokensSaved: o.tokensSaved, deferredTokens: o.deferredTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, latencyMs: totalMs, overheadMs: o.optimizationMs, ttfbMs: o.outcome.ttfbMs, cached: o.outcome.cached, transforms: o.transforms, outputTokensSaved, usd: priced.usd, usdSaved: priced.savingsUsd });
    const knobs = ctx.runtime.snapshot();
    const rec: RequestRecord = {
      requestId: o.requestId,
      timestamp: new Date(now).toISOString(),
      provider: o.adapter.provider,
      model: o.model,
      client: o.client,
      project: o.project,
      status: o.outcome.status,
      stream: o.stream,
      inputTokensOriginal: o.tokensBefore + o.deferredTokens,
      inputTokensOptimized: o.tokensAfter,
      outputTokens: o.outcome.outputTokens,
      tokensSaved: o.tokensSaved,
      deferredTokens: o.deferredTokens,
      savingsPercent: o.tokensBefore + o.deferredTokens > 0 ? ((o.tokensSaved + o.deferredTokens) / (o.tokensBefore + o.deferredTokens)) * 100 : 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      optimizationMs: o.optimizationMs,
      totalMs,
      ttfbMs: o.outcome.ttfbMs,
      transforms: o.transforms,
      cached: o.outcome.cached,
      retrieveRounds: o.outcome.retrieveRounds,
      usd: priced.usd,
      usdSaved: priced.savingsUsd,
      outputTokensSaved: outputTokensSaved || undefined,
    };
    if (knobs.logMessages) {
      rec.requestPreview = previewOf(o.outbound, knobs.logPayloadPreview);
      rec.responsePreview = o.responseJson ? previewOf(o.responseJson, knobs.logPayloadPreview) : undefined;
    }
    ctx.requestLog.record(rec);
    ctx.logger.info('perf', { line: perfLine(rec, o.messages), outputTokensSource: o.outcome.outputTokensSource });
    if (ctx.deps.memory?.observe && o.outcome.status === 200) ctx.deps.memory.observe(o.adapter.getMessages(o.originalBody), o.responseJson ?? undefined);
  } catch (err) {
    ctx.logger.error('outcome_failed', { requestId: o.requestId, message: (err as Error).message });
  }
}

function previewOf(value: Record<string, unknown>, maxChars: number): unknown {
  if (maxChars <= 0) return value;
  const text = JSON.stringify(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : value;
}

function toolNameOf(t: unknown): string | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const o = t as Record<string, unknown>;
  if (typeof o.name === 'string') return o.name;
  const fn = o.function as Record<string, unknown> | undefined;
  return fn && typeof fn.name === 'string' ? fn.name : undefined;
}

function safeTokenizer(deps: ProxyDeps, model: string | undefined): { count(text: string): number } {
  try {
    return deps.tokenizerFor(model);
  } catch {
    return { count: countTokens };
  }
}

function safePrice(ctx: ProxyContext, model: string, tokensSaved: number): number {
  try {
    const p = ctx.deps.priceFor(model, ctx.config.env);
    const usd = (Math.max(0, tokensSaved) * p.input) / 1e6;
    return Number.isFinite(usd) ? usd : 0;
  } catch {
    return (Math.max(0, tokensSaved) * 3) / 1e6;
  }
}

/** Comma-joined header value; enriched tags with commas collapse to their counter shape. */
export function summarizeForHeader(transforms: string[]): string {
  const counts = new Map<string, number>();
  for (const t of transforms) {
    const name = t.includes(',') ? t.split(':').slice(0, 2).join(':') : t;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([k, n]) => (n > 1 ? `${k}*${n}` : k))
    .join(',')
    .replace(/[^\x20-\x7e]/g, '?');
}
