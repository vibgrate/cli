import { describe, expect, it } from 'vitest';
import { buildRetrieveResultMessages, executeRetrieve, extractAllToolCalls, extractRetrieveCalls, MAX_RETRIEVE_ROUNDS, neutralizeRetrieveHistory, residualStatus, retrieveOptionsFromArgs, runRetrieveLoop } from './handler.js';
import { CompressionStore } from './store.js';
import type { Message } from '../types.js';

const ORIGINAL = Array.from({ length: 30 }, (_, i) => `row ${i}: value ${i * 3}`).join('\n');

function storeWith(): { store: CompressionStore; hash: string } {
  const store = new CompressionStore({ now: () => 1000 });
  const hash = store.store(ORIGINAL, { compressed: 'compressed', strategy: 'log', originalItemCount: 30 });
  return { store, hash };
}

describe('extractRetrieveCalls', () => {
  it('reads every response shape', () => {
    const anth = { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'tu1', name: 'vg_retrieve', input: { hash: 'abc' } }, { type: 'tool_use', id: 'tu2', name: 'other', input: {} }] };
    expect(extractAllToolCalls(anth, 'anthropic')).toEqual({ retrieve: [{ id: 'tu1', name: 'vg_retrieve', args: { hash: 'abc' } }], other: [{ id: 'tu2', name: 'other', args: {} }] });
    const oai = { choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'vg_retrieve', arguments: '{"hash":"abc","head":3}' } }] } }] };
    expect(extractRetrieveCalls(oai, 'openai')).toEqual([{ id: 'c1', name: 'vg_retrieve', args: { hash: 'abc', head: 3 } }]);
    const resp = { output: [{ type: 'function_call', call_id: 'fc1', name: 'vg_retrieve', arguments: '{"hash":"abc"}' }] };
    expect(extractRetrieveCalls(resp, 'responses')[0].id).toBe('fc1');
    const gem = { candidates: [{ content: { parts: [{ functionCall: { name: 'vg_retrieve', args: { hash: 'abc' } } }] } }] };
    expect(extractRetrieveCalls(gem, 'gemini')).toEqual([{ id: 'vg_retrieve', name: 'vg_retrieve', args: { hash: 'abc' } }]);
    expect(extractRetrieveCalls({ choices: [null] }, 'openai')).toEqual([]);
    expect(extractRetrieveCalls({ choices: [{ message: { tool_calls: null } }] }, 'openai')).toEqual([]);
  });

  it('residual status', () => {
    expect(residualStatus({ content: [] }, 'anthropic')).toBe('resolved');
    expect(residualStatus({ content: [{ type: 'tool_use', id: 'a', name: 'vg_retrieve', input: {} }] }, 'anthropic')).toBe('error');
    expect(residualStatus({ content: [{ type: 'tool_use', id: 'a', name: 'vg_retrieve', input: {} }, { type: 'tool_use', id: 'b', name: 'x', input: {} }] }, 'anthropic')).toBe('skipped_mixed_tools');
  });
});

describe('executeRetrieve', () => {
  it('returns the original for a valid hash and targeted views from args', () => {
    const { store, hash } = storeWith();
    const r = executeRetrieve(store, { hash: hash.toUpperCase() });
    expect(r.found).toBe(true);
    const body = JSON.parse(r.content) as Record<string, unknown>;
    expect(body.original_content).toBe(ORIGINAL);
    expect(body.original_item_count).toBe(30);
    const head = JSON.parse(executeRetrieve(store, { hash, head: 2 }).content) as Record<string, unknown>;
    expect(head.original_content).toBe('row 0: value 0\nrow 1: value 3');
    expect(head.view).toBe('head');
    const grep = JSON.parse(executeRetrieve(store, { hash, grep: 'value 27' }).content) as Record<string, unknown>;
    expect(grep.original_content).toBe('10:row 9: value 27');
    expect(retrieveOptionsFromArgs({ lines: '3-5', max_tokens: '20', json_path: 'a.b' })).toEqual({ lines: [3, 5], maxTokens: 20, jsonPath: 'a.b' });
  });

  it('explains misses without throwing', () => {
    const { store } = storeWith();
    const bad = JSON.parse(executeRetrieve(store, { hash: 'nope' }).content) as Record<string, unknown>;
    expect(bad.error).toMatch(/12 or 24 hex/);
    const missing = JSON.parse(executeRetrieve(store, { hash: '000000000000000000000000' }).content) as Record<string, unknown>;
    expect(missing.status).toBe('missing');
    expect(missing.error).toMatch(/Do not retry/);
    expect(missing.ttl_seconds).toBe(1800);
  });
});

describe('buildRetrieveResultMessages', () => {
  const calls = [{ id: 'id1', name: 'vg_retrieve', args: { hash: 'h' } }];
  const results = [{ content: '{"ok":true}' }];
  it('anthropic: assistant tool_use + user tool_result', () => {
    const m = buildRetrieveResultMessages(calls, results, 'anthropic');
    expect(m).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'id1', name: 'vg_retrieve', input: { hash: 'h' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'id1', content: '{"ok":true}' }] },
    ]);
  });
  it('openai: assistant tool_calls + tool messages', () => {
    const m = buildRetrieveResultMessages(calls, results, 'openai');
    expect(m[0]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'id1', function: { name: 'vg_retrieve' } }] });
    expect(m[1]).toEqual({ role: 'tool', tool_call_id: 'id1', content: '{"ok":true}' });
  });
  it('responses and gemini shapes', () => {
    expect(buildRetrieveResultMessages(calls, results, 'responses')).toEqual([
      { type: 'function_call', call_id: 'id1', name: 'vg_retrieve', arguments: '{"hash":"h"}' },
      { type: 'function_call_output', call_id: 'id1', output: '{"ok":true}' },
    ]);
    const g = buildRetrieveResultMessages(calls, results, 'gemini');
    expect(g[1]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'vg_retrieve', response: { ok: true } } }] });
  });
});

describe('runRetrieveLoop', () => {
  it('round-trips one retrieval and returns the final answer', async () => {
    const { store, hash } = storeWith();
    const first = { content: [{ type: 'tool_use', id: 'tu1', name: 'vg_retrieve', input: { hash } }], stop_reason: 'tool_use' };
    const seen: Message[][] = [];
    const r = await runRetrieveLoop(first, [{ role: 'user', content: 'q' }], {
      store,
      format: 'anthropic',
      call: async (msgs) => {
        seen.push(msgs);
        return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
      },
    });
    expect(r.rounds).toBe(1);
    expect(r.retrievals).toBe(1);
    expect(r.status).toBe('resolved');
    expect(r.response.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(seen[0]).toHaveLength(3);
    expect(seen[0][1]).toEqual({ role: 'assistant', content: first.content });
    const toolResult = (seen[0][2] as { content: Array<{ content: string }> }).content[0].content;
    expect(JSON.parse(toolResult).original_content).toBe(ORIGINAL);
  });

  it('stops after MAX_RETRIEVE_ROUNDS and on mixed tool turns', async () => {
    const { store, hash } = storeWith();
    const again = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'vg_retrieve', arguments: JSON.stringify({ hash }) } }] } }] };
    let calls = 0;
    const r = await runRetrieveLoop(again, [], { store, format: 'openai', call: async () => (calls += 1, again) });
    expect(MAX_RETRIEVE_ROUNDS).toBe(3);
    expect(r.rounds).toBe(3);
    expect(calls).toBe(3);
    expect(r.status).toBe('error');
    const mixed = { choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'vg_retrieve', arguments: '{}' } }, { id: 'b', function: { name: 'x', arguments: '{}' } }] } }] };
    const m = await runRetrieveLoop(mixed, [], { store, format: 'openai', call: async () => mixed });
    expect(m.rounds).toBe(0);
    expect(m.status).toBe('skipped_mixed_tools');
  });

  it('extends Responses conversations with output items and reports upstream errors', async () => {
    const { store, hash } = storeWith();
    const first = { output: [{ type: 'function_call', call_id: 'fc1', name: 'vg_retrieve', arguments: JSON.stringify({ hash }) }] };
    const seen: Message[][] = [];
    const r = await runRetrieveLoop(first, [{ role: 'user', content: 'q' }], {
      store,
      format: 'responses',
      call: async (msgs) => {
        seen.push(msgs);
        throw new Error('upstream down');
      },
    });
    expect(seen[0].map((m) => m.type)).toEqual([undefined, 'function_call', 'function_call_output']);
    expect(r.upstreamError).toBe('upstream down');
    expect(r.status).toBe('error');
  });
});

describe('neutralizeRetrieveHistory', () => {
  it('replaces prior retrieve rounds with text, never dropping messages', () => {
    const anth: Message[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'vg_retrieve', input: { hash: 'abcdef012345' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'stuff' }, { type: 'text', text: 'next' }] },
    ];
    const out = neutralizeRetrieveHistory(anth, 'anthropic');
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '[retrieved original for hash=abcdef012345]' }] });
    expect(out[2]).toEqual({ role: 'user', content: [{ type: 'text', text: '[retrieved original: 5 chars]' }, { type: 'text', text: 'next' }] });
    expect(anth[1]).toMatchObject({ content: [{ type: 'tool_use' }] });
    const oai: Message[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'vg_retrieve', arguments: '{"hash":"abcdef012345"}' } }, { id: 'c2', type: 'function', function: { name: 'keep', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'x' },
      { role: 'tool', tool_call_id: 'c2', content: 'y' },
    ];
    const o = neutralizeRetrieveHistory(oai, 'openai');
    expect(o[0]).toMatchObject({ content: '[retrieved original for hash=abcdef012345]', tool_calls: [{ id: 'c2' }] });
    expect(o[1]).toEqual({ role: 'user', content: '[retrieved original: 1 chars]' });
    expect(o[2]).toEqual(oai[2]);
    const resp = neutralizeRetrieveHistory([{ type: 'function_call', call_id: 'f', name: 'vg_retrieve', arguments: '{"hash":"abcdef012345"}' }, { type: 'function_call_output', call_id: 'f', output: 'zz' }], 'responses');
    expect(resp.map((m) => m.type)).toEqual(['message', 'message']);
    const gem = neutralizeRetrieveHistory([{ role: 'model', parts: [{ functionCall: { name: 'vg_retrieve', args: { hash: 'abcdef012345' } } }] }, { role: 'user', parts: [{ functionResponse: { name: 'vg_retrieve', response: { a: 1 } } }] }], 'gemini');
    expect(gem[0]).toEqual({ role: 'model', parts: [{ text: '[retrieved original for hash=abcdef012345]' }] });
    expect((gem[1] as { parts: Array<{ text: string }> }).parts[0].text).toMatch(/retrieved original/);
  });
});
