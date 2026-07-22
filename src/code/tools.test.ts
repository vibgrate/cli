import { describe, it, expect, vi } from 'vitest';
import { executeTool, AGENT_TOOLS, type ToolContext } from './tools.js';
import { fixtureGraph } from './graph-fixture.js';
import type { CodeFs } from './session.js';
import type { ToolCall } from './types.js';

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
    appendAudit: () => {},
  };
}

function ctx(over: Partial<ToolContext> = {}): ToolContext & { files: Record<string, string | null>; approvals: unknown[] } {
  const fs = memFs({ 'src/scan.ts': 'export function scanDir() {\n  const timeout = 0;\n  return timeout;\n}\n' });
  const approvals: unknown[] = [];
  const base: ToolContext = {
    root: '/repo',
    graph: fixtureGraph(),
    fsImpl: fs,
    spans: new Map(),
    run: () => ({ stdout: 'ok', exitCode: 0 }),
    approve: async (a) => {
      approvals.push(a);
      return true;
    },
    ...over,
  };
  return Object.assign(base, { files: fs.files, approvals });
}

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: 'c1', name, arguments: args });

describe('AGENT_TOOLS', () => {
  it('advertises the expected tool names', () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(['search_code', 'read_file', 'list_files', 'graph_impact', 'library_docs', 'edit_file', 'create_file', 'delete_file', 'run_command', 'finish']);
  });
});

describe('read-only tools (auto, no approval)', () => {
  it('search_code returns graph matches', async () => {
    const r = await executeTool(call('search_code', { query: 'scanDir' }), ctx());
    expect(r.mutated).toBe(false);
    expect(r.content).toContain('scanDir');
    expect(r.content).toContain('src/scan.ts');
  });

  it('read_file returns file content and honors a line range', async () => {
    const r = await executeTool(call('read_file', { path: 'src/scan.ts', start_line: 2, end_line: 2 }), ctx());
    expect(r.content).toContain('const timeout = 0;');
    expect(r.content).not.toContain('return timeout;');
  });

  it('read_file reports a missing file', async () => {
    const r = await executeTool(call('read_file', { path: 'nope.ts' }), ctx());
    expect(r.content).toContain('not found');
  });

  it('read_file refuses a secrets file (never sends .env to the model)', async () => {
    const c = ctx();
    c.files['.env'] = 'OPENAI_API_KEY=sk-supersecretvalue123';
    const r = await executeTool(call('read_file', { path: '.env' }), c);
    expect(r.content).toMatch(/refusing/i);
    expect(r.content).not.toContain('sk-supersecretvalue123');
  });

  it('read_file redacts stray credentials from an ordinary file', async () => {
    const c = ctx();
    c.files['src/config.ts'] = 'export const KEY = "sk-abcdefghijklmnop";\nconst DB_PASSWORD = "hunter2secret";';
    const r = await executeTool(call('read_file', { path: 'src/config.ts' }), c);
    expect(r.content).not.toContain('hunter2secret');
    expect(r.content).toContain('***redacted***');
  });

  it('list_files lists mapped files', async () => {
    const r = await executeTool(call('list_files', {}), ctx());
    expect(r.content).toContain('src/scan.ts');
    expect(r.content).toContain('src/report.ts');
  });

  it('graph_impact reports dependents', async () => {
    const r = await executeTool(call('graph_impact', { symbol: 'scanDir' }), ctx());
    expect(r.content).toContain('formatReport');
  });
});

describe('mutating tools (gated)', () => {
  it('edit_file applies and returns a change when approved', async () => {
    const c = ctx();
    const r = await executeTool(call('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }), c);
    expect(r.mutated).toBe(true);
    expect(c.files['src/scan.ts']).toContain('5000');
    expect(r.change?.diff).toContain('+  const timeout = 5000;');
    expect(c.approvals).toHaveLength(1);
  });

  it('edit_file does NOT write when the approval is declined', async () => {
    const c = ctx({ approve: async () => false });
    const r = await executeTool(call('edit_file', { path: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 5000;' }), c);
    expect(r.mutated).toBe(false);
    expect(c.files['src/scan.ts']).toContain('const timeout = 0;');
    expect(r.content).toContain('declined');
  });

  it('edit_file reports a non-applying edit without asking for approval', async () => {
    const approve = vi.fn(async () => true);
    const r = await executeTool(call('edit_file', { path: 'src/scan.ts', search: 'does not exist', replace: 'x' }), ctx({ approve }));
    expect(r.mutated).toBe(false);
    expect(r.content).toMatch(/not applied|not-found/);
    expect(approve).not.toHaveBeenCalled();
  });

  it('create_file is gated and refuses to clobber', async () => {
    const c = ctx();
    const ok = await executeTool(call('create_file', { path: 'src/new.ts', content: 'export const x = 1;\n' }), c);
    expect(ok.mutated).toBe(true);
    expect(c.files['src/new.ts']).toContain('export const x = 1;');
    const clobber = await executeTool(call('create_file', { path: 'src/scan.ts', content: 'y' }), c);
    expect(clobber.mutated).toBe(false);
    expect(clobber.content).toContain('already exists');
  });

  it('run_command is gated and returns output', async () => {
    const run = vi.fn(() => ({ stdout: 'PASS 3 tests', exitCode: 0 }));
    const r = await executeTool(call('run_command', { command: 'npm test' }), ctx({ run }));
    expect(run).toHaveBeenCalledWith('npm test');
    expect(r.content).toContain('exit 0');
    expect(r.content).toContain('PASS 3 tests');
  });

  it('run_command declined does not run', async () => {
    const run = vi.fn(() => ({ stdout: '', exitCode: 0 }));
    const r = await executeTool(call('run_command', { command: 'echo hi' }), ctx({ approve: async () => false, run }));
    expect(run).not.toHaveBeenCalled();
    expect(r.content).toContain('declined');
  });

  it('run_command blocks a catastrophic command under --auto without even approving', async () => {
    const run = vi.fn(() => ({ stdout: '', exitCode: 0 }));
    const approve = vi.fn(async () => true);
    const r = await executeTool(call('run_command', { command: 'rm -rf /' }), ctx({ auto: true, run, approve }));
    expect(run).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(r.content).toMatch(/refused|autonomous/i);
  });

  it('run_command allows a normal command under --auto', async () => {
    const run = vi.fn(() => ({ stdout: 'ok', exitCode: 0 }));
    const r = await executeTool(call('run_command', { command: 'npm test' }), ctx({ auto: true, run }));
    expect(run).toHaveBeenCalledWith('npm test');
    expect(r.mutated).toBe(true);
  });
});

describe('library_docs', () => {
  it('reports when a package has no bundled docs', async () => {
    const r = await executeTool(call('library_docs', { name: 'left-pad' }), ctx());
    expect(r.mutated).toBe(false);
    expect(r.content).toMatch(/no bundled docs|left-pad/);
  });
});

describe('finish', () => {
  it('signals completion with a summary', async () => {
    const r = await executeTool(call('finish', { summary: 'raised the timeout' }), ctx());
    expect(r.finished).toBe(true);
    expect(r.finalSummary).toBe('raised the timeout');
  });
});
