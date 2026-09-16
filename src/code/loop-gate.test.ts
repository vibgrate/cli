/**
 * Gold gates for the VG Code loop Review reuses.
 *
 * These fail if a silent no-tools regression, a broken hosted function-calling
 * wire, a broken one-shot residual → patch → verify lifecycle, or a broken
 * `--loop` cap of 5 / no-progress stop lands. Deterministic mocks only.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runAgent,
  AGENT_NO_PROGRESS_STOP_AT,
  AGENT_NO_PROGRESS_NUDGE_AT,
  AGENT_EMPTY_REPLY_RETRIES,
  instructionRequiresMutation,
  looksLikeClarifyingQuestion,
} from './agent.js';
import { fixtureGraph, fixtureGraphWithFiles } from './graph-fixture.js';
import {
  LocalLlamaProvider,
  OpenAiCompatibleProvider,
  OPENAI_COMPATIBLE,
  ScriptedProvider,
  MockProvider,
} from './providers.js';
import { withToolCallFallback } from './text-tool-protocol.js';
import { runCodeSession, type CodeFs } from './session.js';
import type { ChatMessage, ChatOptions, Provider, ProviderResult, ToolCall, ToolSpec } from './types.js';

function memFs(seed: Record<string, string> = {}): CodeFs & { files: Record<string, string | null> } {
  const files: Record<string, string | null> = { ...seed };
  return {
    files,
    read: (f) => (f in files ? files[f] : null),
    write: (f, c) => {
      files[f] = c;
    },
    remove: (f) => {
      files[f] = null;
    },
    appendAudit: () => undefined,
  };
}

const tc = (name: string, args: Record<string, unknown>, id = 'c'): ToolCall => ({ id, name, arguments: args });

const TOOLS: ToolSpec[] = [
  { name: 'finish', description: 'Finish.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
];

function textBackend(
  reply: ProviderResult,
  supportsTools: boolean,
): Provider & { seen: Array<{ messages: ChatMessage[]; opts?: ChatOptions }> } {
  const seen: Array<{ messages: ChatMessage[]; opts?: ChatOptions }> = [];
  return {
    id: 'llama-cpp',
    label: 'Vibgrate (local)',
    local: true,
    model: 'forge-pack',
    supportsTools,
    seen,
    async chat(messages, opts) {
      seen.push({ messages, opts });
      return reply;
    },
  };
}

describe('loop-gate gold — edit-ask heuristic', () => {
  it('flags edit/change/fix/replace and so-returns, not locate Q&A', () => {
    expect(instructionRequiresMutation('edit src/greet.ts so greet returns Hello, <name>!')).toBe(true);
    expect(instructionRequiresMutation('edit the greeting')).toBe(true);
    expect(instructionRequiresMutation('fix the timeout in src/scan.ts')).toBe(true);
    expect(instructionRequiresMutation('replace the greeting in src/greet.ts')).toBe(true);
    expect(instructionRequiresMutation('change greet to return Hello')).toBe(false);
    expect(instructionRequiresMutation('fix the layout in this screenshot')).toBe(false);
    expect(instructionRequiresMutation('change something')).toBe(false);
    expect(instructionRequiresMutation('where is greet')).toBe(false);
    expect(instructionRequiresMutation('what does greet return')).toBe(false);
  });

  it('detects a clarifying question, not a code-fence stub', () => {
    expect(looksLikeClarifyingQuestion('Which timeout should I change — scan or connect?')).toBe(true);
    expect(looksLikeClarifyingQuestion('```ts\n// src/gREET.ts\n```')).toBe(false);
  });
});

describe('loop-gate gold — Code Mode tool channel', () => {
  it('pins the embedded manager as text-protocol (supportsTools === false)', () => {
    const p = new LocalLlamaProvider('forge-pack', '/tmp/forge.gguf');
    expect(p.supportsTools).toBe(false);
    expect(p.id).toBe('llama-cpp');
  });

  it('does not end as silent no-tools when a Code Mode emits text-protocol markup', async () => {
    const backend = textBackend(
      {
        text: '<tool_call>{"name":"finish","arguments":{"summary":"timeout lives in src/scan.ts"}}</tool_call>',
        model: 'forge-pack',
        provider: 'llama-cpp',
      },
      false,
    );
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'where is the timeout',
      providers: [withToolCallFallback(backend)],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.finalText).toMatch(/timeout/);
    expect(result.finalText.trim()).not.toBe('');
    expect(backend.seen[0]?.opts?.tools).toBeUndefined();
    expect(backend.seen[0]?.messages[0]?.content).toContain('## Tool calling (text protocol)');
  });

  it('a fenced JSON tool dump is not a successful free-text finish', async () => {
    // Live Spark smoke (2026-09-16): the model printed a markdown-fenced
    // JSON object shaped like a tool call (spaced keys, `edit-file`, wrong
    // path). isUserFacingProse used to treat that as a solve — steps=1,
    // finished, no mutations. Rescue it or stop as no-tools / max-steps.
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
    const backend = textBackend({ text: dump, model: 'spark-pack', provider: 'llama-cpp' }, false);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'edit src/greet.ts so greet returns Hello, <name>!',
      providers: [withToolCallFallback(backend)],
      fsImpl: memFs({ 'src/greet.ts': 'export function greet(name: string) { return `hi ${name}`; }\n' }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      maxSteps: 1,
      noAudit: true,
    });
    expect(result.stopped).not.toBe('finished');
    expect(result.changes).toHaveLength(0);
    expect(result.finalText).not.toMatch(/" name"/);
  });

  it('rescues a spaced-key edit-file dump and applies a real edit', async () => {
    const dump = [
      '```json',
      '{',
      '  " name": " edit-file",',
      '  " arguments": {',
      '    " path": "src/scan.ts",',
      '    " search": "const timeout = 0;",',
      '    " replace": "const timeout = 5000;"',
      '  }',
      '}',
      '```',
    ].join('\n');
    const provider = new ScriptedProvider('spark-pack', [
      { text: dump },
      { toolCalls: [tc('finish', { summary: 'raised the timeout' }, 'f1')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [withToolCallFallback(provider)],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(fsImpl.files['src/scan.ts']).toContain('5000');
    expect(result.changes).toHaveLength(1);
  });

  it('native read__file / read___file dispatch as read_file, not unknown forever', async () => {
    // Live Flow (2026-09-16): invented `read__file` then `read___file`, both
    // unknown, then fake-finished. Normalize must collapse `_` runs so the
    // loop leaves the double-underscore name on the first dispatch.
    const events: Array<{ type: string; name?: string; content?: string }> = [];
    const greet = 'export function greet(name: string) { return `hi ${name}`; }\n';
    const provider = new ScriptedProvider('flow-pack', [
      { toolCalls: [tc('read__file', { path: 'src/gREET.ts' }, 'r1')] },
      { toolCalls: [tc('read___file', { path: 'src/gREET.ts' }, 'r2')] },
      { toolCalls: [tc('finish', { summary: 'greet lives in src/greet.ts' }, 'f1')] },
    ]);
    const result = await runAgent({
      graph: fixtureGraphWithFiles(['src/greet.ts']),
      root: '/repo',
      instruction: 'where is greet',
      providers: [withToolCallFallback(provider)],
      fsImpl: memFs({ 'src/greet.ts': greet }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
      onEvent: (e) => events.push(e),
    });
    const calls = events.filter((e) => e.type === 'tool-call');
    expect(calls.map((c) => c.name)).toEqual(['read_file', 'read_file', 'finish']);
    const unknown = events.filter((e) => e.type === 'tool-result' && /unknown tool/.test(e.content ?? ''));
    expect(unknown).toHaveLength(0);
    expect(result.stopped).toBe('finished');
    expect(result.changes).toHaveLength(0);
  });

  it('apology plus broken JSON after unknown-tool and 0 successes is not finished', async () => {
    // Live Flow (2026-09-16): after unknown-tool (`read__file` before
    // normalize) the model wrote "Sorry…" + a broken `{` dump and the loop
    // stopped finished with 0 mutations. Must be no-tools.
    const greet = 'export function greet(name: string) { return `hi ${name}`; }\n';
    const provider = new ScriptedProvider('flow-pack', [
      { toolCalls: [tc('not_a_real_tool', { path: 'src/gREET.ts' }, 'u1')] },
      {
        text: 'Sorry, I cannot use that tool. Let me try again:\n{name: read_file, path: src/gREET.ts',
      },
    ]);
    const fsImpl = memFs({ 'src/greet.ts': greet });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'edit src/greet.ts so greet returns Hello, <name>!',
      providers: [withToolCallFallback(provider)],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).not.toBe('finished');
    expect(result.stopped).toBe('no-tools');
    expect(result.changes).toHaveLength(0);
    expect(fsImpl.files['src/greet.ts']).toBe(greet);
  });

  it('read then a file-stub after an edit ask is not finished', async () => {
    // Live Flow (2026-09-16, #2691 tip): read_file(src/gREET.ts) then
    // ```ts\n// src/gREET.ts\n``` — stopped finished, 0 mutations, solved=true.
    const greet = 'export function greet(name: string) { return `hi ${name}`; }\n';
    const provider = new ScriptedProvider('flow-pack', [
      { toolCalls: [tc('read_file', { path: 'src/gREET.ts' }, 'r1')] },
      { text: '```ts\n// src/gREET.ts\n```' },
    ]);
    const fsImpl = memFs({ 'src/greet.ts': greet });
    const result = await runAgent({
      graph: fixtureGraphWithFiles(['src/greet.ts']),
      root: '/repo',
      instruction: 'edit src/greet.ts so greet returns Hello, <name>!',
      providers: [withToolCallFallback(provider)],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).not.toBe('finished');
    expect(result.stopped).toBe('no-tools');
    expect(result.changes).toHaveLength(0);
    expect(fsImpl.files['src/greet.ts']).toBe(greet);
    expect(result.metrics?.trajectory.solved).toBe(false);
    expect(result.metrics?.trajectory.verified).toBe(false);
    expect(result.metrics?.trajectory.filesChanged).toBe(0);
  });

  it('edit_file not-found then prose after an edit ask is not finished', async () => {
    // Live Flow (2026-09-16, #2692): edit_file missed (padded path / wrong
    // SEARCH), mutations=1, filesChanged=0, then prose — fake-finished
    // because the gate keyed off mutationToolCalls === 0. Failed edit does
    // not satisfy; must be no-tools.
    const greet = 'export function greet(name: string) { return `hi ${name}`; }\n';
    const provider = new ScriptedProvider('flow-pack', [
      {
        toolCalls: [
          tc('edit_file', { path: 'src/missing.ts', search: 'return "hi " + name;', replace: 'return "Hello, " + name + "!";' }, 'e1'),
        ],
      },
      { text: 'Updated greet to return Hello.' },
    ]);
    const fsImpl = memFs({ 'src/greet.ts': greet });
    const result = await runAgent({
      graph: fixtureGraphWithFiles(['src/greet.ts']),
      root: '/repo',
      instruction: 'edit src/greet.ts so greet returns Hello, <name>!',
      providers: [withToolCallFallback(provider)],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).not.toBe('finished');
    expect(result.stopped).toBe('no-tools');
    expect(result.changes).toHaveLength(0);
    expect(fsImpl.files['src/greet.ts']).toBe(greet);
    expect(result.metrics?.trajectory.solved).toBe(false);
    expect(result.metrics?.trajectory.filesChanged).toBe(0);
  });

  it('an edit ask that asks a clarifying question still finishes', async () => {
    const provider = new ScriptedProvider('flow-pack', [
      { text: 'Which file should I edit — src/greet.ts or src/scan.ts?' },
    ]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'edit the greeting',
      providers: [withToolCallFallback(provider)],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.finalText).toMatch(/Which file/);
  });

  it('Q&A with a brace example still finishes when no unknown-tool streak', async () => {
    // `{` in a real answer is not a dump. The broken-JSON gate only fires
    // after unknown-tool failures with 0 successful calls.
    const provider = new ScriptedProvider('flow-pack', [
      { text: 'The timeout lives in src/scan.ts. Example: { timeout: 5000 }' },
    ]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'where is the timeout',
      providers: [withToolCallFallback(provider)],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.finalText).toMatch(/timeout/);
  });

  it('a native apply patch call is dispatched, not unknown tool', async () => {
    // Live Spark review-propose smoke (2026-09-16): the model called
    // `apply patch` (space). Built main logged unknown tool and produced
    // no-patch. The name must be rewritten before dispatch.
    const events: Array<{ type: string; name?: string; content?: string }> = [];
    const provider = new ScriptedProvider('spark-pack', [
      { toolCalls: [tc('apply patch', { patch: { operations: [] } }, 'a1')] },
      { toolCalls: [tc('finish', { summary: 'no edit landed' }, 'f1')] },
    ]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'apply the architecture finding',
      providers: [withToolCallFallback(provider)],
      fsImpl: memFs({ 'src/scan.ts': 'const timeout = 0;\n' }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
      onEvent: (e) => events.push(e),
    });
    const calls = events.filter((e) => e.type === 'tool-call');
    expect(calls[0]?.name).toBe('apply_patch');
    const unknown = events.filter((e) => e.type === 'tool-result' && /unknown tool/.test(e.content ?? ''));
    expect(unknown).toHaveLength(0);
    expect(result.finalText).not.toMatch(/unknown tool "apply patch"/);
  });

  it('wrong-case path plus regex SEARCH then a literal edit lands and finishes', async () => {
    const greet = 'export function greet(name: string) { return `hi ${name}`; }\n';
    const provider = new ScriptedProvider('spark-pack', [
      {
        toolCalls: [
          tc('edit_file', { path: 'src/gREET.ts', search: 'hi \\(\\w+\\)', replace: 'Hello, $1!' }, 'e1'),
        ],
      },
      {
        toolCalls: [
          tc(
            'edit_file',
            { path: 'src/greet.ts', search: 'return `hi ${name}`;', replace: 'return `Hello, ${name}!`;' },
            'e2',
          ),
        ],
      },
      { toolCalls: [tc('finish', { summary: 'greet now returns Hello, <name>!' }, 'f1')] },
    ]);
    const fsImpl = memFs({ 'src/greet.ts': greet });
    const result = await runAgent({
      graph: fixtureGraphWithFiles(['src/greet.ts']),
      root: '/repo',
      instruction: 'edit src/greet.ts so greet returns Hello, <name>!',
      providers: [withToolCallFallback(provider)],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.changes).toHaveLength(1);
    expect(fsImpl.files['src/greet.ts']).toContain('Hello, ${name}!');
  });

  it('a PatchIR dump after a successful edit finishes and keeps the write', async () => {
    // Live Spark (2026-09-16, #2692): edit_file landed, next turn dumped
    // {op:REPLACED} / PatchIR, the loop kept generating dumps until timeout,
    // and overlay never flushed so disk still had `hi`. Stop as finished.
    const greet = 'export function greet(name: string) { return `hi ${name}`; }\n';
    const provider = new ScriptedProvider('spark-pack', [
      {
        toolCalls: [
          tc(
            'edit_file',
            { path: 'src/greet.ts', search: 'return `hi ${name}`;', replace: 'return `Hello, ${name}!`;' },
            'e1',
          ),
        ],
      },
      { text: '{"schemaVersion":"patch-ir/0","operations":[{"op":"REPLACED","file":"src/greet.ts","replacement":"Hello"}]}' },
    ]);
    const fsImpl = memFs({ 'src/greet.ts': greet });
    const result = await runAgent({
      graph: fixtureGraphWithFiles(['src/greet.ts']),
      root: '/repo',
      instruction: 'edit src/greet.ts so greet returns Hello, <name>!',
      providers: [withToolCallFallback(provider)],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      overlay: true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.changes.length).toBeGreaterThan(0);
    expect(fsImpl.files['src/greet.ts']).toContain('Hello, ${name}!');
    expect(result.finalText).not.toMatch(/schemaVersion|"op"\s*:\s*"REPLACED"/);
  });

  it('a REPLACED op dump after a failed edit is not a successful finish', async () => {
    // Live Spark coding smoke (2026-09-16, this PR): edit_file missed
    // src/gREET.ts (SEARCH regex, wrong path) → not-found; next reply was
    // bare `{id, op: REPLACED, replacement}`. The loop treated that dump as
    // prose and stopped finished with 0 changes. Must be no-tools / continue.
    const greet = 'export function greet(name: string) { return `hi ${name}`; }\n';
    const provider = new ScriptedProvider('spark-pack', [
      {
        toolCalls: [
          tc('edit_file', { path: 'src/gREET.ts', search: 'hi \\(\\w+\\)', replace: 'Hello, $1!' }, 'e1'),
        ],
      },
      { text: '{"id":"gREET.ts","op":"REPLACED","replacement":"Hi \\\\1!"}' },
    ]);
    const fsImpl = memFs({ 'src/greet.ts': greet });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'edit src/greet.ts so greet returns Hello, <name>!',
      providers: [withToolCallFallback(provider)],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).not.toBe('finished');
    expect(result.stopped).toBe('no-tools');
    expect(result.changes).toHaveLength(0);
    expect(fsImpl.files['src/greet.ts']).toBe(greet);
    expect(result.finalText).not.toMatch(/"op"\s*:\s*"REPLACED"/);
  });

  it('a spaced-name dump then empty reply is not a successful finish', async () => {
    // Live Spark smoke (2026-09-16, post #2664): first dump used `read file`
    // (space); the next reply was bare `{"name":"inspect task"}` with no args.
    // looksLikeToolCallDump used to miss both, so the loop stopped as finished
    // with 0 mutations. Dump then empty must not look like success.
    const greet = 'export function greet(name: string) { return `hi ${name}`; }\n';
    const provider = new ScriptedProvider('spark-pack', [
      { text: '{"name":"inspect task"}' },
      { text: '' },
    ]);
    const fsImpl = memFs({ 'src/greet.ts': greet });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'edit src/greet.ts so greet returns Hello, <name>!',
      providers: [withToolCallFallback(provider)],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).not.toBe('finished');
    expect(result.changes).toHaveLength(0);
    expect(fsImpl.files['src/greet.ts']).toBe(greet);
  });

  it('empty Code Mode replies stay no-tools with an actionable message (never silent)', async () => {
    const backend = textBackend({ text: '', model: 'spark-pack', provider: 'llama-cpp' }, false);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [withToolCallFallback(backend)],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('no-tools');
    expect(result.finalText.trim()).not.toBe('');
    expect(result.finalText).toMatch(/no usable output|stronger model/i);
    expect(result.steps).toBeGreaterThan(AGENT_EMPTY_REPLY_RETRIES);
  });
});

describe('loop-gate gold — hosted native function calling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VIBGRATE_RELAY_TOKEN;
  });

  it('hosted OpenAI-compatible backend sends tools and parses native tool_calls', async () => {
    process.env.VIBGRATE_RELAY_TOKEN = 'vtm_test_token';
    const fetchMock = vi.fn(
      async (_url: string, _init: { body: string }) =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [{ id: 'call_1', function: { name: 'finish', arguments: '{"summary":"done"}' } }],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = new OpenAiCompatibleProvider('hosted-coder', {
      ...OPENAI_COMPATIBLE['vibgrate-relay'],
      id: 'vibgrate-relay',
    });
    const wrapped = withToolCallFallback(p);
    const r = await wrapped.chat([{ role: 'user', content: 'x' }], { tools: TOOLS });
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'finish', arguments: { summary: 'done' } }]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      tools: Array<{ function: { name: string } }>;
    };
    expect(body.tools[0].function.name).toBe('finish');
  });

  it('native hosted tool_calls drive the agent (not a silent no-tools finish)', async () => {
    const provider = new ScriptedProvider('hosted-coder', [
      { toolCalls: [tc('finish', { summary: 'scanDir is in src/scan.ts' }, 't1')] },
    ]);
    // Hosted backends omit supportsTools (absent means native FC).
    expect((provider as Provider).supportsTools).toBeUndefined();
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'where is scanDir',
      providers: [withToolCallFallback(provider)],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.finalText).toMatch(/scanDir/);
    expect(provider.lastOpts?.tools?.some((t) => t.name === 'finish')).toBe(true);
  });
});

describe('loop-gate gold — one-shot residual → patch → verify', () => {
  const editReply = [
    'src/scan.ts',
    '<<<<<<< SEARCH',
    'const timeout = 0;',
    '=======',
    'const timeout = 5000;',
    '>>>>>>> REPLACE',
  ].join('\n');

  it('inspect → assess → dry-run proposes a patch and writes nothing', async () => {
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const r = await runCodeSession({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [new MockProvider('mock-1', editReply)],
      fsImpl,
      noAudit: true,
    });
    expect(r.phasesRun).toEqual(expect.arrayContaining(['inspect', 'assess', 'dry-run']));
    expect(r.phasesRun).not.toContain('execute');
    expect(r.applied).toBe(false);
    expect(fsImpl.files['src/scan.ts']).toBe('const timeout = 0;\n');
    expect(r.changes[0]?.diff).toContain('+const timeout = 5000;');
    expect(r.verification.ok).toBe(false);
    expect(r.verification.detail).toMatch(/dry-run/i);
  });

  it('apply + consent walks execute → verify and the on-disk file matches', async () => {
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const r = await runCodeSession({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [new MockProvider('mock-1', editReply)],
      apply: true,
      consent: true,
      fsImpl,
      noAudit: true,
    });
    expect(r.phasesRun).toEqual(['inspect', 'assess', 'dry-run', 'approve', 'execute', 'verify', 'log']);
    expect(r.applied).toBe(true);
    expect(r.verification.ok).toBe(true);
    expect(fsImpl.files['src/scan.ts']).toBe('const timeout = 5000;\n');
  });
});

describe('loop-gate gold — --loop cap of 5 / no-progress stop', () => {
  it('the loop cap is 5 (nudge at 3)', () => {
    expect(AGENT_NO_PROGRESS_STOP_AT).toBe(5);
    expect(AGENT_NO_PROGRESS_NUDGE_AT).toBe(3);
    expect(AGENT_NO_PROGRESS_NUDGE_AT).toBeLessThan(AGENT_NO_PROGRESS_STOP_AT);
  });

  it('identical non-mutating calls stop as no-progress at the cap, not a silent finish', async () => {
    const provider = new ScriptedProvider('m', [{ toolCalls: [tc('search_code', { query: 'timeout' }, 'x')] }]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      maxSteps: AGENT_NO_PROGRESS_STOP_AT,
      noAudit: true,
    });
    expect(result.stopped).toBe('no-progress');
    expect(result.steps).toBe(AGENT_NO_PROGRESS_STOP_AT);
    expect(result.finalText).toMatch(/repeated|no progress/i);
    expect(result.finalText.trim()).not.toBe('');
    expect(result.changes).toHaveLength(0);
  });
});
