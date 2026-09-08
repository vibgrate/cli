import { describe, expect, it } from 'vitest';
import { classifyError, contentText, countWords, inputSummary, isErrorContent, makeToolCall, normalizeToolName, parseTimestamp, stringifyOutput, truncateHeadTail } from './shared.js';

describe('classifyError', () => {
  it('matches the reference order: specific categories before the generic runtime error', () => {
    expect(classifyError("ENOENT: no such file or directory, open 'x'")).toBe('file_not_found');
    expect(classifyError('ERROR: file or directory not found: tests/')).toBe('file_not_found');
    expect(classifyError("ModuleNotFoundError: No module named 'requests'")).toBe('module_not_found');
    expect(classifyError('bash: python3: command not found')).toBe('command_not_found');
    expect(classifyError('Permission denied (auto-denied)')).toBe('permission_denied');
    expect(classifyError('file is too large (exceeds the 1 MB limit)')).toBe('file_too_large');
    expect(classifyError('EISDIR: illegal operation on a directory')).toBe('is_directory');
    expect(classifyError('SyntaxError: invalid syntax')).toBe('syntax_error');
    expect(classifyError('TimeoutError: deadline exceeded')).toBe('timeout');
    expect(classifyError('ConnectionError: ECONNREFUSED')).toBe('connection_error');
    expect(classifyError('Traceback (most recent call last):\nValueError: bad')).toBe('runtime_error');
    expect(classifyError('No matches found')).toBe('no_matches');
    expect(classifyError('The user declined this action')).toBe('user_rejected');
    expect(classifyError('Sibling tool call errored')).toBe('sibling_error');
    expect(classifyError('process exited with code 2')).toBe('exit_code');
    expect(classifyError('BUILD FAILED in 3s')).toBe('build_failure');
    expect(classifyError('all good')).toBe('unknown');
    expect(classifyError(`${'x'.repeat(2500)} ENOENT`)).toBe('unknown'); // only the first 2 KB is inspected
  });
});

describe('isErrorContent', () => {
  it('needs ≥ 10 chars, looks at the first 1 KB, and ignores exit code 0', () => {
    expect(isErrorContent('Error: x')).toBe(false);
    expect(isErrorContent('Error: something broke')).toBe(true);
    expect(isErrorContent('all fine\nexit code 0')).toBe(false);
    expect(isErrorContent('all fine\nExit code: 1')).toBe(true);
    expect(isErrorContent('exit code 10 something')).toBe(true);
    expect(isErrorContent('FAILED tests/test_a.py::test_x')).toBe(true);
    expect(isErrorContent(`${'ok '.repeat(400)}Error: late`)).toBe(false);
    expect(isErrorContent('')).toBe(false);
  });
});

describe('normalizeToolName / inputSummary', () => {
  it('maps agent-specific names onto the shared schema (case-insensitive)', () => {
    expect(normalizeToolName('run_shell_command')).toBe('Bash');
    expect(normalizeToolName('Shell')).toBe('Bash');
    expect(normalizeToolName('read_file')).toBe('Read');
    expect(normalizeToolName('write_file')).toBe('Write');
    expect(normalizeToolName('apply_diff')).toBe('Edit');
    expect(normalizeToolName('list_dir')).toBe('Glob');
    expect(normalizeToolName('codebase_search')).toBe('Grep');
    expect(normalizeToolName('web_search')).toBe('WebSearch');
    expect(normalizeToolName('Agent')).toBe('Agent');
    expect(normalizeToolName('')).toBe('');
  });

  it('summarises inputs per tool and truncates long commands', () => {
    expect(inputSummary('Bash', { command: 'ls' })).toBe('ls');
    expect(inputSummary('Bash', { command: 'x'.repeat(150) })).toBe(`${'x'.repeat(100)}...`);
    expect(inputSummary('Read', { file_path: '/a' })).toBe('/a');
    expect(inputSummary('Read', {})).toBe('?');
    expect(inputSummary('Grep', { pattern: 'foo' })).toBe('foo');
    expect(inputSummary('Edit', { file_path: '/b' })).toBe('/b');
    expect(inputSummary('Other', { a: 1 })).toBe('{"a":1}');
  });

  it('makeToolCall normalises, classifies, and measures bytes', () => {
    const tc = makeToolCall('shell', 'id1', { command: 'ls' }, { output: 'ls: cannot access: No such file or directory' });
    expect(tc).toMatchObject({ name: 'Bash', id: 'id1', isError: true, errorCategory: 'file_not_found' });
    expect(tc.outputBytes).toBe(Buffer.byteLength(tc.output));
    expect(makeToolCall('Read', 'id2', 'not-an-object', 'ok content here', false).input).toEqual({});
    expect(makeToolCall('Read', 'id3', {}, 'fine output', true).isError).toBe(true);
  });
});

describe('small helpers', () => {
  it('stringifyOutput handles strings, blocks, objects', () => {
    expect(stringifyOutput('s')).toBe('s');
    expect(stringifyOutput(null)).toBe('');
    expect(stringifyOutput([{ type: 'text', text: 'a' }, 'b'])).toBe('a\nb');
    expect(stringifyOutput({ output: 'o' })).toBe('o');
    expect(stringifyOutput({ z: 1 })).toBe('{"z":1}');
  });

  it('parseTimestamp accepts ISO, epoch seconds and milliseconds', () => {
    expect(parseTimestamp('2026-09-01T10:00:00.000Z')).toBe(1788256800000);
    expect(parseTimestamp(1788256800)).toBe(1788256800000);
    expect(parseTimestamp(1788256800000)).toBe(1788256800000);
    expect(parseTimestamp('1788256800')).toBe(1788256800000);
    expect(parseTimestamp('nope')).toBeUndefined();
    expect(parseTimestamp(undefined)).toBeUndefined();
  });

  it('truncateHeadTail keeps both ends; countWords and contentText behave', () => {
    const long = `${'a'.repeat(150)}\n${'b'.repeat(150)}`;
    const t = truncateHeadTail(long, 60);
    expect(t).toContain(' … ');
    expect(t.startsWith('aaaa')).toBe(true);
    expect(t.endsWith('bbbb')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(60);
    expect(truncateHeadTail('short\ntext')).toBe('short text');
    expect(countWords('  one two\tthree\n')).toBe(3);
    expect(countWords('')).toBe(0);
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'output_text', text: 'b' }])).toBe('a\nb');
    expect(contentText('plain')).toBe('plain');
    expect(contentText(42)).toBe('');
  });
});
