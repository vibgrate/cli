import { describe, it, expect, afterEach } from 'vitest';
import { dispatch } from '../src/cli.js';
import { makeProject, cleanup } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('dispatch (simple-as-Google routing)', () => {
  it('bare invocation builds the current folder', () => {
    expect(dispatch([], '/tmp')).toEqual(['build']);
  });

  it('global flags with no positional default to build', () => {
    expect(dispatch(['--json'], '/tmp')).toEqual(['build', '--json']);
  });

  it('does not mistake a -C value for a command', () => {
    expect(dispatch(['-C', 'some/dir', '--json'], '/tmp')).toEqual(['build', '-C', 'some/dir', '--json']);
  });

  it('a quoted question routes to ask', () => {
    expect(dispatch(['where is auth?'], '/tmp')).toEqual(['ask', 'where is auth?']);
  });

  it('a trailing-? single token routes to ask', () => {
    expect(dispatch(['auth?'], '/tmp')).toEqual(['ask', 'auth?']);
  });

  it('an unknown bare word routes to ask (search)', () => {
    expect(dispatch(['auth'], '/tmp')).toEqual(['ask', 'auth']);
  });

  it('an existing path routes to build', () => {
    const dir = makeProject({ 'a.ts': 'x' });
    dirs.push(dir);
    expect(dispatch([dir], '/tmp')).toEqual(['build', dir]);
  });

  it('an explicit command moves to the front', () => {
    expect(dispatch(['--json', 'status'], '/tmp')).toEqual(['status', '--json']);
  });

  it('keeps --help/--version for commander', () => {
    expect(dispatch(['--help'], '/tmp')).toEqual(['--help']);
    expect(dispatch(['--version'], '/tmp')).toEqual(['--version']);
  });
});
