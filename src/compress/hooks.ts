/**
 * Hook runner with error isolation. A throwing hook never breaks a request:
 * `preCompress` falls back to the input messages, `computeBiases` to `{}`,
 * `postCompress` errors are swallowed. Sync callers get the same semantics
 * minus promises (an async hook on the sync path is reported, not awaited).
 */

import type { CompressContext, CompressEvent, CompressionHooks, Message } from './types.js';
import { extractUserQuery } from './format.js';

function isThenable(v: unknown): v is Promise<unknown> {
  return !!v && typeof (v as { then?: unknown }).then === 'function';
}

/** Number of user turns so far. */
export function countTurns(messages: Message[]): number {
  let n = 0;
  for (const m of messages) if (m && typeof m === 'object' && (m as Record<string, unknown>).role === 'user') n += 1;
  return n;
}

/** Tool names called anywhere in the conversation (all formats), in order. */
export function extractToolCalls(messages: Message[]): string[] {
  const names: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as Record<string, unknown>;
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const t = tc as Record<string, unknown>;
        const fn = t?.function as Record<string, unknown> | undefined;
        names.push(String(fn?.name ?? t?.name ?? 'unknown'));
      }
    }
    if (msg.type === 'function_call') names.push(String(msg.name ?? 'unknown'));
    if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        const part = p as Record<string, unknown>;
        if (part?.type === 'tool_use') names.push(String(part.name ?? 'unknown'));
        if (part?.type === 'tool-call') names.push(String(part.toolName ?? 'unknown'));
      }
    }
    if (Array.isArray(msg.parts)) {
      for (const p of msg.parts) {
        const fc = (p as Record<string, unknown>)?.functionCall as Record<string, unknown> | undefined;
        if (fc) names.push(String(fc.name ?? 'unknown'));
      }
    }
  }
  return names;
}

export function buildContext(messages: Message[], opts: { model?: string; provider?: string }): CompressContext {
  return { model: opts.model ?? '', userQuery: extractUserQuery(messages), turnNumber: countTurns(messages), toolCalls: extractToolCalls(messages), provider: opts.provider ?? '' };
}

export interface HookOutcome<T> {
  value: T;
  warnings: string[];
}

export async function runPreCompress(hooks: CompressionHooks | undefined, messages: Message[], ctx: CompressContext): Promise<HookOutcome<Message[]>> {
  if (!hooks?.preCompress) return { value: messages, warnings: [] };
  try {
    const out = await hooks.preCompress(messages, ctx);
    return Array.isArray(out) ? { value: out, warnings: [] } : { value: messages, warnings: ['hook:preCompress returned a non-array; ignored'] };
  } catch (err) {
    return { value: messages, warnings: [`hook:preCompress threw: ${(err as Error).message}`] };
  }
}

export function runPreCompressSync(hooks: CompressionHooks | undefined, messages: Message[], ctx: CompressContext): HookOutcome<Message[]> {
  if (!hooks?.preCompress) return { value: messages, warnings: [] };
  try {
    const out = hooks.preCompress(messages, ctx);
    if (isThenable(out)) {
      void out.catch(() => undefined);
      return { value: messages, warnings: ['hook:preCompress is async; skipped on the sync path'] };
    }
    return Array.isArray(out) ? { value: out, warnings: [] } : { value: messages, warnings: ['hook:preCompress returned a non-array; ignored'] };
  } catch (err) {
    return { value: messages, warnings: [`hook:preCompress threw: ${(err as Error).message}`] };
  }
}

function sanitizeBiases(v: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, f] of Object.entries(v as Record<string, unknown>)) {
    const i = Number.parseInt(k, 10);
    if (!Number.isInteger(i) || i < 0) continue;
    if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0) continue;
    out[i] = f;
  }
  return out;
}

export async function runComputeBiases(hooks: CompressionHooks | undefined, messages: Message[], ctx: CompressContext): Promise<HookOutcome<Record<number, number>>> {
  if (!hooks?.computeBiases) return { value: {}, warnings: [] };
  try {
    return { value: sanitizeBiases(await hooks.computeBiases(messages, ctx)), warnings: [] };
  } catch (err) {
    return { value: {}, warnings: [`hook:computeBiases threw: ${(err as Error).message}`] };
  }
}

export function runComputeBiasesSync(hooks: CompressionHooks | undefined, messages: Message[], ctx: CompressContext): HookOutcome<Record<number, number>> {
  if (!hooks?.computeBiases) return { value: {}, warnings: [] };
  try {
    const out = hooks.computeBiases(messages, ctx);
    if (isThenable(out)) {
      void out.catch(() => undefined);
      return { value: {}, warnings: ['hook:computeBiases is async; skipped on the sync path'] };
    }
    return { value: sanitizeBiases(out), warnings: [] };
  } catch (err) {
    return { value: {}, warnings: [`hook:computeBiases threw: ${(err as Error).message}`] };
  }
}

export async function runPostCompress(hooks: CompressionHooks | undefined, event: CompressEvent): Promise<string[]> {
  if (!hooks?.postCompress) return [];
  try {
    await hooks.postCompress(Object.freeze({ ...event, transformsApplied: [...event.transformsApplied], ccrHashes: [...event.ccrHashes] }));
    return [];
  } catch (err) {
    return [`hook:postCompress threw: ${(err as Error).message}`];
  }
}

export function runPostCompressSync(hooks: CompressionHooks | undefined, event: CompressEvent): string[] {
  if (!hooks?.postCompress) return [];
  try {
    const out = hooks.postCompress(Object.freeze({ ...event, transformsApplied: [...event.transformsApplied], ccrHashes: [...event.ccrHashes] }));
    if (isThenable(out)) void out.catch(() => undefined);
    return [];
  } catch (err) {
    return [`hook:postCompress threw: ${(err as Error).message}`];
  }
}
