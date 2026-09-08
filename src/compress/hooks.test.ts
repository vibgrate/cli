import { describe, expect, it } from 'vitest';
import { buildContext, countTurns, extractToolCalls, runComputeBiases, runComputeBiasesSync, runPostCompress, runPostCompressSync, runPreCompress, runPreCompressSync } from './hooks.js';
import { goldenConversation } from './test-double.js';
import type { CompressEvent } from './types.js';

const ctx = buildContext(goldenConversation(), { model: 'm', provider: 'anthropic' });

describe('context helpers', () => {
  it('builds the context from the conversation', () => {
    expect(ctx).toEqual({ model: 'm', userQuery: 'Why does the retry never succeed?', turnNumber: 7, toolCalls: ['list_services', 'Bash', 'Grep', 'Read'], provider: 'anthropic' });
    expect(countTurns([])).toBe(0);
    expect(extractToolCalls([{ role: 'assistant', tool_calls: [{ function: { name: 'a' } }, {}] }, { type: 'function_call', name: 'f' }, { role: 'model', parts: [{ functionCall: { name: 'g' } }] }])).toEqual(['a', 'unknown', 'f', 'g']);
  });
});

describe('hook runners', () => {
  it('isolate errors and validate shapes', async () => {
    const msgs = goldenConversation();
    expect(await runPreCompress({ preCompress: () => { throw new Error('x'); } }, msgs, ctx)).toEqual({ value: msgs, warnings: ['hook:preCompress threw: x'] });
    expect((await runPreCompress({ preCompress: () => 'nope' as unknown as [] }, msgs, ctx)).warnings[0]).toMatch(/non-array/);
    expect((await runPreCompress({ preCompress: async (m) => m.slice(1) }, msgs, ctx)).value).toHaveLength(msgs.length - 1);
    expect(await runComputeBiases({ computeBiases: () => ({ 0: 2, 1: -1, x: 3, 2: Number.NaN }) as Record<number, number> }, msgs, ctx)).toEqual({ value: { 0: 2 }, warnings: [] });
    expect((await runComputeBiases({ computeBiases: () => { throw new Error('b'); } }, msgs, ctx)).warnings).toEqual(['hook:computeBiases threw: b']);
    const ev: CompressEvent = { tokensBefore: 2, tokensAfter: 1, tokensSaved: 1, compressionRatio: 0.5, transformsApplied: ['a'], ccrHashes: [], model: 'm', userQuery: '', provider: 'p' };
    let seen: CompressEvent | undefined;
    expect(await runPostCompress({ postCompress: (e) => void (seen = e) }, ev)).toEqual([]);
    expect(seen).toEqual(ev);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(await runPostCompress({ postCompress: () => { throw new Error('p'); } }, ev)).toEqual(['hook:postCompress threw: p']);
    expect(await runPostCompress(undefined, ev)).toEqual([]);
  });

  it('sync variants skip async hooks with a warning', () => {
    const msgs = goldenConversation();
    expect(runPreCompressSync({ preCompress: async (m) => m }, msgs, ctx).warnings[0]).toMatch(/async/);
    expect(runPreCompressSync({ preCompress: (m) => m.slice(0, 1) }, msgs, ctx).value).toHaveLength(1);
    expect(runComputeBiasesSync({ computeBiases: async () => ({}) }, msgs, ctx).warnings[0]).toMatch(/async/);
    expect(runComputeBiasesSync({ computeBiases: () => ({ 3: 0.5 }) }, msgs, ctx).value).toEqual({ 3: 0.5 });
    const ev: CompressEvent = { tokensBefore: 2, tokensAfter: 1, tokensSaved: 1, compressionRatio: 0.5, transformsApplied: [], ccrHashes: [], model: 'm', userQuery: '', provider: 'p' };
    expect(runPostCompressSync({ postCompress: async () => undefined }, ev)).toEqual([]);
    expect(runPostCompressSync({ postCompress: () => { throw new Error('z'); } }, ev)).toEqual(['hook:postCompress threw: z']);
  });
});
