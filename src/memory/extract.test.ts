import { describe, expect, it } from 'vitest';
import type { Message } from '../compress/types.js';
import {
  buildRecovery,
  canonicalizeUserText,
  commandsRelatedAsRetry,
  dropContradictions,
  extractDecision,
  extractEnvironment,
  extractMemories,
  extractPreference,
  extractToolCalls,
  isLearnableUserText,
  levenshtein,
  normalizeBashForKey,
  pathsRelatedAsTypo,
  stripSystemReminders,
  type ToolObservation,
} from './extract.js';

function obs(name: string, input: Record<string, unknown>, output: string, isError: boolean, cat: ToolObservation['errorCategory'] = 'unknown'): ToolObservation {
  return { name, id: `${name}-${output.length}`, input, output, isError, errorCategory: isError ? cat : 'unknown', messageIndex: 0 };
}

describe('user text hygiene', () => {
  it('strips system-reminder blocks literally and case-insensitively', () => {
    expect(stripSystemReminders('a <system-reminder>don\'t mention this</system-reminder> b')).toBe('a  b');
    expect(stripSystemReminders('<SYSTEM-REMINDER x="1">y</SYSTEM-REMINDER>z')).toBe('z');
    expect(stripSystemReminders('unclosed <system-reminder>oops')).toBe('unclosed ');
    expect(stripSystemReminders('plain')).toBe('plain');
  });

  it('canonicalises appended memory / ambient context and rejects harness prefixes', () => {
    expect(canonicalizeUserText('real ask\n\n## Relevant Memories\n1. x')).toBe('real ask');
    expect(canonicalizeUserText('## relevant memories for this user')).toBe('');
    expect(canonicalizeUserText('ask <in-app-browser-context>junk')).toBe('ask');
    expect(isLearnableUserText('<environment_context>cwd=/x</environment_context>')).toBe(false);
    expect(isLearnableUserText('Another language model started to solve this problem and produced a summary')).toBe(false);
    expect(isLearnableUserText('please use tabs')).toBe(true);
  });
});

describe('preferences and decisions', () => {
  it('captures corrections after a trigger up to a sentence terminator', () => {
    const p = extractPreference("Don't use npm here, use pnpm for everything. Also fix the tests.");
    expect(p?.kind).toBe('preference');
    expect(p?.text).toBe("User preference: don't use npm here, use pnpm for everything");
    expect(extractPreference('Never mock the database in integration tests\nthanks')?.text).toBe('User preference: never mock the database in integration tests');
    expect(extractPreference('No, use httpx instead of requests.')?.text).toContain('use httpx instead of requests');
  });

  it('rejects short captures, rambling fragments, and reminder-sourced text', () => {
    expect(extractPreference('stop')).toBeNull();
    expect(extractPreference("don't do it")).toBeNull(); // < 10 chars captured
    expect(extractPreference(`never ${'x'.repeat(200)} and more`)).toBeNull(); // hits max without terminator
    expect(extractPreference("<system-reminder>don't mention this reminder to the user please</system-reminder> hi")).toBeNull();
  });

  it('captures decisions from user and assistant text', () => {
    expect(extractDecision("We decided to use PostgreSQL for the main store. It's fine.")?.text).toBe('Decision: we decided to use PostgreSQL for the main store');
    expect(extractDecision("Let's go with vitest instead of jest")?.kind).toBe('decision');
    expect(extractDecision('nothing decided here')).toBeNull();
  });
});

describe('recovery gates', () => {
  it('levenshtein and path typo gate', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(pathsRelatedAsTypo('/a/confg.ts', '/a/config.ts')).toBe(true);
    expect(pathsRelatedAsTypo('/a/src/state.rs', '/b/src/state.rs')).toBe(true);
    expect(pathsRelatedAsTypo('/a/state.rs', '/a/lib.rs')).toBe(false);
    expect(pathsRelatedAsTypo('/a/x', '/a/x')).toBe(false);
  });

  it('bash retry gate needs the same binary and a real overlap', () => {
    expect(commandsRelatedAsRetry('python3 lint.py', 'python lint.py')).toBe(true);
    expect(commandsRelatedAsRetry('pytest tests/unit -q', 'pytest tests/unit -q -x')).toBe(true);
    expect(commandsRelatedAsRetry('grep foo src/a.txt', 'grep barbazqux lib/zz.py')).toBe(false);
    expect(commandsRelatedAsRetry('grep needle src', 'find . -name needle')).toBe(false);
    expect(commandsRelatedAsRetry('npm test', 'pnpm test')).toBe(true);
    expect(commandsRelatedAsRetry('source .venv/bin/activate && ruff check .', 'ruff check . --fix')).toBe(true);
    expect(commandsRelatedAsRetry('npm test', 'npm test')).toBe(false);
  });

  it('normalises bash commands for the evidence key', () => {
    expect(normalizeBashForKey('grep -rn foo src | head -50')).toBe('grep -rn foo src');
    expect(normalizeBashForKey('pytest -q 2>&1')).toBe('pytest -q');
    expect(normalizeBashForKey('a && b | c')).toBe('a && b'); // first pipe wins, then chains
    expect(normalizeBashForKey('a && b')).toBe('a');
    expect(normalizeBashForKey('')).toBe('');
  });

  it('builds recovery memories with the right importance and key', () => {
    const bash = buildRecovery(obs('Bash', { command: 'npm test' }, 'sh: npm: command not found', true, 'command_not_found'), obs('Bash', { command: 'pnpm test' }, 'ok', false));
    expect(bash).toMatchObject({ kind: 'gotcha', importance: 0.85, key: 'error_recovery|Bash|npm test|pnpm test' });
    expect(bash?.text).toBe('Command `npm test` fails (command_not_found). Use `pnpm test` instead.');
    expect(bash?.tags).toContain('npm');
    const read = buildRecovery(obs('Read', { file_path: '/p/confg.ts' }, 'ENOENT', true, 'file_not_found'), obs('Read', { file_path: '/p/config.ts' }, 'export {}', false));
    expect(read).toMatchObject({ importance: 0.7, key: 'error_recovery|Read|confg.ts|config.ts' });
    expect(buildRecovery(obs('Read', { file_path: '/p/a.ts' }, 'ENOENT', true, 'file_not_found'), obs('Read', { file_path: '/p/zzz.ts' }, 'x', false))).toBeNull();
    const grep = buildRecovery(obs('Grep', { pattern: 'fooo' }, 'No matches found', true, 'no_matches'), obs('Grep', { pattern: 'foo' }, 'a.ts:1', false));
    expect(grep).toMatchObject({ importance: 0.5, text: 'Search pattern `fooo` found no results. Use `foo` instead.' });
    expect(buildRecovery(obs('Edit', {}, 'err', true), obs('Edit', {}, 'ok', false))).toBeNull();
  });

  it('extracts environment facts from successful shell calls', () => {
    const venv = extractEnvironment(obs('Bash', { command: 'source .venv/bin/activate && pytest -q' }, '3 passed PASSED', false));
    expect(venv.map((m) => m.kind)).toEqual(['command', 'command']);
    expect(venv[0].text).toBe('Python virtual environment: `source .venv/bin/activate` before running Python tools.');
    expect(venv[1].text).toBe('Working test command: `source .venv/bin/activate && pytest -q`');
    expect(extractEnvironment(obs('Bash', { command: 'pytest' }, 'FAILED', true))).toEqual([]);
    expect(extractEnvironment(obs('Read', {}, 'x', false))).toEqual([]);
  });

  it('drops A→B / B→A path contradictions', () => {
    const items = [
      { text: 'File `/a/x.ts` does not exist. The correct path is `/a/y.ts`.' },
      { text: 'File `/a/y.ts` does not exist. The correct path is `/a/x.ts`.' },
      { text: 'File `/a/q.ts` does not exist. The correct path is `/a/r.ts`.' },
    ];
    expect(dropContradictions(items).map((i) => i.text)).toEqual([items[2].text]);
    expect(dropContradictions([items[2]])).toEqual([items[2]]);
  });
});

describe('extractToolCalls / extractMemories', () => {
  const anthropic: Message[] = [
    { role: 'user', content: 'Run the tests. Never use npm in this repo, use pnpm.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sh: npm: command not found', is_error: true }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pnpm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'Tests 3 passed PASSED' }] }] },
  ];
  const openai: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'check config' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/p/confg.ts"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'Error: ENOENT no such file' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/p/config.ts"}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'export const x = 1' },
  ];

  it('pairs tool calls in both wire shapes and classifies errors', () => {
    const a = extractToolCalls(anthropic);
    expect(a.map((c) => [c.name, c.isError, c.errorCategory])).toEqual([
      ['Bash', true, 'command_not_found'],
      ['Bash', false, 'unknown'],
    ]);
    const o = extractToolCalls(openai);
    expect(o.map((c) => [c.name, c.isError, c.errorCategory])).toEqual([
      ['Read', true, 'file_not_found'],
      ['Read', false, 'unknown'],
    ]);
    expect(extractToolCalls([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'x' }] }])).toEqual([]);
    const withResponse = extractToolCalls(anthropic, { content: [{ type: 'tool_use', id: 't9', name: 'Read', input: { file_path: '/x' } }] });
    expect(withResponse).toHaveLength(2); // pending call without a result is not emitted
  });

  it('extracts preferences, recoveries and commands from a conversation', () => {
    const got = extractMemories(anthropic);
    const texts = got.map((m) => m.text);
    expect(texts).toContain('Command `npm test` fails (command_not_found). Use `pnpm test` instead.');
    expect(texts).toContain('Working test command: `pnpm test`');
    expect(texts).toContain('User preference: never use npm in this repo, use pnpm');
    expect(new Set(got.map((m) => m.key)).size).toBe(got.length);
    expect(extractMemories(anthropic)).toEqual(got); // deterministic
    expect(extractMemories(openai).map((m) => m.text)).toEqual(['File `/p/confg.ts` does not exist. The correct path is `/p/config.ts`.']);
    expect(extractMemories([])).toEqual([]);
  });
});
