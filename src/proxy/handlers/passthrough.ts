/**
 * Pure pass-through routes (`count_tokens`, `embeddings`, `models`, …): the
 * request is forwarded with provider auth untouched and the response is
 * relayed byte for byte (framing headers dropped).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProxyContext } from '../context.js';
import { errorBody, sendJson } from '../http.js';
import { clientResponseHeaders, resolveUpstream, upstreamHeaders } from '../upstream.js';

export async function handlePassthrough(ctx: ProxyContext, req: IncomingMessage, res: ServerResponse, rawBody: Buffer, headers: Record<string, string>, path: string): Promise<void> {
  const upstream = resolveUpstream(path, headers, ctx.config);
  const method = (req.method ?? 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && rawBody.length > 0;
  const outHeaders = upstreamHeaders(headers, { stripInternal: ctx.stripInternalHeaders, bodyBytes: hasBody ? rawBody.length : undefined });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.limits.requestTimeoutMs);
  timer.unref?.();
  ctx.metrics.inboundTotal++;
  let response: Response;
  try {
    response = await ctx.transport(upstream.url, { method, headers: outHeaders, body: hasBody ? rawBody : undefined, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    ctx.metrics.recordUpstreamError(upstream.provider);
    sendJson(res, 502, errorBody(upstream.provider === 'anthropic' ? 'anthropic' : 'openai', 'api_error', `upstream unreachable: ${(err as Error).message}`));
    return;
  }
  const relayHeaders = clientResponseHeaders(response.headers);
  res.writeHead(response.status, relayHeaders);
  if (!response.body) {
    clearTimeout(timer);
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && !res.destroyed) res.write(Buffer.from(value));
    }
  } catch (err) {
    ctx.logger.warn('passthrough_interrupted', { path, message: (err as Error).message });
  } finally {
    clearTimeout(timer);
    if (!res.writableEnded) res.end();
  }
}
