import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { Command } from 'commander';
import { resolveProviders } from '../code/router.js';
import { loadCodeConfig, contextBudgetFor } from '../code/config.js';
import { discoverMcpServers } from '../code/mcp-discovery.js';
import { runCodeSession } from '../code/session.js';
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
    .description('propose a graph-grounded code edit (guided mode with no instruction; dry-run by default)')
    .argument('[instruction...]', 'what to change, in plain language (omit for guided interactive mode)')
    .option('--provider <id>', 'backend: ollama, lmstudio, foundry-local, openrouter, litellm, openai, together, llama-cpp')
    .option('--model <id>', 'model id (or set VG_CODE_MODEL). No model is hard-coded — pick the current best.')
    .option('--mode <mode>', 'Code Mode: spark | flow | forge (preferred over raw model names; auto-fits when omitted and no --model)')
    .option('--model-path <gguf>', 'gguf path for --provider llama-cpp (weights are never auto-downloaded)')
    .option('-f, --file <path>', 'restrict the edit surface to this file (repeatable)', collect, [])
    .option('-b, --budget <n>', 'approx context token budget', '3000')
    .option('--apply', 'write the change (still requires --yes or an interactive confirm)')
    .option('--yes', 'consent to write / to a first-use package install, non-interactively')
    .option('--auto', 'autonomous agent: auto-approve every edit and command (use with care)')
    .option('--max-steps <n>', 'cap the number of agent steps', '24')
    .option('--single', 'one-shot planner (single edit) instead of the multi-step agent')
    .option('--stream', 'stream the model output live')
    .option('--stream-json', 'machine protocol: NDJSON agent events on stdout, approval decisions on stdin (for host UIs like the VS Code panel)')
    .option('--verify [command]', 'after the agent finishes, run tests and make it fix failures (uses the config testCommand if no command is given)')
    .option('--continue', 'resume the most recent session (recap + restore /undo)')
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
        verify?: string | boolean;
        continue?: boolean;
        capsule?: boolean;
        securityTier?: string;
        mock?: string;
        out?: string;
      },
    ) {
      const global = readGlobal(this);
      const instruction = (instructionParts ?? []).join(' ').trim();

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
            system: gatherSystemMemory(),
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
      const maxSteps = opts.maxSteps ? Number(opts.maxSteps) : config.maxSteps;
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
      if (!instruction && !opts.mock) {
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
      if (!instruction) throw usageError('say what to change, e.g. `vg code "add a --timeout flag to the scan command"`');
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
          const primarySlug = route.providers[0]?.model.includes('/')
            ? route.providers[0].model.split('/')[0]
            : route.providers[0]?.id;
          const { runCodeStreamJson } = await import('../code/stream-json.js');
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
          try {
            await runCodeStreamJson({
              graph,
              root,
              instruction,
              providers: route.providers,
              fsImpl: nodeCodeFs(root),
              run,
              executionEnv,
              graphBackend,
              modelProfile,
              auto: !!auto,
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
              advancedMode: !capsule,
              attribution: {
                client: 'vg-code',
                provider: primarySlug,
                model: route.providers[0]?.model,
              },
              now: () => Date.now(),
              emit: emitStream,
              bindDecisions: (session) => {
                const rl = readline.createInterface({ input: process.stdin });
                rl.on('line', (raw) => {
                  try {
                    const msg = JSON.parse(raw) as { approveId?: number; approve?: boolean };
                    if (typeof msg.approveId === 'number') session.submitDecision(msg.approveId, !!msg.approve);
                  } catch {
                    /* ignore malformed host input */
                  }
                });
              },
            });
          } finally {
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
        if (opts.continue) {
          const { loadLatestSession, summarizeSession } = await import('../code/session-store.js');
          const prev = loadLatestSession(root);
          if (prev) priorSummary = summarizeSession(prev);
        }
        const prompter = tty ? new TtyPrompter() : undefined;
        let mcpTools;
        let disposeMcp: (() => Promise<void>) | undefined;
        if (Object.keys(mcp.servers).length) {
          const { McpToolset, defaultMcpConnect } = await import('../code/mcp-tools.js');
          const { toolset } = await McpToolset.connect(mcp.servers, defaultMcpConnect);
          disposeMcp = () => toolset.dispose();
          const approve = async (a: { kind: string }): Promise<boolean> => autonomous || !!(prompter && a.kind === 'tool' && (await prompter.confirm('Call an external tool?', false)));
          mcpTools = { specs: toolset.specs(), owns: (n: string) => toolset.owns(n), execute: (call: import('../code/types.js').ToolCall) => toolset.execute(call, approve as never) };
        }
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
              externalTools: mcpTools,
              prompter,
              capsule,
              files: opts.file.length ? opts.file : undefined,
              executionEnv,
              graphBackend,
              modelProfile,
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
