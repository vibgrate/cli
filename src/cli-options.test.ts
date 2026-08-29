import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from './cli-options.js';
import { buildProgram } from './cli.js';

/**
 * `--offline` and `--local` answer two different questions:
 *
 *   `--offline` — may this reach the network?
 *   `--local`   — where does inference run?
 *
 * They are related (an on-device run has nothing to fetch) but not the same:
 * forcing on-device inference is a choice you may want while fully online. The
 * tests below pin the implication in the one direction it holds, and pin that
 * it does *not* hold in the other.
 */

/** Parse args through a throwaway command and return the resolved globals. */
function globals(args: string[]): ReturnType<typeof readGlobal> {
  const program = new Command();
  let captured: ReturnType<typeof readGlobal> | null = null;
  const cmd = program.command('probe').action(function (this: Command) {
    captured = readGlobal(this);
  });
  applyGlobalOptions(cmd);
  program.parse(['probe', ...args], { from: 'user' });
  return captured!;
}

describe('--offline / --local', () => {
  it('defaults to neither', () => {
    const g = globals([]);
    expect(g.offline).toBe(false);
    expect(g.local).toBeUndefined();
  });

  it('--offline suppresses the network without claiming anything about inference', () => {
    const g = globals(['--offline']);
    expect(g.offline).toBe(true);
    // Crucially NOT true: `--offline` must not force on-device inference, or
    // `vg code --offline` would hard-fail with "no local model backend".
    expect(g.local).toBeUndefined();
  });

  it('--local implies --offline, so existing scripts keep working', () => {
    const g = globals(['--local']);
    expect(g.local).toBe(true);
    expect(g.offline).toBe(true);
  });

  it('accepts both together without contradiction', () => {
    const g = globals(['--offline', '--local']);
    expect(g.offline).toBe(true);
    expect(g.local).toBe(true);
  });
});

describe('the CLI surface', () => {
  it('builds without a duplicate-flag conflict', () => {
    // Commander throws on a duplicate long flag. `models catalog` and `bundle`
    // used to declare their own `--offline`; if either came back while the
    // global one exists, the whole program would fail to construct.
    expect(() => buildProgram()).not.toThrow();
  });

  it('offers both flags on every command that takes globals', () => {
    const program = buildProgram();
    const review = program.commands.find((c) => c.name() === 'review')!;
    const longs = review.options.map((o) => o.long);
    expect(longs).toContain('--offline');
    expect(longs).toContain('--local');
  });

  it('still accepts `vg bundle --offline`, whose own declaration was removed', () => {
    const bundle = buildProgram().commands.find((c) => c.name() === 'bundle')!;
    expect(bundle.options.map((o) => o.long)).toContain('--offline');
    // Exactly one — a second would be the conflict that throws.
    expect(bundle.options.filter((o) => o.long === '--offline')).toHaveLength(1);
  });

  it('still accepts `vg models catalog --offline`', () => {
    const models = buildProgram().commands.find((c) => c.name() === 'models')!;
    const catalog = models.commands.find((c) => c.name() === 'catalog')!;
    expect(catalog.options.filter((o) => o.long === '--offline')).toHaveLength(1);
  });

  it('keeps the reporting family on its own `--offline`', () => {
    // `vg scan --offline` predates this split and must be untouched by it.
    const scan = buildProgram().commands.find((c) => c.name() === 'scan')!;
    expect(scan.options.filter((o) => o.long === '--offline')).toHaveLength(1);
  });
});
