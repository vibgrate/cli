import { Command } from 'commander';
import { startLanguageServer } from '../lsp/server.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';

/**
 * `vg lsp` — the Vibgrate language server (stdio).
 *
 * Editors spawn this; humans generally don't. It is the single engine behind
 * **Vibgrate for VS Code** and **Vibgrate for JetBrains** — one scanner, many
 * thin clients, exactly the architecture Snyk uses and for the same reason:
 * a new IDE should be a new client, never a new scanner.
 *
 * The server speaks standard LSP (diagnostics, hover, CodeLens) plus one
 * custom notification, `vibgrate/score`, which carries the DriftScore and its
 * **band** — never a colour. Clients map band → their own theme colour, which
 * is what keeps light mode, dark mode, high contrast, and JetBrains all honest
 * from a single source of truth.
 *
 * See `docs/IDE-INTEGRATION-PLAN.md` §3.
 */
export function registerLsp(program: Command): void {
  const cmd = program
    .command('lsp')
    .description('start the Vibgrate language server (stdio) — the engine behind the IDE extensions')
    .option(
      '--diagnostics',
      'also publish Problems-panel diagnostics (EOL runtime, unmaintained, license change). Off by default: drift is not a defect, and the Problems panel is not ours to fill',
      false,
    )
    .option('--no-graph', 'skip the local Vibgrate Graph entirely: no background build, and graph queries report it as turned off')
    .option('--no-semantic', 'never use semantic search for graph queries (lexical only; the embedding model is not downloaded)')
    .action(async function (this: Command, opts: { diagnostics?: boolean; graph?: boolean; semantic?: boolean }) {
      const global = readGlobal(this);
      const root = rootOf(global);

      startLanguageServer({
        root,
        // `--local` is the established air-gap flag across the CLI; honour it
        // here too, so an offline editor session stays offline.
        offline: global.local === true,
        diagnostics: opts.diagnostics === true,
        graph: opts.graph !== false,
        semantic: opts.semantic !== false,
      });

      // The server owns the process from here: it lives on stdin/stdout until
      // the client sends `shutdown` + `exit`. Returning from the action must
      // not let the CLI exit, so we never resolve.
      await new Promise<never>(() => {});
    });

  applyGlobalOptions(cmd);
}
