import { describe, expect, it } from 'vitest';
import { BUFFERED_GRACE_SECONDS, HEARTBEAT_INTERVAL_SECONDS, heartbeatFrame, parseSseText, reconstructAnthropicResponse, reconstructOpenAIChatResponse, reconstructOpenAIResponsesResponse, responseToSse, SseBuffer, streamMentionsRetrieveTool } from './streaming.js';

function ev(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('SseBuffer', () => {
  it('splits frames, tolerates CRLF, partial frames and multi-byte splits', () => {
    const b = new SseBuffer();
    const text = 'event: a\ndata: {"x":"héllo"}\n\nevent: b\r\ndata: 1\r\ndata: 2\r\n\r\n: comment\n\ndata: tail';
    const bytes = Buffer.from(text, 'utf8');
    // Split inside the multi-byte "é".
    const cut = bytes.indexOf(Buffer.from('é')) + 1;
    b.push(bytes.subarray(0, cut));
    expect(b.events()).toEqual([]);
    b.push(bytes.subarray(cut));
    const events = b.events();
    expect(events.map((e) => e.event)).toEqual(['a', 'b']);
    expect(JSON.parse(events[0].data)).toEqual({ x: 'héllo' });
    expect(events[1].data).toBe('1\n2');
    expect(b.pending()).toBe('data: tail');
    b.push('\n\n');
    expect(b.events()).toHaveLength(3);
    expect(b.drain()).toBe(text + '\n\n');
    expect(b.events()).toEqual([]);
  });

  it('flags overflow past maxBytes', () => {
    const b = new SseBuffer({ maxBytes: 10 });
    b.push('data: 1\n\n');
    expect(b.overflowed).toBe(false);
    b.push('data: 22\n\n');
    expect(b.overflowed).toBe(true);
    expect(b.bytes).toBe(19);
  });

  it('parseSseText and constants', () => {
    expect(parseSseText('data: a\n\ndata: [DONE]').map((e) => e.data)).toEqual(['a', '[DONE]']);
    expect(BUFFERED_GRACE_SECONDS).toBe(5);
    expect(HEARTBEAT_INTERVAL_SECONDS).toBe(0.25);
    expect(heartbeatFrame()).toBe(': vg-heartbeat\n\n');
  });
});

describe('reconstructAnthropicResponse', () => {
  it('rebuilds text, tool_use (input_json_delta), thinking and usage', () => {
    const stream =
      ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }) +
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me ' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 1 }) +
      ev('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu', name: 'vg_retrieve', input: {} } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"ha' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'sh":"abc"}' } }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 2 }) +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } }) +
      ev('message_stop', { type: 'message_stop' });
    const r = reconstructAnthropicResponse(parseSseText(stream))!;
    expect(r.id).toBe('msg_1');
    expect(r.stop_reason).toBe('tool_use');
    expect(r.usage).toEqual({ input_tokens: 10, output_tokens: 42 });
    expect(r.content).toEqual([
      { type: 'thinking', thinking: 'let me ', signature: 'sig' },
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'tu', name: 'vg_retrieve', input: { hash: 'abc' } },
    ]);
    expect(reconstructAnthropicResponse([])).toBeNull();
  });

  it('round-trips through responseToSse', () => {
    const response = { id: 'msg_2', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't', name: 'x', input: { a: 1 } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } };
    const back = reconstructAnthropicResponse(parseSseText(responseToSse(response, 'anthropic')))!;
    expect(back.content).toEqual(response.content);
    expect(back.stop_reason).toBe('tool_use');
  });
});

describe('reconstructOpenAIChatResponse', () => {
  it('accumulates content and tool_calls by index; finish_reason tool_calls when calls exist', () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null): string => `data: ${JSON.stringify({ id: 'c1', created: 5, model: 'gpt', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const stream =
      chunk({ role: 'assistant', content: '' }) +
      chunk({ content: 'Hi' }) +
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'vg_retrieve', arguments: '' } }] }) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"hash":' } }] }) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"abc"}' } }] }) +
      chunk({}, 'stop') +
      `data: ${JSON.stringify({ id: 'c1', choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } })}\n\n` +
      'data: [DONE]\n\n';
    const r = reconstructOpenAIChatResponse(parseSseText(stream))!;
    expect(r).toMatchObject({ id: 'c1', created: 5, model: 'gpt', object: 'chat.completion', usage: { prompt_tokens: 3, completion_tokens: 4 } });
    const choice = (r.choices as Array<Record<string, unknown>>)[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message).toEqual({ role: 'assistant', content: 'Hi', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'vg_retrieve', arguments: '{"hash":"abc"}' } }] });
    const back = reconstructOpenAIChatResponse(parseSseText(responseToSse(r, 'openai')))!;
    expect((back.choices as Array<Record<string, unknown>>)[0].message).toEqual(choice.message);
    expect(responseToSse(r, 'openai').endsWith('data: [DONE]\n\n')).toBe(true);
    expect(reconstructOpenAIChatResponse([{ data: '[DONE]' }])).toBeNull();
  });
});

describe('reconstructOpenAIResponsesResponse', () => {
  it('prefers the completed response and otherwise assembles items from deltas', () => {
    const completed = { id: 'resp_1', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] };
    const s1 = ev('response.created', { type: 'response.created', response: { id: 'resp_1', object: 'response', status: 'in_progress', output: [] } }) + ev('response.completed', { type: 'response.completed', response: completed });
    expect(reconstructOpenAIResponsesResponse(parseSseText(s1))).toEqual(completed);
    const s2 =
      ev('response.created', { type: 'response.created', response: { id: 'resp_2', object: 'response', output: [] } }) +
      ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'fc', name: 'vg_retrieve', arguments: '' } }) +
      ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"hash"' }) +
      ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, delta: ':"abc"}' }) +
      ev('response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant', content: [] } }) +
      ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'par' }) +
      ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'tial' });
    const r = reconstructOpenAIResponsesResponse(parseSseText(s2))!;
    expect(r.id).toBe('resp_2');
    expect(r.output).toEqual([
      { type: 'function_call', call_id: 'fc', name: 'vg_retrieve', arguments: '{"hash":"abc"}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', annotations: [], text: 'partial' }] },
    ]);
    const back = reconstructOpenAIResponsesResponse(parseSseText(responseToSse(completed, 'responses')));
    expect(back).toEqual(completed);
    expect(reconstructOpenAIResponsesResponse([])).toBeNull();
  });
});

describe('streamMentionsRetrieveTool', () => {
  it('is a cheap byte check', () => {
    const b = new SseBuffer();
    b.push('data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"vg_retrieve"}}\n\n');
    expect(streamMentionsRetrieveTool(b)).toBe(true);
    const c = new SseBuffer();
    c.push('data: {"delta":{"text":"vg_retrieve is a tool"}}\n\n');
    expect(streamMentionsRetrieveTool(c)).toBe(false);
  });
});
