import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { discoverModels } from '../engine/models.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg models` (VG-CLI-SPEC §5 / VG-CLI-CODE §6) — the local-model fleet
 * discovered on disk (Ollama / LM Studio / llama.cpp gguf). Offline, no network,
 * no launch. `vg models pull <name>` fetches a model through your local runtime,
 * but only with `--yes`: **no model is ever downloaded by default.**
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
        info(c.dim('  pull one with `vg models pull <name> --yes` — nothing is downloaded by default'));
        return;
      }
      for (const m of models) info(`  ${c.bold(m.runtime.padEnd(10))} ${m.name}`);
      info(c.dim('  wire a model into edits with `vg code --provider ollama --model <name>`'));
    });
  applyGlobalOptions(cmd);

  // `vg models pull <name>` — consent-gated model download via the local runtime.
  const pull = cmd
    .command('pull')
    .description('download a model via your local runtime (Ollama) — requires --yes; nothing is pulled by default')
    .argument('<name>', 'model name, e.g. qwen2.5-coder:7b')
    .option('--runtime <id>', 'runtime to pull with (default: ollama)', 'ollama')
    .option('--yes', 'actually download (without this it only prints the plan — no model is fetched by default)')
    .action(function (this: Command, name: string, opts: { runtime: string; yes?: boolean }) {
      const global = readGlobal(this);
      if (opts.runtime !== 'ollama') {
        throw new CliError(`only the ollama runtime supports pull today (got --runtime ${opts.runtime}). LM Studio / gguf models are managed in their own apps.`, ExitCode.USAGE_ERROR);
      }
      const plan = { runtime: 'ollama', command: `ollama pull ${name}`, willDownload: !!opts.yes };
      if (!opts.yes) {
        if (global.json) json({ ...plan, note: 'dry-run — re-run with --yes to download (no model is pulled by default)' });
        else {
          info(`${c.cyan('vg models pull')} · would run: ${c.bold(plan.command)}`);
          info(c.dim('  no model is downloaded by default — re-run with --yes to actually pull it'));
        }
        return;
      }
      // Consent given → actually pull. Fail with an actionable error if ollama is absent.
      if (!hasBinary('ollama')) {
        throw new CliError('ollama is not installed or not on PATH — install it from https://ollama.com, then re-run. (We never install a runtime for you.)', ExitCode.NOT_FOUND);
      }
      if (!global.json) info(c.dim(`  $ ${plan.command}`));
      const res = spawnSync('ollama', ['pull', name], { stdio: global.json ? 'ignore' : 'inherit' });
      if (res.status !== 0) {
        throw new CliError(`\`ollama pull ${name}\` failed (exit ${res.status ?? 'signal'}) — check the model name and that \`ollama serve\` is running.`, ExitCode.ERROR);
      }
      if (global.json) json({ ...plan, pulled: true });
      else info(c.green(`  ✔ pulled ${name} — use it with \`vg code --provider ollama --model ${name}\``));
    });
  applyGlobalOptions(pull);
}

function hasBinary(bin: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
  return probe.status === 0;
}
