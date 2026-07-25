import { spawnSync } from 'node:child_process';
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
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

/**
 * `vg models` (VG-CLI-SPEC §5 / VG-CLI-CODE §6) — Code Modes + local fleet.
 *
 * Default path is **outcome-oriented Code Modes** (Spark / Flow / Forge), not
 * GGUF names. The Model Orchestrator fits packs to live memory + repo signals.
 * Raw local discovery remains for power users.
 *
 * `vg models pull <name>` still requires `--yes`: **no model is ever downloaded
 * by default.**
 */
export function registerModels(program: Command): void {
  const cmd = program
    .command('models')
    .description('Code Modes (Spark/Flow/Forge) + local model fleet')
    .option('--raw', 'list discovered local models only (skip Code Modes status)')
    .action(function (this: Command, opts: { raw?: boolean }) {
      const global = readGlobal(this);
      const models = discoverModels();
      const sys = gatherSystemMemory();
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
      if (global.json) {
        json({ ...orch, fleet: report });
        return;
      }
      printOrchestratorStatus(orch);
      info('');
      info(c.dim(`  ${report.models.length} local model(s) on disk · \`vg models --raw\` for the full list`));
      info(c.dim('  set a mode: `vg models mode flow` · ensure pack: `vg models ensure --yes` · pin: `vg models pin flow@…`'));
    });
  applyGlobalOptions(cmd);

  // `vg models status` — explicit alias of default action (rich Code Modes view).
  const status = cmd
    .command('status')
    .description('Code Modes status: mode, pack, underlying model, fit, memory breakdown')
    .action(function (this: Command) {
      const global = readGlobal(this);
      const models = discoverModels();
      const sys = gatherSystemMemory();
      const orch = buildFullStatus(rootOf(global), models, sys);
      if (global.json) {
        json({ ...orch, fleet: buildModelsStatusReport(models, sys) });
        return;
      }
      printOrchestratorStatus(orch);
    });
  applyGlobalOptions(status);

  // `vg models mode [spark|flow|forge]` — show or set default Code Mode.
  const modeCmd = cmd
    .command('mode')
    .description('show or set the default Code Mode (spark | flow | forge)')
    .argument('[mode]', 'spark, flow, or forge (omit to show current)')
    .option('--auto', 'clear the fixed default and auto-fit on next resolve')
    .action(function (this: Command, modeArg: string | undefined, opts: { auto?: boolean }) {
      const global = readGlobal(this);
      if (opts.auto) {
        const state = readOrchestratorState();
        delete state.defaultMode;
        writeOrchestratorState(state);
        if (global.json) json({ defaultMode: null, autoFit: true });
        else info(`${c.cyan('vg models mode')} · ${c.green('auto-fit')} (no fixed default)`);
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
      const sys = gatherSystemMemory();
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
      info(c.dim('  set with `vg models mode flow` · auto with `vg models mode --auto`'));
    });
  applyGlobalOptions(modeCmd);

  // `vg models resolve [mode]` — dry resolve mode → pack → model + fit (no download).
  const resolve = cmd
    .command('resolve')
    .description('resolve a Code Mode to pack + underlying model + fit (no download)')
    .argument('[mode]', 'spark | flow | forge (default: auto-fit or configured default)')
    .action(function (this: Command, modeArg: string | undefined) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const sys = gatherSystemMemory();
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

  // `vg models ensure [mode]` — resolve + pull underlying pack with --yes.
  const ensure = cmd
    .command('ensure')
    .description('resolve the best Code Mode for this machine and pull the pack (requires --yes)')
    .argument('[mode]', 'spark | flow | forge (default: auto-fit)')
    .option('--yes', 'actually download the resolved pack (without this: plan only)')
    .action(function (this: Command, modeArg: string | undefined, opts: { yes?: boolean }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const models = discoverModels();
      const sys = gatherSystemMemory();
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
        const msg = `mode ${resolved.mode} will not fit (${fmt(resolved.fit.needBytes)} need, ${fmt(resolved.fit.availableBytes)} free) — try \`vg models ensure spark --yes\` or free memory`;
        if (global.json) {
          json({ ok: false, reason: 'will_not_fit', resolved });
          return;
        }
        throw new CliError(msg, ExitCode.ERROR);
      }

      const name = resolved.underlying.weightsRef;
      const installed = models.some(
        (m) => m.name.toLowerCase() === name.toLowerCase() || m.name.toLowerCase().includes(name.toLowerCase()),
      );
      const plan = {
        mode: resolved.mode,
        packId: resolved.pack.packId,
        model: name,
        backend: resolved.underlying.backend,
        fit: resolved.fit.label,
        installed,
        willDownload: !!opts.yes && !installed,
        license: resolved.underlying.license,
        promise: resolved.pack.promise,
      };

      if (installed) {
        if (global.json) json({ ok: true, ...plan, note: 'already installed' });
        else {
          info(`${c.cyan('vg models ensure')} · ${c.bold(resolved.mode)} → ${name} ${c.green('already installed')}`);
          info(c.dim(`  pack ${resolved.pack.packId} · fit ${resolved.fit.label}`));
          info(c.dim(`  use with \`vg code --provider ${providerForBackend(resolved.underlying.backend)} --model ${name}\``));
        }
        return;
      }

      if (!opts.yes) {
        if (global.json) {
          json({ ...plan, note: 'dry-run — re-run with --yes to download (no model is pulled by default)' });
          return;
        }
        info(`${c.cyan('vg models ensure')} · would pull ${c.bold(name)} for mode ${c.bold(resolved.mode)}`);
        info(c.dim(`  pack ${resolved.pack.packId} · fit ${resolved.fit.label} · license ${resolved.underlying.license ?? 'see model card'}`));
        info(c.dim(`  ${resolved.pack.promise}`));
        info(c.dim('  no model is downloaded by default — re-run with --yes to pull'));
        return;
      }

      if (resolved.underlying.backend !== 'ollama') {
        throw new CliError(
          `ensure only auto-pulls via Ollama today (pack backend is ${resolved.underlying.backend}). Install the weights manually, then re-run.`,
          ExitCode.USAGE_ERROR,
        );
      }
      if (!hasBinary('ollama')) {
        throw new CliError(
          'ollama is not installed or not on PATH — install it from https://ollama.com, then re-run. (We never install a runtime for you.)',
          ExitCode.NOT_FOUND,
        );
      }
      if (!global.json) {
        info(c.dim(`  license: ${resolved.underlying.license ?? 'see model card'}`));
        info(c.dim(`  $ ollama pull ${name}`));
      }
      const res = spawnSync('ollama', ['pull', name], { stdio: global.json ? 'ignore' : 'inherit' });
      if (res.status !== 0) {
        throw new CliError(`\`ollama pull ${name}\` failed (exit ${res.status ?? 'signal'}) — check network and model name.`, ExitCode.ERROR);
      }
      if (global.json) json({ ok: true, ...plan, pulled: true });
      else {
        info(c.green(`  ✔ ${resolved.mode} ready · ${name}`));
        info(c.dim(`  \`vg code --provider ollama --model ${name}\``));
      }
    });
  applyGlobalOptions(ensure);

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

  // `vg models rm <name>` — consent-gated removal of a locally-installed model.
  // The mirror of `pull`: prints the plan by default, removes only with --yes.
  const rm = cmd
    .command('rm')
    .description('remove a locally-installed model via your runtime (Ollama) — requires --yes; nothing is removed by default')
    .argument('<name>', 'installed model name, e.g. qwen2.5-coder:7b')
    .option('--runtime <id>', 'runtime to remove from (default: ollama)', 'ollama')
    .option('--yes', 'actually remove (without this it only prints the plan — nothing is removed by default)')
    .action(function (this: Command, name: string, opts: { runtime: string; yes?: boolean }) {
      const global = readGlobal(this);
      if (opts.runtime !== 'ollama') {
        throw new CliError(`only the ollama runtime supports rm today (got --runtime ${opts.runtime}). LM Studio / gguf models are managed in their own apps.`, ExitCode.USAGE_ERROR);
      }
      const plan = { runtime: 'ollama', command: `ollama rm ${name}`, willRemove: !!opts.yes };
      if (!opts.yes) {
        if (global.json) json({ ...plan, note: 'dry-run — re-run with --yes to remove (nothing is removed by default)' });
        else {
          info(`${c.cyan('vg models rm')} · would run: ${c.bold(plan.command)}`);
          info(c.dim('  nothing is removed by default — re-run with --yes to actually remove it'));
        }
        return;
      }
      if (!hasBinary('ollama')) {
        throw new CliError('ollama is not installed or not on PATH — install it from https://ollama.com, then re-run.', ExitCode.NOT_FOUND);
      }
      if (!global.json) info(c.dim(`  $ ${plan.command}`));
      const res = spawnSync('ollama', ['rm', name], { stdio: global.json ? 'ignore' : 'inherit' });
      if (res.status !== 0) {
        throw new CliError(`\`ollama rm ${name}\` failed (exit ${res.status ?? 'signal'}) — check the model name with \`vg models\`.`, ExitCode.ERROR);
      }
      if (global.json) json({ ...plan, removed: true });
      else info(c.green(`  ✔ removed ${name}`));
    });
  applyGlobalOptions(rm);

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
  sys: ReturnType<typeof gatherSystemMemory>,
): OrchestratorStatus {
  const state = readOrchestratorState();
  return buildOrchestratorStatus({
    system: sys,
    repo: repoSignals(root),
    installedNames: models.map((m) => m.name),
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
  info(c.dim(`  ${ram}${vram}`));
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
    info(c.dim('  pull a Code Mode pack with `vg models ensure --yes`'));
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
