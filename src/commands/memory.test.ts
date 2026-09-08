import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerServeMemory } from './memory.js';

let dir: string;
let repo: string;
const saved: Record<string, string | undefined> = {};

/** Run `vg serve memory …` against a fresh program, capturing stdout (JSON) and stderr. */
async function run(args: string[]): Promise<{ json: unknown; err: string }> {
  const program = new Command();
  program.exitOverride();
  registerServeMemory(program.command('serve'));
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    outChunks.push(String(s));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
    errChunks.push(String(s));
    return true;
  });
  try {
    await program.parseAsync(['serve', 'memory', ...args, '--cwd', repo], { from: 'user' });
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  const out = outChunks.join('');
  let parsed: unknown = out;
  try {
    if (out.trim().startsWith('{')) parsed = JSON.parse(out);
  } catch {
    parsed = out; // multi-line JSONL export
  }
  return { json: parsed, err: errChunks.join('') };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-memory-cmd-'));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  for (const k of ['VG_MEMORY_DIR', 'VG_MEMORY_PROJECT_ROOT', 'VG_CONTEXT_DIR', 'VG_MEMORY_USER_ID']) saved[k] = process.env[k];
  process.env.VG_MEMORY_DIR = path.join(dir, 'mem');
  process.env.VG_CONTEXT_DIR = path.join(dir, 'ctx');
  process.env.VG_MEMORY_PROJECT_ROOT = repo; // hermetic: never shell out to git
  process.env.VG_MEMORY_USER_ID = 'tester';
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('vg memory', () => {
  it('add → list → search → stats → delete round trip with --json', async () => {
    const added = (await run(['add', 'Use', 'pnpm,', 'never', 'npm', '--kind', 'rule', '--tags', 'Tooling,pnpm', '--json'])).json as { ok: boolean; memory: { id: string; scope: string; kind: string; text: string; tags: string[] }; file: string };
    expect(added.ok).toBe(true);
    expect(added.memory).toMatchObject({ scope: 'project', kind: 'rule', text: 'Use pnpm, never npm', tags: ['pnpm', 'tooling'] });
    expect(added.file.startsWith(path.join(dir, 'mem', 'projects'))).toBe(true);
    expect(fs.statSync(added.file).mode & 0o777).toBe(0o600);

    const again = (await run(['add', 'Use pnpm, never npm', '--kind', 'rule', '--json'])).json as { memory: { evidence: number } };
    expect(again.memory.evidence).toBe(2);

    const listed = (await run(['list', '--json'])).json as { count: number; memories: Array<{ id: string }>; project: { key: string } };
    expect(listed.count).toBe(1);
    expect(listed.memories[0].id).toBe(added.memory.id);
    expect((await run(['--json'])).json).toEqual(listed); // bare `vg memory` lists

    const found = (await run(['search', 'should I use npm or pnpm', '--json'])).json as { count: number; hits: Array<{ score: number; memory: { id: string } }> };
    expect(found.count).toBe(1);
    expect(found.hits[0].memory.id).toBe(added.memory.id);

    const stats = (await run(['stats', '--json'])).json as { total: number; byScope: Record<string, number>; user: string; project: { resolved: boolean } };
    expect(stats).toMatchObject({ total: 1, byScope: { project: 1, user: 0, global: 0 }, user: 'tester', project: { resolved: true } });

    const deleted = (await run(['delete', added.memory.id.slice(0, 8), '--json'])).json as { ok: boolean; deleted: string };
    expect(deleted).toEqual({ ok: true, deleted: added.memory.id });
    expect(((await run(['list', '--json'])).json as { count: number }).count).toBe(0);
  });

  it('export writes JSONL to stdout or a 0600 file; import re-adds and skips duplicates', async () => {
    await run(['add', 'first fact', '--scope', 'user', '--json']);
    await run(['add', 'second fact', '--scope', 'global', '--json']);
    const stdout = (await run(['export'])).json as string;
    expect(stdout.trim().split('\n')).toHaveLength(2);
    const file = path.join(dir, 'dump.jsonl');
    const exported = (await run(['export', file, '--json'])).json as { ok: boolean; count: number; file: string };
    expect(exported).toEqual({ ok: true, count: 2, file });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((await run(['import', file, '--json'])).json).toEqual({ ok: true, file, added: 0, skipped: 2 });
    await run(['clear', '--yes', '--json']);
    expect((await run(['import', file, '--json'])).json).toEqual({ ok: true, file, added: 2, skipped: 0 });
  });

  it('clear needs --yes and honours --scope', async () => {
    await run(['add', 'u', '--scope', 'user', '--json']);
    await run(['add', 'g', '--scope', 'global', '--json']);
    await expect(run(['clear', '--json'])).rejects.toMatchObject({ code: 5 });
    expect((await run(['clear', '--scope', 'user', '--yes', '--json'])).json).toEqual({ ok: true, scope: 'user', cleared: 1 });
    expect(((await run(['list', '--json'])).json as { count: number }).count).toBe(1);
  });

  it('rejects bad scopes / kinds, unknown ids, and project scope without a project', async () => {
    await expect(run(['add', 'x', '--scope', 'galaxy', '--json'])).rejects.toMatchObject({ code: 5 });
    await expect(run(['add', 'x', '--kind', 'poem', '--json'])).rejects.toMatchObject({ code: 5 });
    await expect(run(['delete', 'deadbeef', '--json'])).rejects.toMatchObject({ code: 3 });
    await expect(run(['import', path.join(dir, 'missing.jsonl'), '--json'])).rejects.toMatchObject({ code: 3 });
    delete process.env.VG_MEMORY_PROJECT_ROOT;
    const noRepo = path.join(dir, 'not-a-repo');
    fs.mkdirSync(noRepo);
    repo = noRepo;
    const stats = (await run(['stats', '--json'])).json as { project: { resolved: boolean; key: string } };
    if (!stats.project.resolved) {
      expect(stats.project.key).toBe('no-project');
      await expect(run(['add', 'x', '--scope', 'project', '--json'])).rejects.toMatchObject({ code: 5 });
      const fallback = (await run(['add', 'y', '--json'])).json as { memory: { scope: string } };
      expect(fallback.memory.scope).toBe('user');
    }
  });

  it('prints human output to stderr and nothing to stdout without --json', async () => {
    const r = await run(['add', 'human readable memory']);
    expect(r.json).toBe('');
    expect(r.err).toContain('vg memory add');
    const l = await run(['list']);
    expect(l.json).toBe('');
    expect(l.err).toContain('human readable memory');
  });
});
