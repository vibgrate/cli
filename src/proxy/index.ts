/**
 * Barrel for the local compression listener (`vg serve --compress`). Re-exported from
 * `src/index.ts` for SDK consumers; see INTEGRATION.md.
 */

export { startProxy } from './server.js';
export type { RunningProxy, StartProxyDeps, ProxyStats } from './server.js';
export { resolveProxyConfig, configSummary, isLoopbackBind, normalizeApiUrl, layeredEnv } from './config.js';
export type { ProxyConfig } from './config.js';
export { readProxyState, writeProxyState, removeProxyState, isProxyAlive, probeProxy, ensureProxyRunning, stopProxy, registerClient, unregisterClient, listClients, pruneStaleClients, acquireStartLock, pidAlive } from './lifecycle.js';
export type { ProxyState, EnsureOptions, ClientMarker } from './lifecycle.js';
export type { ProxyDeps, StoreLike, MemoryLike, RetrieveCall, RetrieveResult, SavingsEventLike, SavingsRollupLike } from './deps.js';
export { fallbackDeps, loadDefaultDeps } from './fallbacks.js';
export { RuntimeEnv } from './runtime-env.js';
export type { RuntimeKnobs } from './runtime-env.js';
export { STEERING_SENTINEL, STEERING_SUFFIX, VERBOSITY_LEVELS, steeringText, replaceOrAppendSteeringBlock, classifyTurn, classifyResponsesInput, shapeRequest, clampEffort, resolveVerbosityLevel } from './output-shaper.js';
export type { TurnKind, VerbosityLevel } from './output-shaper.js';
export { assignArm, conversationKey, stratumKey, stratumLabel, parseStratumLabel, inputBucket, modelFamily, SavingsLedger, BaselineModel, Accum, OutputSavingsRecorder, registerModelledFactors, estimateRequestSavings, echoRatio } from './output-savings.js';
export type { SavingsEstimate } from './output-savings.js';
export { compactTools, compactToolDescriptions, compactToolsCached, injectToolSearchDeferral, injectToolSearchDeferralOpenAI, stripUnsupportedToolSearchBlocks, truncateDescription, sortTools, extractToolName, TOOL_SCHEMA_DROP_KEYS, TOOL_SEARCH_CORE_TOOLS } from './tool-schema.js';
export { compactSystemPrompt, compactWhitespace } from './system-compact.js';
export { SessionEngine, resolveSessionId, enforceCacheControlTtlOrder, clientUsesOneHour, countCacheBreakpoints } from './session.js';
export { SemanticCache, semanticCacheKey, stripCacheControl } from './semantic-cache.js';
export { RateLimiter, rateLimitKey, refilledTokens, consumeFromBucket } from './rate-limit.js';
export { CostTracker, periodStart } from './cost.js';
export { BudgetGuard, budgetDenialBody } from './budget.js';
export { ModelRouter, parseModelRoutes, applyModelRoutes, estimateInputTokens } from './model-router.js';
export { Metrics, escapeLabelValue } from './metrics.js';
export { SseParser, RelayBuffer, parseSseBlock, responseToSse, anthropicResponseToSse, openAIChatResponseToSse, openAIResponsesResponseToSse, bufferedTurn, sseError, heartbeat, extractStreamText, estimateOutputTokens, DEFAULT_BUFFERED_GRACE_MS, HEARTBEAT_INTERVAL_MS } from './sse.js';
export type { SseEvent, BufferedOutcome } from './sse.js';
export { isLoopbackAddress, isLoopbackHostHeader, parseCidr, parseCidrs, ipInCidr, ipInCidrs, isInternalAddress, isSafeUpstreamUrl, isSafeUpstreamUrlAsync, corsOrigin, corsHeaders, readToken, tokenMatches, SECURITY_HEADERS, DEFAULT_UPSTREAM_HOSTS } from './guards.js';
export type { Cidr } from './guards.js';
export { resolveUpstream, upstreamHeaders, clientResponseHeaders, fetchWithRetry, retryAfterMs, jitterDelayMs, createTransport, nodeFetch, looksAnthropic } from './upstream.js';
export type { Provider, Upstream } from './upstream.js';
export { ProxyLogger, RequestLogger, redactHeaders, redactPayload, perfLine, summarizeTransforms } from './request-log.js';
export type { RequestRecord } from './request-log.js';
export { AuditLog, isAuditablePath } from './audit.js';
export { SavingsTracker } from './savings-tracker.js';
export { classifyClient, classifyAuthMode, resolveProject, sanitizeProjectName } from './identity.js';
export { matchRoute, ROUTE_TABLE } from './routes.js';
export { dashboardHtml } from './dashboard.html.js';
export { runPerf, builtinFixtures, percentile } from './perf.js';
export type { PerfReport, PerfRow, PerfFixture } from './perf.js';
export { proxyDiagnostics } from './diagnostics.js';
export type { ProxyDiagnosis } from './diagnostics.js';
