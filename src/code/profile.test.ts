import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatProfileLine, ProfileRecorder, profilingEnabled, resolveProfileSwitches, acpWireLogger } from './profile.js';
import { visibleTranscript } from './host-transcript.js';
import { resolveAcpTarget } from '../commands/code-acp.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vg-profile-'));
}

/** Frames of one native-shaped turn: explore → edit → finish. */
const TURN = [
  { event: 'event', type: 'step', n: 1 },
  { event: 'event', type: 'tool-call', name: 'search_code', args: { query: 'x' } },
  { event: 'event', type: 'tool-result', name: 'search_code', content: 'hit', mutated: false },
  { event: 'event', type: 'step', n: 2 },
  { event: 'event', type: 'activity', group: 1, final: false, summary: 'Explored 1 item' },
  { event: 'event', type: 'tool-call', name: 'edit_file', args: {} },
  { event: 'approve-request', id: 1, action: { kind: 'edit', file: 'a.ts', diff: '' } },
  { event: 'event', type: 'tool-result', name: 'edit_file', content: 'ok', mutated: true },
  { event: 'event', type: 'activity', group: 1, final: true, summary: 'Explored 1 item · Edited 1 file · +1 −1' },
  { event: 'event', type: 'changes-summary', files: [{ path: 'a.ts', added: 1, removed: 1, status: 'modified' }], totalAdded: 1, totalRemoved: 1 },
  { event: 'event', type: 'metrics', metrics: { steps: 3, stopReason: 'finished', wallMs: 900, toolCalls: 3 } },
  {
    event: 'done',
    result: { finalText: 'Done.', steps: 3, stopped: 'finished', changes: [{ file: 'a.ts' }], usage: { promptTokens: 10, completionTokens: 5 } },
  },
];

describe('profile switches', () => {
  it('flags win; env turns them on for hosts that spawn the CLI', () => {
    expect(resolveProfileSwitches({}, {})).toEqual({ print: false, profileOut: undefined, traceOut: undefined, acpLog: undefined });
    expect(resolveProfileSwitches({ profile: true, profileOut: 'p.jsonl' }, {})).toMatchObject({ print: true, profileOut: 'p.jsonl' });
    const env = { VG_CODE_PROFILE: '1', VG_CODE_PROFILE_OUT: 'e.jsonl', VG_CODE_TRACE_OUT: 't.ndjson', VG_CODE_ACP_LOG: 'w.ndjson' };
    expect(resolveProfileSwitches({}, env)).toEqual({ print: true, profileOut: 'e.jsonl', traceOut: 't.ndjson', acpLog: 'w.ndjson' });
    expect(resolveProfileSwitches({}, { VG_CODE_PROFILE: '0' }).print).toBe(false);
    expect(profilingEnabled(resolveProfileSwitches({}, {}))).toBe(false);
  });
});

describe('ProfileRecorder', () => {
  it('computes steps, stop, wall, tools, changes and the visible-line counts; prints the one-liner', () => {
    let now = 10_000;
    const printed: string[] = [];
    const dir = tmp();
    const out = path.join(dir, 'profile.jsonl');
    const rec = new ProfileRecorder({ print: true, profileOut: out }, { backend: 'native', provider: 'p', model: 'm' }, () => now, (s) => printed.push(s));
    rec.beginTurn('add a --timeout flag');
    for (const line of TURN) {
      now += 100;
      rec.observe(line);
    }
    const p = rec.endTurn();
    expect(p).toMatchObject({
      steps: 3,
      stopReason: 'finished',
      wallMs: 1200,
      engineWallMs: 900,
      toolCalls: 3,
      changes: 1,
      filesChanged: ['a.ts'],
      activityLines: 1,
      changesCards: 1,
      permissionCards: 1,
      timeToFirstToolMs: 200,
      timeToFirstActivityMs: 500,
      timeToFirstTokenMs: null,
      concludedCleanly: true,
      promptTokens: 10,
    });
    expect(p.hiddenFrames['tool-call']).toBe(2);
    expect(printed[0]).toBe(
      'profile: steps=3 stop=finished wall=1.2s tools=3 changes=1 activity=1 cards=1 ttft=- clean=yes backend=native\n',
    );
    const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].schema).toBe('vg-code-profile/1');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an error frame is not a clean conclusion', () => {
    const rec = new ProfileRecorder({ print: false }, { backend: 'grok-build', provider: 'grok-build', model: 'g' });
    rec.beginTurn('x');
    rec.observe({ event: 'error', message: 'Grok Build exited unexpectedly (code 1).' });
    const p = rec.endTurn();
    expect(p.concludedCleanly).toBe(false);
    expect(p.stopReason).toBe('error');
    expect(p.error).toMatch(/exited unexpectedly/);
  });

  it('trace and wire logs are redacted at write time (no credential reaches disk)', () => {
    const dir = tmp();
    const trace = path.join(dir, 'trace.ndjson');
    const wire = path.join(dir, 'wire.ndjson');
    const secret = 'ghp_' + 'a'.repeat(36);
    const rec = new ProfileRecorder({ print: false, traceOut: trace }, { backend: 'native', provider: 'p', model: 'm' });
    rec.observe({ event: 'session-start', sessionId: 's1' }); // before the first turn: traced as turn 0
    rec.beginTurn(`use token ${secret}`);
    rec.observe({ event: 'event', type: 'tool-result', name: 'run_command', content: `export GITHUB_TOKEN=${secret}`, mutated: false });
    const p = rec.endTurn();
    acpWireLogger(wire)('recv', JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { text: secret } }));
    const traced = fs.readFileSync(trace, 'utf8');
    expect(traced).not.toContain(secret);
    expect(traced.split('\n')[0]).toContain('"turn":0');
    expect(fs.readFileSync(wire, 'utf8')).not.toContain(secret);
    expect(p.instruction).not.toContain(secret);
    expect(p.turn).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('formatProfileLine matches the spec shape', () => {
    const line = formatProfileLine({
      schema: 'vg-code-profile/1',
      backend: 'native',
      provider: 'p',
      model: 'm',
      turn: 1,
      instruction: '',
      startedAt: '',
      steps: 7,
      stopReason: 'finished',
      wallMs: 12_400,
      engineWallMs: null,
      toolCalls: 11,
      changes: 2,
      filesChanged: [],
      activityLines: 2,
      changesCards: 1,
      permissionCards: 0,
      questions: 0,
      hiddenFrames: {},
      timeToFirstTokenMs: 800,
      timeToFirstToolMs: null,
      timeToFirstActivityMs: null,
      concludedCleanly: true,
      promptTokens: 0,
      completionTokens: 0,
      error: null,
    });
    expect(line).toMatch(/^profile: steps=7 stop=finished wall=12\.4s tools=11 changes=2 /);
  });
});

describe('visibleTranscript (HOST_UI.md defaults)', () => {
  it('updates an activity group in place and hides raw tool rows', () => {
    const v = visibleTranscript(TURN);
    expect(v.items).toEqual([
      { kind: 'activity', text: 'Explored 1 item · Edited 1 file · +1 −1' },
      { kind: 'permission', text: 'edit' },
      { kind: 'changes', text: '1 file(s) · +1 −1' },
      { kind: 'answer', text: 'Done.' },
    ]);
    expect(v.activityLines).toBe(1);
  });

  it('group ids restart per turn: two turns of one group are two lines', () => {
    const turn = [
      { event: 'event', type: 'activity', group: 1, final: true, summary: 'Explored 1 item' },
      { event: 'done', result: { finalText: 'ok' } },
    ];
    expect(visibleTranscript([...turn, ...turn]).activityLines).toBe(2);
  });
});

describe('resolveAcpTarget', () => {
  it('--provider grok-build is the alias for `grok agent stdio` with the Grok steer method', () => {
    expect(resolveAcpTarget({ provider: 'grok-build' })).toEqual({
      command: 'grok agent stdio',
      providerId: 'grok-build',
      label: 'Grok Build',
      steerMethod: '_x.ai/interject',
    });
  });
  it('an explicit --acp-command wins; a grok binary is still recognised; others are generic ACP', () => {
    expect(resolveAcpTarget({ provider: 'grok-build', acpCommand: '/opt/grok/bin/grok agent stdio --debug' })?.command).toBe(
      '/opt/grok/bin/grok agent stdio --debug',
    );
    expect(resolveAcpTarget({ acpCommand: '/usr/local/bin/grok agent stdio' })?.providerId).toBe('grok-build');
    expect(resolveAcpTarget({ acpCommand: 'my-agent --acp' })).toEqual({ command: 'my-agent --acp', providerId: 'acp', label: 'my-agent (ACP)' });
    expect(resolveAcpTarget({ provider: 'ollama' })).toBeNull();
    expect(resolveAcpTarget({})).toBeNull();
  });
});
