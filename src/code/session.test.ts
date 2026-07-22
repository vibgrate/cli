import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCodeSession, commitChanges, undoChanges, nodeCodeFs, type CodeFs } from './session.js';
import type { FileChange } from './types.js';
import { MockProvider } from './providers.js';
import { fixtureGraph } from './graph-fixture.js';
import type { Provider } from './types.js';

/** An in-memory filesystem so a governance test never writes to real disk. */
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

const editReply = [
  'src/scan.ts',
  '<<<<<<< SEARCH',
  'const timeout = 0;',
  '=======',
  'const timeout = 5000;',
  '>>>>>>> REPLACE',
].join('\n');

function mock(reply = editReply): Provider {
  return new MockProvider('mock-1', reply);
}

describe('runCodeSession — governance lifecycle', () => {
  it('dry-run is the default: it proposes but writes nothing', async () => {
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const r = await runCodeSession({ graph: fixtureGraph(), root: '/repo', instruction: 'raise the timeout', providers: [mock()], fsImpl });
    expect(r.applied).toBe(false);
    expect(fsImpl.files['src/scan.ts']).toBe('const timeout = 0;\n'); // unchanged
    expect(r.changes[0].diff).toContain('+const timeout = 5000;');
    expect(r.phasesRun).toContain('dry-run');
    expect(r.phasesRun).not.toContain('execute');
  });

  it('apply WITHOUT consent refuses to write (never destructive-by-default)', async () => {
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const r = await runCodeSession({ graph: fixtureGraph(), root: '/repo', instruction: 'x', providers: [mock()], apply: true, consent: false, fsImpl });
    expect(r.applied).toBe(false);
    expect(fsImpl.files['src/scan.ts']).toBe('const timeout = 0;\n');
    expect(r.verification.detail).toMatch(/--yes/);
  });

  it('apply WITH consent walks execute → verify → log and writes', async () => {
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const r = await runCodeSession({ graph: fixtureGraph(), root: '/repo', instruction: 'x', providers: [mock()], apply: true, consent: true, fsImpl });
    expect(r.applied).toBe(true);
    expect(fsImpl.files['src/scan.ts']).toBe('const timeout = 5000;\n');
    expect(r.verification.ok).toBe(true);
    expect(r.phasesRun).toEqual(['inspect', 'assess', 'dry-run', 'approve', 'execute', 'verify', 'log']);
  });

  it('records a secret-free audit entry with a correlation id', async () => {
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const r = await runCodeSession({ graph: fixtureGraph(), root: '/repo', instruction: 'x', providers: [mock()], apply: true, consent: true, fsImpl, now: () => 123 });
    expect(fsImpl.audit).toHaveLength(1);
    const rec = JSON.parse(fsImpl.audit[0]);
    expect(rec.applied).toBe(true);
    expect(rec.correlationId).toBe(r.correlationId);
    expect(rec.ts).toBe(123);
    // No file contents in the audit record (only statuses).
    expect(JSON.stringify(rec)).not.toContain('timeout = 5000');
  });

  it('falls back to the next provider when the first fails, flagging fellBack', async () => {
    const throwing: Provider = {
      id: 'openrouter',
      label: 'OpenRouter',
      local: false,
      model: 'x',
      chat: async () => {
        throw new Error('HTTP 503');
      },
    };
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const r = await runCodeSession({ graph: fixtureGraph(), root: '/repo', instruction: 'x', providers: [throwing, mock()], fsImpl });
    expect(r.provider.id).toBe('mock');
    expect(r.provider.fellBack).toBe(true);
  });

  it('does not write when the model returns no applicable edit', async () => {
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const r = await runCodeSession({ graph: fixtureGraph(), root: '/repo', instruction: 'x', providers: [mock('no edits here')], apply: true, consent: true, fsImpl });
    expect(r.applied).toBe(false);
    expect(fsImpl.files['src/scan.ts']).toBe('const timeout = 0;\n');
  });

  it('detects a verification mismatch when the write does not take', async () => {
    const base = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    // A filesystem whose write silently drops content — verify must catch it.
    const brokenFs: CodeFs = { ...base, write: () => {} };
    const r = await runCodeSession({ graph: fixtureGraph(), root: '/repo', instruction: 'x', providers: [mock()], apply: true, consent: true, fsImpl: brokenFs });
    expect(r.verification.ok).toBe(false);
    expect(r.verification.detail).toContain('differs');
  });
});

describe('commitChanges — the REPL apply path', () => {
  it('writes + verifies + audits a previously-computed dry-run, without a second model call', async () => {
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    // Dry-run once (no write, no audit).
    const dry = await runCodeSession({ graph: fixtureGraph(), root: '/repo', instruction: 'x', providers: [mock()], fsImpl, noAudit: true });
    expect(dry.applied).toBe(false);
    expect(fsImpl.files['src/scan.ts']).toBe('const timeout = 0;\n');
    expect(fsImpl.audit).toHaveLength(0);

    // Approve → commit the exact reviewed changes.
    const committed = commitChanges(dry, fsImpl, () => 7);
    expect(committed.applied).toBe(true);
    expect(committed.verification.ok).toBe(true);
    expect(fsImpl.files['src/scan.ts']).toBe('const timeout = 5000;\n');
    expect(fsImpl.audit).toHaveLength(1);
    expect(committed.phasesRun).toContain('execute');
  });

  it('refuses to commit when nothing applied cleanly', async () => {
    const fsImpl = memFs({ 'src/scan.ts': 'const timeout = 0;\n' });
    const dry = await runCodeSession({ graph: fixtureGraph(), root: '/repo', instruction: 'x', providers: [mock('no edits here')], fsImpl, noAudit: true });
    const committed = commitChanges(dry, fsImpl);
    expect(committed.applied).toBe(false);
    expect(fsImpl.files['src/scan.ts']).toBe('const timeout = 0;\n');
  });
});

describe('undoChanges — /undo', () => {
  it('restores edited content, re-creates deletions, and removes new files', () => {
    const fsImpl = memFs({ 'edited.ts': 'new', 'kept-created.ts': 'created' });
    const changes: FileChange[] = [
      { file: 'edited.ts', before: 'old', after: 'new', outcomes: [{ edit: { op: 'replace', file: 'edited.ts', search: 'old', replace: 'new' }, status: 'applied' }], diff: 'd' },
      { file: 'created.ts', before: null, after: 'created', outcomes: [{ edit: { op: 'create', file: 'created.ts', content: 'created' }, status: 'applied' }], diff: 'd' },
      { file: 'gone.ts', before: 'was here', after: null, outcomes: [{ edit: { op: 'delete', file: 'gone.ts' }, status: 'applied' }], diff: 'd' },
    ];
    const restored = undoChanges(changes, fsImpl);
    expect(restored.sort()).toEqual(['created.ts', 'edited.ts', 'gone.ts']);
    expect(fsImpl.files['edited.ts']).toBe('old'); // restored
    expect(fsImpl.files['created.ts']).toBeNull(); // removed
    expect(fsImpl.files['gone.ts']).toBe('was here'); // re-created
  });

  it('skips changes that never applied cleanly', () => {
    const fsImpl = memFs({ 'a.ts': 'x' });
    const restored = undoChanges([{ file: 'a.ts', before: 'orig', after: 'x', outcomes: [{ edit: { op: 'replace', file: 'a.ts', search: 'orig', replace: 'x' }, status: 'not-found' }], diff: '' }], fsImpl);
    expect(restored).toEqual([]);
    expect(fsImpl.files['a.ts']).toBe('x');
  });
});

describe('nodeCodeFs — path safety', () => {
  it('refuses to read/write paths that escape the project root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-code-'));
    try {
      const impl = nodeCodeFs(dir);
      expect(() => impl.write('../escape.ts', 'x')).toThrow(/escapes the project root/);
      // A normal in-root write works.
      impl.write('a/b.ts', 'hi');
      expect(fs.readFileSync(path.join(dir, 'a/b.ts'), 'utf8')).toBe('hi');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
