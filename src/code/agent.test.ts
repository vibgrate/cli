import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAgent, compact, compactWithModel, type AgentEvent } from './agent.js';
import { ScriptedProvider } from './providers.js';
import { fixtureGraph } from './graph-fixture.js';
import { readModelSavings } from '../engine/savings.js';
import type { CodeFs } from './session.js';
import type { ChatMessage, Provider, ToolCall } from './types.js';

function memFs(seed: Record<string, string> = {}): CodeFs & { files: Record<string, string | null>; audit: string[] } {
  const files: Record<string, string | null> = { ...seed };
  const audit: string[] = [];
  return {
    files,
    audit,
    read: (f) => (f in files ? files[f] : null),
    write: (f, c) => {
      files[f] = c;
    },
    remove: (f) => {
      files[f] = null;
    },
    appendAudit: (line) => audit.push(line),
  };
}

const tc = (name: string, args: Record<string, unknown>, id = 'c'): ToolCall => ({ id, name, arguments: args });

describe('runAgent — the agentic loop', () => {
  const baseFile = 'export function scanDir() {\n  const timeout = 0;\n  return timeout;\n}\n';

  it('default path is full agent: locate questions call the model (no short-circuit)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-agent-locate-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src', 'extension.ts'),
        `void open('https://dash.vibgrate.com/signup');\n`,
      );
      const provider = new ScriptedProvider('m', [
        {
          toolCalls: [
            tc('search_code', { query: 'https://dash.vibgrate.com/signup' }, 's1'),
          ],
        },
        { toolCalls: [tc('finish', { summary: 'Found in src/extension.ts:1' }, 'f1')] },
      ]);
      const result = await runAgent({
        graph: fixtureGraph(),
        root: dir,
        instruction: 'where is https://dash.vibgrate.com/signup?',
        providers: [provider],
        fsImpl: memFs(),
        run: () => ({ stdout: '', exitCode: 0 }),
        approve: async () => true,
        noAudit: true,
      });
      expect(result.stopped).toBe('finished');
      expect(result.provider.id).not.toBe('deterministic-locate');
      expect(result.finalText).toMatch(/extension\.ts:1/i);
      expect(result.steps).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opt-in deterministicLocate short-circuits pure URL locate without the model', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-agent-locate-opt-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src', 'extension.ts'),
        `void open('https://dash.vibgrate.com/signup');\n`,
      );
      const provider = new ScriptedProvider('m', [
        { text: '{"schemaVersion":"patch-ir/0","operations":[]}', toolCalls: [] },
      ]);
      const events: AgentEvent[] = [];
      const result = await runAgent({
        graph: fixtureGraph(),
        root: dir,
        instruction: 'where is https://dash.vibgrate.com/signup?',
        providers: [provider],
        fsImpl: memFs(),
        run: () => ({ stdout: '', exitCode: 0 }),
        approve: async () => true,
        onEvent: (e) => events.push(e),
        noAudit: true,
        deterministicLocate: true,
      });
      expect(result.stopped).toBe('finished');
      expect(result.provider.id).toBe('deterministic-locate');
      expect(result.finalText).toContain('extension.ts:1');
      expect(result.finalText).not.toContain('patch-ir');
      expect(events.some((e) => e.type === 'assistant' && e.text.includes('Found'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops between steps when the host cancels, keeping work already applied', async () => {
    // Step 1 applies an edit; the host cancels before step 2 would run.
    const signal = { aborted: false };
    const provider = new ScriptedProvider('m', [
      {
        toolCalls: [
          tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 't1'),
        ],
      },
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: '5000', replace: '9999' }, 't2')] },
      { toolCalls: [tc('finish', { summary: 'never reached' }, 't3')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });

    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the request timeout',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => {
        // The user hits Stop while reviewing the first edit.
        signal.aborted = true;
        return true;
      },
      signal,
    });

    expect(result.stopped).toBe('cancelled');
    expect(result.finalText).toMatch(/stopped at your request/i);
    // The approved edit stands — cancel stops the loop, it does not roll back.
    expect(fsImpl.files['src/scan.ts']).toContain('5000');
    expect(fsImpl.files['src/scan.ts']).not.toContain('9999');
  });

  it('does not start any step when cancelled before the first', async () => {
    const provider = new ScriptedProvider('m', [{ toolCalls: [tc('finish', { summary: 'x' }, 't1')] }]);
    const chat = vi.spyOn(provider, 'chat');
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'anything',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      signal: { aborted: true },
    });
    expect(result.stopped).toBe('cancelled');
    expect(result.steps).toBe(0);
    expect(chat).not.toHaveBeenCalled();
  });

  it('checkpoints an approved change before it is written, and reports the files', async () => {
    const taken: Array<{ files: string[]; contentAtSnapshot: string | null }> = [];
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 't1')] },
      { toolCalls: [tc('finish', { summary: 'done' }, 't2')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const events: AgentEvent[] = [];

    await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      onEvent: (e) => events.push(e),
      checkpoint: (files) => {
        // The snapshot must happen before the write lands.
        taken.push({ files, contentAtSnapshot: fsImpl.files['src/scan.ts'] });
        return { ref: 'refs/vibgrate/checkpoints/s1/1', commit: 'c1', seq: taken.length };
      },
    });

    expect(taken).toHaveLength(1);
    expect(taken[0].files).toEqual(['src/scan.ts']);
    expect(taken[0].contentAtSnapshot).toContain('const timeout = 0;');
    const cp = events.find((e) => e.type === 'checkpoint');
    expect(cp).toMatchObject({ ref: 'refs/vibgrate/checkpoints/s1/1', commit: 'c1', seq: 1, files: ['src/scan.ts'] });
  });

  it('does not checkpoint a declined change', async () => {
    const taken: string[][] = [];
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 't1')] },
      { toolCalls: [tc('finish', { summary: 'declined' }, 't2')] },
    ]);
    await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl: memFs({ 'src/scan.ts': baseFile }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => false,
      checkpoint: (files) => {
        taken.push(files);
        return { ref: 'r', commit: 'c', seq: 1 };
      },
    });
    expect(taken).toEqual([]);
  });

  it('does not checkpoint a command approval — there is nothing to restore', async () => {
    const taken: string[][] = [];
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('run_command', { command: 'npm test' }, 't1')] },
      { toolCalls: [tc('finish', { summary: 'ran tests' }, 't2')] },
    ]);
    await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'run the tests',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: 'ok', exitCode: 0 }),
      approve: async () => true,
      checkpoint: (files) => {
        taken.push(files);
        return { ref: 'r', commit: 'c', seq: 1 };
      },
    });
    expect(taken).toEqual([]);
  });

  it('applies the change even when the checkpoint fails or throws', async () => {
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 't1')] },
      { toolCalls: [tc('finish', { summary: 'done' }, 't2')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      checkpoint: () => {
        throw new Error('git exploded');
      },
    });
    expect(result.stopped).toBe('finished');
    expect(fsImpl.files['src/scan.ts']).toContain('5000');
  });

  it('runs a full search → read → edit → run → finish session', async () => {
    // A scripted "model" that drives a realistic tool sequence.
    const provider = new ScriptedProvider('m', [
      { text: 'Let me find it.', toolCalls: [tc('search_code', { query: 'timeout' }, 't1')] },
      { toolCalls: [tc('read_file', { path: 'src/scan.ts' }, 't2')] },
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 't3')] },
      { toolCalls: [tc('run_command', { command: 'npm test' }, 't4')] },
      { toolCalls: [tc('finish', { summary: 'raised the timeout to 5000ms' }, 't5')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const run = vi.fn(() => ({ stdout: 'all tests passed', exitCode: 0 }));
    const events: AgentEvent[] = [];

    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the request timeout to 5000ms',
      providers: [provider],
      fsImpl,
      run,
      approve: async () => true,
      onEvent: (e) => events.push(e),
    });

    expect(result.stopped).toBe('finished');
    expect(result.finalText).toBe('raised the timeout to 5000ms');
    expect(fsImpl.files['src/scan.ts']).toContain('5000');
    expect(result.changes).toHaveLength(1);
    expect(run).toHaveBeenCalledWith('npm test');
    // the tool activity was surfaced
    expect(events.some((e) => e.type === 'tool-call' && e.name === 'search_code')).toBe(true);
    expect(events.some((e) => e.type === 'change')).toBe(true);
    // run-provenance/0: policy pin + content-hashed mutation
    expect(result.provenance?.schemaVersion).toBe('run-provenance/0');
    expect(result.provenance?.policyVersion).toMatch(/^context-policy@/);
    expect(result.provenance?.mutations).toHaveLength(1);
    expect(result.provenance?.mutations[0]?.file).toBe('src/scan.ts');
    expect(result.provenance?.mutations[0]?.afterHash).toBeTruthy();
    expect(result.provenance?.mutationsRootHash).toBeTruthy();
  });

  it('respects a declined edit — nothing is written, the loop continues', async () => {
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 't1')] },
      { toolCalls: [tc('finish', { summary: 'user declined the edit' }, 't2')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => false, // decline everything
    });
    expect(fsImpl.files['src/scan.ts']).toBe(baseFile); // unchanged
    expect(result.changes).toHaveLength(0);
    expect(result.stopped).toBe('finished');
  });

  it('stops at the step cap when the model never finishes', async () => {
    const provider = new ScriptedProvider('m', [{ toolCalls: [tc('search_code', { query: 'x' })] }]); // repeats forever
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      maxSteps: 3,
    });
    expect(result.stopped).toBe('max-steps');
    expect(result.steps).toBe(3);
  });

  it('treats clean free-text answers as finished (task-space Q&A)', async () => {
    const provider = new ScriptedProvider('m', [{ text: 'I need more detail about which timeout.' }]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.finalText).toContain('more detail');
  });

  it('retries an empty reply with a nudge instead of ending with nothing', async () => {
    // Weak local models sometimes return an empty completion; the user must
    // never see a silent "done". One empty turn, then a real answer.
    const provider = new ScriptedProvider('m', [
      { text: '' },
      { text: 'The scan timeout lives in src/scan.ts and defaults to zero.' },
    ]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(result.finalText).toContain('scan timeout');
  });

  it('gives an actionable message when the model stays empty after retries', async () => {
    const provider = new ScriptedProvider('m', [{ text: '' }]); // empty forever
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.stopped).toBe('no-tools');
    expect(result.finalText).toMatch(/no usable output|stronger model/i);
    expect(result.finalText).not.toBe('done');
  });

  it('plan mode denies every mutation engine-side without calling the approval gate', async () => {
    const approvals: string[] = [];
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5;' }, 't1')] },
      { toolCalls: [tc('run_command', { command: 'echo hi' }, 't2')] },
      { toolCalls: [tc('finish', { summary: 'Plan: raise the timeout in src/scan.ts.' }, 't3')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: 'ran', exitCode: 0 }),
      approve: async (a) => {
        approvals.push(a.kind);
        return true;
      },
      plan: true,
      noAudit: true,
    });
    expect(approvals).toHaveLength(0); // gate never consulted — denied engine-side
    expect(fsImpl.files['src/scan.ts']).toBe(baseFile); // nothing written
    expect(result.changes).toHaveLength(0);
    expect(result.stopped).toBe('finished');
  });

  it('read-only commands skip the approval gate; mutating commands still gate', async () => {
    const approvals: string[] = [];
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('run_command', { command: 'git status --short' }, 't1')] },
      { toolCalls: [tc('run_command', { command: 'touch marker.txt' }, 't2')] },
      { toolCalls: [tc('finish', { summary: 'done' }, 't3')] },
    ]);
    const ran: string[] = [];
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'inspect then mutate',
      providers: [provider],
      fsImpl: memFs(),
      run: (cmd) => {
        ran.push(cmd);
        return { stdout: 'ok', exitCode: 0 };
      },
      approve: async (a) => {
        approvals.push(a.kind === 'run' ? a.command : a.kind);
        return true;
      },
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(ran).toEqual(['git status --short', 'touch marker.txt']);
    // Only the mutating command reached the gate.
    expect(approvals).toEqual(['touch marker.txt']);
  });

  it('plan mode denies even read-only commands (plan wins over the classifier)', async () => {
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('run_command', { command: 'git status' }, 't1')] },
      { toolCalls: [tc('finish', { summary: 'plan' }, 't2')] },
    ]);
    const ran: string[] = [];
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'plan something',
      providers: [provider],
      fsImpl: memFs(),
      run: (cmd) => {
        ran.push(cmd);
        return { stdout: '', exitCode: 0 };
      },
      approve: async () => true,
      plan: true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(ran).toEqual([]); // nothing executed in plan mode
  });

  it('a standing allow-always rule skips the gate with a visible notice, and never overrides the denylist', async () => {
    const approvals: string[] = [];
    const notices: string[] = [];
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('run_command', { command: 'pnpm test --run' }, 't1')] },
      { toolCalls: [tc('run_command', { command: 'git push origin main --force' }, 't2')] },
      { toolCalls: [tc('finish', { summary: 'done' }, 't3')] },
    ]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'test then push',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: 'ok', exitCode: 0 }),
      approve: async (a) => {
        approvals.push(a.kind === 'run' ? a.command : a.kind);
        return true;
      },
      approvalRules: () => [
        { kind: 'run', prefix: 'pnpm test' },
        // A rule for the dangerous shape must still be screened out.
        { kind: 'run', prefix: 'git push' },
      ],
      onEvent: (e) => {
        if (e.type === 'notice') notices.push(e.text);
      },
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    // pnpm test matched its rule (no gate); the force-push is dangerous, so
    // its rule is ignored and the human gate is consulted.
    expect(approvals).toEqual(['git push origin main --force']);
    expect(notices.some((n) => n.includes('Auto-approved by standing rule'))).toBe(true);
  });

  it('a standing edit rule auto-approves the matching file edit and still checkpoints', async () => {
    const approvals: string[] = [];
    const checkpoints: string[][] = [];
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5;' }, 't1')] },
      { toolCalls: [tc('finish', { summary: 'done' }, 't2')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async (a) => {
        approvals.push(a.kind);
        return true;
      },
      approvalRules: () => [{ kind: 'edit', glob: 'src/**' }],
      checkpoint: (files) => {
        checkpoints.push(files);
        return { ref: 'refs/vibgrate/checkpoints/t/1', commit: 'abc1234', seq: 1 };
      },
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(approvals).toEqual([]); // gate skipped by the rule
    expect(fsImpl.files['src/scan.ts']).toContain('const timeout = 5;'); // write landed
    expect(checkpoints).toEqual([['src/scan.ts']]); // undo still possible
  });

  it('attaches user images to the task turn for the provider to encode', async () => {
    const seenMessages: ChatMessage[][] = [];
    const provider: Provider = {
      id: 'spy',
      label: 'Spy',
      local: true,
      model: 'spy-1',
      async chat(messages) {
        seenMessages.push(messages);
        return { text: 'I looked at the screenshot; the button overlaps the sidebar.', model: 'spy-1', provider: 'spy' };
      },
    };
    const image = { name: 'shot.png', mediaType: 'image/png', dataBase64: 'aGk=' };
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'fix the layout in this screenshot',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      images: [image],
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    const task = seenMessages[0].find((m) => m.role === 'user' && 'images' in m && m.images?.length);
    expect(task).toBeTruthy();
    expect((task as { images?: unknown[] }).images).toEqual([image]);
  });

  it('drops images and notices when the routed model is known to be blind', async () => {
    const seenMessages: ChatMessage[][] = [];
    const events: AgentEvent[] = [];
    const provider: Provider = {
      id: 'ollama',
      label: 'Ollama',
      local: true,
      model: 'qwen2.5-coder:7b', // registry: vision false
      async chat(messages) {
        seenMessages.push(messages);
        return { text: 'I used the on-disk reference; the layout bug is in panel.css.', model: 'qwen2.5-coder:7b', provider: 'ollama' };
      },
    };
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'fix the layout in this screenshot',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      images: [{ name: 'shot.png', mediaType: 'image/png', dataBase64: 'aGk=' }],
      onEvent: (e) => events.push(e),
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(seenMessages[0].some((m) => m.role === 'user' && 'images' in m && m.images?.length)).toBe(false);
    expect(events.some((e) => e.type === 'notice' && /cannot view images/i.test(e.text))).toBe(true);
  });

  it('sanitizes raw PatchIR dumps into a clean task-space message (no JSON in the panel)', async () => {
    const provider = new ScriptedProvider('m', [
      { text: '{"schemaVersion":"patch-ir/0","operations":[{"op":"replace-text","file":"a.ts","search":"x","replace":"y"}]}' },
    ]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'change something',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(result.finalText).not.toContain('operations');
    expect(result.finalText).not.toContain('patch-ir');
    expect(result.finalText).toMatch(/edit-shaped payload|tools|Markdown/i);
    expect(result.finalText.length).toBeGreaterThan(20);
  });

  it('writes a secret-free audit record at the end of a run', async () => {
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }, 't1')] },
      { toolCalls: [tc('run_command', { command: 'npm test' }, 't2')] },
      { toolCalls: [tc('finish', { summary: 'done' }, 't3')] },
    ]);
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: 'ok', exitCode: 0 }),
      approve: async () => true,
      now: () => 99,
    });
    expect(result.stopped).toBe('finished');
    expect(fsImpl.audit).toHaveLength(1);
    const rec = JSON.parse(fsImpl.audit[0]);
    expect(rec.kind).toBe('agent');
    expect(rec.stopped).toBe('finished');
    expect(rec.commands).toBe(1);
    expect(rec.files.map((f: { file: string }) => f.file)).toContain('src/scan.ts');
    // no code, no command text, no secrets in the record
    expect(JSON.stringify(rec)).not.toContain('timeout = 5000');
    expect(JSON.stringify(rec)).not.toContain('npm test');
  });

  it('stops as no-progress when the model repeats an identical non-mutating call', async () => {
    // Always the same search — never mutates, never finishes.
    const provider = new ScriptedProvider('m', [{ toolCalls: [tc('search_code', { query: 'timeout' }, 'x')] }]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      maxSteps: 50,
    });
    expect(result.stopped).toBe('no-progress');
    expect(result.steps).toBeLessThanOrEqual(5); // stops well before the step cap
  });

  it('auto-completes open set_progress items when the model finishes', async () => {
    const provider = new ScriptedProvider('m', [
      {
        toolCalls: [
          tc(
            'set_progress',
            {
              items: [
                { id: '1', title: 'Inspect routes', status: 'done' },
                { id: '2', title: 'Summarize endpoints', status: 'in_progress' },
              ],
            },
            'p1',
          ),
        ],
      },
      { toolCalls: [tc('finish', { summary: 'Here are the invoice endpoints.' }, 'f1')] },
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'find invoice endpoints',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      onEvent: (e) => events.push(e),
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    const progressEvents = events.filter((e) => e.type === 'progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    const last = progressEvents[progressEvents.length - 1];
    expect(last?.type).toBe('progress');
    if (last?.type === 'progress') {
      expect(last.items.every((i) => i.status === 'done')).toBe(true);
      expect(last.items.map((i) => i.title)).toEqual(['Inspect routes', 'Summarize endpoints']);
    }
  });

  it('auto-verify: keeps going until the test command passes', async () => {
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 1;' }, 'e1')] },
      { toolCalls: [tc('finish', { summary: 'first attempt' }, 'f1')] },
      { toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 1;', replace: 'const timeout = 5000;' }, 'e2')] },
      { toolCalls: [tc('finish', { summary: 'fixed it' }, 'f2')] },
    ]);
    let testRuns = 0;
    const run = vi.fn(() => ({ stdout: testRuns++ === 0 ? 'FAIL: 1 test' : 'all pass', exitCode: testRuns <= 1 ? 1 : 0 }));
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'raise the timeout',
      providers: [provider],
      fsImpl,
      run,
      approve: async () => true,
      verify: { command: 'npm test', maxRounds: 2 },
    });
    expect(result.stopped).toBe('finished');
    expect(result.finalText).toBe('fixed it');
    expect(run).toHaveBeenCalledTimes(2); // failed once, then passed
    expect(fsImpl.files['src/scan.ts']).toContain('5000');
  });

  it('accumulates token usage for the cost meter', async () => {
    const provider = new ScriptedProvider('m', [{ toolCalls: [tc('finish', { summary: 'done' }, 'f')] }]);
    // ScriptedProvider reports no usage; a provider that does would surface here.
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'x',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
    });
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('records per-model savings for the first graph search', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-agent-'));
    try {
      const provider = new ScriptedProvider('claude-3.5-sonnet', [
        { toolCalls: [tc('search_code', { query: 'timeout' }, 't1')] },
        { toolCalls: [tc('finish', { summary: 'done' }, 't2')] },
      ]);
      await runAgent({
        graph: fixtureGraph(),
        root,
        instruction: 'x',
        providers: [provider],
        fsImpl: memFs(),
        run: () => ({ stdout: '', exitCode: 0 }),
        approve: async () => true,
        attribution: { client: 'vg-code', provider: 'anthropic', model: 'anthropic/claude-3.5-sonnet' },
        now: () => Date.now(),
      });
      const models = readModelSavings(root, 30, Date.now());
      expect(models).toHaveLength(1);
      expect(models[0].model).toBe('anthropic/claude-3.5-sonnet');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('with capsule:true, first context includes exact source evidence (no navigation needed)', async () => {
    const scanBody = [
      'export type Report = { ok: boolean };',
      'export type Config = { root: string };',
      '',
      '// scanDir must never follow symlinks out of the root',
      'export function scanDir(dir: string): Report {',
      '  const cfg = readConfig();',
      '  return { ok: true };',
      '}',
      '',
      'export function readConfig(): Config {',
      '  return { root: "." };',
      '}',
    ].join('\n');
    const seen: string[] = [];
    const scripted = new ScriptedProvider('m', [{ toolCalls: [tc('finish', { summary: 'done' }, 't1')] }]);
    // Spy that implements Provider.chat fully (ScriptedProvider ignores messages).
    const provider: Provider = {
      id: scripted.id,
      label: scripted.label,
      local: scripted.local,
      model: scripted.model,
      async chat(messages, opts) {
        for (const m of messages) {
          if (typeof m.content === 'string') seen.push(m.content);
        }
        return scripted.chat(messages, opts);
      },
    };

    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'add a timeout to scanDir',
      providers: [provider],
      fsImpl: memFs({ 'src/scan.ts': scanBody }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      capsule: true,
      noAudit: true,
    });

    expect(result.stopped).toBe('finished');
    const joined = seen.join('\n');
    expect(joined).toContain('Exact source evidence');
    expect(joined).toContain('function scanDir');
  });

  it('with capsule + overlay, edits are readable before flush and persist on finish', async () => {
    const scanBody = 'export function scanDir() {\n  const timeout = 0;\n  return timeout;\n}\n';
    const fsImpl = memFs({ 'src/scan.ts': scanBody });
    const provider = new ScriptedProvider('m', [
      {
        toolCalls: [
          tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 7;' }, 't1'),
        ],
      },
      { toolCalls: [tc('finish', { summary: 'done' }, 't2')] },
    ]);
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'scanDir timeout',
      providers: [provider],
      fsImpl,
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      capsule: true,
      overlay: true,
      verifyLadder: false,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    expect(fsImpl.files['src/scan.ts']).toContain('timeout = 7');
  });

  it('default (no capsule) does not inject Exact source evidence block', async () => {
    const seen: string[] = [];
    const scripted = new ScriptedProvider('m', [{ toolCalls: [tc('finish', { summary: 'done' }, 't1')] }]);
    const provider: Provider = {
      id: scripted.id,
      label: scripted.label,
      local: scripted.local,
      model: scripted.model,
      async chat(messages, opts) {
        for (const m of messages) {
          if (typeof m.content === 'string') seen.push(m.content);
        }
        return scripted.chat(messages, opts);
      },
    };

    await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'add a timeout to scanDir',
      providers: [provider],
      fsImpl: memFs({ 'src/scan.ts': 'export function scanDir() {}' }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });

    expect(seen.join('\n')).not.toContain('Exact source evidence');
  });
});

describe('compact', () => {
  const head: ChatMessage[] = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'context' },
    { role: 'user', content: 'task' },
  ];
  const round = (i: number): ChatMessage[] => [
    { role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: { path: `f${i}.ts` } }] },
    { role: 'tool', content: 'x'.repeat(500), toolCallId: `c${i}`, name: 'read_file' },
  ];

  it('leaves a small transcript untouched', () => {
    const msgs = [...head, ...round(1), ...round(2)];
    const r = compact(msgs, 100_000, []);
    expect(r.droppedRounds).toBe(0);
    expect(r.messages).toBe(msgs);
  });

  it('keeps the prefix + recent rounds and summarizes the middle when over budget', () => {
    const rounds = Array.from({ length: 14 }, (_, i) => round(i)).flat();
    const msgs = [...head, ...rounds];
    const r = compact(msgs, 500, [{ file: 'a.ts', before: null, after: 'x', outcomes: [], diff: '' }]);
    expect(r.droppedRounds).toBe(14 - 8); // KEEP_ROUNDS = 8
    // prefix preserved, a summary note inserted, then the last 8 rounds (16 messages)
    expect(r.messages.slice(0, 3)).toEqual(head);
    expect(r.messages[3].role).toBe('user');
    expect(r.messages[3].content).toContain('summarized');
    expect(r.messages[3].content).toContain('a.ts');
    expect(r.messages.length).toBe(3 + 1 + 8 * 2);
    // never split an assistant/tool pair — the first kept round starts with an assistant
    expect(r.messages[4].role).toBe('assistant');
  });

  it('compactWithModel replaces the note with the model-written checkpoint', async () => {
    const rounds = Array.from({ length: 14 }, (_, i) => round(i)).flat();
    const msgs = [...head, ...rounds];
    const transcripts: string[] = [];
    const r = await compactWithModel(msgs, 500, [], async (t) => {
      transcripts.push(t);
      return 'Objective: fix timeout. Findings: default is 0. Next steps: edit scan.ts.';
    });
    expect(r.droppedRounds).toBe(14 - 8);
    expect(r.messages[3].content).toContain('Checkpoint summary');
    expect(r.messages[3].content).toContain('fix timeout');
    // The summarizer saw the dropped rounds, not the kept tail.
    expect(transcripts[0]).toContain('read_file');
    expect(r.messages.length).toBe(3 + 1 + 8 * 2);
  });

  it('compactWithModel falls back to the deterministic note when the summarizer fails or returns junk', async () => {
    const rounds = Array.from({ length: 14 }, (_, i) => round(i)).flat();
    const msgs = [...head, ...rounds];
    const failed = await compactWithModel(msgs, 500, [], async () => {
      throw new Error('model unavailable');
    });
    expect(failed.droppedRounds).toBe(14 - 8);
    expect(failed.messages[3].content).toContain('summarized');
    const junk = await compactWithModel(msgs, 500, [], async () => '{"schemaVersion":"patch-ir/0"}');
    expect(junk.messages[3].content).toContain('summarized');
  });

  it('compactWithModel never calls the summarizer when nothing needs compacting', async () => {
    const msgs = [...head, ...round(1)];
    let called = 0;
    const r = await compactWithModel(msgs, 100_000, [], async () => {
      called++;
      return 'x';
    });
    expect(r.droppedRounds).toBe(0);
    expect(called).toBe(0);
  });
});

describe('cap-truncated replies', () => {
  const base = () => ({
    graph: fixtureGraph(),
    root: process.cwd(),
    instruction: 'explain the billing flow',
    fsImpl: memFs(),
    run: () => ({ stdout: '', exitCode: 0 }),
    approve: async () => true,
    noAudit: true,
  });

  it('continues a reply cut off at the output cap and stitches the halves together', async () => {
    const provider = new ScriptedProvider('m', [
      { text: 'Stripe billing lives in lib/stripe.ts. The flow starts', truncated: true },
      { text: ' with a checkout session and settles on the webhook.' },
    ]);
    const result = await runAgent({ ...base(), providers: [provider] });
    expect(result.stopped).toBe('finished');
    expect(result.finalText).toBe(
      'Stripe billing lives in lib/stripe.ts. The flow starts with a checkout session and settles on the webhook.',
    );
    expect(result.finalText).not.toMatch(/cut short/);
  });

  it('keeps every partial and says so when the model never stops hitting the cap', async () => {
    // Always truncated: continuations are bounded, and the user still gets all
    // the text that was produced plus an explicit note.
    const provider = new ScriptedProvider('m', [{ text: 'part. ', truncated: true }]);
    const result = await runAgent({ ...base(), providers: [provider] });
    expect(result.finalText).toMatch(/^part\. part\. part\./);
    expect(result.finalText).toMatch(/cut short at the model's output limit/);
  });

  it('leaves an untruncated reply exactly as the model wrote it', async () => {
    const provider = new ScriptedProvider('m', [{ text: 'The billing flow is in lib/stripe.ts.' }]);
    const result = await runAgent({ ...base(), providers: [provider] });
    expect(result.finalText).toBe('The billing flow is in lib/stripe.ts.');
  });
});

describe('steer (v4 inject)', () => {
  const steerFile = 'export function scanDir() {\n  const timeout = 0;\n  return timeout;\n}\n';

  it('drains injected content at the step boundary: event + user message before the next model call', async () => {
    const provider = new ScriptedProvider('m', [
      // Step 1 keeps the loop going with a read; the steer lands before step 2.
      { toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'src/scan.ts' } }] },
      { toolCalls: [{ id: 't2', name: 'finish', arguments: { summary: 'done with steer' } }] },
    ]);
    const chat = vi.spyOn(provider, 'chat');
    const events: AgentEvent[] = [];
    const pending: string[] = ['also handle the empty case'];
    const result = await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'improve scanDir',
      providers: [provider],
      fsImpl: memFs({ 'src/scan.ts': steerFile }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      // Nothing pending on step 1; the steer arrives before step 2.
      takeInjected: () => (chat.mock.calls.length >= 1 ? (pending.shift() ?? null) : null),
      onEvent: (e) => events.push(e),
    });
    expect(result.stopped).toBe('finished');
    const injected = events.filter((e) => e.type === 'injected');
    expect(injected).toEqual([{ type: 'injected', text: 'also handle the empty case' }]);
    // The steer text reached the model as a user message on the later call.
    const lastMessages = chat.mock.calls.at(-1)![0]!;
    expect(
      lastMessages.some(
        (m) => m.role === 'user' && String(m.content).includes('also handle the empty case'),
      ),
    ).toBe(true);
  });

  it('emits no injected event when nothing is pending', async () => {
    const provider = new ScriptedProvider('m', [
      { toolCalls: [{ id: 't1', name: 'finish', arguments: { summary: 'plain' } }] },
    ]);
    const events: AgentEvent[] = [];
    await runAgent({
      graph: fixtureGraph(),
      root: '/repo',
      instruction: 'do a thing',
      providers: [provider],
      fsImpl: memFs({ 'src/scan.ts': steerFile }),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      takeInjected: () => null,
      onEvent: (e) => events.push(e),
    });
    expect(events.filter((e) => e.type === 'injected')).toHaveLength(0);
  });
});

describe('reasoning traces (protocol v5)', () => {
  const finishStep = (summary: string) => ({ toolCalls: [tc('finish', { summary }, 'f1')] });

  it('streams the reasoning channel as thinking events, never folded into the answer', async () => {
    const provider = new ScriptedProvider('m', [
      { reasoning: 'weighing the options', ...finishStep('all set') },
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent({
      graph: fixtureGraph(),
      root: process.cwd(),
      instruction: 'think about it',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      onEvent: (e) => events.push(e),
      stream: true,
      noAudit: true,
    });
    expect(result.stopped).toBe('finished');
    const thinking = events.filter((e): e is Extract<AgentEvent, { type: 'thinking' }> => e.type === 'thinking');
    expect(thinking.map((e) => e.text)).toEqual(['weighing the options']);
    // The trace must not leak into the visible answer stream.
    const said = events.filter((e) => e.type === 'assistant' || e.type === 'token');
    expect(said.some((e) => JSON.stringify(e).includes('weighing'))).toBe(false);
  });

  it('emits the whole trace once when the backend does not stream', async () => {
    const provider = new ScriptedProvider('m', [
      { reasoning: 'one shot of thought', ...finishStep('done') },
    ]);
    const events: AgentEvent[] = [];
    await runAgent({
      graph: fixtureGraph(),
      root: process.cwd(),
      instruction: 'think about it',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      onEvent: (e) => events.push(e),
      noAudit: true,
    });
    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(1);
  });

  it('forwards the reasoning budget to the provider', async () => {
    const provider = new ScriptedProvider('m', [finishStep('done')]);
    await runAgent({
      graph: fixtureGraph(),
      root: process.cwd(),
      instruction: 'go',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      reasoningEffort: 'high',
      noAudit: true,
    });
    expect(provider.lastOpts?.reasoningEffort).toBe('high');
  });

  it('omits the knob entirely when no budget was asked for', async () => {
    const provider = new ScriptedProvider('m', [finishStep('done')]);
    await runAgent({
      graph: fixtureGraph(),
      root: process.cwd(),
      instruction: 'go',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      noAudit: true,
    });
    expect(provider.lastOpts && 'reasoningEffort' in provider.lastOpts).toBe(false);
  });

  it('reports cached prompt tokens on the usage event when the provider says', async () => {
    const provider = new ScriptedProvider('m', [
      { usage: { promptTokens: 900, completionTokens: 40, cachedPromptTokens: 768 }, ...finishStep('done') },
    ]);
    const events: AgentEvent[] = [];
    await runAgent({
      graph: fixtureGraph(),
      root: process.cwd(),
      instruction: 'go',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      onEvent: (e) => events.push(e),
      noAudit: true,
    });
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      promptTokens: 900,
      completionTokens: 40,
      cachedPromptTokens: 768,
    });
  });

  it('leaves cachedPromptTokens off the usage event when the provider is silent', async () => {
    const provider = new ScriptedProvider('m', [
      { usage: { promptTokens: 10, completionTokens: 2 }, ...finishStep('done') },
    ]);
    const events: AgentEvent[] = [];
    await runAgent({
      graph: fixtureGraph(),
      root: process.cwd(),
      instruction: 'go',
      providers: [provider],
      fsImpl: memFs(),
      run: () => ({ stdout: '', exitCode: 0 }),
      approve: async () => true,
      onEvent: (e) => events.push(e),
      noAudit: true,
    });
    const usage = events.find((e) => e.type === 'usage');
    expect(usage && 'cachedPromptTokens' in usage).toBe(false);
  });
});
