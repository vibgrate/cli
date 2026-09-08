import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendSavingsEvent, pruneSavingsEvents, readSavingsEvents, resetSavings, rollupSavings, sanitizeLabel, type SavingsEvent } from './ledger.js';
import { savingsEventsPath } from './paths.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

function ev(ts: number, extra: Partial<SavingsEvent> = {}): SavingsEvent {
  return { ts, source: 'sdk', model: 'claude-x', client: 'cli', tokensBefore: 1000, tokensAfter: 400, tokensSaved: 600, usdSaved: 0.0018, transforms: ['router:log:0.40'], ccrHashes: 1, ...extra };
}

describe('ledger', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ledger-'));
    env = { VG_CONTEXT_DIR: dir } as NodeJS.ProcessEnv;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('appends jsonl with 0600, reads tolerant of corrupt lines, sanitises labels', () => {
    expect(appendSavingsEvent(ev(NOW, { model: 'weird model/name!', project: '/repo path' }), env)).toBe(true);
    const file = savingsEventsPath(env);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.appendFileSync(file, 'garbage\n');
    appendSavingsEvent(ev(NOW - 1000), env);
    const rows = readSavingsEvents(env);
    expect(rows).toHaveLength(2);
    expect(rows[0].model).toBe('weird_model/name_');
    expect(rows[0].project).toBe('/repo_path');
    expect(sanitizeLabel('', 'x')).toBe('x');
    expect(appendSavingsEvent({ ...ev(0) }, env)).toBe(false);
    expect(readSavingsEvents(env, { sinceMs: NOW })).toHaveLength(1);
  });

  it('prunes to 30 days and rollups bucket by window / model / client / project', () => {
    appendSavingsEvent(ev(NOW - 40 * DAY), env);
    appendSavingsEvent(ev(NOW - 10 * DAY, { model: 'gpt-y', client: 'ide', usdSaved: 0.01 }), env);
    appendSavingsEvent(ev(NOW - 3 * DAY, { project: 'p1' }), env);
    appendSavingsEvent(ev(NOW - 3600_000, { project: 'p1', tokensSaved: 100, tokensAfter: 900 }), env);
    expect(readSavingsEvents(env, { now: NOW })).toHaveLength(3);
    expect(pruneSavingsEvents(env, NOW)).toBe(1);
    expect(pruneSavingsEvents(env, NOW)).toBe(0);
    const r = rollupSavings(readSavingsEvents(env), NOW);
    expect(r.today).toMatchObject({ window: 'today', requests: 1, tokensSaved: 100 });
    expect(r['7d']).toMatchObject({ requests: 2, tokensSaved: 700 });
    expect(r['30d'].requests).toBe(3);
    expect(r.all.tokensSaved).toBe(1300);
    expect(Object.keys(r.all.byModel)).toEqual(['gpt-y', 'claude-x']);
    expect(r.all.byClient.ide).toEqual({ requests: 1, tokensSaved: 600, usdSaved: 0.01 });
    expect(r.all.byProject).toEqual({ p1: { requests: 2, tokensSaved: 700, usdSaved: 0.0036 }, unknown: { requests: 1, tokensSaved: 600, usdSaved: 0.01 } });
    expect(rollupSavings(readSavingsEvents(env), NOW)).toEqual(r);
    expect(resetSavings(env)).toBe(true);
    expect(readSavingsEvents(env)).toEqual([]);
  });
});
