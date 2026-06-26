import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../src/cli-options.js';

function globalsFor(argv: string[]) {
  const cmd = applyGlobalOptions(new Command('t'));
  cmd.parse(argv, { from: 'user' });
  return readGlobal(cmd);
}

describe('global options', () => {
  it('--local sets local (the only air-gapped switch — no env vars)', () => {
    expect(globalsFor(['--local']).local).toBe(true);
  });

  it('local is unset by default', () => {
    expect(globalsFor([]).local).toBeUndefined();
  });
});
