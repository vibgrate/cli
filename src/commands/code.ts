import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { Command } from 'commander';
import { resolveProviders } from '../code/router.js';
import { parseReasoningEffort } from '../code/providers.js';
import { loadCodeConfig, contextBudgetFor } from '../code/config.js';
import { discoverMcpServers } from '../code/mcp-discovery.js';
import { runCodeSession } from '../code/session.js';
import { ensureRelevanceModule } from '../install/relevance-module.js';
import { summarizeDiffs } from '../code/diff.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { requireGraph, rootOf } from './util.js';
import { CliError, ExitCode, usageError } from '../util/exit.js';
import { c, info, json, out } from '../util/output.js';
import type { CodeSessionResult, LifecyclePhase } from '../code/types.js';

/**
 * `vg code "<instruction>"` (VG-CLI-CODE §2) — the graph-grounded coding loop.
 *
 * Proposes a minimal edit for an instruction, grounded in the deterministic code
 * graph and routed to a model you choose (local or hosted). **Dry-run by
 * default**: it prints the proposed diff and writes nothing. `--apply` (with
 * `--yes`, or an interactive confirm) walks the same inspect → assess → approve
 * → execute → verify → log lifecycle the rest of the platform enforces — there
 * is no quick-apply back-door (GUARDRAILS §5).
 *
 * No model is bundled and nothing is installed by default: a backend is chosen
 * only from what you've configured (a hosted key or a locally-pulled model), and
 * the only path that installs a package (`--provider llama-cpp`) does so once, on
 * first use, and only with `--yes`.
 */
export function registerCode(program: Command): void {
  const cmd = program
    .command('code')
    .description('graph-grounded coding agent (guided mode with no instruction; every edit and command is approved)')
    .argument('[instruction...]', 'what to change, in plain language (omit for guided interactive mode)')
    .option('--provider <id>', 'backend: vibgrate-relay (Vibgrate Relay), ollama, lmstudio, foundry-local, openrouter, litellm, openai, together, llama-cpp')
    .option('--model <id>', 'model id (or set VG_CODE_MODEL). No model is hard-coded — pick the current best.')
    .option('--mode <mode>', 'Code Mode: spark | flow | forge (preferred over raw model names; auto-fits when omitted and no --model)')
    .option('--model-path <gguf>', 'gguf path for --provider llama-cpp (weights are never auto-downloaded)')
    .option('-f, --file <path>', 'restrict the edit surface to this file (repeatable)', collect, [])
    .option('-b, --budget <n>', 'approx context token budget', '3000')
    .option('--apply', 'one-shot path (--single/--mock) only: write the change (still requires --yes or an interactive confirm)')
    .option('--yes', 'consent to write / to a first-use package install, non-interactively')
    .option('--auto', 'autonomous agent: auto-approve every edit and command (use with care)')
    .option('--max-steps <n>', 'cap the number of agent steps (default 24; also settable as maxSteps in vibgrate.config.json)')
    .option('--single', 'one-shot planner (single edit) instead of the multi-step agent')
    .option('--stream', 'stream the model output live')
    .option('--stream-json', 'machine protocol: NDJSON agent events on stdout, approval decisions on stdin (for host UIs like the VS Code panel)')
    .option('--session', 'with --stream-json: stay open for further turns (warm graph and tools) instead of exiting after one')
    .option('--verify [command]', 'after the agent finishes, run tests and make it fix failures (uses the config testCommand if no command is given)')
    .option('--continue [id]', 'resume a session: the most recent one, or the given session id (recap + restore /undo)')
    .option('--restore-checkpoint <commit>', 'one-shot: restore the given --file paths from a checkpoint commit, then exit (for host UIs after the original session ended)')
    .option('--reasoning-effort <level>', 'how hard a reasoning-capable model should think: low | medium | high (ignored by models without the knob)')
    .option('--worktree [id]', 'run the session in an isolated git worktree under .vibgrate/worktrees (bare: create a new one; with id: reuse it)')
    .option('--worktree-diff <id>', 'one-shot: print the worktree\'s delta against its base as a patch, then exit')
    .option('--worktree-apply <id>', 'one-shot: apply the worktree\'s delta onto the main tree (git apply --3way), then exit')
    .option('--worktree-remove <id>', 'one-shot: remove the worktree checkout, then exit')
    .option('--capsule', 'use a source-bearing Task Capsule for first context (Fusion A/B; exact source ranges from the graph)')
    .option('--no-capsule', 'disable Task Capsule context even if enabled in .vibgrate/code.json')
    .option('--security-tier <tier>', 'shell isolation: L0 (host), L1 (Seatbelt/bubblewrap when available), L2/L3 reserved')
    .option('--mock <file>', 'use a scripted reply from <file> instead of a model (offline; for tests/CI)')
    .option('-o, --out <file>', 'write the JSON result to <file> (implies --json shape; for CI/benchmarks)')
    .action(async function (
      this: Command,
      instructionParts: string[],
      opts: {
        provider?: string;
        model?: string;
        mode?: string;
        modelPath?: string;
        file: string[];
        budget?: string;
        apply?: boolean;
        yes?: boolean;
        auto?: boolean;
        maxSteps?: string;
        single?: boolean;
        stream?: boolean;
        streamJson?: boolean;
        session?: boolean;
        verify?: string | boolean;
        continue?: boolean | string;
        restoreCheckpoint?: string;
        reasoningEffort?: string;
        worktree?: boolean | string;
        worktreeDiff?: string;
        worktreeApply?: string;
        worktreeRemove?: string;
        capsule?: boolean;
        securityTier?: string;
        mock?: string;
        out?: string;
      },
    ) {
      const global = readGlobal(this);
      let instruction = (instructionParts ?? []).join(' ').trim();

      // `--continue [id]` takes an optional session id, and commander cannot
      // tell an id from the first word of a bare-word instruction:
      // `vg code --continue fix the tests` parses as continue="fix". Anything
      // not shaped like a minted session id is the instruction's first word —
      // fold it back and keep `--continue`'s bare meaning (resume latest).
      if (typeof opts.continue === 'string') {
        const { looksLikeSessionId } = await import('../code/session-store.js');
        if (!looksLikeSessionId(opts.continue)) {
          instruction = [opts.continue, instruction].filter(Boolean).join(' ');
          opts.continue = true;
        }
      }

      // One-shot checkpoint restore: no model, no map, no session — just git.
      // Host UIs use this when the session that made a change has ended, so an
      // Undo button keeps working after a reload / model switch / new chat.
      if (opts.restoreCheckpoint) {
        const { restoreCheckpoint, isValidCheckpointCommit } = await import('../code/checkpoint.js');
        if (!isValidCheckpointCommit(opts.restoreCheckpoint)) {
          throw usageError('--restore-checkpoint expects a checkpoint commit id (hex SHA)');
        }
        const files = (opts.file ?? []).filter(Boolean);
        if (!files.length) {
          throw usageError('--restore-checkpoint needs the files to restore, e.g. -f src/a.ts -f src/b.ts');
        }
        const root = rootOf(global);
        const child = await import('node:child_process');
        const gitRunner = (gitArgs: string[], gitEnv?: Record<string, string>) => {
          const res = child.spawnSync('git', gitArgs, {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, ...(gitEnv ?? {}) },
            timeout: 30_000,
            maxBuffer: 32 * 1024 * 1024,
          });
          return { stdout: res.stdout ?? '', exitCode: res.status ?? 1 };
        };
        const outcome = restoreCheckpoint(gitRunner, { commit: opts.restoreCheckpoint, files });
        if (opts.streamJson) {
          process.stdout.write(
            JSON.stringify({ event: 'checkpoint-restored', commit: opts.restoreCheckpoint, ...outcome }) + '\n',
          );
        } else if (global.json) {
          json({ commit: opts.restoreCheckpoint, ...outcome });
        } else {
          out(
            `restored ${outcome.restored.length}, removed ${outcome.removed.length}, failed ${outcome.failed.length}`,
          );
        }
        if (outcome.failed.length) process.exitCode = 1;
        return;
      }

      // Worktree one-shots (diff / apply / remove): plain git, no model, no
      // map. Host UIs drive the review-then-apply flow with these after the
      // worktree session itself has ended.
      if (opts.worktreeDiff || opts.worktreeApply || opts.worktreeRemove) {
        const wt = await import('../code/worktree-session.js');
        const child = await import('node:child_process');
        const os = await import('node:os');
        const pathMod = await import('node:path');
        const root = rootOf(global);
        const gitRunner: import('../code/worktree-session.js').GitRunner = (gitArgs, gitEnv) => {
          const res = child.spawnSync('git', gitArgs, {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, ...(gitEnv ?? {}) },
            timeout: 60_000,
            maxBuffer: 64 * 1024 * 1024,
          });
          return { stdout: (res.stdout ?? '') + (res.stderr ?? ''), exitCode: res.status ?? 1 };
        };
        const emitLine = (line: unknown): void => {
          if (opts.streamJson) process.stdout.write(JSON.stringify(line) + '\n');
          else if (global.json) json(line);
        };
        const findWt = (id: string) =>
          wt.listSessionWorktrees(gitRunner, root).find((w) => w.id === id);
        if (opts.worktreeDiff) {
          const target = findWt(opts.worktreeDiff);
          if (!target) throw new CliError(`no worktree ${opts.worktreeDiff} under .vibgrate/worktrees`, ExitCode.NOT_FOUND);
          const diff = wt.worktreeDiffToBase(gitRunner, target.path, target.base);
          if ('error' in diff) throw new CliError(diff.error, ExitCode.ERROR);
          // Cap the transported patch: a runaway delta must not blow up the
          // host's JSON parse. The apply path re-reads it from git, not this.
          const MAX_PATCH = 2 * 1024 * 1024;
          const truncated = diff.patch.length > MAX_PATCH;
          emitLine({
            event: 'worktree-diff',
            id: target.id,
            base: target.base,
            files: diff.files,
            patch: truncated ? diff.patch.slice(0, MAX_PATCH) : diff.patch,
            truncated,
          });
          if (!opts.streamJson && !global.json) {
            out(diff.patch || `worktree ${target.id}: no changes vs base`);
          }
          return;
        }
        if (opts.worktreeApply) {
          const target = findWt(opts.worktreeApply);
          if (!target) throw new CliError(`no worktree ${opts.worktreeApply} under .vibgrate/worktrees`, ExitCode.NOT_FOUND);
          const diff = wt.worktreeDiffToBase(gitRunner, target.path, target.base);
          if ('error' in diff) throw new CliError(diff.error, ExitCode.ERROR);
          if (!diff.files.length) {
            emitLine({ event: 'worktree-applied', id: target.id, applied: true, files: [] });
            if (!opts.streamJson && !global.json) out(`worktree ${target.id}: nothing to apply`);
            return;
          }
          const patchFile = pathMod.join(
            fs.mkdtempSync(pathMod.join(os.tmpdir(), 'vg-wt-')),
            'delta.patch',
          );
          fs.writeFileSync(patchFile, diff.patch);
          const outcome = wt.applyWorktreePatch(gitRunner, root, patchFile, diff.files);
          emitLine({ event: 'worktree-applied', id: target.id, ...outcome });
          if (!opts.streamJson && !global.json) {
            out(
              outcome.applied
                ? `applied ${outcome.files.length} file(s) from worktree ${target.id}`
                : `apply failed: ${outcome.error}`,
            );
          }
          if (!outcome.applied) process.exitCode = 1;
          return;
        }
        if (opts.worktreeRemove) {
          const outcome = wt.removeSessionWorktree(gitRunner, root, opts.worktreeRemove);
          emitLine({ event: 'worktree-removed', id: opts.worktreeRemove, ...outcome });
          if (!opts.streamJson && !global.json) {
            out(outcome.removed ? `removed worktree ${opts.worktreeRemove}` : `remove failed: ${outcome.error}`);
          }
          if (!outcome.removed) process.exitCode = 1;
          return;
        }
      }

      // Worktree session (P3): root the whole run in an isolated checkout under
      // .vibgrate/worktrees/<id>. Sessions/approvals still live in the MAIN
      // repo's .vibgrate (shared History; consent is per-developer, not
      // per-checkout) — everything else (map, edits, shell) happens inside the
      // worktree. The main root is remembered before cwd is re-pointed.
      const mainRoot = rootOf(global);
      let activeWorktree: import('../code/worktree-session.js').WorktreeInfo | undefined;
      if (opts.worktree) {
        const wt = await import('../code/worktree-session.js');
        const child = await import('node:child_process');
        const gitRunner: import('../code/worktree-session.js').GitRunner = (gitArgs, gitEnv) => {
          const res = child.spawnSync('git', gitArgs, {
            cwd: mainRoot,
            encoding: 'utf8',
            env: { ...process.env, ...(gitEnv ?? {}) },
            timeout: 60_000,
            maxBuffer: 64 * 1024 * 1024,
          });
          return { stdout: (res.stdout ?? '') + (res.stderr ?? ''), exitCode: res.status ?? 1 };
        };
        if (typeof opts.worktree === 'string') {
          const existing = wt
            .listSessionWorktrees(gitRunner, mainRoot)
            .find((w) => w.id === opts.worktree);
          if (!existing) {
            throw new CliError(`no worktree ${opts.worktree} under .vibgrate/worktrees — start one with --worktree`, ExitCode.NOT_FOUND);
          }
          activeWorktree = existing;
        } else {
          const created = wt.createSessionWorktree(
            gitRunner,
            mainRoot,
            `wt${Date.now().toString(36)}`,
          );
          if ('error' in created) throw new CliError(created.error, ExitCode.ERROR);
          activeWorktree = created;
        }
        // Everything downstream (config, map, graph, shell, checkpoints)
        // resolves from the worktree; refs and objects are shared with the
        // main repository by git's own worktree design.
        global.cwd = activeWorktree.path;
      }

      // Auto-provision the optional relevance module: fully silent — installs
      // automatically when absent; on any failure the run proceeds without it
      // (the seam degrades to the built-in lexicon). VIBGRATE_NO_KERNEL=1 or
      // an explicit `vg module` decline skips this entirely; `--local` stays
      // network-free.
      if (!global.local) {
        await ensureRelevanceModule();
      }

      // Project config (.vibgrate/code.json): flags win, then the file, then
      // built-in defaults — so an indie dev sets model/preferences once.
      const config = loadCodeConfig(rootOf(global));
      // Code Mode resolution: --mode / config.modelProfile.mode → pack → Vibgrate manager.
      // Explicit --provider / --model is the custom escape hatch (Ollama, LM Studio, hosted).
      let provider = opts.provider ?? config.provider;
      let model = opts.model ?? config.model;
      const modeFlag = opts.mode ?? config.modelProfile?.mode;
      /** True when this run is a Code Mode (spark|flow|forge) on the Vibgrate manager. */
      let codeModeActive = false;
      /** True when the user (or config) explicitly chose a non-mode provider/model. */
      const customSelection = !!(opts.provider || opts.model || opts.modelPath || config.provider || config.model);
      // Code Mode only when the user did not pick a custom provider/model (flags or config).
      if (!customSelection && (modeFlag || (!provider && !model))) {
        try {
          const { parseMode, resolveMode, readOrchestratorState, activePin } =
            await import('../runtime/model-orchestrator.js');
          const { gatherSystemMemory } = await import('../code/local-runtime.js');
          const { loadGraph } = await import('../engine/load.js');
          const state = readOrchestratorState();
          const mode = parseMode(modeFlag) ?? state.defaultMode ?? undefined;
          const pin = mode ? activePin(mode, state) : null;
          let repo: { fileCount?: number; graphNodeCount?: number } = {};
          try {
            const g = loadGraph(rootOf(global));
            if (g) {
              repo = {
                fileCount: g.nodes.filter((n) => n.kind === 'file').length,
                graphNodeCount: g.nodes.length,
              };
            }
          } catch {
            /* ignore */
          }
          const resolved = resolveMode({
            mode,
            autoFit: !mode,
            system: await gatherSystemMemory(),
            repo,
            pin,
            defaultMode: state.defaultMode,
          });
          if (resolved.fit.label === 'will_not_fit' && !opts.mock) {
            throw new CliError(
              `Code Mode ${resolved.mode} will not fit on this machine (${resolved.fit.reasons[0] ?? 'insufficient memory'}). Try \`vg models install spark\` or free RAM.`,
              ExitCode.ERROR,
            );
          }
          // Code Modes always use the first-party Vibgrate manager (embedded GGUF).
          const { resolveGgufPath } = await import('../runtime/resolve-gguf.js');
          const primaryRef =
            resolved.pack.primary.backend === 'llama.cpp'
              ? resolved.pack.primary.weightsRef
              : resolved.underlying.weightsRef;
          const gguf =
            resolveGgufPath({
              modelRef: primaryRef,
              modelPath: opts.modelPath,
            }) ??
            resolveGgufPath({
              modelRef: resolved.underlying.weightsRef,
              modelPath: opts.modelPath,
            });
          if (!gguf && !opts.mock) {
            throw new CliError(
              `Code Mode ${resolved.mode} uses the Vibgrate model manager — weights not installed. Run \`vg models install ${resolved.mode}\` then retry. (Custom Ollama/LM Studio: pass --provider explicitly.)`,
              ExitCode.NOT_FOUND,
            );
          }
          if (gguf) {
            codeModeActive = true;
            provider = 'llama-cpp';
            model = model ?? gguf.ref ?? primaryRef;
            opts.modelPath = gguf.path;
            if (!global.json && !global.quiet && !opts.streamJson) {
              info(
                `${c.cyan('vg code')} · Code Mode ${c.bold(resolved.mode)} → Vibgrate manager ${c.dim(gguf.path)} ${c.dim(`(${resolved.fit.label})`)}`,
              );
            }
          }
          // Merge pack contract into profile overrides when config did not set budget.
          if (!config.modelProfile?.capsuleBudgetTokens) {
            config.modelProfile = {
              ...config.modelProfile,
              mode: resolved.mode,
              capsuleBudgetTokens: resolved.profile.capsuleBudgetTokens,
              maxRepairRounds: resolved.profile.maxRepairRounds,
              constrainedDecoding: resolved.profile.constrainedDecoding,
              securityTier: resolved.profile.securityTier,
            };
          } else if (!config.modelProfile?.mode) {
            config.modelProfile = { ...config.modelProfile, mode: resolved.mode };
          }
        } catch (e) {
          if (e instanceof CliError) throw e;
          // Orchestrator failure must not block --model / mock paths that already set provider.
          if (!provider && !model && !opts.mock) throw e;
        }
      }
      const auto = opts.auto ?? config.auto;
      // No commander default here on purpose: a hard-coded default would always
      // populate opts.maxSteps and silently shadow `maxSteps` in
      // vibgrate.config.json, so a raised project cap never took effect.
      // Flag → config → the engine's own DEFAULT_MAX_STEPS (undefined).
      const parsedMaxSteps = opts.maxSteps === undefined ? NaN : Number(opts.maxSteps);
      const maxSteps =
        Number.isFinite(parsedMaxSteps) && parsedMaxSteps > 0 ? Math.floor(parsedMaxSteps) : config.maxSteps;
      // --capsule / --no-capsule win over config; absent flag → config (default off).
      const capsule = typeof opts.capsule === 'boolean' ? opts.capsule : !!config.capsule;
      const securityTier = resolveSecurityTierFlag(opts.securityTier, config.securityTier, !!auto);
      const contextBudget = contextBudgetFor(config);
      // --verify (optionally with a command) → verify config; falls back to the config testCommand.
      const verifyCommand = opts.verify === true ? config.testCommand : typeof opts.verify === 'string' ? opts.verify : undefined;
      const verify = verifyCommand ? { command: verifyCommand } : undefined;
      // Adopt the ecosystem-standard MCP config files (.mcp.json, .cursor/mcp.json,
      // .vscode/mcp.json) and merge with our own — ours wins on name conflicts.
      const mcp = discoverMcpServers(rootOf(global), config.mcpServers);

      // No instruction → guided interactive mode (needs a TTY). Piped/CI use
      // must pass an instruction (or --mock), so automation never hangs on a prompt.
      // Exception: a --stream-json --session host may start with no argv task and
      // send the first turn as a `submit` frame (so it can carry mode/attachments).
      const stdinFirstTurn = !instruction && !!opts.streamJson && !!opts.session;
      if (!instruction && !opts.mock && !stdinFirstTurn) {
        if (!(process.stdin.isTTY && process.stdout.isTTY)) {
          throw usageError('say what to change, e.g. `vg code "add a --timeout flag to the scan command"` (guided mode needs an interactive terminal)');
        }
        const { runInteractive } = await import('../code/interactive.js');
        await runInteractive(
          rootOf(global),
          global,
          {
            provider,
            model,
            modelPath: opts.modelPath,
            budget: opts.budget,
            file: opts.file,
            auto,
            maxSteps,
            denyCommands: config.denyCommands,
            testCommand: config.testCommand,
            contextBudget,
            stream: opts.stream,
            verify,
            mcpServers: mcp.servers,
            mcpSources: mcp.sources,
            continueSession: opts.continue,
            capsule,
            securityTier,
            modelProfile: config.modelProfile,
          },
          undefined,
        );
        return;
      }
      if (!instruction && !stdinFirstTurn) throw usageError('say what to change, e.g. `vg code "add a --timeout flag to the scan command"`');

      // Auto-build a missing map (same contract as guided mode / `vg serve`) so
      // host UIs never fail the first turn with "no map found". Under
      // --stream-json, progress is NDJSON on stdout for the progress bar.
      {
        const { ensureCodeMap } = await import('../code/ensure-map.js');
        const mapRoot = rootOf(global);
        try {
          await ensureCodeMap(mapRoot, global, {
            onProgress: (p) => {
              if (opts.streamJson) {
                process.stdout.write(
                  JSON.stringify({
                    event: 'event',
                    type: 'map_build',
                    phase: p.phase,
                    message: p.message,
                    ...(p.pct != null ? { pct: p.pct } : {}),
                  }) + '\n',
                );
                return;
              }
              if (!global.json && !global.quiet && (p.phase === 'start' || p.phase === 'done')) {
                info(c.dim(`vg code · ${p.message}`));
              }
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (opts.streamJson) {
            process.stdout.write(
              JSON.stringify({ event: 'error', message: `Could not build the code map: ${msg}` }) + '\n',
            );
            return;
          }
          throw e;
        }
      }

      const { root, graph } = requireGraph(global);

      let mockReply: string | undefined;
      if (opts.mock) {
        try {
          mockReply = fs.readFileSync(opts.mock, 'utf8');
        } catch {
          throw new CliError(`couldn't read the --mock file: ${opts.mock}`, ExitCode.USAGE_ERROR);
        }
      }

      const route = resolveProviders(
        {
          provider,
          model,
          modelPath: opts.modelPath,
          local: global.local,
          consent: opts.yes || codeModeActive || customSelection,
          mockReply,
          codeMode: codeModeActive,
          preferEmbedded: codeModeActive || undefined,
        },
        {},
      );

      // Ensure installable runtime packages for the chosen manager (silent when
      // Code Mode or user-selected custom backend; never installs desktop apps).
      if (!opts.mock && route.providers[0]) {
        const { ensureManagerRuntime } = await import('../runtime/model-manager.js');
        const ensure = await ensureManagerRuntime({
          providerId: route.providers[0].id,
          model: route.providers[0].model,
          offline: !!global.local,
          // Code Mode / explicit custom selection / --yes count as consent for
          // npm runtime deps (and ollama pull when the binary is already present).
          consent: !!(opts.yes || codeModeActive || customSelection || process.stdin.isTTY),
          onProgress: (line) => {
            if (!global.json && !global.quiet && !opts.streamJson) info(c.dim(`  ${line}`));
          },
        });
        if (!ensure.ok) {
          throw new CliError(ensure.error ?? 'model manager runtime not ready', ExitCode.ERROR);
        }
        if (!global.json && !global.quiet && !opts.streamJson && (ensure.installed.length || ensure.pulled.length)) {
          for (const s of ensure.installed) info(c.dim(`  installed ${s}`));
          for (const s of ensure.pulled) info(c.dim(`  pulled ${s}`));
        }
      }

      // Host UIs (--stream-json) only parse NDJSON on stdout — keep human chatter off.
      if (!global.json && !global.quiet && !opts.streamJson) {
        info(`${c.cyan('vg code')} · ${c.dim(route.reason)}`);
        info(`${c.cyan('vg code')} · manager ${c.bold(route.managerLine)}`);
      }

      // `--stream-json`: the machine protocol for host UIs (the VS Code panel).
      // NDJSON agent events on stdout; approval decisions read as JSON lines on
      // stdin. Governance is preserved — the host answers the same approve gate.
      if (opts.streamJson && !opts.mock) {
        const emitStream = (line: unknown): void => {
          process.stdout.write(JSON.stringify(line) + '\n');
        };
        try {
          const { RunOutcomeRecorder, newOneShotRunId, turnRunId } = await import('../code/run-outcome.js');
          const primarySlug = route.providers[0]?.model.includes('/')
            ? route.providers[0].model.split('/')[0]
            : route.providers[0]?.id;
          const { runCodeStreamJson, parseHostMessage } = await import('../code/stream-json.js');
          const { nodeCodeFs } = await import('../code/session.js');
          const readline = await import('node:readline');
          const child = await import('node:child_process');
          const { loadOrDiscoverFederation } = await import('../runtime/federation.js');
          const { resolveExecutionEnv } = await import('../runtime/execution-env.js');
          const { resolveModelExecutionProfile, mergeModelExecutionProfile } = await import(
            '../runtime/model-execution-profile.js'
          );
          const { startCodeRuntimeSession } = await import('../code/runtime-session.js');
          const { resolveGraphBackend } = await import('../code/graph-backend.js');
          const { detectGitRef } = await import('../runtime/git-ref.js');
          const { repositoryIdFromRoot } = await import('../runtime/paths.js');
          const { vgdRequest } = await import('../runtime/vgd/index.js');
          const federation = loadOrDiscoverFederation(root);
          const modelProfile = mergeModelExecutionProfile(
            resolveModelExecutionProfile({
              providerId: primarySlug,
              model: route.providers[0]?.model,
              budget: Number(opts.budget) || undefined,
              securityTier,
            }),
            config.modelProfile,
          );
          const tier = securityTier ?? modelProfile.securityTier ?? (auto ? 'L1' : 'L0');
          const writableRoots = federation?.members.map((m) => m.root) ?? [root];
          const executionEnv = resolveExecutionEnv(tier, { writableRoots });
          const runtime = await startCodeRuntimeSession({ root });
          const git = detectGitRef(root);
          const repositoryId = repositoryIdFromRoot(root);
          // Local, append-only run-outcome record (docs/VG-RUN-OUTCOME-EVENTS-SPEC.md)
          // — the shared instrumentation the verify loop and Relay's routing
          // telemetry both build on. A silent observer: it never changes what's
          // written to stdout, only what's appended to .vibgrate/run-outcomes.jsonl.
          const runOutcome = new RunOutcomeRecorder(
            root,
            repositoryId,
            git.ref || null,
            { mode: codeModeActive ? modeFlag : undefined, provider: primarySlug, model: route.providers[0]?.model },
            tier,
            !!auto,
          );
          const emitAndRecord = (line: unknown): void => {
            runOutcome.observe(line as Parameters<typeof runOutcome.observe>[0]);
            emitStream(line);
          };
          if (runtime.socketPath && git.ref) {
            try {
              await vgdRequest(
                { op: 'put-graph', repositoryId, gitRef: git.ref, graph },
                { socketPath: runtime.socketPath },
              );
            } catch {
              /* best-effort */
            }
          }
          const graphBackend = resolveGraphBackend({
            graph,
            repositoryId,
            gitRef: git.ref || null,
            socketPath: runtime.socketPath,
          });
          const run = (command: string): { stdout: string; exitCode: number } => {
            const res = child.spawnSync(command, {
              cwd: root,
              shell: true,
              encoding: 'utf8',
              timeout: 120_000,
              maxBuffer: 10 * 1024 * 1024,
            });
            return {
              stdout: (res.stdout ?? '') + (res.stderr ? `\n${res.stderr}` : ''),
              exitCode: res.status ?? 1,
            };
          };
          // Always expose local `vg serve` MCP tools + any project-configured servers.
          const { createVgBuiltinMcpTools, mergeExternalToolsets } = await import('../code/vg-mcp-bridge.js');
          const vgBuiltin = createVgBuiltinMcpTools({
            getGraph: () => graph,
            root,
            local: global.local === true,
          });
          let disposeMcpStream: (() => Promise<void>) | undefined;
          let projectMcp;
          // Filled by bindDecisions so non-readonly project MCP tools use the host approve gate.
          let streamApprove: (a: import('../code/tools.js').MutatingAction) => Promise<boolean> = async () =>
            !!auto;
          if (Object.keys(mcp.servers).length) {
            const { McpToolset, defaultMcpConnect } = await import('../code/mcp-tools.js');
            const { toolset } = await McpToolset.connect(mcp.servers, defaultMcpConnect);
            disposeMcpStream = () => toolset.dispose();
            projectMcp = {
              specs: toolset.specs(),
              owns: (n: string) => toolset.owns(n),
              execute: (call: import('../code/types.js').ToolCall) =>
                toolset.execute(call, (action) => streamApprove(action)),
            };
          }
          const externalTools = mergeExternalToolsets(vgBuiltin, projectMcp);
          // Checkpoints: snapshot the tree when the user approves a change, so
          // it can be undone. Refs live under refs/vibgrate/checkpoints/ and the
          // staging goes through a private index, so the user's own index,
          // branch and HEAD are untouched.
          const { createCheckpoint } = await import('../code/checkpoint.js');
          const os = await import('node:os');
          const pathMod = await import('node:path');
          const checkpointIndex = pathMod.join(
            fs.mkdtempSync(pathMod.join(os.tmpdir(), 'vg-code-cp-')),
            'index',
          );
          const gitRunner = (gitArgs: string[], gitEnv?: Record<string, string>) => {
            const res = child.spawnSync('git', gitArgs, {
              cwd: root,
              encoding: 'utf8',
              env: { ...process.env, ...(gitEnv ?? {}) },
              timeout: 30_000,
              maxBuffer: 32 * 1024 * 1024,
            });
            return { stdout: res.stdout ?? '', exitCode: res.status ?? 1 };
          };
          // Namespaces this run's checkpoint refs. Independent of the session
          // store id: refs are git state, sessions are panel state.
          const checkpointSessionId = `r${Date.now().toString(36)}`;
          let checkpointSeq = 0;
          const takeCheckpoint = (files: string[]) =>
            createCheckpoint(gitRunner, {
              sessionId: checkpointSessionId,
              seq: ++checkpointSeq,
              files,
              indexFile: checkpointIndex,
            });


          const { loadApprovalRules, addApprovalRule, ruleForAction, ruleLabel } = await import('../code/approvals.js');
          const { loadProjectRules, nodeRulesReader } = await import('../code/rules.js');
          const projectRules = loadProjectRules(nodeRulesReader(root));
          if (projectRules.sources.length && !global.quiet) {
            emitStream({
              event: 'event',
              type: 'notice',
              text: `project instructions: ${projectRules.sources.join(', ')}`,
            } as never);
          }
          // Everything above is built once. In session mode it is reused for
          // every turn — that reuse is the point: no cold graph load, no MCP
          // reconnect, no overlay rebuild between messages.
          const baseAgentOptions = {
            graph,
            root,
            providers: route.providers,
            fsImpl: nodeCodeFs(root),
            run,
            // Live command-output events for the VG Code panel (async shell).
            // Sandboxed executionEnv still uses its own runner when set.
            streamShell: !executionEnv,
            allowSubagents: true,
            executionEnv,
            graphBackend,
            modelProfile,
            auto: !!auto,
            // v5: spawn-time reasoning budget. Session mode lets a per-turn
            // value override it; one-shot runs use this.
            reasoningEffort: parseReasoningEffort(opts.reasoningEffort),
            maxSteps,
            budget: modelProfile.capsuleBudgetTokens,
            contextBudget,
            denyCommands: config.denyCommands,
            testCommand: config.testCommand,
            stream: true,
            verify: verify
              ? { command: verify.command, maxRounds: modelProfile.maxRepairRounds }
              : undefined,
            capsule,
            files: opts.file.length ? opts.file : undefined,
            worktreeOverlay: true,
            // Real-model host: compaction writes a model checkpoint summary.
            llmCompaction: true,
            // Full coding agent: free discovery by default. Capsule is context only.
            advancedMode: true,
            externalTools,
            attribution: {
              client: 'vg-code',
              provider: primarySlug,
              model: route.providers[0]?.model,
            },
            now: () => Date.now(),
            projectRules: projectRules.rendered || undefined,
            checkpoint: takeCheckpoint,
            // Standing allow-always rules, re-read per approval so an
            // "Always allow" or a revocation applies to the very next action.
            // Always the MAIN root: consent is per-developer, and a worktree
            // checkout has no code-approvals.json (it is gitignored).
            approvalRules: () => loadApprovalRules(mainRoot),
          };
          try {
            if (opts.session) {
              const { runCodeStreamJsonSession, STREAM_JSON_PROTOCOL_VERSION } = await import(
                '../code/stream-json.js'
              );
              const { runAgent } = await import('../code/agent.js');
              const {
                condenseSession,
                loadLatestSession,
                loadSession,
                newSession,
                recordTask,
                saveSession,
                sessionsDir,
                summarizeSession,
              } = await import('../code/session-store.js');
              const { VERSION } = await import('../version.js');

              // `--continue <id>` resumes that exact chat — no shared `latest`
              // pointer, so two windows on one repo can't race each other.
              // Bare `--continue` keeps the old most-recent behaviour.
              // Sessions persist under the MAIN root even for worktree runs,
              // so History is one list and survives worktree removal.
              const resumedRecord =
                typeof opts.continue === 'string'
                  ? loadSession(mainRoot, opts.continue)
                  : opts.continue
                    ? loadLatestSession(mainRoot)
                    : undefined;
              if (typeof opts.continue === 'string' && !resumedRecord) {
                // Say so instead of silently starting fresh — the host told us
                // which chat it expected to continue.
                emitStream({
                  event: 'event',
                  type: 'notice',
                  text: `Could not load session ${opts.continue} — starting a fresh conversation.`,
                });
              }
              let record =
                resumedRecord ??
                newSession(
                  `s${Date.now().toString(36)}`,
                  primarySlug ?? route.providers[0]?.id ?? 'unknown',
                  route.providers[0]?.model ?? 'unknown',
                  Date.now(),
                );
              // A worktree run stamps its checkout on the record (History's WT
              // badge; resume knows where to re-root).
              if (activeWorktree) record = { ...record, worktree: activeWorktree };

              // One stdin reader for the whole session: approvals and answers go
              // to the live turn, `submit` queues the next one.
              type TurnRequest = import('../code/stream-json.js').TurnRequest;
              const pendingTurns: TurnRequest[] = [];
              let wakeTurn: ((turn: TurnRequest | null) => void) | undefined;
              let ended = false;
              const pushTurn = (turn: TurnRequest | null): void => {
                if (wakeTurn) {
                  const wake = wakeTurn;
                  wakeTurn = undefined;
                  wake(turn);
                } else if (turn !== null) {
                  pendingTurns.push(turn);
                }
              };
              const nextTurn = (): Promise<TurnRequest | null> => {
                if (ended) return Promise.resolve(null);
                const queued = pendingTurns.shift();
                if (queued !== undefined) return Promise.resolve(queued);
                return new Promise<TurnRequest | null>((resolve) => {
                  wakeTurn = resolve;
                });
              };

              let turnIndex = 0;
              // v5: the attachment metadata for the turn currently running, so
              // onTurnEnd can file it with the record. Carried on a variable
              // rather than through the result because attachments are the
              // host's input to the turn, not the agent's output from it.
              let lastTurnAttachments: import('../code/session-store.js').SessionAttachment[] | undefined;
              await runCodeStreamJsonSession({
                emit: emitAndRecord,
                auto: !!auto,
                sessionId: record.id,
                resumed: !!resumedRecord,
                // Environment facts for the host: where sessions live (the
                // single source of truth for history UIs, fixing multi-root
                // ambiguity) and the versions in play for its first-use report.
                sessionInfo: {
                  sessionDir: sessionsDir(mainRoot),
                  engineVersion: VERSION,
                  protocolVersion: STREAM_JSON_PROTOCOL_VERSION,
                  provider: primarySlug,
                  model: route.providers[0]?.model,
                  ...(activeWorktree
                    ? { worktree: { path: activeWorktree.path, base: activeWorktree.base } }
                    : {}),
                },
                instruction,
                nextTurn,
                bindDecisions: (session) => {
                  streamApprove = (action) => session.approve(action);
                  // v3: an approval with `always: true` persists a standing
                  // rule so this action shape skips the card from now on.
                  session.onAlwaysRule = (action) => {
                    const rule = ruleForAction(action);
                    if (!rule) return;
                    const saved = addApprovalRule(mainRoot, rule);
                    emitStream({
                      event: 'event',
                      type: 'notice',
                      text: saved
                        ? `Always-allow rule saved: ${ruleLabel(rule)} (manage in .vibgrate/code-approvals.json)`
                        : 'Could not save the always-allow rule (is .vibgrate writable?) — approved this once.',
                    });
                  };
                  const rl = readline.createInterface({ input: process.stdin });
                  rl.on('line', (raw) => {
                    const msg = parseHostMessage(raw);
                    if (!msg) return;
                    if (msg.kind === 'approve') {
                      session.submitDecision(msg.id, msg.approve, msg.always);
                      runOutcome.noteDecision(msg.id, msg.approve);
                    }
                    else if (msg.kind === 'answer') session.submitAnswer(msg.id, msg.answer);
                    else if (msg.kind === 'submit')
                      pushTurn({ instruction: msg.instruction, agentMode: msg.agentMode, images: msg.images });
                    else if (msg.kind === 'restore') {
                      // Undo an approved change. Scoped to the files that change
                      // touched — never a sweeping restore of the tree.
                      void import('../code/checkpoint.js').then(({ restoreCheckpoint }) => {
                        const outcome = restoreCheckpoint(gitRunner, {
                          commit: msg.commit,
                          files: msg.files,
                        });
                        emitStream({ event: 'checkpoint-restored', commit: msg.commit, ...outcome });
                      });
                    }
                    else if (msg.kind === 'compact') {
                      // Manual `/compact`: condense the stored record now; the
                      // next turn's recap is computed from it (see runTurn).
                      record = condenseSession(record, Date.now());
                      saveSession(mainRoot, record);
                      emitStream({
                        event: 'event',
                        type: 'notice',
                        text: 'Conversation compacted — earlier turns condensed into a checkpoint.',
                      } as never);
                    }
                    else if (msg.kind === 'inject') {
                      // v4 steer: content for the RUNNING turn, applied at its
                      // next step boundary (or the start of the next turn when
                      // the send races the turn's end).
                      session.inject(msg.text);
                    }
                    else if (msg.kind === 'rename') {
                      // v4: title the live chat. Persisted immediately so the
                      // History list reflects it without waiting for turn end.
                      const t = msg.title.slice(0, 120);
                      if (t) record = { ...record, title: t };
                      else { record = { ...record }; delete record.title; }
                      saveSession(mainRoot, record);
                    }
                    else if (msg.kind === 'cancel') { session.cancelTurn(); runOutcome.cancelPending(); }
                    else if (msg.kind === 'end') {
                      ended = true;
                      pushTurn(null);
                    }
                  });
                  // Host went away (panel closed, window reloaded): end cleanly
                  // rather than leaving an orphaned process holding the graph.
                  rl.on('close', () => {
                    ended = true;
                    session.cancelTurn();
                    runOutcome.cancelPending();
                    pushTurn(null);
                  });
                },
                runTurn: ({ instruction: turnInstruction, signal, session, agentMode, auto: turnAuto, images, reasoningEffort: turnEffort, attachments: turnAttachments }) => {
                  lastTurnAttachments = turnAttachments;
                  // Recap always reflects the *current* record, so a manual
                  // `/compact` between turns takes effect on the very next one.
                  const priorSummary = summarizeSession(record) || undefined;
                  turnIndex++;
                  runOutcome.beginRun(turnRunId(record.id, turnIndex), turnInstruction);
                  const plan = agentMode === 'plan';
                  // Project MCP tools go through the same per-turn posture:
                  // plan denies mutating external tools engine-side.
                  streamApprove = plan ? async () => false : (action) => session.approve(action);
                  return runAgent({
                    ...baseAgentOptions,
                    instruction: turnInstruction,
                    // v4 steer: the loop drains injected content at each step.
                    takeInjected: () => session.drainInjected(),
                    priorSummary,
                    // Carry-over for capsule seed ranking: the previous
                    // turn's instruction (the current turn is recorded only
                    // in onTurnEnd, so .at(-1) is the prior ask).
                    priorInstruction: record.tasks.at(-1)?.instruction,
                    signal,
                    auto: turnAuto,
                    plan,
                    images,
                    // v5: per-turn reasoning budget beats the spawn-time flag,
                    // so a host's effort picker takes effect without a respawn.
                    reasoningEffort: turnEffort ?? baseAgentOptions.reasoningEffort,
                    approve: session.approve,
                    askUser: session.askUser,
                    onEvent: session.onEvent,
                  });
                },
                onTurnEnd: (turn) => {
                  // Persist the prompt + final answer for History reload; never
                  // file bodies or tool transcripts. Caps live in recordTask.
                  record = recordTask(
                    record,
                    {
                      instruction: turn.instruction,
                      summary: turn.result?.finalText ?? 'turn failed',
                      changes: turn.result?.changes ?? [],
                      stopped: turn.result?.stopped ?? 'error',
                      // Metadata only — recordTask never stores the bytes.
                      attachments: lastTurnAttachments,
                    },
                    Date.now(),
                  );
                  saveSession(mainRoot, record);
                  return summarizeSession(record);
                },
              });
            } else {
              runOutcome.beginRun(newOneShotRunId(), instruction);
              await runCodeStreamJson({
                ...baseAgentOptions,
                instruction,
                emit: emitAndRecord,
                bindDecisions: (session) => {
                  streamApprove = (action) => session.approve(action);
                  session.onAlwaysRule = (action) => {
                    const rule = ruleForAction(action);
                    if (rule) addApprovalRule(mainRoot, rule);
                  };
                  const rl = readline.createInterface({ input: process.stdin });
                  rl.on('line', (raw) => {
                    const msg = parseHostMessage(raw);
                    if (!msg) return;
                    if (msg.kind === 'approve') {
                      session.submitDecision(msg.id, msg.approve, msg.always);
                      runOutcome.noteDecision(msg.id, msg.approve);
                    }
                    else if (msg.kind === 'answer') session.submitAnswer(msg.id, msg.answer);
                    else if (msg.kind === 'cancel') { session.cancelTurn(); runOutcome.cancelPending(); }
                  });
                  rl.on('close', () => runOutcome.cancelPending());
                },
              });
            }
          } finally {
            await disposeMcpStream?.();
            await runtime.dispose();
          }
        } catch (e) {
          // Always give the host a terminal error frame — human stderr alone leaves the panel blank.
          // Do not rethrow: handleError would print a second copy and exit before hosts drain stdout.
          const message = e instanceof Error ? e.message : String(e);
          emitStream({ event: 'error', message });
          process.exitCode = e instanceof CliError ? e.code : ExitCode.ERROR;
        }
        return;
      }

      // Default one-shot with a real model runs the multi-step AGENT (tool
      // calling). `--single` forces the one-shot planner, and `--mock` always
      // uses the deterministic single-edit path (tests/CI/benchmarks).
      if (!opts.mock && !opts.single) {
        const primarySlug = route.providers[0]?.model.includes('/') ? route.providers[0].model.split('/')[0] : route.providers[0]?.id;
        const autonomous = !!auto;
        const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
        if (!autonomous && !tty) {
          throw usageError('the agent approves each edit/command — run in a terminal to approve interactively, or pass --auto to run autonomously (or --single for a one-shot diff).');
        }
        const { agentTask } = await import('../code/interactive.js');
        const { nodeCodeFs } = await import('../code/session.js');
        const { TtyPrompter } = await import('../code/ui.js');

        // Optional continuity + external MCP tools for one-shot runs too.
        let priorSummary: string | undefined;
        let priorInstruction: string | undefined;
        if (opts.continue) {
          const { loadLatestSession, loadSession, summarizeSession } = await import('../code/session-store.js');
          const prev =
            typeof opts.continue === 'string' ? loadSession(mainRoot, opts.continue) : loadLatestSession(mainRoot);
          if (prev) {
            priorSummary = summarizeSession(prev);
            priorInstruction = prev.tasks.at(-1)?.instruction;
          } else if (typeof opts.continue === 'string') {
            // The caller named an exact chat — say the recap is missing rather
            // than silently running without the context they asked for.
            info(`could not load session ${opts.continue} — continuing without its recap`);
          }
        }
        const prompter = tty ? new TtyPrompter() : undefined;
        const { createVgBuiltinMcpTools, mergeExternalToolsets } = await import('../code/vg-mcp-bridge.js');
        const vgBuiltin = createVgBuiltinMcpTools({
          getGraph: () => graph,
          root,
          local: global.local === true,
        });
        let projectMcp;
        let disposeMcp: (() => Promise<void>) | undefined;
        if (Object.keys(mcp.servers).length) {
          const { McpToolset, defaultMcpConnect } = await import('../code/mcp-tools.js');
          const { toolset } = await McpToolset.connect(mcp.servers, defaultMcpConnect);
          disposeMcp = () => toolset.dispose();
          const approve = async (a: { kind: string }): Promise<boolean> =>
            autonomous || !!(prompter && a.kind === 'tool' && (await prompter.confirm('Call an external tool?', false)));
          projectMcp = {
            specs: toolset.specs(),
            owns: (n: string) => toolset.owns(n),
            execute: (call: import('../code/types.js').ToolCall) => toolset.execute(call, approve as never),
          };
        }
        const mcpTools = mergeExternalToolsets(vgBuiltin, projectMcp);
        try {
          const { loadFederation } = await import('../runtime/federation.js');
          const { resolveExecutionEnv } = await import('../runtime/execution-env.js');
          const { resolveModelExecutionProfile, mergeModelExecutionProfile } = await import('../runtime/model-execution-profile.js');
          const { startCodeRuntimeSession } = await import('../code/runtime-session.js');
          const { resolveGraphBackend } = await import('../code/graph-backend.js');
          const { detectGitRef } = await import('../runtime/git-ref.js');
          const { repositoryIdFromRoot } = await import('../runtime/paths.js');
          const { vgdRequest } = await import('../runtime/vgd/index.js');
          const federation = loadFederation(root);
          const modelProfile = mergeModelExecutionProfile(
            resolveModelExecutionProfile({
              providerId: primarySlug,
              model: route.providers[0]?.model,
              budget: Number(opts.budget) || undefined,
              securityTier,
            }),
            config.modelProfile,
          );
          const tier = securityTier ?? modelProfile.securityTier ?? (autonomous ? 'L1' : 'L0');
          const executionEnv = resolveExecutionEnv(tier, {
            writableRoots: federation?.members.map((m) => m.root) ?? [root],
          });
          const runtime = await startCodeRuntimeSession({ root });
          const git = detectGitRef(root);
          const repositoryId = repositoryIdFromRoot(root);
          if (runtime.socketPath && git.ref) {
            try {
              await vgdRequest(
                { op: 'put-graph', repositoryId, gitRef: git.ref, graph },
                { socketPath: runtime.socketPath },
              );
            } catch {
              /* best-effort */
            }
          }
          const graphBackend = resolveGraphBackend({
            graph,
            repositoryId,
            gitRef: git.ref || null,
            socketPath: runtime.socketPath,
          });
          try {
            const agentResult = await agentTask({
              root,
              graph,
              instruction,
              providers: route.providers,
              fsImpl: nodeCodeFs(root),
              attribution: { client: 'vg-code', provider: primarySlug, model: route.providers[0]?.model },
              auto: autonomous,
              maxSteps,
              budget: modelProfile.capsuleBudgetTokens,
              contextBudget,
              denyCommands: config.denyCommands,
              testCommand: config.testCommand,
              stream: opts.stream,
              verify: verify
                ? { command: verify.command, maxRounds: modelProfile.maxRepairRounds }
                : undefined,
              priorSummary,
              priorInstruction,
              externalTools: mcpTools,
              prompter,
              capsule,
              files: opts.file.length ? opts.file : undefined,
              executionEnv,
              graphBackend,
              modelProfile,
              llmCompaction: true,
            });
            if (global.json) json(agentResult);
            if (agentResult.stopped === 'error') process.exitCode = ExitCode.ERROR;
          } finally {
            await runtime.dispose();
          }
        } finally {
          await disposeMcp?.();
        }
        return;
      }

      // Consent for a write: --yes, or an interactive y/N confirm on a TTY.
      // A requested apply without either degrades to a dry-run (never destructive-by-default).
      let consent = !!opts.yes;
      if (opts.apply && !consent && process.stdin.isTTY && process.stdout.isTTY) {
        consent = await confirm(`Apply the proposed change to ${root}?`);
      }

      const onPhase = (phase: LifecyclePhase, detail: string): void => {
        if (!global.json && !global.quiet) info(c.dim(`  ${phase}: ${detail}`));
      };

      // Attribute the graph-backed call to VG Code + the chosen model for
      // per-model savings auditing (client is fixed `vg-code`).
      const primary = route.providers[0];
      const providerSlug = primary?.model.includes('/') ? primary.model.split('/')[0] : primary?.id;
      const result = await runCodeSession({
        graph,
        root,
        instruction,
        providers: route.providers,
        apply: !!opts.apply,
        consent,
        files: opts.file.length ? opts.file : undefined,
        budget: Number(opts.budget) || 3000,
        capsule,
        onPhase,
        now: () => Date.now(),
        attribution: { client: 'vg-code', provider: providerSlug, model: primary?.model },
      });

      // `--out` writes the machine-readable result to a file (CI/benchmarks),
      // independent of what goes to the terminal.
      if (opts.out) {
        fs.writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
      }
      if (global.json) {
        json(result);
      } else if (!opts.out) {
        renderHuman(result);
      } else if (!global.quiet) {
        info(c.dim(`  wrote result to ${opts.out}`));
      }

      // Exit non-zero when a write was asked for but did not happen or failed to
      // verify — CI and agents branch on this.
      if (opts.apply && (!result.applied || !result.verification.ok)) {
        process.exitCode = ExitCode.GATE_FAILED;
      }
    });
  applyGlobalOptions(cmd);
}

function renderHuman(r: CodeSessionResult): void {
  const applicable = r.changes.filter((c2) => c2.diff !== '');
  if (applicable.length === 0) {
    info(c.yellow('  no change proposed — the model returned no applicable edit'));
    const problems = r.changes.flatMap((c2) => c2.outcomes).filter((o) => o.status !== 'applied' && o.reason);
    for (const p of problems) info(c.dim(`  · ${p.reason}`));
    return;
  }
  for (const change of applicable) {
    out(change.diff);
    out('');
  }
  info(c.dim(`vg code · ${summarizeDiffs(r.changes.map((x) => ({ file: x.file, diff: x.diff })))} · via ${r.provider.id}/${r.provider.model}${r.provider.fellBack ? ' (fell back)' : ''}`));
  // Surface any non-clean outcomes so the caller can fix the SEARCH text.
  for (const change of r.changes) {
    for (const o of change.outcomes) {
      if (o.status !== 'applied' && o.status !== 'no-op' && o.reason) info(c.yellow(`  ! ${change.file}: ${o.reason}`));
    }
  }
  if (r.applied) {
    info(r.verification.ok ? c.green(`  ✔ applied — ${r.verification.detail}`) : c.red(`  ✗ ${r.verification.detail}`));
  } else {
    info(c.dim(`  dry-run — re-run with --apply --yes to write (ref ${r.correlationId})`));
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** CLI flag → config → auto-implies-L1 → L0. Invalid flag values throw usage. */
function resolveSecurityTierFlag(
  flag: string | undefined,
  fromConfig: 'L0' | 'L1' | 'L2' | 'L3' | undefined,
  auto: boolean,
): 'L0' | 'L1' | 'L2' | 'L3' {
  if (flag !== undefined) {
    const t = flag.trim().toUpperCase();
    if (t === 'L0' || t === 'L1' || t === 'L2' || t === 'L3') return t;
    throw usageError(`--security-tier must be L0, L1, L2, or L3 (got ${JSON.stringify(flag)})`);
  }
  if (fromConfig) return fromConfig;
  return auto ? 'L1' : 'L0';
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
