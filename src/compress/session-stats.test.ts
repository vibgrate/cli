import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionStatsPath } from './paths.js';
import { readSessionStats, recordSessionStat, SESSION_WINDOW_MS } from './session-stats.js';

describe('session stats', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-stats-'));
    env = { VG_CONTEXT_DIR: dir } as NodeJS.ProcessEnv;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('records rows (0600), aggregates the 2h window across pids and prunes on read', () => {
    const now = 10_000_000_000;
    expect(recordSessionStat({ ts: now - SESSION_WINDOW_MS - 1, pid: 1, tokensSaved: 999, requests: 9 }, env)).toBe(true);
    recordSessionStat({ ts: now - 1000, pid: 1, tokensSaved: 10, requests: 1 }, env);
    recordSessionStat({ ts: now - 500, pid: 2, tokensSaved: 5, requests: 2 }, env);
    fs.appendFileSync(sessionStatsPath(env), 'bad line\n');
    if (process.platform !== 'win32') expect(fs.statSync(sessionStatsPath(env)).mode & 0o777).toBe(0o600);
    const s = readSessionStats(now, env, { selfPid: 1 });
    expect(s).toEqual({ tokensSaved: 15, requests: 3, processes: 2, others: { tokensSaved: 5, requests: 2, processes: 1 } });
    expect(fs.readFileSync(sessionStatsPath(env), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    expect(readSessionStats(now, { VG_CONTEXT_DIR: path.join(dir, 'missing') } as NodeJS.ProcessEnv)).toMatchObject({ requests: 0, processes: 0 });
  });
});
