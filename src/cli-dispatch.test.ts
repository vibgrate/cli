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

  it('keeps an explicit `code` invocation as the code command', () => {
    expect(dispatch(['code', 'add a flag'], cwd)).toEqual(['code', 'add a flag']);
  });

  it('routes a quoted question (with a space) to ask, not code', () => {
    expect(dispatch(['add a flag to scan'], cwd)).toEqual(['ask', 'add a flag to scan']);
  });

  it('moves a command in front of leading global flags', () => {
    expect(dispatch(['--json', 'bisect', 'lodash', '4.17.21'], cwd)).toEqual([
      'bisect',
      '--json',
      'lodash',
      '4.17.21',
    ]);
  });

  describe('context compression adds no verb of its own', () => {
    // FEATURE-DESIGN-PRINCIPLES P1. Each of these was a top-level command
    // during development; a bare-word fall-through to `ask` would silently
    // search for "proxy" instead of saying where the capability went.
    const moved: Array<[string, RegExp]> = [
      ['proxy', /vg serve --compress/],
      ['wrap', /vg install <agent> --compress/],
      ['unwrap', /vg uninstall <agent>/],
      ['dashboard', /vg show savings/],
      ['perf', /vg savings --benchmark/],
      ['compress', /vg serve --compress/],
      ['retrieve', /vg serve retrieve/],
      ['memory', /vg serve memory/],
      ['learn', /vg install <agent> --learn/],
    ];
    for (const [verb, hint] of moved) {
      it(`points \`vg ${verb}\` at its new home`, () => {
        expect(() => dispatch([verb], cwd)).toThrow(hint);
        expect(() => dispatch([verb], cwd)).toThrow(new RegExp(`\`vg ${verb}\` has moved`));
      });
    }

    it('still routes a real question containing one of those words to ask', () => {
      expect(dispatch(['how does the proxy work?'], cwd)).toEqual(['ask', 'how does the proxy work?']);
    });
  });
});
