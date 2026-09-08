import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, memoryHash, memoryIdFromHash, parseMemoryLine, userKey } from './store.js';
import { NO_PROJECT } from './types.js';
import type { GitRunner } from './project.js';

let dir: string;
let env: NodeJS.ProcessEnv;
const gitOk: GitRunner = (_args, cwd) => `${cwd}\n`;
const gitNone: GitRunner = () => null;
let clock = 1_700_000_000_000;
const now = (): number => clock;

function open(opts: Partial<ConstructorParameters<typeof MemoryStore>[0]> = {}): MemoryStore {
  return new MemoryStore({ cwd: path.join(dir, 'repo'), env, git: gitOk, now, ...opts });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-memory-'));
  fs.mkdirSync(path.join(dir, 'repo'));
  env = { VG_MEMORY_DIR: path.join(dir, 'mem'), VG_CONTEXT_DIR: path.join(dir, 'ctx') };
  clock = 1_700_000_000_000;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('MemoryStore', () => {
  it('adds, dedups by content hash and accumulates evidence', () => {
    const s = open();
    const a = s.add({ scope: 'project', kind: 'preference', text: 'Use   pnpm, not npm ', tags: ['Tooling'], source: 'user' });
    clock += 1000;
    const b = s.add({ scope: 'project', kind: 'preference', text: 'Use pnpm, not npm', tags: ['pnpm'], source: 'agent' });
    expect(a.id).toBe(b.id);
    expect(a.text).toBe('Use pnpm, not npm');
    expect(b.evidence).toBe(2);
    expect(b.tags).toEqual(['pnpm', 'tooling']);
    expect(b.source).toBe('user'); // first writer wins
    expect(b.updatedAt).toBe(clock);
    expect(b.createdAt).toBe(clock - 1000);
    expect(s.list()).toHaveLength(1);
  });

  it('ids are deterministic across stores and machines (content hash)', () => {
    const s1 = open();
    const m1 = s1.add({ scope: 'user', kind: 'fact', text: 'The auth module lives in src/auth', tags: [], source: 'user' });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-memory-2-'));
    try {
      const s2 = new MemoryStore({ cwd: path.join(dir, 'repo'), env: { VG_MEMORY_DIR: other }, git: gitOk, now: () => 1 });
      const m2 = s2.add({ scope: 'user', kind: 'fact', text: 'The auth module lives in src/auth', tags: [], source: 'agent' });
      expect(m2.id).toBe(m1.id);
      expect(m2.hash).toBe(m1.hash);
      expect(m1.id).toBe(memoryIdFromHash(memoryHash('user', 'fact', 'The auth module lives in src/auth')));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('redacts secrets at ingest', () => {
    const s = open();
    const m = s.add({ scope: 'global', kind: 'fact', text: 'Deploy uses API_KEY=sk-aaaaaaaaaaaaaaaaaaaa and token ghp_bbbbbbbbbbbbbbbbbbbb', tags: [], source: 'user' });
    expect(m.text).not.toContain('aaaaaaaaaaaaaaaaaaaa');
    expect(m.text).not.toContain('ghp_bbbbbbbbbbbbbbbbbbbb');
    expect(m.text).toContain('***redacted***');
    expect(fs.readFileSync(s.filePath('global'), 'utf8')).not.toContain('sk-aaaaaaaaaaaaaaaaaaaa');
  });

  it('writes 0600 files inside 0700 directories, one JSONL per scope', () => {
    const s = open();
    s.add({ scope: 'project', kind: 'fact', text: 'p', tags: [], source: 'user' });
    s.add({ scope: 'user', kind: 'fact', text: 'u', tags: [], source: 'user' });
    s.add({ scope: 'global', kind: 'fact', text: 'g', tags: [], source: 'user' });
    for (const scope of ['project', 'user', 'global'] as const) {
      const file = s.filePath(scope);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    }
    expect(s.filePath('project')).toContain(path.join('projects', s.projectKey));
    expect(s.filePath('user')).toContain(path.join('users', 'default'));
  });

  it('persists canonical sorted lines and reloads them identically', () => {
    const s = open();
    s.add({ scope: 'user', kind: 'command', text: 'Working test command: `pnpm test`', tags: ['test'], source: 'learned', evidence: 3 });
    clock += 5;
    s.add({ scope: 'user', kind: 'gotcha', text: 'foo', tags: [], source: 'agent' });
    const raw = fs.readFileSync(s.filePath('user'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).text).toContain('pnpm test'); // createdAt order
    expect(Object.keys(JSON.parse(lines[0]))).toEqual([...Object.keys(JSON.parse(lines[0]))].sort());
    const again = open();
    expect(again.list()).toEqual(s.list());
  });

  it('tolerates junk lines and duplicate rows on read', () => {
    const s = open();
    s.add({ scope: 'global', kind: 'fact', text: 'keep me', tags: [], source: 'user' });
    const file = s.filePath('global');
    const line = fs.readFileSync(file, 'utf8').trimEnd();
    fs.writeFileSync(file, `not json\n${line}\n${line}\n{"text":""}\n{"scope":"nope","kind":"fact","text":"x"}\n`);
    const again = open();
    expect(again.list().map((m) => m.text)).toEqual(['keep me']);
    expect(parseMemoryLine('{"scope":"user","kind":"fact","text":"  a  b "}')?.text).toBe('a b');
    expect(parseMemoryLine('')).toBeNull();
  });

  it('fails closed: unresolved project hides project scope from search but not from list', () => {
    const s = open({ git: gitNone });
    expect(s.projectResolved).toBe(false);
    expect(s.projectKey).toBe(NO_PROJECT);
    s.add({ scope: 'project', kind: 'fact', text: 'orphan project memory', tags: [], source: 'user' });
    s.add({ scope: 'user', kind: 'fact', text: 'user memory about project', tags: [], source: 'user' });
    expect(s.search('project memory').map((h) => h.memory.text)).toEqual(['user memory about project']);
    expect(s.list().map((m) => m.text).sort()).toEqual(['orphan project memory', 'user memory about project']);
  });

  it('honours VG_MEMORY_PROJECT_ROOT and explicit projectRoot', () => {
    const s = open({ git: gitNone, env: { ...env, VG_MEMORY_PROJECT_ROOT: path.join(dir, 'repo') } });
    expect(s.projectResolved).toBe(true);
    expect(s.project.source).toBe('env');
    const t = open({ git: gitNone, projectRoot: path.join(dir, 'repo') });
    expect(t.project.source).toBe('explicit');
    expect(t.projectKey).toBe(s.projectKey);
  });

  it('search ranks by relevance and is deterministic', () => {
    const s = open();
    s.add({ scope: 'project', kind: 'command', text: 'Working test command: `pnpm test`', tags: ['test'], source: 'learned' });
    s.add({ scope: 'project', kind: 'preference', text: 'User prefers tabs over spaces', tags: [], source: 'user' });
    s.add({ scope: 'global', kind: 'fact', text: 'Tests live under src/**/*.test.ts', tags: ['test'], source: 'user' });
    const a = s.search('how do I run the tests');
    const b = s.search('how do I run the tests');
    expect(a).toEqual(b);
    expect(a[0].memory.text).toContain('pnpm test');
    expect(a.every((h) => h.score > 0)).toBe(true);
    expect(s.search('tabs', { kinds: ['command'] })).toEqual([]);
    expect(s.search('tabs', { scope: ['project'] })[0].memory.kind).toBe('preference');
  });

  it('hybrid search uses the injected vector hook without requiring a model', () => {
    const vec = (t: string): number[] => [t.includes('cat') ? 1 : 0, t.includes('dog') ? 1 : 0];
    const s = open({ vectors: { id: 'toy', embed: (texts) => texts.map(vec) } });
    s.add({ scope: 'user', kind: 'fact', text: 'the cat sleeps', tags: [], source: 'user' });
    s.add({ scope: 'user', kind: 'fact', text: 'the dog barks', tags: [], source: 'user' });
    expect(s.search('cat')[0].memory.text).toBe('the cat sleeps');
    const broken = open({ vectors: { id: 'broken', embed: () => { throw new Error('no model'); } } });
    expect(broken.search('dog')[0].memory.text).toBe('the dog barks'); // fails open to lexical
  });

  it('get by id or unique prefix; update re-keys; delete; clear', () => {
    const s = open();
    const m = s.add({ scope: 'user', kind: 'fact', text: 'alpha beta', tags: [], source: 'user' });
    expect(s.get(m.id)?.text).toBe('alpha beta');
    expect(s.get(m.id.slice(0, 6))?.id).toBe(m.id);
    const u = s.update(m.id, 'alpha gamma');
    expect(u?.id).not.toBe(m.id);
    expect(s.get(m.id)).toBeNull();
    expect(s.list().map((x) => x.text)).toEqual(['alpha gamma']);
    expect(s.delete('nope')).toBe(false);
    expect(s.delete(u?.id ?? '')).toBe(true);
    expect(fs.existsSync(s.filePath('user'))).toBe(false);
    s.add({ scope: 'user', kind: 'fact', text: 'x', tags: [], source: 'user' });
    s.add({ scope: 'global', kind: 'fact', text: 'y', tags: [], source: 'user' });
    expect(s.clear('user')).toBe(1);
    expect(s.clear()).toBe(1);
    expect(s.list()).toEqual([]);
  });

  it('list filters and orders newest first, then id', () => {
    const s = open();
    s.add({ scope: 'user', kind: 'fact', text: 'one', tags: ['a'], source: 'user' });
    clock += 10;
    s.add({ scope: 'user', kind: 'rule', text: 'two', tags: ['a', 'b'], source: 'learned' });
    expect(s.list().map((m) => m.text)).toEqual(['two', 'one']);
    expect(s.list({ kinds: ['rule'] }).map((m) => m.text)).toEqual(['two']);
    expect(s.list({ tags: ['b'] }).map((m) => m.text)).toEqual(['two']);
    expect(s.list({ source: ['user'] }).map((m) => m.text)).toEqual(['one']);
    expect(s.list({ limit: 1 })).toHaveLength(1);
  });

  it('stats / export / import round-trip; import skips existing and re-keys project rows', () => {
    const s = open();
    s.add({ scope: 'project', kind: 'fact', text: 'p1', tags: [], source: 'user' });
    s.add({ scope: 'user', kind: 'gotcha', text: 'u1', tags: [], source: 'learned', evidence: 4 });
    const st = s.stats();
    expect(st.total).toBe(2);
    expect(st.byScope).toEqual({ project: 1, user: 1, global: 0 });
    expect(st.byKind).toEqual({ fact: 1, gotcha: 1 });
    expect(st.evidence).toBe(5);
    expect(st.files.map((f) => f.scope)).toEqual(['project', 'user']);
    const jsonl = s.export();
    expect(jsonl.trimEnd().split('\n')).toHaveLength(2);
    expect(s.import(jsonl)).toEqual({ added: 0, skipped: 2 });
    const otherRepo = path.join(dir, 'other');
    fs.mkdirSync(otherRepo);
    const t = open({ cwd: otherRepo });
    // The user-scope row is shared between the two stores (same user dir), so only the
    // project row is new here; the garbage line is skipped.
    expect(t.import(jsonl + 'garbage\n')).toEqual({ added: 1, skipped: 2 });
    const imported = t.list({ scope: ['project'] })[0];
    expect(imported.project).toBe(t.projectKey);
    expect(imported.source).toBe('imported');
    expect(t.list({ scope: ['user'] })[0].evidence).toBe(4);
    const fresh = open({ cwd: otherRepo, env: { VG_MEMORY_DIR: path.join(dir, 'mem2') } });
    expect(fresh.import(jsonl)).toEqual({ added: 2, skipped: 0 });
  });

  it('userKey sanitises and honours VG_MEMORY_USER_ID', () => {
    expect(userKey(undefined, {})).toBe('default');
    expect(userKey('Alice Smith/ops', {})).toBe('Alice-Smith-ops');
    expect(userKey(undefined, { VG_MEMORY_USER_ID: 'bob' })).toBe('bob');
    expect(open({ userId: 'x/y' }).filePath('user')).toContain(path.join('users', 'x-y'));
  });
});
