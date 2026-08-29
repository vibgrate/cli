/**
 * `vg llm-host` — thin enterprise process shell around the llm-host library.
 *
 * Model Orchestrator / Code Modes stay in the main CLI or vgd. This process
 * only serves load/generate/unload over a local socket (ADR-005).
 */

import { Command } from 'commander';
import { ensurePackage, ensureUnavailableMessage } from '../code/ensure.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { defaultProcessEndpoint, startProcessHostServer } from '../runtime/llm-host/index.js';
import { c, info, json } from '../util/output.js';

export function registerLlmHost(program: Command): void {
  const cmd = program
    .command('llm-host')
    .description('isolated inference host process (enterprise isolation; management stays in vg/vgd)');

  const serve = cmd
    .command('serve')
    .description('listen on a local socket and serve load/generate/unload IPC')
    .option('--socket <path>', 'Unix socket path (default: under Vibgrate runtime dir)')
    .option('--model-path <gguf>', 'optional default GGUF to load on first generate')
    .option('--yes', 'consent to install node-llama-cpp into the runtime cache if missing')
    .action(async function (this: Command, opts: { socket?: string; modelPath?: string; yes?: boolean }) {
      const global = readGlobal(this);
      const socketPath = opts.socket || defaultProcessEndpoint();

      // Install/load binding when possible (install intent via --yes or prior vg models install).
      let binding: unknown | null = null;
      const ensured = await ensurePackage('node-llama-cpp@^3', {
        consent: !!opts.yes,
        local: !!global.offline,
        interactive: false,
      });
      if (ensured.module) {
        binding = ensured.module;
      } else if (opts.yes || !global.offline) {
        // Soft: host can still start; generate will error until binding present.
        if (!global.json) {
          info(
            c.dim(
              `  binding unavailable: ${ensureUnavailableMessage(ensured.reason ?? 'install-failed', 'node-llama-cpp@^3', ensured.detail)}`,
            ),
          );
        }
      }

      if (global.json) {
        json({ ok: true, op: 'serve', socket: socketPath, binding: !!binding });
      } else {
        info(`${c.cyan('vg llm-host serve')} · ${socketPath}`);
        info(c.dim(`  isolation process · binding ${binding ? 'ready' : 'missing (run vg models install)'}`));
      }

      // Mutate binding on shared state used by server — startProcessHostServer copies initial binding.
      const handle = await startProcessHostServer({
        socketPath,
        binding: binding ?? undefined,
        onListen: (p) => {
          if (!global.json) info(c.dim(`  listening on ${p}`));
        },
      });

      // Optional preload model ref into server: we need access to state — reopen API.
      // For v0, client sends load(modelPath); --model-path is documentation only unless we inject.
      if (opts.modelPath && !global.json) {
        info(c.dim(`  default model path hint: ${opts.modelPath} (client must send load)`));
      }

      const shutdown = async (): Promise<void> => {
        await handle.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());

      // Keep alive until signal.
      await new Promise(() => {
        /* never resolves */
      });
    });
  applyGlobalOptions(serve);

  const status = cmd
    .command('status')
    .description('print default socket path and isolation mode hints')
    .action(function (this: Command) {
      const global = readGlobal(this);
      const socket = defaultProcessEndpoint();
      const body = {
        isolationDefault: 'embedded',
        processSocket: socket,
        env: 'VIBGRATE_INFERENCE_ISOLATION=process|embedded',
      };
      if (global.json) json(body);
      else {
        info(`${c.cyan('vg llm-host status')}`);
        info(c.dim(`  default isolation: embedded (Approach B)`));
        info(c.dim(`  process socket: ${socket}`));
        info(c.dim(`  set VIBGRATE_INFERENCE_ISOLATION=process for enterprise host`));
      }
    });
  applyGlobalOptions(status);

  // Default: status when bare `vg llm-host`
  cmd.action(function (this: Command) {
    const global = readGlobal(this);
    const socket = defaultProcessEndpoint();
    if (global.json) json({ isolationDefault: 'embedded', processSocket: socket });
    else {
      info(`${c.cyan('vg llm-host')} · dual-mode inference shell`);
      info(c.dim('  serve   start isolated host on a local socket'));
      info(c.dim('  status  default paths and env'));
    }
  });
  applyGlobalOptions(cmd);
}
