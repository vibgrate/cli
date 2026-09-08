/**
 * Sidecar endpoints: `POST /v1/compress` (`{messages, model, options}` →
 * `CompressResult`, fail-open on timeout) and `POST /v1/retrieve`
 * (`{hash, grep?, head?, tail?}` → the original content).
 */

import type { ServerResponse } from 'node:http';
import type { CompressOptions, Message } from '../../compress/types.js';
import type { ProxyContext } from '../context.js';
import { passthroughResult, detectFormatFallback, messagesTokens } from '../fallbacks.js';
import { parseJsonBody, sendJson } from '../http.js';

const ALLOWED_OPTIONS = new Set(['mode', 'profile', 'compressUserMessages', 'compressSystemMessages', 'compressAssistantText', 'protectRecent', 'protectAnalysisContext', 'frozenMessageCount', 'targetRatio', 'minTokensToCompress', 'lossless', 'losslessThenLossy', 'crossTurnDedup', 'codeAware', 'compressors', 'modelLimit', 'protectReads', 'thinkingCompact', 'provider', 'query']);

export async function handleCompress(ctx: ProxyContext, res: ServerResponse, rawBody: Buffer, headers: Record<string, string>): Promise<void> {
  const body = parseJsonBody(rawBody);
  if (!body || !Array.isArray(body.messages)) {
    sendJson(res, 400, { error: { type: 'invalid_request', message: 'expected {messages: [...], model?, options?}' } });
    return;
  }
  const messages = body.messages as Message[];
  const model = typeof body.model === 'string' ? body.model : undefined;
  const options: CompressOptions = { model };
  const raw = (body.options && typeof body.options === 'object' ? body.options : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) if (ALLOWED_OPTIONS.has(k)) (options as Record<string, unknown>)[k] = v;
  if (typeof body.frozen_message_count === 'number') options.frozenMessageCount = body.frozen_message_count;
  options.ccr = { enabled: ctx.config.ccr && (raw.ccr !== false) };
  options.now = ctx.deps.now;
  if (headers['x-vg-bypass']?.toLowerCase() === 'true') {
    sendJson(res, 200, { ...passthroughResult(messages, detectFormatFallback(messages), messagesTokens(messages)), warnings: [], bypass: true });
    return;
  }
  const knobs = ctx.runtime.snapshot();
  const deadline = knobs.compressDeadlineMs;
  const start = ctx.deps.now();
  try {
    const work = ctx.deps.compressMessages(messages, options);
    const result = deadline > 0 ? await Promise.race([work, ctx.deps.sleep(deadline).then(() => null)]) : await work;
    if (!result) {
      ctx.metrics.recordCompressionFailed('timeout');
      sendJson(res, 200, { ...passthroughResult(messages, detectFormatFallback(messages), messagesTokens(messages)), compression_skipped: true, skip_reason: 'compression_timeout' });
      return;
    }
    const ms = ctx.deps.now() - start;
    ctx.metrics.recordRequest({ provider: 'compress', model: model ?? 'unknown', client: 'sidecar', status: 200, inputTokens: result.tokensAfter, outputTokens: 0, tokensSaved: result.tokensSaved, deferredTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: ms, overheadMs: ms, cached: false, transforms: result.transformsApplied, usd: 0, usdSaved: 0 });
    sendJson(res, 200, result, { 'x-vg-tokens-before': String(result.tokensBefore), 'x-vg-tokens-after': String(result.tokensAfter), 'x-vg-tokens-saved': String(result.tokensSaved) });
  } catch (err) {
    ctx.metrics.recordCompressionFailed('error');
    sendJson(res, 503, { error: { type: 'compression_error', message: (err as Error).message } });
  }
}

export function handleRetrieve(ctx: ProxyContext, res: ServerResponse, rawBody: Buffer, hashFromPath?: string): void {
  const body = parseJsonBody(rawBody) ?? {};
  const hash = typeof body.hash === 'string' ? body.hash : (hashFromPath ?? '');
  if (!hash) {
    sendJson(res, 400, { error: { type: 'invalid_request', message: 'hash required' } });
    return;
  }
  const args: Record<string, unknown> = { hash };
  for (const k of ['grep', 'head', 'tail', 'lines', 'jsonPath']) if (body[k] !== undefined) args[k] = body[k];
  const r = ctx.deps.executeRetrieve(args, { maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined });
  const entry = ctx.deps.store?.get(hash) ?? null;
  if (!r.found) {
    sendJson(res, 404, { error: { type: 'not_found', message: r.content }, hash });
    return;
  }
  sendJson(res, 200, { hash, original_content: r.content, truncated: r.truncated ?? false, original_tokens: entry?.originalTokens, compressed_tokens: entry?.compressedTokens, original_item_count: entry?.originalItemCount, compressed_item_count: entry?.compressedItemCount, tool_name: entry?.toolName, strategy: entry?.strategy });
}
