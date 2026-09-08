import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lastLearnRun, learnStatePath, readLearnState, recordLearnRun } from './state.js';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-learn-state-'));
  env = { VG_LEARN_DIR: path.join(dir, 'learn') };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('learn state', () => {
  it('records runs per project under learnDir with 0600 and sorted keys', () => {
    expect(readLearnState(env)).toEqual({ version: 1, runs: {} });
    expect(lastLearnRun('p', env)).toBeNull();
    const run = { lastRunAt: 5, target: '/p/CLAUDE.local.md', sessions: 3, applied: true, rules: 2, agents: ['claude'] };
    const file = recordLearnRun('zeta', run, env);
    recordLearnRun('alpha', { ...run, sessions: 1 }, env);
    expect(file).toBe(learnStatePath(env));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(Object.keys(readLearnState(env).runs)).toEqual(['alpha', 'zeta']);
    expect(lastLearnRun('zeta', env)).toEqual(run);
    fs.writeFileSync(file, 'garbage');
    expect(readLearnState(env)).toEqual({ version: 1, runs: {} });
  });
});
