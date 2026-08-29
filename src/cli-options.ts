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
  /**
   * `--offline` — never reach the network. Skip the embedding model, the
   * relevance module, the hosted catalog, and any upload.
   *
   * **Read this, not `local`, for every network decision.** `--local` implies
   * `--offline`, so this is already true whenever the user passed either.
   */
  offline?: boolean;
  /**
   * `--local` — run inference **on-device only**: pick a local backend
   * (embedded → ollama), never a hosted model. Consumed by `vg code` alone.
   *
   * It implies {@link offline} (an on-device run has nothing to fetch), which
   * is what keeps every pre-existing `--local` script working unchanged. The
   * converse does not hold: `--offline` says nothing about where inference runs.
   */
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
  /**
   * --no-daemon (commander exposes this as `daemon: false`) — never auto-start
   * or use the local runtime; run everything in this process, as vg did before
   * vgd existed. Also settable once via `VG_NO_DAEMON=1`.
   */
  daemon?: boolean;
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
    // Two distinct questions, two flags.
    //
    // `--offline` answers "may this reach the network?" — the same question
    // `vg scan --offline` and `vg evidence --offline` already answer, so the
    // whole CLI now spells it the same way.
    //
    // `--local` answers "where does inference run?" — on-device only, never a
    // hosted model. That is a choice you may want while fully online, which is
    // why it cannot simply be renamed: `vg code --local` on a connected machine
    // is meaningful, and `--offline` would not say it.
    //
    // `--local` implies `--offline`, so every script that already passes
    // `--local` keeps its exact current behaviour. The converse does not hold.
    .option('--offline', 'never touch the network (no model download, no catalog fetch, no upload)')
    .option('--local', 'run inference on-device only — never a hosted model (implies --offline)')
    .option('--quiet', 'suppress progress output')
    .option('--client <name>', 'identify the AI client (e.g. claude) so navigation calls are counted in vg savings')
    .option('--no-daemon', 'never auto-start or use the local runtime (vgd) — run everything in this process')
    .option('--no-color', 'disable colored output');
}

/** Read the global subset from a command's parsed options. */
export function readGlobal(cmd: Command): GlobalOpts {
  // `optsWithGlobals()`, not `opts()`: a global flag (e.g. `--json`) declared on
  // both a command and its parent binds to the parent in commander, so a nested
  // subcommand (`vg models uninstall … --json`) would otherwise never see it.
  const o = cmd.optsWithGlobals() as Record<string, unknown>;
  return {
    cwd: o.cwd as string | undefined,
    deep: o.deep as boolean | undefined,
    json: o.json as boolean | undefined,
    generatedAt: o.generatedAt as string | undefined,
    graph: o.graph as string | undefined,
    noCache: o.cache === false,
    // `--local` implies `--offline`: an on-device run has nothing to fetch, and
    // folding it in here is what makes every existing `--local` invocation keep
    // working without each consumer having to remember the implication.
    offline: (o.offline as boolean | undefined) === true || (o.local as boolean | undefined) === true,
    local: o.local as boolean | undefined,
    quiet: o.quiet as boolean | undefined,
    client: o.client as string | undefined,
    daemon: o.daemon as boolean | undefined,
  };
}
