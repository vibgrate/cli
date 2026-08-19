import { spawnSync } from 'node:child_process';
import * as readline from 'node:readline';
import { Command } from 'commander';
import { discoverModels } from '../engine/models.js';
import { fetchCatalog } from '../code/catalog.js';
import { fmt } from '../code/capability.js';
import { gatherSystemMemory } from '../code/local-runtime.js';
import { buildModelsStatusReport } from '../code/model-status.js';
import { loadGraph } from '../engine/load.js';
import {
  activePin,
  buildOrchestratorStatus,
  parseMode,
  pinPack,
  providerForBackend,
  QUALIFIED_PACKS,
  readOrchestratorState,
  recommendMode,
  resolveMode,
  setDefaultMode,
  unpinPack,
  writeOrchestratorState,
  type OrchestratorStatus,
} from '../runtime/model-orchestrator.js';
import { buildModelInstallPlan } from '../runtime/model-install-plan.js';
import { executeModelInstallPlan } from '../runtime/model-install.js';
import { probeInferenceBackends } from '../runtime/inference-adapters.js';
import { HOST_BENCH_ARMS, type HostBenchArmId } from '../runtime/host-bench.js';
import { evaluateHostBenchGates, renderGateResultMarkdown } from '../runtime/host-bench-gates.js';
import { renderHostBenchReportText, runHostBench, type HostBenchRunMode } from '../runtime/host-bench-runner.js';
import {
  buildCodingMetricsReport,
  renderCodingMetricsMarkdown,
} from '../runtime/coding-metrics.js';
import { applyRecommendedDefaultMode } from '../runtime/local-inference-status.js';
import { freeBytesOnVolume, weightStoreDir } from '../runtime/weight-store.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';
import { hasOllamaBinary, resolveOllamaBinary } from '../util/resolve-ollama.js';

/**
 * `vg models` (VG-CLI-SPEC §5 / VG-CLI-CODE §6) — Code Modes + local fleet.
 *
 * Default path is **outcome-oriented Code Modes** (Spark / Flow / Forge), not
 * GGUF names. The Model Orchestrator fits packs to live memory + repo signals.
 * Raw local discovery remains for power users.
 *
 * Consent polarity matches the rest of `vg`: **named actions run by default**.
 * `install` / `pull` install when invoked; pass `--dry-run` to print the plan
 * only. `--yes` only skips interactive confirms. Destructive `uninstall`
 * confirms on a TTY unless `--yes` is set.
 */
export function registerModels(program: Command): void {
  const cmd = program
    .command('models')
    .description('Code Modes (Spark/Flow/Forge) + local model fleet')
    .option('--raw', 'list discovered local models only (skip Code Modes status)')
    .action(async function (this: Command, opts: { raw?: boolean }) {
      const global = readGlobal(this);
      const models = discoverModels();
      const sys = await gatherSystemMemory();
      const report = buildModelsStatusReport(models, sys);

      if (opts.raw) {
        if (global.json) {
          json(report);
          return;
        }
        printRawFleet(report);
        return;
      }

      // Default: Code Modes orchestrator status + fleet summary.
      const root = rootOf(global);
      const orch = buildFullStatus(root, models, sys);
      const backends = probeInferenceBackends({ hasBinary });
      if (global.json) {
        json({ ...orch, fleet: report, backends });
        return;
      }
      printOrchestratorStatus(orch);
      info('');
      printBackends(backends);
      info(c.dim(`  ${report.models.length} local model(s) on disk · \`vg models --raw\` for the full list`));
      info(c.dim('  set a mode: `vg models mode flow` · install pack: `vg models install` · pin: `vg models pin flow@…`'));
    });
  applyGlobalOptions(cmd);

  // `vg models status` — explicit alias of default action (rich Code Modes view).
  const status = cmd
    .command('status')
    .description('Code Modes status: mode, pack, underlying model, fit, memory breakdown')
    .action(async function (this: Command) {
      const global = readGlobal(this);
      const models = discoverModels();
      const sys = await gatherSystemMemory();
      const orch = buildFullStatus(rootOf(global), models, sys);
      const backends = probeInferenceBackends({ hasBinary });
      if (global.json) {
        json({ ...orch, fleet: buildModelsStatusReport(models, sys), backends });
        return;
      }
      printOrchestratorStatus(orch);
      printBackends(backends);
    });
  applyGlobalOptions(status);

  // `vg models mode [spark|flow|forge]` — show or set default Code Mode.
  const modeCmd = cmd
    .command('mode')
    .description('show or set the default Code Mode (spark | flow | forge)')
    .argument('[mode]', 'spark, flow, or forge (omit to show current)')
    .option('--auto', 'clear the fixed default and auto-fit on next resolve')
    .option(
      '--apply-recommend',
      'pin the hardware-recommended mode when no default is set (from free RAM/VRAM + repo size)',
    )
    .action(async function (
      this: Command,
      modeArg: string | undefined,
      opts: { auto?: boolean; applyRecommend?: boolean },
    ) {
      const global = readGlobal(this);
      if (opts.auto) {
        const state = readOrchestratorState();
        delete state.defaultMode;
        writeOrchestratorState(state);
        if (global.json) json({ defaultMode: null, autoFit: true });
        else info(`${c.cyan('vg models mode')} · ${c.green('auto-fit')} (no fixed default)`);
        return;
      }
      if (opts.applyRecommend) {
        const state = readOrchestratorState();
        const sys = await gatherSystemMemory();
        const result = applyRecommendedDefaultMode({
          system: sys,
          repo: repoSignals(rootOf(global)),
          currentDefault: state.defaultMode ?? null,
          setDefault: setDefaultMode,
        });
        if (global.json) json(result);
        else if (result.applied) {
          info(`${c.cyan('vg models mode')} · ${c.green('pinned')} ${c.bold(result.mode)} ${c.dim(result.reason)}`);
        } else {
          info(`${c.cyan('vg models mode')} · ${result.reason}`);
          info(c.dim('  clear with `vg models mode --auto` then re-run --apply-recommend'));
        }
        return;
      }
      if (modeArg) {
        const mode = parseMode(modeArg);
        if (!mode) throw new CliError(`unknown mode "${modeArg}" — use spark, flow, or forge`, ExitCode.USAGE_ERROR);
        setDefaultMode(mode);
        if (global.json) json({ defaultMode: mode });
        else info(`${c.cyan('vg models mode')} · default set to ${c.bold(mode)}`);
        return;
      }
      const state = readOrchestratorState();
      const sys = await gatherSystemMemory();
      const recommended = recommendMode(sys, repoSignals(rootOf(global)));
      const current = state.defaultMode ?? recommended;
      if (global.json) {
        json({ defaultMode: state.defaultMode ?? null, recommended, effective: current, autoFit: !state.defaultMode });
        return;
      }
      info(
        `${c.cyan('vg models mode')} · effective ${c.bold(current)}` +
          (state.defaultMode ? c.dim(' (pinned default)') : c.dim(` (auto-fit → ${recommended})`)),
      );
      info(
        c.dim(
          '  set with `vg models mode flow` · auto with `vg models mode --auto` · pin fit with `vg models mode --apply-recommend`',
        ),
      );
    });
  applyGlobalOptions(modeCmd);

  // `vg models resolve [mode]` — dry resolve mode → pack → model + fit (no download).
  const resolve = cmd
    .command('resolve')
    .description('resolve a Code Mode to pack + underlying model + fit (no download)')
    .argument('[mode]', 'spark | flow | forge (default: auto-fit or configured default)')
    .action(async function (this: Command, modeArg: string | undefined) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const sys = await gatherSystemMemory();
      const state = readOrchestratorState();
      const mode = parseMode(modeArg) ?? state.defaultMode;
      const pin = mode ? activePin(mode, state) : null;
      const resolved = resolveMode({
        mode: mode ?? undefined,
        autoFit: !mode,
        system: sys,
        repo: repoSignals(root),
        pin,
        defaultMode: state.defaultMode,
      });
      if (global.json) {
        json(resolved);
        return;
      }
      info(`${c.cyan('vg models resolve')} · ${c.bold(resolved.mode)} → ${resolved.pack.packId}`);
      info(`  underlying  ${resolved.underlying.weightsRef}  ${c.dim(`(${resolved.underlying.backend})`)}`);
      info(`  fit         ${fitColor(resolved.fit.label)} ${c.dim(`score ${resolved.fit.score}`)}`);
      for (const r of resolved.fit.reasons) info(c.dim(`  · ${r}`));
      info(
        c.dim(
          `  provider ${providerForBackend(resolved.underlying.backend)} · capsule ~${resolved.profile.capsuleBudgetTokens} tokens`,
        ),
      );
      if (resolved.fit.label === 'will_not_fit') {
        info(c.yellow('  will not fit — choose a lower mode or free memory before loading'));
      }
    });
  applyGlobalOptions(resolve);

  // `vg models install [mode]` — resolve + install pack dep closure (action by default).
  const installCmd = cmd
    .command('install')
    .description('resolve the best Code Mode for this machine and install the pack')
    .argument('[mode]', 'spark | flow | forge (default: auto-fit)')
    .option('--dry-run', 'print the install plan only — do not download')
    .option('--yes', 'skip prompts (install already runs by default)')
    .action(async function (this: Command, modeArg: string | undefined, opts: { dryRun?: boolean; yes?: boolean }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const models = discoverModels();
      const sys = await gatherSystemMemory();
      const state = readOrchestratorState();
      const mode = parseMode(modeArg) ?? state.defaultMode;
      const pin = mode ? activePin(mode, state) : null;
      const resolved = resolveMode({
        mode: mode ?? undefined,
        autoFit: !mode,
        system: sys,
        repo: repoSignals(root),
        pin,
        installedNames: models.map((m) => m.name),
        defaultMode: state.defaultMode,
      });

      if (resolved.fit.label === 'will_not_fit') {
        const msg = `mode ${resolved.mode} will not fit (${fmt(resolved.fit.needBytes)} need, ${fmt(resolved.fit.availableBytes)} free) — try \`vg models install spark\` or free memory`;
        if (global.json) {
          json({ ok: false, reason: 'will_not_fit', resolved });
          return;
        }
        throw new CliError(msg, ExitCode.ERROR);
      }

      const name = resolved.underlying.weightsRef;
      const dryRun = !!opts.dryRun;
      const installPlan = buildModelInstallPlan({
        backend: resolved.underlying.backend,
        weightsRef: name,
        license: resolved.underlying.license,
        mode: resolved.mode,
        packId: resolved.pack.packId,
        promise: resolved.pack.promise,
        fit: resolved.fit.label,
        installedNames: models.map((m) => m.name),
        offline: !!global.local,
        hasBinary,
        downloadUrl: resolved.underlying.downloadUrl,
        sha256: resolved.underlying.sha256,
      });

      if (installPlan.ready) {
        if (global.json) json({ ok: true, ...installPlan, note: 'already installed' });
        else {
          info(`${c.cyan('vg models install')} · ${c.bold(resolved.mode)} → ${name} ${c.green('already installed')}`);
          info(c.dim(`  pack ${resolved.pack.packId} · fit ${resolved.fit.label}`));
          info(c.dim(`  use with \`vg code --provider ${providerForBackend(resolved.underlying.backend)} --model ${name}\``));
        }
        return;
      }

      if (dryRun) {
        if (global.json) {
          json({ ...installPlan, note: 'dry-run — re-run without --dry-run to install' });
          return;
        }
        printInstallPlanHuman('vg models install', installPlan);
        info(c.dim('  dry-run — re-run without --dry-run to install'));
        return;
      }

      if (!global.json) {
        printInstallPlanHuman('vg models install', installPlan);
        if (installPlan.license) info(c.dim(`  license: ${installPlan.license}`));
      }

      const result = await executeModelInstallPlan(installPlan, {
        offline: !!global.local,
        quiet: !!global.json,
        onProgress: (line) => {
          if (!global.json) info(c.dim(`  ${line}`));
        },
      });
      if (!result.ok) {
        throw new CliError(result.error ?? 'install failed', ExitCode.ERROR);
      }
      if (global.json) {
        json({
          ok: true,
          ...installPlan,
          installedDeps: result.installedDeps,
          pulledWeights: result.pulledWeights,
        });
      } else {
        info(c.green(`  ✔ ${resolved.mode} ready · ${name}`));
        info(c.dim(`  \`vg code --provider ${providerForBackend(resolved.underlying.backend)} --model ${name}\``));
      }
    });
  applyGlobalOptions(installCmd);

  // `vg models pin <packId>` / `unpin <mode>`
  const pin = cmd
    .command('pin')
    .description('pin a pack version for a mode (e.g. flow@2026.07.1) for reproducibility')
    .argument('<packId>', 'pack id from `vg models status` (mode@channel)')
    .action(function (this: Command, packId: string) {
      const global = readGlobal(this);
      const pack = QUALIFIED_PACKS.find((p) => p.packId === packId);
      if (!pack) {
        throw new CliError(
          `unknown pack "${packId}" — known: ${QUALIFIED_PACKS.map((p) => p.packId).join(', ')}`,
          ExitCode.USAGE_ERROR,
        );
      }
      pinPack(pack.mode, packId);
      if (global.json) json({ pinned: { mode: pack.mode, packId } });
      else info(`${c.cyan('vg models pin')} · ${c.bold(pack.mode)} → ${packId}`);
    });
  applyGlobalOptions(pin);

  const unpin = cmd
    .command('unpin')
    .description('clear the pack pin for a Code Mode')
    .argument('<mode>', 'spark | flow | forge')
    .action(function (this: Command, modeArg: string) {
      const global = readGlobal(this);
      const mode = parseMode(modeArg);
      if (!mode) throw new CliError(`unknown mode "${modeArg}"`, ExitCode.USAGE_ERROR);
      unpinPack(mode);
      if (global.json) json({ unpinned: mode });
      else info(`${c.cyan('vg models unpin')} · ${mode}`);
    });
  applyGlobalOptions(unpin);

  // `vg models packs` — list qualified packs (power users).
  const packs = cmd
    .command('packs')
    .description('list qualified Code Mode packs (underlying candidates)')
    .action(function (this: Command) {
      const global = readGlobal(this);
      if (global.json) {
        json({ packs: QUALIFIED_PACKS });
        return;
      }
      info(`${c.cyan('vg models packs')} · ${QUALIFIED_PACKS.length} qualified pack(s)`);
      for (const p of QUALIFIED_PACKS) {
        info(`  ${c.bold(p.packId)}  ${p.primary.weightsRef}  ${c.dim(p.promise)}`);
        for (const f of p.fallback ?? []) info(c.dim(`    fallback ${f.weightsRef}`));
      }
    });
  applyGlobalOptions(packs);

  // `vg models pull <name>` — download via the local runtime (action by default).
  const pull = cmd
    .command('pull')
    .description('download a model via your local runtime (Ollama)')
    .argument('<name>', 'model name, e.g. qwen2.5-coder:7b')
    .option('--runtime <id>', 'runtime to pull with (default: ollama)', 'ollama')
    .option('--dry-run', 'print the pull plan only — do not download')
    .option('--yes', 'skip prompts (pull already runs by default; kept for scripts)')
    .action(async function (this: Command, name: string, opts: { runtime: string; dryRun?: boolean; yes?: boolean }) {
      const global = readGlobal(this);
      if (opts.runtime !== 'ollama') {
        throw new CliError(`only the ollama runtime supports pull today (got --runtime ${opts.runtime}). LM Studio / gguf models are managed in their own apps.`, ExitCode.USAGE_ERROR);
      }
      const dryRun = !!opts.dryRun;
      const models = discoverModels();
      const installPlan = buildModelInstallPlan({
        backend: 'ollama',
        weightsRef: name,
        installedNames: models.map((m) => m.name),
        offline: !!global.local,
        hasBinary,
      });

      if (installPlan.ready) {
        if (global.json) json({ ok: true, ...installPlan, note: 'already installed' });
        else info(`${c.cyan('vg models pull')} · ${c.bold(name)} ${c.green('already installed')}`);
        return;
      }

      if (dryRun) {
        if (global.json) json({ ...installPlan, note: 'dry-run — re-run without --dry-run to download' });
        else {
          printInstallPlanHuman('vg models pull', installPlan);
          info(c.dim('  dry-run — re-run without --dry-run to pull'));
        }
        return;
      }

      if (!global.json) printInstallPlanHuman('vg models pull', installPlan);

      const result = await executeModelInstallPlan(installPlan, {
        offline: !!global.local,
        quiet: !!global.json,
        onProgress: (line) => {
          if (!global.json) info(c.dim(`  ${line}`));
        },
      });
      if (!result.ok) {
        throw new CliError(result.error ?? 'pull failed', ExitCode.ERROR);
      }
      if (global.json) {
        json({ ok: true, ...installPlan, pulledWeights: result.pulledWeights, installedDeps: result.installedDeps });
      } else {
        info(c.green(`  ✔ pulled ${name} — use it with \`vg code --provider ollama --model ${name}\``));
      }
    });
  applyGlobalOptions(pull);

  // `vg models uninstall <name>` — remove a local model. Destructive: confirm on
  // TTY unless `--yes`; `--dry-run` prints the plan only.
  // Supports Ollama (`ollama rm`), first-party GGUF weight store, and on-disk
  // LM Studio / loose GGUF paths discovered by `vg models --raw`.
  const uninstallCmd = cmd
    .command('uninstall')
    .description('uninstall a locally-installed model (Ollama, LM Studio, or GGUF)')
    .argument('<name>', 'installed model name, e.g. qwen2.5-coder:7b or a .gguf basename')
    .option('--runtime <id>', 'runtime: ollama | lm-studio | gguf (default: auto-detect from installed fleet)')
    .option('--dry-run', 'print the uninstall plan only — do not delete')
    .option('--yes', 'uninstall without an interactive confirm (required non-interactively)')
    .action(async function (this: Command, name: string, opts: { runtime?: string; dryRun?: boolean; yes?: boolean }) {
      const global = readGlobal(this);
      const dryRun = !!opts.dryRun;
      const target = resolveUninstallTarget(name, opts.runtime);
      if (!target) {
        const hint = opts.runtime
          ? `no installed model named "${name}" for runtime ${opts.runtime}`
          : `no installed model named "${name}"`;
        throw new CliError(
          `${hint} — check the name with \`vg models --raw\`.`,
          ExitCode.NOT_FOUND,
        );
      }

      const plan =
        target.runtime === 'ollama'
          ? {
              runtime: 'ollama' as const,
              name: target.name,
              path: target.path,
              command: `ollama rm ${target.name}`,
              willRemove: !dryRun,
            }
          : {
              runtime: target.runtime,
              name: target.name,
              path: target.path,
              command: `rm ${target.path}`,
              willRemove: !dryRun,
            };

      if (dryRun) {
        if (global.json) json({ ...plan, willRemove: false, note: 'dry-run — re-run without --dry-run to uninstall' });
        else {
          info(`${c.cyan('vg models uninstall')} · would run: ${c.bold(plan.command)}`);
          info(c.dim(`  ${target.runtime} · ${target.name}`));
          info(c.dim('  dry-run — re-run without --dry-run to uninstall (non-interactive: add --yes)'));
        }
        return;
      }
      const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
      if (!opts.yes) {
        if (!interactive) {
          throw new CliError(
            `refusing to uninstall "${target.name}" non-interactively without --yes — re-run with --yes, or pass --dry-run to preview.`,
            ExitCode.USAGE_ERROR,
          );
        }
        const ok = await confirmYesNo(`Uninstall local model ${target.name} (${target.runtime})?`);
        if (!ok) {
          if (global.json) json({ ...plan, willRemove: false, cancelled: true });
          else info(c.dim('  cancelled'));
          return;
        }
      }

      if (target.runtime === 'ollama') {
        const ollama = resolveOllamaBinary();
        if (!ollama) {
          throw new CliError(
            'ollama is not installed or not on PATH — install it from https://ollama.com, then re-run. ' +
              '(Dock-launched editors often miss Homebrew; open a terminal and try `which ollama`, or add /opt/homebrew/bin to PATH.)',
            ExitCode.NOT_FOUND,
          );
        }
        if (!global.json) info(c.dim(`  $ ${plan.command}`));
        const res = spawnSync(ollama, ['rm', target.name], {
          encoding: 'utf8',
          stdio: global.json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        });
        if (res.status !== 0) {
          const tail = [res.stderr, res.stdout]
            .filter(Boolean)
            .join('\n')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-3)
            .join(' · ');
          throw new CliError(
            `\`ollama rm ${target.name}\` failed (exit ${res.status ?? 'signal'})${tail ? `: ${tail}` : ''} — check the model name with \`vg models --raw\`.`,
            ExitCode.ERROR,
          );
        }
      } else {
        // File-backed fleet (Vibgrate weight store, LM Studio cache, loose GGUF).
        if (!target.path || !fs.existsSync(target.path)) {
          throw new CliError(
            `model file not found at ${target.path || '(unknown path)'} — it may already be removed.`,
            ExitCode.NOT_FOUND,
          );
        }
        if (!target.path.endsWith('.gguf')) {
          throw new CliError(
            `refusing to delete non-GGUF path for ${target.runtime} model "${target.name}"`,
            ExitCode.USAGE_ERROR,
          );
        }
        if (!global.json) info(c.dim(`  $ rm ${target.path}`));
        try {
          fs.unlinkSync(target.path);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new CliError(`could not delete ${target.path}: ${msg}`, ExitCode.ERROR);
        }
      }

      if (global.json) json({ ...plan, removed: true });
      else info(c.green(`  ✔ uninstalled ${target.name}`));
    });
  applyGlobalOptions(uninstallCmd);

  // `vg models host-bench` — Approach B measurement arms + release gates (P3).
  // Default is simulate (warm host path, no GPU). --mock for registry shells;
  // --live needs a real binding + --model-path GGUF (operator hardware runs).
  const hostBench = cmd
    .command('host-bench')
    .description('Approach B host measurement arms (TTFT / grammar / KV / sampler) + optional release gates')
    .option('--mock', 'registry metric shells only (no generate)')
    .option('--simulate', 'multi-turn warm-host simulation without a GPU (default)')
    .option('--live', 'run against a real binding + GGUF (requires --model-path)')
    .option('--model-path <path>', 'GGUF path for --live')
    .option('--turns <n>', 'turns per arm for simulate/live (default 2)', '2')
    .option('--arms <ids>', 'comma-separated arm ids (default: all)')
    .option('--gate', 'evaluate release gates; exit 2 on hard failure')
    .option('--dry-run', 'print planned arms only — do not run')
    .action(async function (
      this: Command,
      opts: {
        mock?: boolean;
        simulate?: boolean;
        live?: boolean;
        modelPath?: string;
        turns?: string;
        arms?: string;
        gate?: boolean;
        dryRun?: boolean;
      },
    ) {
      const global = readGlobal(this);
      let mode: HostBenchRunMode = 'simulate';
      if (opts.mock) mode = 'mock';
      else if (opts.live) mode = 'live';
      else if (opts.simulate) mode = 'simulate';

      const armIds = opts.arms
        ? opts.arms
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean) as HostBenchArmId[]
        : undefined;
      if (armIds?.length) {
        const known = new Set(HOST_BENCH_ARMS.map((a) => a.id));
        const bad = armIds.filter((id) => !known.has(id));
        if (bad.length) {
          throw new CliError(
            `unknown host-bench arm(s): ${bad.join(', ')} — known: ${[...known].join(', ')}`,
            ExitCode.USAGE_ERROR,
          );
        }
      }

      if (opts.dryRun) {
        const planned = armIds?.length
          ? HOST_BENCH_ARMS.filter((a) => armIds.includes(a.id))
          : HOST_BENCH_ARMS;
        if (global.json) {
          json({ dryRun: true, mode, arms: planned.map((a) => ({ id: a.id, label: a.label, metrics: a.metrics })) });
          return;
        }
        info(`${c.cyan('vg models host-bench')} · dry-run · mode=${mode} · ${planned.length} arm(s)`);
        for (const a of planned) info(`  ${a.id}  ${c.dim(a.hypothesis)}`);
        info(c.dim('  re-run without --dry-run to execute'));
        return;
      }

      if (mode === 'live' && !opts.modelPath) {
        throw new CliError(
          'live host-bench needs --model-path <gguf> (and a loaded llama.cpp binding from `vg models install`)',
          ExitCode.USAGE_ERROR,
        );
      }

      // Live binding: optional dynamic import only when operator asks for live.
      // Never static-import native deps (published CLI stays free of them).
      let binding: unknown | undefined;
      if (mode === 'live') {
        try {
          const spec = 'node-llama-cpp';
          const mod = await (Function('s', 'return import(s)') as (s: string) => Promise<unknown>)(spec).catch(
            () => null,
          );
          binding = mod ?? undefined;
        } catch {
          binding = undefined;
        }
        if (!binding) {
          throw new CliError(
            'live host-bench could not load node-llama-cpp — run `vg models install` for a llama-cpp pack, or use --simulate',
            ExitCode.NOT_FOUND,
          );
        }
      }

      const turns = Math.max(1, Number(opts.turns) || 2);
      const result = await runHostBench({
        mode,
        armIds,
        turns,
        modelPath: opts.modelPath,
        binding,
        onProgress: (line) => {
          if (!global.json) info(c.dim(`  ${line}`));
        },
      });

      const gateResult = opts.gate ? evaluateHostBenchGates(result.report) : null;

      if (global.json) {
        json({
          ...result,
          gates: gateResult,
        });
      } else {
        info(renderHostBenchReportText(result));
        if (gateResult) {
          info('');
          info(renderGateResultMarkdown(gateResult));
        }
      }

      if (gateResult && !gateResult.ok) {
        throw new CliError(
          `host-bench release gates failed (${gateResult.hardFailed} hard) — see gate table above`,
          ExitCode.GATE_FAILED,
        );
      }
    });
  applyGlobalOptions(hostBench);

  // `vg models coding-metrics` — unified host-bench + Fusion FCS/ZNS report
  // (coding-metrics/0). Feeds the website benchmarks-coding/ publish path.
  const codingMetrics = cmd
    .command('coding-metrics')
    .description(
      'unified coding metrics report: host-bench arms + Fusion FCS/ZNS (publishable coding-metrics/0)',
    )
    .option('--mock', 'host-bench metric shells only')
    .option('--simulate', 'host-bench multi-turn simulate without GPU (default)')
    .option('--live', 'host-bench against real binding + GGUF (requires --model-path)')
    .option('--model-path <path>', 'GGUF path for --live')
    .option('--turns <n>', 'turns per host-bench arm (default 2)', '2')
    .option('--skip-fusion', 'skip offline Fusion FCS/ZNS pack')
    .option('--gate', 'fail with exit 2 when host-bench hard gates fail')
    .option('--out <file>', 'write full JSON report to file')
    .option('--version <semver>', 'stamp cliVersion on the report (default package VERSION)')
    .action(async function (
      this: Command,
      opts: {
        mock?: boolean;
        simulate?: boolean;
        live?: boolean;
        modelPath?: string;
        turns?: string;
        skipFusion?: boolean;
        gate?: boolean;
        out?: string;
        version?: string;
      },
    ) {
      const global = readGlobal(this);
      let mode: HostBenchRunMode = 'simulate';
      if (opts.mock) mode = 'mock';
      else if (opts.live) mode = 'live';
      else if (opts.simulate) mode = 'simulate';

      if (mode === 'live' && !opts.modelPath) {
        throw new CliError(
          'live coding-metrics needs --model-path <gguf> (or use --simulate)',
          ExitCode.USAGE_ERROR,
        );
      }

      let binding: unknown | undefined;
      if (mode === 'live') {
        try {
          const spec = 'node-llama-cpp';
          const mod = await (Function('s', 'return import(s)') as (s: string) => Promise<unknown>)(spec).catch(
            () => null,
          );
          binding = mod ?? undefined;
        } catch {
          binding = undefined;
        }
        if (!binding) {
          throw new CliError(
            'live coding-metrics could not load node-llama-cpp — run `vg models install` or use --simulate',
            ExitCode.NOT_FOUND,
          );
        }
      }

      const report = await buildCodingMetricsReport({
        mode,
        turns: Math.max(1, Number(opts.turns) || 2),
        modelPath: opts.modelPath,
        binding,
        skipFusion: !!opts.skipFusion,
        cliVersion: opts.version,
        onProgress: (line) => {
          if (!global.json) info(c.dim(`  ${line}`));
        },
      });

      if (opts.out) {
        const outPath = path.resolve(opts.out);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
        if (!global.json) info(c.dim(`  wrote ${outPath}`));
      }

      if (global.json) {
        json(report);
      } else {
        info(renderCodingMetricsMarkdown(report));
        if (!report.hostGates.ok) {
          info('');
          info(renderGateResultMarkdown(report.hostGates));
        }
      }

      if (opts.gate && !report.hostGates.ok) {
        throw new CliError(
          `coding-metrics host gates failed (${report.hostGates.hardFailed} hard)`,
          ExitCode.GATE_FAILED,
        );
      }
    });
  applyGlobalOptions(codingMetrics);

  // `vg models catalog` — the live, hosted model catalog (OpenRouter), the SAME
  // list the interactive wizard uses. Key-free and cached; this is the one place
  // the catalog is fetched, so host UIs (the VS Code model picker) render a list
  // that refreshes live instead of re-implementing the fetch.
  const catalog = cmd
    .command('catalog')
    .description('the live hosted model catalog (OpenRouter) — key-free, cached, refreshed from the network')
    .option('--offline', 'never touch the network — use the cache (or the curated fallback)')
    .option('--refresh', 'bypass the cache and refresh from the network')
    .action(async function (this: Command, opts: { offline?: boolean; refresh?: boolean }) {
      const global = readGlobal(this);
      const cat = await fetchCatalog({ offline: opts.offline, noCache: opts.refresh });
      if (global.json) {
        json(cat);
        return;
      }
      const count = cat.providers.reduce((n, p) => n + p.models.length, 0);
      info(`${c.cyan('vg models catalog')} · ${count} model(s) across ${cat.providers.length} provider(s) · ${c.dim(cat.source)}`);
      for (const p of cat.providers) {
        info(`  ${c.bold(p.label)} ${c.dim(`(${p.models.length})`)}`);
        for (const m of p.models.slice(0, 8)) info(`    ${m.id}`);
        if (p.models.length > 8) info(c.dim(`    …and ${p.models.length - 8} more`));
      }
      info(c.dim('  use one with `vg code --provider openrouter --model <id>` (needs OPENROUTER_API_KEY)'));
    });
  applyGlobalOptions(catalog);
}

function hasBinary(bin: string): boolean {
  if (bin === 'ollama' || bin === 'ollama.exe') return hasOllamaBinary();
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
  return probe.status === 0;
}

function repoSignals(root: string): { fileCount?: number; graphNodeCount?: number } {
  try {
    const g = loadGraph(root);
    if (!g) return {};
    const fileCount = g.nodes.filter((n) => n.kind === 'file').length;
    return { fileCount, graphNodeCount: g.nodes.length };
  } catch {
    return {};
  }
}

function buildFullStatus(
  root: string,
  models: ReturnType<typeof discoverModels>,
  sys: Awaited<ReturnType<typeof gatherSystemMemory>>,
): OrchestratorStatus {
  const state = readOrchestratorState();
  // Free space on the first-party weight store volume (macOS: Library/Caches/Vibgrate).
  const freeDiskBytes = freeBytesOnVolume(weightStoreDir());
  return buildOrchestratorStatus({
    system: sys,
    repo: repoSignals(root),
    installedNames: models.map((m) => m.name),
    freeDiskBytes,
    pins: state.pins,
    defaultMode: state.defaultMode,
  });
}

function printOrchestratorStatus(orch: OrchestratorStatus): void {
  info(`${c.cyan('vg models')} · Code Modes  ${c.dim(orch.schemaVersion)}`);
  info(`  recommended ${c.bold(orch.recommended)}  ${c.dim(`default ${orch.defaultMode}${orch.pin ? ` · pin ${orch.pin.packId}` : ''}`)}`);
  for (const m of orch.modes) {
    const mark = m.mode === orch.recommended ? '→' : ' ';
    const inst = m.installed ? c.green('installed') : c.dim('not installed');
    info(
      `  ${mark} ${c.bold(m.mode.padEnd(6))} ${fitColor(m.fit).padEnd(14)} ${m.underlyingModelId}  ${inst}${m.pinned ? c.dim(' · pinned') : ''}`,
    );
    info(c.dim(`      ${m.packId} · ${m.promise}`));
  }
  const sys = orch.system;
  const ram = `RAM ${fmt(sys.freeRamBytes)} free / ${fmt(sys.totalRamBytes)}`;
  const vram =
    typeof sys.vramTotalBytes === 'number'
      ? ` · VRAM ${fmt(sys.vramFreeBytes ?? 0)} free / ${fmt(sys.vramTotalBytes)}`
      : '';
  const disk =
    typeof sys.freeDiskBytes === 'number' ? ` · Disk ${fmt(sys.freeDiskBytes)} free (model cache)` : '';
  info(c.dim(`  ${ram}${vram}${disk}`));
  if (orch.memoryBreakdown) {
    const b = orch.memoryBreakdown;
    info(
      c.dim(
        `  pie  model ${fmt(b.modelBytes)} · kv ${fmt(b.kvBytes)} · ide ${fmt(b.ideBytes)} · graph ${fmt(b.graphBytes)} · free ${fmt(b.freeAfterReservesBytes)}`,
      ),
    );
  }
}

function printRawFleet(report: ReturnType<typeof buildModelsStatusReport>): void {
  info(`${c.cyan('vg models --raw')} · ${report.models.length} local model(s) discovered`);
  if (report.models.length === 0) {
    info(c.dim('  none found (looked in ~/.ollama, ~/.lmstudio, ~/models, ~/.cache)'));
    info(c.dim('  install a Code Mode pack with `vg models install`'));
  } else {
    for (const m of report.models) {
      const est = m.estimate;
      const size = est.guessed ? `~${fmt(est.bytes)}?` : `~${fmt(est.bytes)}`;
      info(`  ${c.bold(m.runtime.padEnd(10))} ${m.name}  ${c.dim(`${est.quant} · ${size}`)}`);
    }
  }
  const sys = report.system;
  info(c.dim(`  RAM ${fmt(sys.freeRamBytes)} free / ${fmt(sys.totalRamBytes)}`));
}

function fitColor(label: string): string {
  if (label === 'flies') return c.green(label);
  if (label === 'comfortable') return c.green(label);
  if (label === 'tight') return c.yellow(label);
  if (label === 'will_not_fit') return c.red(label);
  return label;
}

/** Interactive y/N confirm on stderr (matches `vg code` write consent). */
function confirmYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Normalize `--runtime` aliases to the discoverModels runtime id. */
function normalizeUninstallRuntime(raw?: string): 'ollama' | 'lm-studio' | 'gguf' | undefined {
  if (!raw?.trim()) return undefined;
  const r = raw.trim().toLowerCase();
  if (r === 'ollama') return 'ollama';
  if (r === 'lm-studio' || r === 'lmstudio' || r === 'lm_studio') return 'lm-studio';
  if (r === 'gguf' || r === 'llama-cpp' || r === 'llamacpp' || r === 'vibgrate') return 'gguf';
  throw new CliError(
    `unknown --runtime ${raw} (use ollama, lm-studio, or gguf)`,
    ExitCode.USAGE_ERROR,
  );
}

/**
 * Resolve which discovered model to uninstall. Prefers exact name match, then
 * basename / path suffix. When `--runtime` is set, only that fleet is searched.
 */
function resolveUninstallTarget(
  name: string,
  runtimeOpt?: string,
): { runtime: 'ollama' | 'lm-studio' | 'gguf'; name: string; path: string } | null {
  const want = name.trim();
  if (!want) return null;
  const wantLc = want.toLowerCase();
  const runtime = normalizeUninstallRuntime(runtimeOpt);
  const fleet = discoverModels().filter((m) => (runtime ? m.runtime === runtime : true));

  const exact = fleet.filter((m) => m.name.toLowerCase() === wantLc);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    // Same name on multiple runtimes — prefer ollama, then gguf, then lm-studio.
    const order = ['ollama', 'gguf', 'lm-studio'] as const;
    for (const rt of order) {
      const hit = exact.find((m) => m.runtime === rt);
      if (hit) return hit;
    }
    return exact[0];
  }

  // Basename / path suffix (LM Studio stores publisher/repo/file.gguf).
  const base = path.basename(wantLc);
  const soft = fleet.filter((m) => {
    const n = m.name.toLowerCase();
    return n === base || n.endsWith('/' + base) || n.endsWith(wantLc) || path.basename(n) === base;
  });
  if (soft.length === 1) return soft[0];
  if (soft.length > 1) {
    // Prefer exact basename match over fuzzy path contains.
    const baseHits = soft.filter((m) => path.basename(m.name).toLowerCase() === base);
    const pool = baseHits.length ? baseHits : soft;
    const order = ['ollama', 'gguf', 'lm-studio'] as const;
    for (const rt of order) {
      const hit = pool.find((m) => m.runtime === rt);
      if (hit) return hit;
    }
    return pool[0];
  }

  // Ollama-only fallback: allow uninstall by tag name even if discovery missed
  // (e.g. ollama installed but manifests not readable in this sandbox).
  if (!runtime || runtime === 'ollama') {
    if (want.includes(':') || !want.includes('/') && !want.endsWith('.gguf')) {
      return { runtime: 'ollama', name: want, path: '' };
    }
  }
  return null;
}

function printInstallPlanHuman(label: string, plan: import('../runtime/model-install-plan.js').ModelInstallPlan): void {
  const title = plan.mode ? `${plan.mode} → ${plan.model}` : plan.model;
  info(`${c.cyan(label)} · ${c.bold(title)}`);
  if (plan.packId) info(c.dim(`  pack ${plan.packId}${plan.fit ? ` · fit ${plan.fit}` : ''}`));
  if (plan.promise) info(c.dim(`  ${plan.promise}`));
  info(c.dim(`  weights channel ${plan.weights.channel}`));
  for (const dep of plan.runtimeDeps) {
    const mark = dep.status === 'satisfied' ? c.green('ok') : dep.status === 'missing' ? c.yellow('install') : c.yellow('need');
    info(c.dim(`  dep ${dep.id} [${mark}] ${dep.reason}`));
  }
  if (plan.willInstall.length) info(c.dim(`  will install: ${plan.willInstall.join(', ')}`));
  if (plan.willDownload.length) info(c.dim(`  will download: ${plan.willDownload.join(', ')}`));
  for (const b of plan.blocked) info(c.yellow(`  blocked ${b.id}: ${b.reason}`));
}

function printBackends(backends: ReturnType<typeof probeInferenceBackends>): void {
  info(c.dim('  inference backends'));
  for (const b of backends) {
    const mark = b.available ? c.green('up') : c.dim('—');
    info(c.dim(`    [${mark}] ${b.id} · ${b.detail ?? b.label}`));
  }
}
