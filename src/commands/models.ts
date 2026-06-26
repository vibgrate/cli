import { Command } from 'commander';
import { discoverModels } from '../engine/models.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg models` (VG-CLI-SPEC §5) — the local-model fleet discovered on disk
 * (Ollama / LM Studio / llama.cpp gguf). Offline, no network, no launch.
 */
export function registerModels(program: Command): void {
  const cmd = program
    .command('models')
    .description('the local model fleet (Ollama / LM Studio / gguf), discovered offline')
    .action(function (this: Command) {
      const global = readGlobal(this);
      const models = discoverModels();
      if (global.json) {
        json({ models });
        return;
      }
      info(`${c.cyan('vg models')} · ${models.length} local model(s) discovered`);
      if (models.length === 0) {
        info(c.dim('  none found (looked in ~/.ollama, ~/.lmstudio, ~/models, ~/.cache)'));
        return;
      }
      for (const m of models) info(`  ${c.bold(m.runtime.padEnd(10))} ${m.name}`);
    });
  applyGlobalOptions(cmd);
}
