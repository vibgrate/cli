import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompressionStore } from './ccr/store.js';
import { RETRIEVE_TOOL_NAME } from './ccr/tool.js';
import { toOpenAI } from './format.js';
import { readSavingsEvents } from './ledger.js';
import { compressionMiddleware, withCompression } from './sdk.js';
import { FakeRouter, goldenConversation } from './test-double.js';
import type { Message } from './types.js';

const OPTS = { mode: 'token' as const, minTokensToCompress: 100, minCharsForBlock: 200, protectRecent: 0, now: () => 1_000 };

describe('withCompression', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sdk-'));
    env = { VG_CONTEXT_DIR: dir, VG_CCR_BACKEND: 'memory' } as NodeJS.ProcessEnv;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('wraps an Anthropic-shaped client: compresses, injects the tool, resolves retrievals, records savings', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      apiKey: 'k',
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          const msgs = params.messages as Message[];
          const text = JSON.stringify(msgs);
          const hash = /<<vg-ccr:([0-9a-f]{12})/.exec(text)?.[1];
          if (calls.length === 1 && hash) return { content: [{ type: 'tool_use', id: 'tu', name: RETRIEVE_TOOL_NAME, input: { hash, head: 2 } }], stop_reason: 'tool_use' };
          return { content: [{ type: 'text', text: `answer after ${msgs.length} messages` }], stop_reason: 'end_turn' };
        },
        other: () => 'untouched',
      },
    };
    const store = new CompressionStore({ now: () => 1_000 });
    const wrapped = withCompression(client, { ...OPTS, router: new FakeRouter({ keepItems: 3 }), store, env, client: 'test-client', model: 'claude-x' });
    expect(wrapped.apiKey).toBe('k');
    expect(wrapped.messages.other()).toBe('untouched');
    const res = await wrapped.messages.create({ model: 'claude-x', max_tokens: 10, messages: goldenConversation() });
    expect(res.content[0]).toEqual({ type: 'text', text: 'answer after 14 messages' });
    expect(calls).toHaveLength(2);
    const first = calls[0];
    expect((first.messages as Message[]).length).toBe(12);
    expect(JSON.stringify(first.messages)).toContain('<<vg-ccr:');
    expect((first.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([RETRIEVE_TOOL_NAME]);
    expect(first.max_tokens).toBe(10);
    const toolResult = (calls[1].messages as Array<{ content: Array<{ content: string }> }>)[13].content[0].content;
    expect(JSON.parse(toolResult).view).toBe('head');
    const ledger = readSavingsEvents(env);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ source: 'sdk', client: 'test-client', model: 'claude-x' });
    expect(ledger[0].tokensSaved).toBeGreaterThan(0);
    // Sticky: the tool stays advertised on a later marker-free call.
    await wrapped.messages.create({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] });
    expect((calls[2].tools as unknown[]).length).toBe(1);
  });

  it('streaming requests are lossless-only passthroughs (no markers, no tool, one call)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = { messages: { create: async (p: Record<string, unknown>) => (calls.push(p), { content: [] }) } };
    const wrapped = withCompression(client, { ...OPTS, router: new FakeRouter({ keepItems: 3 }), env, ledger: false });
    await wrapped.messages.create({ model: 'm', stream: true, messages: goldenConversation() });
    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toBeUndefined();
    const text = JSON.stringify(calls[0].messages);
    expect(text).not.toContain('<<vg-ccr:');
    expect(text).toContain('@src/services/billing/handlers/'); // lossless fold still applied
    expect(readSavingsEvents(env)).toEqual([]);
  });

  it('wraps OpenAI chat and Responses clients and fails open on router errors', async () => {
    const chatCalls: Array<Record<string, unknown>> = [];
    const respCalls: Array<Record<string, unknown>> = [];
    const client = {
      chat: { completions: { create: async (p: Record<string, unknown>) => (chatCalls.push(p), { choices: [{ message: { role: 'assistant', content: 'ok' } }] }) } },
      responses: { create: async (p: Record<string, unknown>) => (respCalls.push(p), { output: [] }) },
    };
    const wrapped = withCompression(client, { ...OPTS, router: new FakeRouter({ keepItems: 3 }), env, ledger: false });
    const oai = toOpenAI(goldenConversation(), 'anthropic');
    const r = await wrapped.chat.completions.create({ model: 'gpt-x', messages: oai });
    expect(r.choices[0].message.content).toBe('ok');
    expect(JSON.stringify(chatCalls[0].messages)).toContain('rows_offloaded');
    expect((chatCalls[0].tools as Array<{ function: { name: string } }>)[0].function.name).toBe(RETRIEVE_TOOL_NAME);
    const items: Message[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list' }] },
      { type: 'function_call', call_id: 'f1', name: 'list_services', arguments: '{}' },
      { type: 'function_call_output', call_id: 'f1', output: (goldenConversation()[2] as { content: Array<{ content: string }> }).content[0].content },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'which is unhealthy?' }] },
    ];
    await wrapped.responses.create({ model: 'gpt-x', input: items });
    expect(JSON.stringify(respCalls[0].input)).toContain('rows_offloaded');
    expect((respCalls[0].tools as Array<{ name: string }>)[0].name).toBe(RETRIEVE_TOOL_NAME);
    const broken = withCompression(client, { ...OPTS, router: new FakeRouter({ throwOn: true }), env, ledger: false });
    await broken.chat.completions.create({ model: 'gpt-x', messages: oai });
    expect(chatCalls[1].messages).toEqual(oai);
    expect(chatCalls[1].tools).toBeUndefined();
    await wrapped.chat.completions.create({ model: 'gpt-x', messages: [] });
    expect(chatCalls[2].messages).toEqual([]);
  });

  it('compressionMiddleware transforms Vercel prompts and leaves params alone when nothing saved', async () => {
    const mw = compressionMiddleware({ ...OPTS, router: new FakeRouter({ keepItems: 3 }), env, ledger: false });
    const prompt: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'list services' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'v1', toolName: 'list_services', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'v1', toolName: 'list_services', output: { type: 'text', value: (goldenConversation()[2] as { content: Array<{ content: string }> }).content[0].content } }] },
      { role: 'user', content: [{ type: 'text', text: 'which is unhealthy?' }] },
    ];
    const out = await mw.transformParams({ params: { modelId: 'gpt-x', prompt }, type: 'generate' });
    expect(out.modelId).toBe('gpt-x');
    expect(out.prompt).not.toBe(prompt);
    const result = (out.prompt as Array<{ content: Array<{ output: { value: string } }> }>)[2].content[0].output.value;
    expect(result).toContain('{"id":1,'); // lossless JSON compaction only
    expect(result).not.toContain('<<vg-ccr:'); // middleware runs lossless-only (no retrieval loop inside the SDK)
    const untouched = { prompt: [{ role: 'user', content: 'hi' }] };
    expect(await mw.transformParams({ params: untouched })).toBe(untouched);
    expect(await mw.transformParams({ params: { prompt: [] } })).toEqual({ prompt: [] });
  });
});
