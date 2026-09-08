import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_PROJECT, installFixtures, removeFixtures, type InstalledFixtures } from './__fixtures__/install.js';
import { compareSessions, parseDuration, projectMatches, scanSessions, SCANNERS } from './scan.js';
import { aiderScanner } from './scanners/aider.js';
import { claudeScanner, decodeClaudeProjectDir } from './scanners/claude.js';
import { codexScanner, normalizeCodexTool, parseCodexOutput } from './scanners/codex.js';
import { copilotScanner } from './scanners/copilot.js';
import { cursorScanner, decodeCursorSlug } from './scanners/cursor.js';
import { geminiScanner } from './scanners/gemini.js';
import { grokScanner } from './scanners/grok.js';
import { opencodeScanner } from './scanners/opencode.js';
import type { Session, ToolCall } from './types.js';

let fx: InstalledFixtures;
const NOW = Date.parse('2026-09-08T00:00:00Z');

beforeAll(() => {
  fx = installFixtures();
});
afterAll(() => removeFixtures(fx));

function tools(s: Session): ToolCall[] {
  return s.turns.filter((t) => t.kind === 'tool_call').map((t) => t.toolCall as ToolCall);
}

describe('claude scanner', () => {
  it('reads main and subagent transcripts with tool pairs, tokens, cwd and interruptions', () => {
    const sessions = claudeScanner.scan({ now: NOW, env: fx.env, home: fx.home });
    expect(sessions.map((s) => [s.id, s.source])).toEqual([
      ['agent-1', 'subagent'],
      ['main-session', 'main'],
    ]);
    const main = sessions.find((s) => s.id === 'main-session') as Session;
    expect(main.project).toBe(FIXTURE_PROJECT);
    expect(main.startedAt).toBe(Date.parse('2026-09-01T10:00:00.000Z'));
    expect(main.endedAt).toBe(Date.parse('2026-09-01T10:01:20.000Z'));
    const tc = tools(main);
    expect(tc.map((t) => [t.name, t.isError, t.errorCategory])).toEqual([
      ['Read', true, 'file_not_found'],
      ['Read', true, 'file_not_found'],
      ['Read', true, 'file_not_found'],
      ['Read', false, 'unknown'],
      ['Bash', false, 'unknown'],
      ['Bash', false, 'unknown'],
      ['Bash', false, 'unknown'],
      ['Bash', true, 'command_not_found'],
      ['Bash', false, 'unknown'],
    ]);
    expect(main.inputTokens).toBe(1200 + 300 + 1300 + 1400 + 1500 + 1600 + 1700 + 1800 + 1900 + 2000 + 2100 + 2200);
    expect(main.outputTokens).toBe(40 + 20 + 20 + 20 + 25 + 25 + 25 + 15 + 15 + 320 + 180);
    expect(main.turns.filter((t) => t.kind === 'interruption')).toHaveLength(1);
    expect(main.turns.filter((t) => t.kind === 'user').map((t) => t.text)).toEqual(['Please fix the failing tests. Don\'t use npm, use pnpm for everything in this repo.', 'ok thanks']);
    const long = main.turns.filter((t) => t.kind === 'assistant' && (t.words ?? 0) >= 150);
    expect(long.length).toBeGreaterThanOrEqual(2);
    expect(main.turns.map((t) => t.index)).toEqual([...main.turns.map((t) => t.index)].sort((a, b) => a - b));
  });

  it('honours CLAUDE_CONFIG_DIR and decodes escaped project dirs', () => {
    expect(claudeScanner.sessionsDir({ CLAUDE_CONFIG_DIR: '/cfg' })).toEqual(['/cfg/projects']);
    expect(claudeScanner.sessionsDir({}, '/h')).toEqual(['/h/.claude/projects']);
    expect(decodeClaudeProjectDir('-home-user-demo')).toBe('/home/user/demo');
    expect(decodeClaudeProjectDir('C--Users-x')).toBe('C:\\Users\\x');
    expect(decodeClaudeProjectDir('weird')).toBeUndefined();
    expect(claudeScanner.scan({ now: NOW, env: {}, home: path.join(fx.home, 'nope') })).toEqual([]);
  });
});

describe('codex scanner', () => {
  it('parses legacy JSON and modern JSONL rollouts', () => {
    const sessions = codexScanner.scan({ now: NOW, env: fx.env, home: fx.home }).sort(compareSessions);
    expect(sessions.map((s) => s.id)).toEqual(['codex-legacy-1', 'codex-rollout-1']);
    const legacy = sessions[0];
    expect(legacy.project).toBe(FIXTURE_PROJECT);
    expect(tools(legacy).map((t) => [t.name, t.input.command, t.isError, t.errorCategory])).toEqual([
      ['Bash', 'python3 lint.py', true, 'command_not_found'],
      ['Bash', 'uv run python lint.py', false, 'unknown'],
    ]);
    expect(tools(legacy)[1].output).toBe('All checks passed\nexit code 0');
    const rollout = sessions[1];
    expect(rollout.startedAt).toBe(Date.parse('2026-09-01T13:00:00.000Z'));
    expect(tools(rollout).map((t) => [t.name, t.isError])).toEqual([
      ['Bash', true],
      ['Read', false],
    ]);
    expect(tools(rollout)[0].input.command).toBe('cat README.md');
    expect(rollout.turns.filter((t) => t.kind === 'user').map((t) => t.text)).toEqual(['Read the readme']);
    expect(rollout.turns.filter((t) => t.kind === 'assistant')).toHaveLength(1);
  });

  it('helpers normalise shell list commands and JSON outputs', () => {
    expect(normalizeCodexTool('shell', { command: ['bash', '-lc', 'ls'] })).toEqual({ name: 'Bash', input: { command: 'ls' } });
    expect(normalizeCodexTool('exec_command', { cmd: 'ls' }).input.command).toBe('ls');
    expect(normalizeCodexTool('read_file', { path: 'x' }).name).toBe('read_file');
    expect(parseCodexOutput('{"output":"hi","metadata":{}}')).toBe('hi');
    expect(parseCodexOutput('plain')).toBe('plain');
    expect(parseCodexOutput({ a: 1 })).toBe('{"a":1}');
  });
});

describe('gemini scanner', () => {
  it('pairs functionCall / functionResponse parts and counts tokens once', () => {
    const [s] = geminiScanner.scan({ now: NOW, env: fx.env, home: fx.home });
    expect(s.id).toBe('gemini-session-1');
    expect(s.project).toBe(FIXTURE_PROJECT);
    expect(tools(s).map((t) => [t.name, t.input.command, t.isError, t.errorCategory])).toEqual([
      ['Bash', 'ls src/', true, 'file_not_found'],
      ['Bash', 'ls lib/', false, 'unknown'],
    ]);
    expect(s.inputTokens).toBe(2700);
    expect(s.outputTokens).toBe(72);
    expect(s.startedAt).toBe(Date.parse('2026-09-01T14:00:00.000Z'));
  });
});

describe('grok scanner', () => {
  it('reads ACP updates and decodes the workspace from the directory name', () => {
    const [s] = grokScanner.scan({ now: NOW, env: fx.env, home: fx.home });
    expect(s.id).toBe('grok-1');
    expect(s.project).toBe(FIXTURE_PROJECT);
    expect(tools(s).map((t) => [t.name, t.input.command, t.isError, t.errorCategory, t.output])).toEqual([
      ['Bash', 'make build', true, 'build_failure', "make: *** No rule to make target 'build'.  Stop.\nBUILD FAILED"],
      ['Bash', 'make all', false, 'unknown', 'Build finished successfully'],
    ]);
    expect(s.turns.filter((t) => t.kind === 'user')).toHaveLength(1);
    expect(s.turns.filter((t) => t.kind === 'assistant')).toHaveLength(1);
  });
});

describe('opencode scanner', () => {
  it('joins session / message / part JSON storage', () => {
    const [s] = opencodeScanner.scan({ now: NOW, env: fx.env, home: fx.home });
    expect(s.id).toBe('ses-1');
    expect(s.project).toBe(FIXTURE_PROJECT);
    expect(s.startedAt).toBe(1788278400000);
    expect(s.endedAt).toBe(1788278460000);
    expect(tools(s).map((t) => [t.name, t.id, t.isError, t.errorCategory])).toEqual([
      ['Bash', 'toolu_oc_1', true, 'module_not_found'],
      ['Bash', 'toolu_oc_2', false, 'unknown'],
    ]);
    expect(s.turns.filter((t) => t.kind === 'user').map((t) => t.text)).toEqual(['Fix the broken import in app.py']);
    expect(s.turns.find((t) => t.kind === 'assistant')).toMatchObject({ inputTokens: 700, outputTokens: 40, hasToolUse: true });
    expect(opencodeScanner.sessionsDir({ XDG_DATA_HOME: '/xdg' })).toEqual(['/xdg/opencode/storage']);
  });
});

describe('cursor scanner', () => {
  it('parses OpenAI-shaped transcripts and normalises tool names', () => {
    const [s] = cursorScanner.scan({ now: NOW, env: fx.env, home: fx.home });
    expect(s.id).toBe('cur-1');
    expect(s.project).toBe(FIXTURE_PROJECT); // from the cwd field
    expect(tools(s).map((t) => [t.name, t.isError, t.errorCategory])).toEqual([
      ['Read', true, 'file_too_large'],
      ['Grep', false, 'unknown'],
    ]);
    expect(s.turns.filter((t) => t.kind === 'user')[0].text).toContain('Never edit generated files');
    expect(decodeCursorSlug('home-user-demo', (p) => p === '/home/user/demo')).toBe('/home/user/demo');
    expect(decodeCursorSlug('nope', () => false)).toBeUndefined();
  });
});

describe('copilot scanner', () => {
  it('reads event streams with tool start/complete pairs', () => {
    const [s] = copilotScanner.scan({ now: NOW, env: fx.env, home: fx.home });
    expect(s.id).toBe('copilot-1');
    expect(s.project).toBe(FIXTURE_PROJECT);
    expect(tools(s).map((t) => [t.name, t.isError, t.errorCategory])).toEqual([
      ['Bash', true, 'permission_denied'],
      ['Bash', false, 'unknown'],
    ]);
    expect(tools(s)[1].output).toBe('a.json\nb.json');
    expect(s.turns.filter((t) => t.kind === 'assistant')).toHaveLength(3);
  });
});

describe('aider scanner', () => {
  it('splits markdown history into sessions with edits and /run commands', () => {
    const sessions = aiderScanner.scan({ now: NOW, env: fx.env, home: fx.home, project: fx.project });
    expect(sessions.map((s) => s.id)).toEqual(['.aider.chat.history-1', '.aider.chat.history-2']);
    const first = sessions[0];
    expect(first.project).toBe(fx.project);
    expect(first.startedAt).toBe(Date.parse('2026-09-01T18:00:00'));
    expect(tools(first).map((t) => [t.name, t.input.command ?? t.input.file_path, t.isError])).toEqual([
      ['Edit', 'hello.py', false],
      ['Bash', 'pytest -q', true],
      ['Bash', 'pytest -q test_hello.py', false],
    ]);
    expect(tools(first)[1].errorCategory).toBe('file_not_found');
    expect(first.turns.filter((t) => t.kind === 'user').map((t) => t.text)).toEqual(['Add a greeting function to hello.py']);
    expect(first.turns.some((t) => t.kind === 'assistant' && t.text?.includes('explicit file argument'))).toBe(true);
    expect(tools(sessions[1])).toHaveLength(1);
    expect(aiderScanner.scan({ now: NOW, env: {}, home: path.join(fx.home, 'nowhere'), project: path.join(fx.home, 'nowhere') })).toEqual([]);
  });
});

describe('scanSessions', () => {
  it('scans every agent, filters by time and project, and orders deterministically', () => {
    const all = scanSessions({ now: NOW, env: fx.env, home: fx.home });
    const agents = new Set(all.map((s) => s.agent));
    for (const a of ['claude', 'codex', 'gemini', 'grok', 'opencode', 'cursor', 'copilot']) expect(agents.has(a)).toBe(true);
    expect(all).toEqual([...all].sort(compareSessions));
    expect(scanSessions({ now: NOW, env: fx.env, home: fx.home })).toEqual(all);

    const claudeOnly = scanSessions({ agents: ['claude', 'bogus'], now: NOW, env: fx.env, home: fx.home });
    expect(new Set(claudeOnly.map((s) => s.agent))).toEqual(new Set(['claude']));

    const recent = scanSessions({ now: NOW, sinceMs: Date.parse('2026-09-02T00:00:00Z'), env: fx.env, home: fx.home });
    expect(recent.map((s) => s.id)).toEqual(['agent-1']);

    const byProject = scanSessions({ now: NOW, project: FIXTURE_PROJECT, env: fx.env, home: fx.home });
    expect(byProject.length).toBe(all.length);
    expect(scanSessions({ now: NOW, project: '/elsewhere', env: fx.env, home: fx.home })).toEqual([]);
  });

  it('skips a scanner that throws instead of failing the run', () => {
    const original = SCANNERS.grok.scan;
    const errors: string[] = [];
    try {
      (SCANNERS.grok as { scan: typeof original }).scan = () => {
        throw new Error('boom');
      };
      const out = scanSessions({ now: NOW, env: fx.env, home: fx.home, onError: (a, e) => errors.push(`${a}:${(e as Error).message}`) });
      expect(errors).toEqual(['grok:boom']);
      expect(out.some((s) => s.agent === 'claude')).toBe(true);
    } finally {
      (SCANNERS.grok as { scan: typeof original }).scan = original;
    }
  });

  it('projectMatches and parseDuration', () => {
    expect(projectMatches('/a/b/c', '/a/b')).toBe(true);
    expect(projectMatches('/a/bc', '/a/b')).toBe(false);
    expect(projectMatches(undefined, '/a')).toBe(false);
    expect(parseDuration('7d')).toBe(7 * 86_400_000);
    expect(parseDuration('48h')).toBe(48 * 3_600_000);
    expect(parseDuration('2w')).toBe(14 * 86_400_000);
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('3')).toBe(3 * 86_400_000);
    expect(parseDuration('soon')).toBeNull();
  });

  it('fixture files were laid out as the agents write them', () => {
    expect(fs.existsSync(path.join(fx.home, '.claude', 'projects', '-home-user-demo', 'main-session.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(fx.home, '.codex', 'sessions', '2026', '09', '01', 'rollout-2026-09-01.jsonl'))).toBe(true);
  });
});
