import type { Command } from 'commander';

/** Global flags shared across all `vg` commands (VG-CLI-SPEC §1.1). */
export interface GlobalOpts {
  /** -C, --cwd <dir> */
  cwd?: string;
  /** --deep */
  deep?: boolean;
  /** --json */
  json?: boolean;
  /** --generated-at <iso> */
  generatedAt?: string;
  /** --graph <file> (override the map path) */
  graph?: string;
  /** --no-cache (commander exposes this as `cache: false`) */
  noCache?: boolean;
  /** --local (never touch the network) */
  local?: boolean;
  /** --quiet */
  quiet?: boolean;
}

/**
 * Attach the global flags to a command. They live on every subcommand (rather
 * than only the program) so the "simple as Google" dispatch can put the command
 * token first and let flags appear in any order after it.
 */
export function applyGlobalOptions(cmd: Command): Command {
  return cmd
    .option('-C, --cwd <dir>', 'run as if started in <dir>', '.')
    .option('--deep', 'do more: precise resolution, all edges, semantic links')
    .option('--json', 'machine-readable JSON on stdout')
    .option('--generated-at <iso>', 'pin the artifact timestamp for byte-deterministic output')
    .option('--graph <file>', 'override the map path')
    .option('--no-cache', 'full rebuild (ignore the incremental cache)')
    .option('--local', 'never touch the network (lexical-only semantic)')
    .option('--quiet', 'suppress progress output')
    .option('--no-color', 'disable colored output');
}

/** Read the global subset from a command's parsed options. */
export function readGlobal(cmd: Command): GlobalOpts {
  const o = cmd.opts<Record<string, unknown>>();
  return {
    cwd: o.cwd as string | undefined,
    deep: o.deep as boolean | undefined,
    json: o.json as boolean | undefined,
    generatedAt: o.generatedAt as string | undefined,
    graph: o.graph as string | undefined,
    noCache: o.cache === false,
    local: o.local as boolean | undefined,
    quiet: o.quiet as boolean | undefined,
  };
}
