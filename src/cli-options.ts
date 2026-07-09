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
  /**
   * --client <name> — the AI on the other end (e.g. `claude`, `cursor`). When an
   * AI host runs `vg`, passing this lets navigation calls be counted in the local
   * savings ledger with the command-vs-MCP split, so `vg savings` and the opt-in
   * share-stats upload can attribute usage. Counts only; a coarse label, not
   * identity (sanitized before it's recorded). Absent for human-run commands.
   */
  client?: string;
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
    .option('--client <name>', 'identify the AI client (e.g. claude) so navigation calls are counted in vg savings')
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
    client: o.client as string | undefined,
  };
}
