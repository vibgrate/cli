import { describe, it, expect, vi } from 'vitest';
import { executeTool, AGENT_TOOLS, occurrenceSearchQuery, type ToolContext } from './tools.js';
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
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([
      'search_code',
      'read_file',
      'list_files',
      'graph_impact',
      'library_docs',
      'edit_file',
      'create_file',
      'delete_file',
      'apply_patch',
      'run_command',
      'inspect_task',
      'inspect_change',
      'verify_change',
      'ask_user',
      'finish',
      'abort',
    ]);
  });
});

describe('read-only tools (auto, no approval)', () => {
  it('search_code returns graph matches', async () => {
    const r = await executeTool(call('search_code', { query: 'scanDir' }), ctx());
    expect(r.mutated).toBe(false);
    expect(r.content).toContain('scanDir');
    expect(r.content).toContain('src/scan.ts');
  });

  it('search_code literal-sweeps a URL needle against the workspace tree', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'vg-search-url-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), 'const u = "https://dash.vibgrate.com/signup";\n');
      writeFileSync(join(root, 'src', 'b.ts'), '// no link here\n');
      const r = await executeTool(
        call('search_code', { query: 'https://dash.vibgrate.com/signup' }),
        ctx({ root }),
      );
      expect(r.mutated).toBe(false);
      expect(r.content).toMatch(/src\/a\.ts:1/);
      expect(r.content).toMatch(/literal match/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('search_code reports zero hits honestly for a missing URL', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'vg-search-url-miss-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), 'export const x = 1;\n');
      const r = await executeTool(
        call('search_code', { query: 'https://dash.vibgrate.com/signup does not exist find occurrences' }),
        ctx({ root }),
      );
      expect(r.content).toMatch(/no symbol or text match/i);
      expect(r.content).not.toMatch(/DoesNot|NonExisting|commandExists/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('occurrenceSearchQuery quotes bare identifiers for literal sweeps', () => {
    expect(occurrenceSearchQuery('stripe')).toBe('"stripe"');
    expect(occurrenceSearchQuery('"stripe"')).toBe('"stripe"');
    expect(occurrenceSearchQuery('where is stripe')).toBe('where is stripe');
    expect(occurrenceSearchQuery('https://x.test/a')).toBe('https://x.test/a');
  });

  it('search_code finds bare-token occurrences like workspace Find (not false empty)', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'vg-search-stripe-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'src', 'stripe-config.ts'), 'export const STRIPE_KEY = "sk_test";\n// stripe meters\n');
      writeFileSync(join(root, 'docs', 'STRIPE-SETUP.md'), '# stripe setup\n');
      const r = await executeTool(call('search_code', { query: 'stripe' }), ctx({ root }));
      expect(r.content).toMatch(/stripe/i);
      expect(r.content).toMatch(/literal match/i);
      expect(r.content).not.toMatch(/no symbol or text match/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it('apply_patch blocks invented identifiers when trie is set', async () => {
    const { buildIdentifierTrieFromGraph } = await import('../runtime/identifier-trie.js');
    const c = ctx();
    c.identifierTrie = buildIdentifierTrieFromGraph({
      nodes: c.graph.nodes.map((n) => ({ name: n.name, qualifiedName: n.qualifiedName, id: n.id })),
    });
    c.enforceIdentifiers = true;
    const r = await executeTool(
      call('apply_patch', {
        patch: {
          operations: [
            {
              op: 'replace-text',
              file: 'src/scan.ts',
              search: 'const timeout = 0;',
              replace: 'const timeout = inventGhostSymbol();',
            },
          ],
        },
      }),
      c,
    );
    expect(r.mutated).toBe(false);
    expect(r.content).toMatch(/blocked|identifier/i);
    expect(c.files['src/scan.ts']).toContain('timeout = 0');
  });

  it('apply_patch applies a multi-op PatchIR when approved', async () => {
    const c = ctx();
    const r = await executeTool(
      call('apply_patch', {
        patch: {
          operations: [
            { op: 'replace-text', file: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 9;' },
            { op: 'create-file', file: 'src/extra.ts', content: 'export const n = 1;\n' },
          ],
        },
      }),
      c,
    );
    expect(r.mutated).toBe(true);
    expect(c.files['src/scan.ts']).toContain('timeout = 9');
    expect(c.files['src/extra.ts']).toContain('export const n = 1');
    expect(r.content).toMatch(/2 file/);
    // One atomic multi-file approval (not per-file).
    expect(c.approvals).toHaveLength(1);
    expect(c.approvals[0]).toMatchObject({
      kind: 'patch',
      files: expect.arrayContaining([
        expect.objectContaining({ file: 'src/scan.ts', op: 'edit' }),
        expect.objectContaining({ file: 'src/extra.ts', op: 'create' }),
      ]),
    });
  });

  it('apply_patch declines the whole transaction without writing', async () => {
    const c = ctx({ approve: async () => false });
    const before = c.files['src/scan.ts'];
    const r = await executeTool(
      call('apply_patch', {
        patch: {
          operations: [
            { op: 'replace-text', file: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 9;' },
            { op: 'create-file', file: 'src/extra.ts', content: 'export const n = 1;\n' },
          ],
        },
      }),
      c,
    );
    expect(r.mutated).toBe(false);
    expect(r.content).toMatch(/declined/i);
    expect(c.files['src/scan.ts']).toBe(before);
    expect(c.files['src/extra.ts']).toBeUndefined();
  });

  it('apply_patch is all-or-nothing when an op fails', async () => {
    const c = ctx();
    const before = c.files['src/scan.ts'];
    const r = await executeTool(
      call('apply_patch', {
        patch: {
          operations: [
            { op: 'replace-text', file: 'src/scan.ts', search: 'const timeout = 0;', replace: 'const timeout = 1;' },
            { op: 'replace-text', file: 'nope.ts', search: 'a', replace: 'b' },
          ],
        },
      }),
      c,
    );
    expect(r.mutated).toBe(false);
    expect(c.files['src/scan.ts']).toBe(before);
    expect(r.content).toMatch(/not applied/i);
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

  it('run_command refuses network-looking commands under --auto (network policy)', async () => {
    const run = vi.fn(() => ({ stdout: '', exitCode: 0 }));
    const r = await executeTool(
      call('run_command', { command: 'curl https://example.com/x' }),
      ctx({ auto: true, run }),
    );
    expect(run).not.toHaveBeenCalled();
    expect(r.mutated).toBe(false);
    expect(r.content).toMatch(/network policy/i);
  });

  it('run_command refuses shell lines that embed credential shapes', async () => {
    const run = vi.fn(() => ({ stdout: '', exitCode: 0 }));
    const r = await executeTool(
      call('run_command', { command: 'echo sk-abcdefghijklmnop' }),
      ctx({ auto: false, run }),
    );
    expect(run).not.toHaveBeenCalled();
    expect(r.content).toMatch(/credential-shaped|secret/i);
  });
});

describe('library_docs', () => {
  it('reports when a package has no bundled docs', async () => {
    const r = await executeTool(call('library_docs', { name: 'left-pad' }), ctx());
    expect(r.mutated).toBe(false);
    expect(r.content).toMatch(/no bundled docs|left-pad/);
  });
});

describe('ask_user', () => {
  it('returns the human answer when askUser is wired', async () => {
    const r = await executeTool(call('ask_user', { question: 'Which port?', options: ['3000', '8080'] }), {
      ...ctx(),
      askUser: async (req) => {
        expect(req.question).toBe('Which port?');
        expect(req.options).toEqual(['3000', '8080']);
        return '8080';
      },
    });
    expect(r.mutated).toBe(false);
    expect(r.content).toContain('8080');
  });

  it('does not block when no host is available', async () => {
    const r = await executeTool(call('ask_user', { question: 'Continue?' }), ctx());
    expect(r.content).toMatch(/No interactive host|assumptions/i);
  });
});

describe('finish', () => {
  it('signals completion with a summary', async () => {
    const r = await executeTool(call('finish', { summary: 'raised the timeout' }), ctx());
    expect(r.finished).toBe(true);
    expect(r.finalSummary).toBe('raised the timeout');
  });
});
