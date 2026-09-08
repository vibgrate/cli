import { describe, expect, it } from 'vitest';
import { detectFormat, enumerateBlocks, extractUserQuery, fromOpenAI, lastAssistantIndex, latestUserMessageIndex, toOpenAI, toolArgsIndex, toolNameIndex, walkTextBlocks } from './format.js';
import { goldenConversation } from './test-double.js';
import type { Message } from './types.js';

describe('detectFormat', () => {
  it('recognises every shape structurally', () => {
    expect(detectFormat([{ role: 'user', content: 'hi' }])).toBe('openai');
    expect(detectFormat([{ role: 'assistant', content: null, tool_calls: [] }])).toBe('openai');
    expect(detectFormat([{ role: 'tool', tool_call_id: 'x', content: 'y' }])).toBe('openai');
    expect(detectFormat(goldenConversation())).toBe('anthropic');
    expect(detectFormat([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }])).toBe('anthropic');
    expect(detectFormat([{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 't', input: {} }] }])).toBe('vercel');
    expect(detectFormat([{ role: 'user', content: [{ type: 'image', image: 'https://x/y.png' }] }])).toBe('vercel');
    expect(detectFormat([{ role: 'model', parts: [{ text: 'hi' }] }])).toBe('gemini');
    expect(detectFormat([{ role: 'user', parts: [{ text: 'hi' }] }])).toBe('gemini');
    expect(detectFormat([{ type: 'function_call_output', call_id: 'c', output: 'o' }])).toBe('responses');
    expect(detectFormat([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] }])).toBe('responses');
    expect(detectFormat([])).toBe('openai');
  });
});

describe('toolNameIndex / toolArgsIndex', () => {
  it('maps ids to names and parsed args across formats', () => {
    const names = toolNameIndex(goldenConversation());
    expect(names.get('toolu_02')).toBe('Bash');
    expect(names.get('toolu_04')).toBe('Read');
    const args = toolArgsIndex(goldenConversation());
    expect(args.get('toolu_04')).toEqual({ file_path: 'src/services/billing/handlers/invoice_3.ts' });
    const oai: Message[] = [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }] }];
    expect(toolNameIndex(oai).get('c1')).toBe('Read');
    expect(toolArgsIndex(oai).get('c1')).toEqual({ path: 'a.ts' });
    const resp: Message[] = [{ type: 'function_call', call_id: 'f1', name: 'Grep', arguments: 'not json' }];
    expect(toolNameIndex(resp).get('f1')).toBe('Grep');
    expect(toolArgsIndex(resp).get('f1')).toBe('not json');
    const gem: Message[] = [{ role: 'model', parts: [{ functionCall: { name: 'ls', args: { p: '.' } } }] }];
    expect(toolNameIndex(gem).get('ls')).toBe('ls');
  });
});

describe('enumerateBlocks / walkTextBlocks', () => {
  it('visits text and tool results with mutators, skipping hot-zone blocks', () => {
    const msgs = goldenConversation();
    const blocks = enumerateBlocks(msgs);
    const kinds = blocks.map((b) => `${b.messageIndex}:${b.blockType}:${b.kind}`);
    expect(kinds).toContain('1:tool_use:other');
    expect(kinds).toContain('2:tool_result:tool_result');
    expect(kinds).toContain('0:string:text');
    const seen: string[] = [];
    walkTextBlocks(msgs, (b) => {
      seen.push(`${b.messageIndex}/${b.blockType}/${b.toolName ?? '-'}`);
      if (b.messageIndex === 4) b.set('REPLACED');
    });
    expect(seen).toContain('4/tool_result/Bash');
    expect(seen).not.toContain('1/tool_use/list_services');
    expect((msgs[4] as { content: Array<{ content: string }> }).content[0].content).toBe('REPLACED');
  });

  it('flattens list-form tool_result text and re-wraps on write-back, reporting cache_control and is_error', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] }, { type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'x' }, { type: 'image', source: {} }] }] },
    ];
    const blocks = enumerateBlocks(msgs);
    expect(blocks[0]).toMatchObject({ kind: 'tool_result', text: 'a\nb', cacheControl: true, isError: true });
    expect(blocks[1]).toMatchObject({ kind: 'text', cacheControl: true });
    expect(blocks[2]).toMatchObject({ kind: 'other', blockType: 'tool_result' });
    blocks[0].set('joined');
    expect((msgs[0] as { content: Array<{ content: unknown }> }).content[0].content).toEqual([{ type: 'text', text: 'joined', cache_control: { type: 'ephemeral' } }]);
  });

  it('handles OpenAI tool messages, Vercel tool-results, Gemini functionResponses and Responses outputs', () => {
    const oai: Message[] = [{ role: 'tool', tool_call_id: 'c', content: 'out', name: 'Bash' }, { role: 'assistant', content: 'hi', tool_calls: [{ id: 'c', type: 'function', function: { name: 'Bash', arguments: '{}' } }] }];
    const ob = enumerateBlocks(oai);
    expect(ob[0]).toMatchObject({ kind: 'tool_result', toolName: 'Bash', toolCallId: 'c' });
    ob[0].set('new');
    expect(oai[0].content).toBe('new');
    const vercel: Message[] = [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'v', toolName: 'db', output: { type: 'json', value: { rows: [1, 2] } } }, { type: 'tool-result', toolCallId: 'w', toolName: 'sh', result: 'text out' }] }];
    const vb = enumerateBlocks(vercel);
    expect(vb[0]).toMatchObject({ kind: 'tool_result', toolName: 'db', text: '{"rows":[1,2]}' });
    vb[0].set('{"rows":[1]}');
    vb[1].set('shorter');
    const parts = (vercel[0] as { content: Array<Record<string, unknown>> }).content;
    expect(parts[0].output).toEqual({ type: 'json', value: { rows: [1] } });
    expect(parts[1].result).toBe('shorter');
    const gem: Message[] = [{ role: 'user', parts: [{ functionResponse: { name: 'ls', response: { content: 'a\nb' } } }, { functionResponse: { name: 'raw', response: 'plain' } }, { text: 'hello' }] }];
    const gb = enumerateBlocks(gem);
    expect(gb[0]).toMatchObject({ kind: 'tool_result', toolName: 'ls', text: 'a\nb', role: 'tool' });
    gb[0].set('a');
    gb[1].set('p');
    gb[2].set('hi');
    expect((gem[0] as { parts: Array<Record<string, unknown>> }).parts).toEqual([{ functionResponse: { name: 'ls', response: { content: 'a' } } }, { functionResponse: { name: 'raw', response: 'p' } }, { text: 'hi' }]);
    const resp: Message[] = [{ type: 'function_call', call_id: 'f', name: 'Bash', arguments: '{}' }, { type: 'function_call_output', call_id: 'f', output: 'o' }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] }, { role: 'user', content: 'plain' }];
    const rb = enumerateBlocks(resp);
    expect(rb.map((b) => `${b.kind}:${b.blockType}`)).toEqual(['other:function_call', 'tool_result:tool_result', 'text:text', 'text:string']);
    expect(rb[1].toolName).toBe('Bash');
    rb[1].set('o2');
    rb[2].set('q2');
    expect(resp[1].output).toBe('o2');
  });

  it('helpers: latest user / last assistant / user query', () => {
    const msgs = goldenConversation();
    expect(latestUserMessageIndex(msgs)).toBe(11);
    expect(lastAssistantIndex(msgs)).toBe(9);
    expect(extractUserQuery(msgs)).toBe('Why does the retry never succeed?');
    expect(extractUserQuery([{ role: 'user', parts: [{ text: 'g' }] }])).toBe('g');
    expect(extractUserQuery([])).toBe('');
  });
});

describe('toOpenAI / fromOpenAI', () => {
  it('anthropic → openai → anthropic is the identity when only text changes', () => {
    const original = goldenConversation();
    (original[2] as Record<string, unknown>).content = [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'x', cache_control: { type: 'ephemeral' } }];
    const oai = toOpenAI(original, 'anthropic');
    expect(detectFormat(oai)).toBe('openai');
    expect(oai[1]).toMatchObject({ role: 'assistant', content: 'Listing services.', tool_calls: [{ id: 'toolu_01', function: { name: 'list_services' } }] });
    expect(oai[2]).toMatchObject({ role: 'tool', tool_call_id: 'toolu_01', content: 'x', cache_control: { type: 'ephemeral' } });
    const back = fromOpenAI(structuredClone(oai), 'anthropic', original);
    expect(back).toEqual(original);
    // Rewrite one tool result in the OpenAI view and check only that text changed.
    const edited = structuredClone(oai);
    (edited[4] as Record<string, unknown>).content = 'SHORT';
    const back2 = fromOpenAI(edited, 'anthropic', original);
    expect((back2[4] as { content: Array<{ content: string }> }).content[0].content).toBe('SHORT');
    (back2[4] as { content: Array<{ content: string }> }).content[0].content = (original[4] as { content: Array<{ content: string }> }).content[0].content;
    expect(back2).toEqual(original);
  });

  it('structural conversion without an original keeps ids, cache_control and is_error', () => {
    const anth: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'a' }, { type: 'tool_use', id: 'u', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u', is_error: true, content: 'err' }] },
    ];
    const roundtrip = fromOpenAI(toOpenAI(anth, 'anthropic'), 'anthropic');
    expect(roundtrip).toEqual(anth);
  });

  it('vercel, gemini and responses round-trip through the OpenAI view', () => {
    const vercel: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool-call', toolCallId: 'v1', toolName: 'db', input: { q: 1 } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'v1', toolName: 'db', output: { type: 'json', value: { rows: [] } } }] },
    ];
    expect(fromOpenAI(toOpenAI(vercel, 'vercel'), 'vercel', vercel)).toEqual(vercel);
    expect(fromOpenAI(toOpenAI(vercel, 'vercel'), 'vercel')).toEqual(vercel);
    const gem: Message[] = [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'ok' }, { functionCall: { name: 'ls', args: { p: '.' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'ls', response: { content: 'a' } } }] },
    ];
    const gOai = toOpenAI(gem, 'gemini');
    expect(gOai[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'gemini_ls_1', function: { name: 'ls' } }] });
    expect(fromOpenAI(gOai, 'gemini', gem)).toEqual(gem);
    expect(fromOpenAI(gOai, 'gemini')).toEqual(gem);
    const resp: Message[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      { type: 'function_call', call_id: 'f1', name: 'Bash', arguments: '{"command":"ls"}' },
      { type: 'function_call_output', call_id: 'f1', output: 'a\nb' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ];
    const rOai = toOpenAI(resp, 'responses');
    expect(rOai[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'f1' }] });
    expect(rOai[2]).toMatchObject({ role: 'tool', tool_call_id: 'f1', content: 'a\nb' });
    expect(fromOpenAI(rOai, 'responses', resp)).toEqual(resp);
    expect(fromOpenAI(rOai, 'responses')).toEqual(resp);
  });
});
