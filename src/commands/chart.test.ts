import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { KNOWN_COMMANDS } from '../cli.js';
import { registerShowChart } from './chart.js';

describe('vg show chart', () => {
  it('nests chart under show and does not invent a top-level verb', () => {
    const show = new Command().command('show');
    registerShowChart(show);
    const chart = show.commands.find((c) => c.name() === 'chart');
    expect(chart).toBeTruthy();
    expect(chart?.description()).toMatch(/interactive map/i);
    expect(KNOWN_COMMANDS.has('chart')).toBe(false);
    expect(KNOWN_COMMANDS.has('show')).toBe(true);
  });
});
