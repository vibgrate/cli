import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { registerDaemon } from './daemon.js';

/** The `daemon` command as `buildProgram()` wires it — positional options and all. */
function daemonCommand(): Command {
  const program = new Command();
  program.exitOverride();
  // buildProgram() enables this; it is exactly what makes an option typed after
  // a subcommand name belong to that subcommand rather than to its parent.
  program.enablePositionalOptions();
  registerDaemon(program);
  return program.commands.find((c) => c.name() === 'daemon') as Command;
}

describe('vg daemon — `--socket` after the subcommand name', () => {
  it('is accepted by every subcommand, not only by the `daemon` parent', () => {
    // `socketOf` looks at the leaf before the parent, and the background spawn
    // re-invokes this CLI as `daemon start --socket <path>`. A leaf that does
    // not declare the option rejects it as unknown and exits 1 — with stdio
    // ignored, which is how `vg daemon ensure` and every auto-start failed
    // silently while a foreground `vg daemon start` worked.
    const subcommands = daemonCommand().commands;
    expect(subcommands.length).toBeGreaterThan(0);
    for (const sub of subcommands) {
      expect(
        sub.options.some((o) => o.long === '--socket'),
        `vg daemon ${sub.name()} must accept --socket`,
      ).toBe(true);
    }
  });

  it('parses `daemon status --socket <path>` instead of erroring on an unknown option', async () => {
    const program = new Command();
    program.exitOverride();
    program.enablePositionalOptions();
    registerDaemon(program);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitCode = process.exitCode;
    try {
      // No daemon lives here, so `status` reports "not running" — the point is
      // that it gets far enough to look.
      await program.parseAsync(['daemon', 'status', '--socket', '/nonexistent/vg-test.sock'], {
        from: 'user',
      });
    } catch (e) {
      expect((e as { code?: string }).code).not.toBe('commander.unknownOption');
    } finally {
      process.exitCode = exitCode;
      out.mockRestore();
      err.mockRestore();
    }
  });
});
