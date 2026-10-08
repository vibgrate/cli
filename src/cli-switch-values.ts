import type { Command, Option } from 'commander';

/**
 * Explain an on/off switch written with a value (`--vulns=false`) or with a
 * `--no-` prefix the command does not define (`--no-vulns`).
 *
 * Commander rejects both as an unknown option, which is safe but unhelpful:
 * `--vulns=false` reads as "unknown option" for a switch that exists, and for
 * `--no-vulns` it suggests `--vulns`, the opposite of what was asked. Returns
 * a usage message for the first such argument, or `undefined` to leave the
 * input to commander. Only inputs commander would reject anyway are matched.
 */
export function switchValueError(program: Command, args: string[]): string | undefined {
  const { cmd, rest } = resolveCommand(program, args);
  if (isPassThrough(cmd)) return undefined;
  const usage = commandPath(cmd);

  for (const arg of rest) {
    if (arg === '--') break;
    if (!arg.startsWith('--')) continue;

    const eq = arg.indexOf('=');
    if (eq > 0) {
      const flag = arg.slice(0, eq);
      const opt = switchNamed(cmd, flag);
      if (!opt || (!opt.negate && opt.defaultValue !== undefined)) continue;
      const hint = flag.startsWith('--no-')
        ? `use \`${usage} ${flag}\`, or leave it out`
        : `it is off unless you pass it: use \`${usage} ${flag}\` to turn it on, or leave it out`;
      return `${flag} is an on/off switch and takes no value (got ${arg}); ${hint}.`;
    }

    if (arg.startsWith('--no-') && !findOption(cmd, arg)) {
      const positive = `--${arg.slice('--no-'.length)}`;
      const opt = switchNamed(cmd, positive);
      if (!opt || opt.negate || opt.defaultValue !== undefined) continue;
      return `${arg} is not an option. ${positive} is off unless you pass it, so leave it out (to turn it on: \`${usage} ${positive}\`).`;
    }
  }
  return undefined;
}

/** Walk leading subcommand names (`models catalog ...`) down to the leaf. */
function resolveCommand(program: Command, args: string[]): { cmd: Command; rest: string[] } {
  let cmd = program;
  let i = 0;
  for (; i < args.length; i++) {
    const sub = cmd.commands.find((c) => c.name() === args[i] || c.aliases().includes(args[i]));
    if (!sub) break;
    cmd = sub;
  }
  return { cmd, rest: args.slice(i) };
}

/**
 * A pass-through command (`vg serve <agent> ...`) forwards options after its
 * first operand to another program, so their spelling is not ours to judge.
 * Commander exposes the setter but not a getter for this.
 */
function isPassThrough(cmd: Command): boolean {
  return (cmd as unknown as { _passThroughOptions?: boolean })._passThroughOptions === true;
}

/**
 * Only the leaf's own options count: the program enables positional options,
 * so a parent's flag is not accepted after a subcommand name (global flags are
 * declared on every subcommand instead, see cli-options.applyGlobalOptions).
 */
function findOption(cmd: Command, long: string): Option | undefined {
  return cmd.options.find((o) => o.long === long);
}

/** The option named `long` if it takes no value: `--vulns`, and also `--no-graph`. */
function switchNamed(cmd: Command, long: string): Option | undefined {
  const opt = findOption(cmd, long);
  return opt && !opt.required && !opt.optional ? opt : undefined;
}

function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}
