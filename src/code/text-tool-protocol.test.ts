import { describe, it, expect } from 'vitest';
import {
  looksLikeBrokenJsonDump,
  looksLikeToolCallDump,
  normalizeToolName,
  parseTextToolCalls,
  textToolProtocolInstruction,
  withToolCallFallback,
} from './text-tool-protocol.js';
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

  it('maps a spaced tool name onto the advertised tool', () => {
    const { calls } = parseTextToolCalls('{"name":"read file","arguments":{"path":"src/greet.ts"}}');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].arguments).toEqual({ path: 'src/greet.ts' });
  });

  it('maps apply patch (Review/Spark space form) onto apply_patch', () => {
    expect(normalizeToolName('apply patch')).toBe('apply_patch');
    expect(normalizeToolName('apply\tpatch')).toBe('apply_patch');
    const { calls } = parseTextToolCalls('{"name":"apply patch","arguments":{"patch":{"operations":[]}}}');
    expect(calls[0]?.name).toBe('apply_patch');
  });

  it('collapses underscore runs onto the canonical tool name', () => {
    // Live Flow (2026-09-16): invented `read__file` / `read___file` / `edit__file`
    // and then spun on unknown-tool. Collapse `_` runs after space/hyphen map.
    expect(normalizeToolName('read__file')).toBe('read_file');
    expect(normalizeToolName('read___file')).toBe('read_file');
    expect(normalizeToolName('edit__file')).toBe('edit_file');
    expect(normalizeToolName('read__file', TOOLS)).toBe('read_file');
    const { calls } = parseTextToolCalls('{"name":"read__file","arguments":{"path":"src/gREET.ts"}}', TOOLS);
    expect(calls[0]?.name).toBe('read_file');
  });

  it('maps a case-folded spaced name onto the offered tool list', () => {
    const { calls } = parseTextToolCalls('{"name":"Read  File","arguments":{"path":"src/greet.ts"}}', TOOLS);
    expect(calls[0]?.name).toBe('read_file');
  });

  it('recovers a Code Mode dump with spaced keys and a hyphenated tool name', () => {
    const EDIT: ToolSpec[] = [
      {
        name: 'edit_file',
        description: 'Edit.',
        parameters: { type: 'object', properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } } },
      },
    ];
    const dump = [
      '```json',
      '{',
      '  " name": " edit-file",',
      '  " arguments": {',
      '    " path": "src/greep.ts",',
      '    " search": "hi \\\\(\\\\w+\\\\)",',
      '    " replace": " Hello, $1!"',
      '  }',
      '}',
      '```',
    ].join('\n');
    const { calls, text } = parseTextToolCalls(dump, EDIT);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('edit_file');
    expect(calls[0].arguments).toEqual({
      path: 'src/greep.ts',
      search: 'hi \\(\\w+\\)',
      replace: ' Hello, $1!',
    });
    expect(text).toBe('');
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

// Weaker models answer by writing the call in source syntax inside a fence,
// which used to surface as a code block containing the user's own answer.
describe('parseTextToolCalls — source-syntax calls', () => {
  const SCHEMA_TOOLS: ToolSpec[] = [
    {
      name: 'finish',
      description: 'Finish with a summary.',
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
    {
      name: 'edit_file',
      description: 'Edit a file.',
      parameters: {
        type: 'object',
        properties: { file: { type: 'string' }, contents: { type: 'string' } },
        required: ['file', 'contents'],
      },
    },
  ];

  it('recovers a fenced finish("…") as a real finish call', () => {
    const raw = 'Next Steps\n\n```\nfinish("Stripe payments live in lib/stripe.ts")\n```';
    const { calls, text } = parseTextToolCalls(raw, SCHEMA_TOOLS);
    expect(calls).toEqual([
      { id: 'text_0', name: 'finish', arguments: { summary: 'Stripe payments live in lib/stripe.ts' } },
    ]);
    expect(text).toBe('Next Steps');
  });

  it('recovers single-quoted and object-argument forms', () => {
    expect(parseTextToolCalls("```\nfinish('done')\n```", SCHEMA_TOOLS).calls[0]?.arguments).toEqual({ summary: 'done' });
    expect(parseTextToolCalls('```\nfinish({"summary":"done"})\n```', SCHEMA_TOOLS).calls[0]?.arguments).toEqual({
      summary: 'done',
    });
  });

  it('unescapes a JSON string literal rather than passing it through raw', () => {
    const { calls } = parseTextToolCalls('```\nfinish("line one\\nline \\"two\\"")\n```', SCHEMA_TOOLS);
    expect(calls[0]?.arguments).toEqual({ summary: 'line one\nline "two"' });
  });

  it('recovers an unfenced call that is the entire reply', () => {
    const { calls, text } = parseTextToolCalls('finish("all done")', SCHEMA_TOOLS);
    expect(calls[0]?.name).toBe('finish');
    expect(text).toBe('');
  });

  it('refuses a tool that is not offered', () => {
    const raw = '```\nrm_rf("/")\n```';
    expect(parseTextToolCalls(raw, SCHEMA_TOOLS).calls).toHaveLength(0);
    expect(parseTextToolCalls(raw, SCHEMA_TOOLS).text).toBe(raw);
  });

  it('refuses a bare positional argument when the schema has more than one required param', () => {
    // Nothing tells us whether "a.ts" is `file` or `contents` — guessing could
    // truncate or overwrite a file.
    expect(parseTextToolCalls('```\nedit_file("a.ts")\n```', SCHEMA_TOOLS).calls).toHaveLength(0);
  });

  it('refuses multiple positional arguments and non-literal expressions', () => {
    expect(parseTextToolCalls('```\nfinish("a", "b")\n```', SCHEMA_TOOLS).calls).toHaveLength(0);
    expect(parseTextToolCalls('```\nfinish(someVariable)\n```', SCHEMA_TOOLS).calls).toHaveLength(0);
    expect(parseTextToolCalls('```\nfinish({bad json})\n```', SCHEMA_TOOLS).calls).toHaveLength(0);
  });

  it('does nothing without a tool list — prose about a tool stays prose', () => {
    const raw = '```\nfinish("x")\n```';
    expect(parseTextToolCalls(raw).calls).toHaveLength(0);
    expect(parseTextToolCalls(raw).text).toBe(raw);
  });

  it('leaves a fence that merely mentions a call inside a longer block alone', () => {
    const raw = '```\n// when done:\nfinish("x")\n```';
    expect(parseTextToolCalls(raw, SCHEMA_TOOLS).calls).toHaveLength(0);
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

  it('rewrites a native spaced tool name before the caller sees it', async () => {
    const APPLY: ToolSpec[] = [
      ...TOOLS,
      { name: 'apply_patch', description: 'Apply a patch.', parameters: { type: 'object', properties: { patch: { type: 'object' } } } },
    ];
    const p = fake({
      text: '',
      model: 'fake-1',
      provider: 'fake',
      toolCalls: [{ id: '1', name: 'apply patch', arguments: { patch: { operations: [] } } }],
    });
    const r = await withToolCallFallback(p).chat(base, { tools: APPLY });
    expect(r.toolCalls?.[0].name).toBe('apply_patch');
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

describe('looksLikeToolCallDump', () => {
  it('flags fenced JSON and Hermes dumps, not ordinary prose', () => {
    expect(looksLikeToolCallDump('```json\n{ " name": " edit-file", " arguments": {} }\n```')).toBe(true);
    expect(looksLikeToolCallDump('<tool_call>{"name":"finish","arguments":{}}</tool_call>')).toBe(true);
    expect(looksLikeToolCallDump('{"name":"edit_file","arguments":{"path":"a.ts"}}')).toBe(true);
    expect(looksLikeToolCallDump('Here is the answer: use `read_file` on a.ts.')).toBe(false);
    expect(looksLikeToolCallDump('```json\n{"foo": 1}\n```')).toBe(false);
  });

  it('flags a bare {name} dump with spaces, even without arguments', () => {
    expect(looksLikeToolCallDump('{"name":"inspect task"}')).toBe(true);
    expect(looksLikeToolCallDump('{"name":"read file"}')).toBe(true);
  });

  it('flags prose mixed with a truncated / unquoted JSON dump', () => {
    expect(looksLikeBrokenJsonDump('Sorry, I cannot use that tool. Let me try:\n{name: read_file, path: src/gREET.ts')).toBe(
      true,
    );
    expect(looksLikeBrokenJsonDump('I apologize — here is the call\n{ "name": "read_file"')).toBe(true);
    expect(looksLikeBrokenJsonDump('The timeout is in src/scan.ts.')).toBe(false);
    expect(looksLikeBrokenJsonDump('{"name":"read_file","arguments":{"path":"a.ts"}}')).toBe(false);
  });

  it('flags a PatchIR / REPLACED op dump, not ordinary JSON', () => {
    expect(looksLikeToolCallDump('{"id":"gREET.ts","op":"REPLACED","replacement":"Hi \\\\1!"}')).toBe(true);
    expect(looksLikeToolCallDump('{"op":"create-file","file":"a.ts","content":"x"}')).toBe(true);
    expect(looksLikeToolCallDump('{"op":"REPLACE","path":"src/greet.ts","search":"a","replace":"b"}')).toBe(true);
    expect(looksLikeToolCallDump('```json\n{"foo": 1}\n```')).toBe(false);
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
