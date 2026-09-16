/**
 * Review → PatchIR contract gold tests.
 *
 * The adapter must call the existing agent / one-shot session — never a second
 * loop — and errors must never look like success.
 */

import { describe, it, expect } from 'vitest';
import { AGENT_NO_PROGRESS_STOP_AT } from '../code/agent.js';
import { fixtureGraph } from '../code/graph-fixture.js';
import { PATCH_IR_SCHEMA_VERSION, validatePatchIR } from '../code/patch-ir.js';
import { MockProvider, ScriptedProvider } from '../code/providers.js';
import type { CodeFs } from '../code/session.js';
import type { Provider, ToolCall } from '../code/types.js';
import {
  REVIEW_PROPOSE_LOOP_CAP,
  fileChangesToPatchIR,
  isDefaultBranchRef,
  parseReviewProposeModelId,
  proposeFindingFix,
} from './propose.js';
import { capsule, finding } from './test-fixtures.js';

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

const editReply = [
  'src/scan.ts',
  '<<<<<<< SEARCH',
  'const timeout = 0;',
  '=======',
  'const timeout = 5000;',
  '>>>>>>> REPLACE',
].join('\n');

const baseFile = 'export function scanDir() {\n  const timeout = 0;\n  return timeout;\n}\n';

function baseInput(overrides: Partial<Parameters<typeof proposeFindingFix>[0]> = {}) {
  return {
    capsule: capsule({
      policies: [{ evidence_id: 'policy:1', id: 'layering', rule: 'outer layers flow one way', source: 'review.toml' as const }],
    }),
    finding: finding({ paths: ['src/scan.ts'], remediation: 'Raise the timeout through the application service.' }),
    policySnippet: 'outer layers flow one way',
    modelId: 'forge',
    root: '/repo',
    graph: fixtureGraph(),
    fsImpl: memFs({ 'src/scan.ts': baseFile }),
    currentRef: 'refs/heads/feat/fix',
    noCheckpoint: true,
    correlationId: 'rp-test',
    ...overrides,
  };
}

describe('parseReviewProposeModelId', () => {
  it('accepts hosted Relay slugs and the three Code Modes', () => {
    expect(parseReviewProposeModelId('relay:hosted-coder')).toEqual({ kind: 'relay', model: 'hosted-coder' });
    expect(parseReviewProposeModelId('spark')).toEqual({ kind: 'code-mode', mode: 'spark' });
    expect(parseReviewProposeModelId('flow')).toEqual({ kind: 'code-mode', mode: 'flow' });
    expect(parseReviewProposeModelId('forge')).toEqual({ kind: 'code-mode', mode: 'forge' });
  });

  it('rejects empty, unknown, and bare relay: ids', () => {
    expect(parseReviewProposeModelId('')).toBeNull();
    expect(parseReviewProposeModelId('relay:')).toBeNull();
    expect(parseReviewProposeModelId('gpt-4')).toBeNull();
    expect(parseReviewProposeModelId('ollama')).toBeNull();
  });
});

describe('isDefaultBranchRef', () => {
  it('treats main/master as default and detached HEAD as not', () => {
    expect(isDefaultBranchRef('refs/heads/main')).toBe(true);
    expect(isDefaultBranchRef('master')).toBe(true);
    expect(isDefaultBranchRef(null)).toBe(false);
    expect(isDefaultBranchRef('HEAD')).toBe(false);
    expect(isDefaultBranchRef('refs/heads/feat/x')).toBe(false);
  });
});

describe('fileChangesToPatchIR', () => {
  it('lifts a replace into patch-ir/0', () => {
    const patch = fileChangesToPatchIR([
      {
        file: 'src/scan.ts',
        before: 'const timeout = 0;\n',
        after: 'const timeout = 5000;\n',
        outcomes: [{ status: 'applied', edit: { op: 'replace', file: 'src/scan.ts', search: 'const timeout = 0;\n', replace: 'const timeout = 5000;\n' } }],
        diff: '--- a/src/scan.ts\n+++ b/src/scan.ts\n',
      },
    ]);
    expect(patch?.schemaVersion).toBe(PATCH_IR_SCHEMA_VERSION);
    expect(validatePatchIR(patch!).ok).toBe(true);
    expect(patch?.operations[0]).toMatchObject({ op: 'replace-text', file: 'src/scan.ts' });
  });

  it('returns null when nothing changed', () => {
    expect(fileChangesToPatchIR([])).toBeNull();
    expect(fileChangesToPatchIR([{ file: 'a.ts', before: 'x', after: 'x', outcomes: [], diff: '' }])).toBeNull();
  });
});

describe('proposeFindingFix — Review contract', () => {
  it('one-shot residual → patch → verify is dry-run by default and returns PatchIR', async () => {
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const r = await proposeFindingFix(
      baseInput({
        loop: false,
        modelId: 'relay:hosted-coder',
        providers: [new MockProvider('hosted-coder', editReply)],
        fsImpl,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.stopReason).toBe('finished');
    expect(r.error).toBeNull();
    expect(r.patch?.schemaVersion).toBe(PATCH_IR_SCHEMA_VERSION);
    expect(validatePatchIR(r.patch!).ok).toBe(true);
    expect(r.proposedDiff).toContain('+const timeout = 5000;');
    expect(fsImpl.files['src/scan.ts']).toBe('const timeout = 0;\n');
    expect(r.toolTrace.some((t) => t.name === 'one-shot-assess')).toBe(true);
  });

  it('one-shot apply + consent writes and verifies', async () => {
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const r = await proposeFindingFix(
      baseInput({
        loop: false,
        apply: true,
        consent: true,
        modelId: 'relay:hosted-coder',
        providers: [new MockProvider('hosted-coder', editReply)],
        fsImpl,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.error).toBeNull();
    expect(fsImpl.files['src/scan.ts']).toBe('const timeout = 5000;\n');
    expect(r.toolTrace.some((t) => t.name === 'one-shot-verify')).toBe(true);
  });

  it('agent loop produces PatchIR from edit_file + finish', async () => {
    const fsImpl = memFs({ 'src/scan.ts': baseFile });
    const provider = new ScriptedProvider('forge-pack', [
      {
        toolCalls: [
          tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5;' }, 'e1'),
        ],
      },
      { toolCalls: [tc('finish', { summary: 'Raised the timeout.' }, 'f1')] },
    ]);
    const r = await proposeFindingFix(baseInput({ loop: true, providers: [provider], fsImpl, modelId: 'forge' }));
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.stopReason).toBe('finished');
    expect(r.patch).toBeTruthy();
    expect(r.toolTrace.map((t) => t.name)).toContain('edit_file');
    expect(fsImpl.files['src/scan.ts']).toBe(baseFile);
  });

  it('--loop cap is 5 and identical calls stop as no-progress (not success)', async () => {
    expect(REVIEW_PROPOSE_LOOP_CAP).toBe(5);
    expect(REVIEW_PROPOSE_LOOP_CAP).toBe(AGENT_NO_PROGRESS_STOP_AT);
    const provider = new ScriptedProvider('m', [{ toolCalls: [tc('search_code', { query: 'timeout' }, 'x')] }]);
    const r = await proposeFindingFix(baseInput({ loop: true, providers: [provider] }));
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(false);
    expect(r.stopReason).toBe('no-progress');
    expect(r.steps).toBe(REVIEW_PROPOSE_LOOP_CAP);
    expect(r.error).toMatch(/progress|repeated/i);
    expect(r.patch).toBeNull();
  });

  it('empty Code Mode replies are no-tools, never a successful empty patch', async () => {
    const provider = new ScriptedProvider('spark-pack', [{ text: '' }]);
    const r = await proposeFindingFix(baseInput({ loop: true, providers: [provider], modelId: 'spark' }));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe('no-tools');
    expect(r.error).toBeTruthy();
    expect(r.patch).toBeNull();
  });

  it('never writes the default branch even with apply + consent', async () => {
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const r = await proposeFindingFix(
      baseInput({
        loop: false,
        apply: true,
        consent: true,
        currentRef: 'refs/heads/main',
        providers: [new MockProvider('hosted-coder', editReply)],
        fsImpl,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(false);
    expect(r.stopReason).toBe('default-branch');
    expect(r.error).toMatch(/default branch/);
    expect(r.error).toMatch(/rp-test/);
    expect(fsImpl.files['src/scan.ts']).toBe('const timeout = 0;\n');
  });

  it('apply without consent stays dry-run and is not ok', async () => {
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const r = await proposeFindingFix(
      baseInput({
        loop: false,
        apply: true,
        consent: false,
        providers: [new MockProvider('hosted-coder', editReply)],
        fsImpl,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(false);
    expect(r.error).toMatch(/--yes/);
    expect(fsImpl.files['src/scan.ts']).toBe('const timeout = 0;\n');
    expect(r.patch).toBeTruthy();
  });

  it('unknown model id is not success', async () => {
    const r = await proposeFindingFix(baseInput({ modelId: 'mystery' }));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe('invalid-model');
    expect(r.error).toMatch(/relay:|spark|flow|forge/);
  });

  it('a fallback backend is fallback-backend, not success', async () => {
    const relay: Provider = {
      id: 'vibgrate-relay',
      label: 'Vibgrate Relay',
      local: false,
      model: 'hosted-coder',
      chat: async () => {
        throw new Error('ECONNRESET');
      },
    };
    const local = new ScriptedProvider('local-coder', [
      {
        toolCalls: [tc('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5;' }, 'e1')],
      },
      { toolCalls: [tc('finish', { summary: 'answered on the fallback' }, 'f1')] },
    ]);
    const r = await proposeFindingFix(
      baseInput({ loop: true, modelId: 'relay:hosted-coder', providers: [relay, local] }),
    );
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe('fallback-backend');
    expect(r.provider.fellBack).toBe(true);
    expect(r.patch).toBeNull();
    expect(r.error).toMatch(/fallback backend/i);
  });

  it('plan-mode leakage (no mutations) is no-patch, not success', async () => {
    // A provider that only "plans" — no edit — must not report ok.
    const provider = new ScriptedProvider('m', [
      { toolCalls: [tc('finish', { summary: 'Plan: raise the timeout later.' }, 'f1')] },
    ]);
    const r = await proposeFindingFix(baseInput({ loop: true, providers: [provider] }));
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe('no-patch');
    expect(r.applied).toBe(false);
    expect(r.error).toMatch(/without a patch/);
  });
});
