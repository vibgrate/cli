import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acquireLock,
  applyJsonFields,
  applyManaged,
  applyTomlManaged,
  applyYamlFields,
  claimFields,
  identityMismatch,
  readJsonForWrite,
  readMarker,
  readOwners,
  releaseFields,
  revertJsonFields,
  revertManaged,
  revertTomlManaged,
  revertYamlFields,
  snapshotIfAbsent,
  stripJsonc,
  stripManagedBlocks,
  type ManagedEdit,
} from './edit.js';
import { wrapBackupPath, wrapMarkerPath, wrapOwnersPath, wrapSettingsLockPath } from '../compress/paths.js';
import type { EditContext, PrevValue } from './types.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'vg-wrap-edit-'));
const mode = (file: string): number => fs.statSync(file).mode & 0o777;

function jsonEdit(file: string, fields: Record<string, unknown>): ManagedEdit {
  return { format: 'json', edit: () => applyJsonFields(file, fields), revert: (prev) => revertJsonFields(file, prev) };
}

const alive = new Set<number>();
const ctx = (pid: number, extra: Partial<EditContext> = {}): EditContext => ({ agent: 'claude', pid, port: 8787, now: () => 1_700_000_000_000, version: '0.0.0-test', isAlive: (p) => alive.has(p), identity: (p) => ({ pid: p }), ...extra });

describe('JSON field edits', () => {
  it('apply → revert is byte-identical, preserving unrelated keys and formatting', () => {
    const dir = tmp();
    const file = path.join(dir, 'settings.json');
    const original = '{\n    "permissions": {"allow": ["Bash(npm test)"]},\n    "env": {"FOO": "bar"}\n}\n';
    fs.writeFileSync(file, original);
    alive.add(1);
    const r = applyManaged(file, 'http://127.0.0.1:8787', jsonEdit(file, { 'env.ANTHROPIC_BASE_URL': 'http://127.0.0.1:8787' }), ctx(1));
    expect(r.status).toBe('applied');
    expect(r.fields).toEqual(['env.ANTHROPIC_BASE_URL']);
    const mid = JSON.parse(fs.readFileSync(file, 'utf8')) as { env: Record<string, string>; permissions: unknown };
    expect(mid.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
    expect(mid.env.FOO).toBe('bar');
    expect(mid.permissions).toEqual({ allow: ['Bash(npm test)'] });
    // 4-space indent detected from the existing file.
    expect(fs.readFileSync(file, 'utf8')).toContain('\n    "env"');
    expect(fs.existsSync(wrapBackupPath(file))).toBe(true);
    expect(mode(wrapMarkerPath(file))).toBe(0o600);
    expect(mode(wrapOwnersPath(file))).toBe(0o600);
    const rv = revertManaged(file, jsonEdit(file, {}), ctx(1));
    expect(rv.status).toBe('reverted');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(wrapBackupPath(file))).toBe(false);
    expect(fs.existsSync(wrapMarkerPath(file))).toBe(false);
    expect(fs.existsSync(wrapOwnersPath(file))).toBe(false);
    alive.delete(1);
  });

  it('creates a missing file and deletes it again on revert', () => {
    const dir = tmp();
    const file = path.join(dir, '.claude', 'settings.local.json');
    alive.add(2);
    applyManaged(file, 'u', jsonEdit(file, { 'env.ANTHROPIC_BASE_URL': 'u' }), ctx(2));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ env: { ANTHROPIC_BASE_URL: 'u' } });
    expect(readMarker(file)?.created).toBe(true);
    revertManaged(file, jsonEdit(file, {}), ctx(2));
    expect(fs.existsSync(file)).toBe(false);
    alive.delete(2);
  });

  it('keeps user edits made during the session (field-precise revert)', () => {
    const dir = tmp();
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, '{"env":{"A":"1"}}\n');
    alive.add(3);
    applyManaged(file, 'u', jsonEdit(file, { 'env.ANTHROPIC_BASE_URL': 'u' }), ctx(3));
    const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as { env: Record<string, string> };
    cur.env.B = '2';
    fs.writeFileSync(file, JSON.stringify(cur));
    revertManaged(file, jsonEdit(file, {}), ctx(3));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ env: { A: '1', B: '2' } });
    alive.delete(3);
  });

  it('refuses to clobber an unparseable or non-object file', () => {
    const dir = tmp();
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{ broken');
    expect(() => readJsonForWrite(file)).toThrow(/not a JSON object/);
    fs.writeFileSync(file, '[1,2]');
    expect(() => readJsonForWrite(file)).toThrow(/not a JSON object/);
    fs.writeFileSync(file, '');
    expect(readJsonForWrite(file)).toEqual({ obj: {}, existed: true, text: '' });
  });

  it('reads JSONC (comments, trailing commas) and stripJsonc respects strings', () => {
    expect(stripJsonc('{"a": "http://x//y", // c\n "b": [1,2,],}')).toBe('{"a": "http://x//y", \n "b": [1,2]}');
    expect(JSON.parse(stripJsonc('/* head */{"a":1,/* mid */"b":"/*not*/",}'))).toEqual({ a: 1, b: '/*not*/' });
    expect(() => stripJsonc('{"a":1 /* open')).toThrow();
  });

  it('array indices are traversed, never replaced', () => {
    const dir = tmp();
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, '{"models":[{"n":"a","k":"keep"},{"n":"b"}]}\n');
    const r = applyJsonFields(file, { 'models.0.base_url': 'u', 'models.1.base_url': 'u' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ models: [{ n: 'a', k: 'keep', base_url: 'u' }, { n: 'b', base_url: 'u' }] });
    const rv = revertJsonFields(file, r.previous);
    expect(JSON.parse(rv.text)).toEqual({ models: [{ n: 'a', k: 'keep' }, { n: 'b' }] });
  });

  it('a backup is never overwritten by a later wrap', () => {
    const dir = tmp();
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, '{"v":1}');
    expect(snapshotIfAbsent(file).created).toBe(true);
    expect(mode(wrapBackupPath(file))).toBe(0o600);
    fs.writeFileSync(file, '{"v":2}');
    expect(snapshotIfAbsent(file).created).toBe(false);
    expect(fs.readFileSync(wrapBackupPath(file), 'utf8')).toBe('{"v":1}');
  });
});

describe('YAML field edits', () => {
  it('preserves comments and restores byte-identically', () => {
    const dir = tmp();
    const file = path.join(dir, 'config.yaml');
    const original = '# goose config\nGOOSE_PROVIDER: openai # provider\nOPENAI_HOST: https://api.openai.com\nextensions:\n  - name: dev\n';
    fs.writeFileSync(file, original);
    const r = applyYamlFields(file, { OPENAI_HOST: 'http://127.0.0.1:8787', ANTHROPIC_HOST: 'http://127.0.0.1:8787' });
    expect(r.changed).toBe(true);
    expect(r.previous).toEqual({ OPENAI_HOST: { present: true, value: 'https://api.openai.com' }, ANTHROPIC_HOST: { present: false } });
    const mid = fs.readFileSync(file, 'utf8');
    expect(mid).toContain('# goose config');
    expect(mid).toContain('OPENAI_HOST: http://127.0.0.1:8787');
    expect(mid).toContain('ANTHROPIC_HOST: http://127.0.0.1:8787');
    const rv = revertYamlFields(file, r.previous);
    expect(rv.text).toBe(original);
  });

  it('per-index fields on sequences (Continue models)', () => {
    const dir = tmp();
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, 'models:\n  - name: a\n    provider: anthropic\n  - name: b\n    provider: openai\n    apiBase: https://x/v1\n');
    const r = applyYamlFields(file, (cur) => {
      const out: Record<string, unknown> = {};
      (cur.models as Array<Record<string, unknown>>).forEach((m, i) => (out[`models.${i}.apiBase`] = m.provider === 'anthropic' ? 'P' : 'P/v1'));
      return out;
    });
    expect(r.previous['models.0.apiBase']).toEqual({ present: false });
    expect(r.previous['models.1.apiBase']).toEqual({ present: true, value: 'https://x/v1' });
    expect(fs.readFileSync(file, 'utf8')).toContain('apiBase: P\n');
    const rv = revertYamlFields(file, r.previous);
    expect(rv.text).toBe('models:\n  - name: a\n    provider: anthropic\n  - name: b\n    provider: openai\n    apiBase: https://x/v1\n');
  });

  it('refuses invalid YAML', () => {
    const dir = tmp();
    const file = path.join(dir, 'bad.yaml');
    fs.writeFileSync(file, 'a: [1,\n');
    expect(() => applyYamlFields(file, { a: 1 })).toThrow(/not valid YAML/);
  });
});

describe('TOML managed blocks', () => {
  const spec = { label: 'vg install codex --compress', topLevel: { model_provider: '"vg"', openai_base_url: '"http://127.0.0.1:8787/v1"' }, blocks: ['[model_providers.vg]\nbase_url = "http://127.0.0.1:8787/v1"'] };

  it('inserts top-level keys before the first table, rewrites declared ones with # was:, appends the table block, and strips cleanly', () => {
    const dir = tmp();
    const file = path.join(dir, 'config.toml');
    const original = '# user config\nmodel = "gpt-5"\nmodel_provider = "openai"\n\n[profiles.fast]\nmodel = "o3"\n';
    fs.writeFileSync(file, original);
    const r = applyTomlManaged(file, spec);
    const mid = fs.readFileSync(file, 'utf8');
    expect(mid).toContain('model_provider = "vg"  # was: "openai"');
    expect(mid.indexOf('openai_base_url = "http://127.0.0.1:8787/v1"')).toBeLessThan(mid.indexOf('[profiles.fast]'));
    expect(mid).toContain('# --- vg compression (managed by vg install codex --compress) ---\nopenai_base_url');
    expect(mid.trimEnd().endsWith('# --- end vg compression ---')).toBe(true);
    expect(mid).toContain('# user config');
    expect(r.previous.model_provider).toEqual({ present: true, value: 'in-place' });
    expect(r.previous.openai_base_url).toEqual({ present: false });
    expect(r.previous['managed-block']).toEqual({ present: false });
    // Re-apply is idempotent (no duplicate blocks, the # was: value survives).
    applyTomlManaged(file, spec);
    const again = fs.readFileSync(file, 'utf8');
    expect(again.match(/# --- end vg compression ---/g)).toHaveLength(2);
    expect(again).toContain('# was: "openai"');
    const rv = revertTomlManaged(file, 'vg install codex --compress', r.previous);
    expect(rv.text).toBe(original);
    expect(stripManagedBlocks(again, 'vg install codex --compress')).not.toContain('vg compression');
  });

  it('refuses invalid TOML and leaves the file alone', () => {
    const dir = tmp();
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, 'model = "x\n');
    expect(() => applyTomlManaged(file, spec)).toThrow(/not valid TOML/);
    expect(fs.readFileSync(file, 'utf8')).toBe('model = "x\n');
  });

  it('managed apply/revert round-trips via the backup (comments intact)', () => {
    const dir = tmp();
    const file = path.join(dir, 'config.toml');
    const original = '# keep me\nmodel = "gpt-5"   # trailing\n';
    fs.writeFileSync(file, original);
    alive.add(9);
    const edit: ManagedEdit = { format: 'toml', edit: () => applyTomlManaged(file, spec), revert: (p) => revertTomlManaged(file, 'vg install codex --compress', p) };
    applyManaged(file, 'u', edit, ctx(9, { agent: 'codex' }));
    expect(fs.readFileSync(file, 'utf8')).toContain('[model_providers.vg]');
    revertManaged(file, edit, ctx(9, { agent: 'codex' }));
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    alive.delete(9);
  });
});

describe('advisory lock', () => {
  it('serializes, reclaims a stale lock, and times out on a live one', () => {
    const dir = tmp();
    const lock = path.join(dir, '.vg-wrap-settings.lock');
    let t = 1_000_000;
    const now = (): number => t;
    const release = acquireLock(lock, { now, pid: 100, isAlive: () => true });
    expect(mode(lock)).toBe(0o600);
    // A live holder blocks; the wait budget is honoured.
    expect(() => acquireLock(lock, { now: () => (t += 100), pid: 200, isAlive: () => true, timeoutMs: 500, pollMs: 1 })).toThrow(/timed out/);
    release();
    expect(fs.existsSync(lock)).toBe(false);
    // Stale by age: reclaimed.
    fs.writeFileSync(lock, JSON.stringify({ pid: 300, ts: 0 }));
    const r2 = acquireLock(lock, { now: () => 40_000, pid: 200, isAlive: () => true, staleMs: 30_000 });
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(200);
    r2();
    // Stale by dead holder: reclaimed immediately.
    fs.writeFileSync(lock, JSON.stringify({ pid: 300, ts: 40_000 }));
    const r3 = acquireLock(lock, { now: () => 40_001, pid: 200, isAlive: (p) => p !== 300 });
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(200);
    r3();
  });

  it('applyManaged holds the settings lock and releases it', () => {
    const dir = tmp();
    const file = path.join(dir, 's.json');
    alive.add(5);
    applyManaged(file, 'u', jsonEdit(file, { 'env.X': 'u' }), ctx(5));
    expect(fs.existsSync(wrapSettingsLockPath(file))).toBe(false);
    alive.delete(5);
  });
});

describe('ownership across concurrent wraps', () => {
  it('second session inherits; first exit is skipped; last exit restores the true original', () => {
    const dir = tmp();
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, '{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}\n');
    alive.add(11);
    alive.add(12);
    const url1 = 'http://127.0.0.1:8787';
    const url2 = 'http://127.0.0.1:8788';
    applyManaged(file, url1, jsonEdit(file, { 'env.ANTHROPIC_BASE_URL': url1 }), ctx(11));
    const r2 = applyManaged(file, url2, jsonEdit(file, { 'env.ANTHROPIC_BASE_URL': url2 }), ctx(12, { port: 8788 }));
    expect(r2.status).toBe('updated');
    const owners = readOwners(file);
    expect(owners['env.ANTHROPIC_BASE_URL']!.original).toEqual({ present: true, value: 'https://api.anthropic.com' });
    expect(owners['env.ANTHROPIC_BASE_URL']!.holders.map((h) => [h.pid, h.inherited])).toEqual([
      [11, false],
      [12, true],
    ]);
    // The marker records the founder's original, not session 1's proxy URL.
    expect(readMarker(file)!.fields['env.ANTHROPIC_BASE_URL']).toEqual({ present: true, value: 'https://api.anthropic.com' });

    // Session 1 exits while session 2 is live: nothing restored, marker re-homed.
    const rv1 = revertManaged(file, jsonEdit(file, {}), ctx(11));
    expect(rv1.status).toBe('skipped');
    expect(rv1.reason).toMatch(/still in use by pid 12/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).env.ANTHROPIC_BASE_URL).toBe(url2);
    expect(readMarker(file)!.pid).toBe(12);
    alive.delete(11);

    // Session 2 exits last: it inherited, so the original is restored — never session 1's URL.
    const rv2 = revertManaged(file, jsonEdit(file, {}), ctx(12));
    expect(rv2.status).toBe('reverted');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}\n');
    expect(fs.existsSync(wrapOwnersPath(file))).toBe(false);
    alive.delete(12);
  });

  it('force reverts even with another live holder; a dead holder is healed on the next apply', () => {
    const dir = tmp();
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, '{"env":{}}\n');
    alive.add(21);
    applyManaged(file, 'u1', jsonEdit(file, { 'env.K': 'u1' }), ctx(21));
    // A dead session's marker is reverted before a new session claims the slot.
    alive.delete(21);
    alive.add(22);
    applyManaged(file, 'u2', jsonEdit(file, { 'env.K': 'u2' }), ctx(22));
    expect(readOwners(file)['env.K']!.original).toEqual({ present: false });
    expect(readOwners(file)['env.K']!.holders.map((h) => h.pid)).toEqual([22]);
    alive.add(23);
    applyManaged(file, 'u3', jsonEdit(file, { 'env.K': 'u3' }), ctx(23));
    const rv = revertManaged(file, jsonEdit(file, {}), ctx(99, { force: true }));
    expect(rv.status).toBe('reverted');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
    alive.delete(22);
    alive.delete(23);
  });

  it('claim/release primitives: trustCaller only for a non-inherited founder', () => {
    const dir = tmp();
    const file = path.join(dir, 's.json');
    fs.mkdirSync(dir, { recursive: true });
    alive.add(31);
    alive.add(32);
    const prev: Record<string, PrevValue> = { k: { present: false } };
    claimFields(file, prev, ctx(31));
    claimFields(file, { k: { present: true, value: 'u1' } }, ctx(32));
    const rel32 = releaseFields(file, ['k'], ctx(32));
    expect(rel32.k).toMatchObject({ shouldRestore: false, trustCaller: false });
    expect(rel32.k!.survivor?.pid).toBe(31);
    const rel31 = releaseFields(file, ['k'], ctx(31));
    expect(rel31.k).toMatchObject({ shouldRestore: true, trustCaller: true, original: { present: false } });
    expect(readOwners(file)).toEqual({});
    alive.delete(31);
    alive.delete(32);
  });

  it('durable routing survives session wraps and is released only by unwrap', () => {
    const dir = tmp();
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, '{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}\n');
    const durable = applyManaged(file, 'http://127.0.0.1:8787', jsonEdit(file, { 'env.ANTHROPIC_BASE_URL': 'http://127.0.0.1:8787' }), ctx(0, { durable: true }));
    expect(durable.marker.durable).toBe(true);
    expect(readOwners(file)['env.ANTHROPIC_BASE_URL']!.holders).toEqual([{ pid: 0, inherited: false, durable: true }]);
    // A session on top inherits; its exit keeps the durable routing in place.
    alive.add(41);
    applyManaged(file, 'http://127.0.0.1:9999', jsonEdit(file, { 'env.ANTHROPIC_BASE_URL': 'http://127.0.0.1:9999' }), ctx(41));
    const rv = revertManaged(file, jsonEdit(file, {}), ctx(41));
    expect(rv.status).toBe('skipped');
    expect(rv.reason).toMatch(/durable/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999');
    expect(readMarker(file)!.durable).toBe(true);
    alive.delete(41);
    // A later session does not "heal" the durable marker away.
    alive.add(42);
    applyManaged(file, 'http://127.0.0.1:8787', jsonEdit(file, { 'env.ANTHROPIC_BASE_URL': 'http://127.0.0.1:8787' }), ctx(42));
    revertManaged(file, jsonEdit(file, {}), ctx(42));
    expect(readMarker(file)!.durable).toBe(true);
    alive.delete(42);
    // unwrap releases it and restores the original.
    const un = revertManaged(file, jsonEdit(file, {}), ctx(43, { releaseDurable: true }));
    expect(un.status).toBe('reverted');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}\n');
    expect(readMarker(file)).toBeNull();
  });

  it('identity mismatch needs proof', () => {
    expect(identityMismatch({ pid: 1 }, { pid: 1, startSrc: 'proc', startTime: 5 })).toBe(false);
    expect(identityMismatch({ pid: 1, startSrc: 'proc', startTime: 5 }, { pid: 1, startSrc: 'proc', startTime: 5.5 })).toBe(false);
    expect(identityMismatch({ pid: 1, startSrc: 'proc', startTime: 5 }, { pid: 1, startSrc: 'proc', startTime: 500 })).toBe(true);
  });
});
