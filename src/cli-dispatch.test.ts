import { describe, it, expect } from 'vitest';
import { buildProgram, dispatch, KNOWN_COMMANDS } from './cli.js';

/**
 * `dispatch()` routes a bare first word to `ask` (search) unless it is a known
 * command. A subcommand registered on the program but missing from
 * KNOWN_COMMANDS is silently swallowed by the `ask` fallback — exactly the trap
 * that hid `vg bisect` behind `vg ask`. This guard keeps the two in lockstep.
 */
describe('KNOWN_COMMANDS ↔ registered commands', () => {
  it('lists every command registered on the program', () => {
    const registered = buildProgram()
      .commands.map((c) => c.name())
      .filter((n) => n !== 'help'); // commander's built-in help command
    const missing = registered.filter((n) => !KNOWN_COMMANDS.has(n));
    expect(missing).toEqual([]);
  });
});

describe('dispatch', () => {
  const cwd = '/nonexistent-cwd-for-test';

  it('keeps an explicit `bisect` invocation as the bisect command', () => {
    expect(dispatch(['bisect', 'lodash', '4.17.21'], cwd)).toEqual(['bisect', 'lodash', '4.17.21']);
  });

  it('routes a bare unknown word to ask, not bisect', () => {
    expect(dispatch(['lodash'], cwd)).toEqual(['ask', 'lodash']);
  });

  it('moves a command in front of leading global flags', () => {
    expect(dispatch(['--json', 'bisect', 'lodash', '4.17.21'], cwd)).toEqual([
      'bisect',
      '--json',
      'lodash',
      '4.17.21',
    ]);
  });
});
