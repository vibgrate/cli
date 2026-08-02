import { describe, it, expect } from 'vitest';
import { parseTextToolCalls, textToolProtocolInstruction, withToolCallFallback } from './text-tool-protocol.js';
import type { ChatMessage, ChatOptions, Provider, ProviderResult, ToolSpec } from './types.js';

const TOOLS: ToolSpec[] = [
  { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { file: { type: 'string' } } } },
  { name: 'finish', description: 'Finish with a summary.', parameters: { type: 'object', properties: { summary: { type: 'string' } } } },
];

function fake(reply: ProviderResult | ((messages: ChatMessage[], opts?: ChatOptions) => ProviderResult), supportsTools?: boolean): Provider & { seen: { messages: ChatMessage[]; opts?: ChatOptions }[] } {
  const seen: { messages: ChatMessage[]; opts?: ChatOptions }[] = [];
  return {
    id: 'fake',
    label: 'Fake',
    local: true,
    model: 'fake-1',
    supportsTools,
    seen,
    async chat(messages: ChatMessage[], opts?: ChatOptions) {
      seen.push({ messages, opts });
      return typeof reply === 'function' ? reply(messages, opts) : reply;
    },
  };
}

describe('parseTextToolCalls', () => {
  it('parses Hermes/Qwen-style <tool_call> tags', () => {
    const { calls, text } = parseTextToolCalls(
      'Let me read that.\n<tool_call>{"name":"read_file","arguments":{"file":"a.ts"}}</tool_call>',
    );
    expect(calls).toEqual([{ id: 'text_0', name: 'read_file', arguments: { file: 'a.ts' } }]);
    expect(text).toBe('Let me read that.');
  });

  it('parses multiple tags in order', () => {
    const { calls } = parseTextToolCalls(
      '<tool_call>{"name":"read_file","arguments":{"file":"a.ts"}}</tool_call>\n<tool_call>{"name":"read_file","arguments":{"file":"b.ts"}}</tool_call>',
    );
    expect(calls.map((c) => c.arguments.file)).toEqual(['a.ts', 'b.ts']);
  });

  it('parses a fenced tool_call block', () => {
    const { calls, text } = parseTextToolCalls('```tool_call\n{"name":"finish","arguments":{"summary":"done"}}\n```');
    expect(calls).toEqual([{ id: 'text_0', name: 'finish', arguments: { summary: 'done' } }]);
    expect(text).toBe('');
  });

  it('parses a bare top-level JSON object with name+arguments', () => {
    const { calls } = parseTextToolCalls('{"name":"finish","arguments":{"summary":"all good"}}');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('finish');
  });

  it('accepts parameters/input as argument aliases', () => {
    const { calls } = parseTextToolCalls('<tool_call>{"name":"read_file","parameters":{"file":"a.ts"}}</tool_call>');
    expect(calls[0].arguments).toEqual({ file: 'a.ts' });
  });

  it('leaves ordinary prose and non-call JSON alone', () => {
    const prose = 'Here is the answer: use `read_file` on a.ts.';
    expect(parseTextToolCalls(prose)).toEqual({ calls: [], text: prose });
    const notCall = '```json\n{"foo": 1}\n```';
    expect(parseTextToolCalls(notCall).calls).toHaveLength(0);
  });

  it('tolerates malformed JSON inside a tag without dropping the text', () => {
    const raw = '<tool_call>{oops}</tool_call>';
    const { calls, text } = parseTextToolCalls(raw);
    expect(calls).toHaveLength(0);
    expect(text).toBe(raw);
  });
});

describe('withToolCallFallback', () => {
  const base: ChatMessage[] = [
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'Task: do the thing' },
  ];

  it('passes through a native provider untouched', async () => {
    const p = fake({ text: 'hi', model: 'fake-1', provider: 'fake', toolCalls: [{ id: '1', name: 'finish', arguments: {} }] });
    const wrapped = withToolCallFallback(p);
    const r = await wrapped.chat(base, { tools: TOOLS });
    expect(r.toolCalls).toHaveLength(1);
    expect(p.seen[0].opts?.tools).toEqual(TOOLS);
    expect(p.seen[0].messages).toBe(base);
  });

  it('rescues tool markup a native provider returned as plain text', async () => {
    const p = fake({
      text: '<tool_call>{"name":"read_file","arguments":{"file":"a.ts"}}</tool_call>',
      model: 'fake-1',
      provider: 'fake',
    });
    const r = await withToolCallFallback(p).chat(base, { tools: TOOLS });
    expect(r.toolCalls).toEqual([{ id: 'text_0', name: 'read_file', arguments: { file: 'a.ts' } }]);
    expect(r.text).toBe('');
  });

  it('teaches the text protocol to a provider without native tools', async () => {
    const p = fake({ text: '<tool_call>{"name":"finish","arguments":{"summary":"ok"}}</tool_call>', model: 'fake-1', provider: 'fake' }, false);
    const r = await withToolCallFallback(p).chat(base, { tools: TOOLS });
    expect(r.toolCalls?.[0].name).toBe('finish');
    // The system prompt gained the protocol instruction; tools were not passed down.
    const sent = p.seen[0];
    expect(sent.messages[0].content).toContain('## Tool calling (text protocol)');
    expect(sent.messages[0].content).toContain('read_file');
    expect(sent.opts?.tools).toBeUndefined();
  });

  it('flattens prior tool rounds into text for non-native backends', async () => {
    const history: ChatMessage[] = [
      ...base,
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file', arguments: { file: 'a.ts' } }] },
      { role: 'tool', content: 'file body', toolCallId: '1', name: 'read_file' },
    ];
    const p = fake({ text: 'prose answer that is long enough', model: 'fake-1', provider: 'fake' }, false);
    await withToolCallFallback(p).chat(history, { tools: TOOLS });
    const sent = p.seen[0].messages;
    expect(sent.some((m) => m.role === 'tool')).toBe(false);
    expect(sent.find((m) => m.role === 'assistant')?.content).toContain('<tool_call>');
    expect(sent.find((m) => m.role === 'user' && m.content.startsWith('Tool result for read_file'))).toBeTruthy();
  });

  it('forces the text protocol when the capability registry marks the model incapable', async () => {
    // Backend is native-capable, but the model is known not to tool-call.
    const p = fake({ text: '<tool_call>{"name":"finish","arguments":{"summary":"ok"}}</tool_call>', model: 'fake-1', provider: 'fake' }, true);
    const r = await withToolCallFallback(p, { nativeTools: false }).chat(base, { tools: TOOLS });
    expect(r.toolCalls?.[0].name).toBe('finish');
    expect(p.seen[0].messages[0].content).toContain('## Tool calling (text protocol)');
    expect(p.seen[0].opts?.tools).toBeUndefined();
  });

  it('returns plain prose unchanged when the model answered without tools', async () => {
    const p = fake({ text: 'The answer is 42.', model: 'fake-1', provider: 'fake' }, false);
    const r = await withToolCallFallback(p).chat(base, { tools: TOOLS });
    expect(r.text).toBe('The answer is 42.');
    expect(r.toolCalls).toBeUndefined();
  });
});

describe('textToolProtocolInstruction', () => {
  it('names every tool with its first description line', () => {
    const s = textToolProtocolInstruction(TOOLS);
    expect(s).toContain('read_file');
    expect(s).toContain('finish');
    expect(s).toContain('<tool_call>');
  });
});
