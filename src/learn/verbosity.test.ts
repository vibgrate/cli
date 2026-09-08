import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verbosityProfilePath } from '../compress/paths.js';
import { installFixtures, removeFixtures, type InstalledFixtures } from './__fixtures__/install.js';
import { scanSessions } from './scan.js';
import type { Session, Turn } from './types.js';
import { learnVerbosity, loadVerbosityProfile, recommendLevel, saveVerbosityProfile, verbositySignals, type VerbositySignals } from './verbosity.js';

let fx: InstalledFixtures;
let sessions: Session[];
const NOW = Date.parse('2026-09-08T00:00:00Z');
let dir: string;

beforeAll(() => {
  fx = installFixtures();
  sessions = scanSessions({ now: NOW, env: fx.env, home: fx.home });
});
afterAll(() => removeFixtures(fx));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-verbosity-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function synthetic(humanTurns: number, interrupts: number, fastSkips: number): Session {
  const turns: Turn[] = [];
  let i = 0;
  let ts = 0;
  const long = 'word '.repeat(200).trim();
  for (let h = 0; h < humanTurns; h++) {
    ts += 60_000;
    turns.push({ index: ++i, kind: 'assistant', ts, text: long, words: 200, outputTokens: 250 });
    // A fast skip replies within 5 s of a 200-word answer (read time 48 s); others wait a minute.
    ts += h < fastSkips ? 5_000 : 60_000;
    turns.push({ index: ++i, kind: 'user', ts, text: 'ok' });
  }
  for (let k = 0; k < interrupts; k++) turns.push({ index: ++i, kind: 'interruption', text: '[Request interrupted by user]' });
  return { id: 'syn', agent: 'claude', startedAt: 0, endedAt: ts, turns, path: '/tmp/syn.jsonl' };
}

describe('verbositySignals', () => {
  it('measures the fixture sessions', () => {
    const s = verbositySignals(sessions);
    expect(s.sessions).toBe(sessions.length);
    expect(s.responses).toBeGreaterThan(10);
    expect(s.interrupts).toBe(1);
    expect(s.humanTurns).toBeGreaterThanOrEqual(9);
    expect(s.interruptRate).toBeCloseTo(1 / (s.humanTurns + 1), 3);
    expect(s.fastSkipRate).toBe(1); // "ok thanks" arrived 4 s after a 320-word answer
    expect(s.medianWords).toBeGreaterThan(0);
    expect(s.longOutputRate).toBe(0); // no answer reaches the 200-word floor (text is capped at 2000 chars... but words are counted before)
  });

  it('computes structure ratios and length-adaptive long outputs', () => {
    const turns: Turn[] = [
      { index: 1, kind: 'assistant', text: '- a\n- b\nplain', words: 300 },
      { index: 2, kind: 'user', text: 'x' },
      { index: 3, kind: 'assistant', text: '```js\ncode\n```', words: 10 },
    ];
    const s = verbositySignals([{ id: 'x', agent: 'codex', startedAt: 0, endedAt: 0, turns, path: '/tmp/x' }]);
    expect(s.responses).toBe(2);
    expect(s.bulletsRatio).toBeCloseTo(2 / 6, 3);
    expect(s.codeRatio).toBe(0.5);
    expect(s.medianWords).toBe(300);
    expect(s.meanWords).toBe(155);
    expect(s.longOutputRate).toBe(0.5); // threshold = max(200, median 300)
    expect(verbositySignals([])).toMatchObject({ responses: 0, medianWords: 0, fastSkipRate: 0, interruptRate: 0 });
  });
});

describe('recommendLevel bands', () => {
  const base: VerbositySignals = { responses: 100, medianWords: 100, meanWords: 100, bulletsRatio: 0, codeRatio: 0, longOutputRate: 0, interruptRate: 0, fastSkipRate: 0, sessions: 5, humanTurns: 30, interrupts: 0 };

  it('defaults to L2/low under 10 human turns', () => {
    expect(recommendLevel({ ...base, humanTurns: 5 })).toEqual({ level: 2, confidence: 'low', rationale: 'Too few human turns to calibrate; defaulting to L2.' });
  });

  it('maps pressure to L1 / L2 / L3 (capped) with medium/high confidence', () => {
    expect(recommendLevel({ ...base, interruptRate: 0.05, fastSkipRate: 0.04 })).toMatchObject({ level: 1, confidence: 'medium' });
    expect(recommendLevel({ ...base, interruptRate: 0.1, fastSkipRate: 0.1 })).toMatchObject({ level: 2 });
    expect(recommendLevel({ ...base, interruptRate: 0.2, fastSkipRate: 0.2 })).toMatchObject({ level: 3 });
    expect(recommendLevel({ ...base, interruptRate: 0.4, fastSkipRate: 0.4 })).toMatchObject({ level: 3 });
    expect(recommendLevel({ ...base, interruptRate: 0.4, fastSkipRate: 0.4 }).rationale).toContain('capping at L3');
    expect(recommendLevel({ ...base, humanTurns: 70 }).confidence).toBe('high');
    expect(recommendLevel({ ...base, humanTurns: 59, interrupts: 1 }).confidence).toBe('high');
  });

  it('learnVerbosity end to end on synthetic behaviour', () => {
    const calm = learnVerbosity([synthetic(20, 0, 0)]);
    expect(calm).toMatchObject({ verbosityLevel: 1, suggested: 'L1', confidence: 'medium', source: 'heuristic', learnedAt: null });
    const rushed = learnVerbosity([synthetic(20, 4, 10)], { projectPath: '/p' });
    expect(rushed.suggested).toBe('L3');
    expect(rushed.projectPath).toBe('/p');
    expect(rushed.signals.fastSkipRate).toBe(0.5);
    expect(rushed.signals.interruptRate).toBeCloseTo(4 / 24, 3);
    expect(learnVerbosity(sessions).projectPath).toBe('/home/user/demo');
  });
});

describe('save / load profile', () => {
  it('round-trips through verbosityProfilePath with 0600 and stamps learnedAt', () => {
    const env = { VG_CONTEXT_DIR: path.join(dir, 'ctx') };
    const profile = learnVerbosity([synthetic(20, 4, 10)], { projectPath: '/p' });
    const file = saveVerbosityProfile(profile, env, NOW);
    expect(file).toBe(verbosityProfilePath(env));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const loaded = loadVerbosityProfile(env);
    expect(loaded).toEqual({ ...profile, learnedAt: NOW });
    expect(loadVerbosityProfile({ VG_CONTEXT_DIR: path.join(dir, 'missing') })).toBeNull();
    fs.writeFileSync(file, '{"verbosityLevel": 9, "confidence": "weird"}');
    expect(loadVerbosityProfile(env)).toMatchObject({ verbosityLevel: 4, suggested: 'L4', confidence: 'low' });
    fs.writeFileSync(file, 'not json');
    expect(loadVerbosityProfile(env)).toBeNull();
  });
});
