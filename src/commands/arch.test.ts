import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { KNOWN_COMMANDS } from '../cli.js';
import { registerShowArch } from './arch.js';

describe('vg show arch', () => {
  it('nests arch under show and does not invent a top-level verb', () => {
    const show = new Command().command('show');
    registerShowArch(show);
    const arch = show.commands.find((c) => c.name() === 'arch');
    expect(arch).toBeTruthy();
    expect(arch?.description()).toMatch(/architecture map/i);
    expect(KNOWN_COMMANDS.has('arch')).toBe(false);
    expect(KNOWN_COMMANDS.has('chart')).toBe(false);
    expect(KNOWN_COMMANDS.has('show')).toBe(true);
  });

  it('keeps the pre-rename `chart` spelling as a hidden alias with the same options', () => {
    const show = new Command().command('show');
    registerShowArch(show);
    const arch = show.commands.find((c) => c.name() === 'arch');
    const chart = show.commands.find((c) => c.name() === 'chart');
    expect(chart).toBeTruthy();
    // commander marks hidden commands via _hidden; the help listing must not show it.
    expect(show.helpInformation()).toMatch(/\barch\b/);
    expect(show.helpInformation()).not.toMatch(/\bchart\b/);
    const flags = (cmd?: Command) => (cmd?.options ?? []).map((o) => o.long).sort();
    expect(flags(chart)).toEqual(flags(arch));
  });
});
