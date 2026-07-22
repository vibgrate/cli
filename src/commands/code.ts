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
    .option('--provider <id>', 'backend: ollama, lmstudio, openrouter, litellm, openai, together, llama-cpp')
    .option('--model <id>', 'model id (or set VG_CODE_MODEL). No model is hard-coded — pick the current best.')
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
    .option('--mock <file>', 'use a scripted reply from <file> instead of a model (offline; for tests/CI)')
    .option('-o, --out <file>', 'write the JSON result to <file> (implies --json shape; for CI/benchmarks)')
    .action(async function (
      this: Command,
      instructionParts: string[],
      opts: {
        provider?: string;
        model?: string;
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
        mock?: string;
        out?: string;
      },
    ) {
      const global = readGlobal(this);
      const instruction = (instructionParts ?? []).join(' ').trim();

      // Project config (.vibgrate/code.json): flags win, then the file, then
      // built-in defaults — so an indie dev sets model/preferences once.
      const config = loadCodeConfig(rootOf(global));
      const provider = opts.provider ?? config.provider;
      const model = opts.model ?? config.model;
      const auto = opts.auto ?? config.auto;
      const maxSteps = opts.maxSteps ? Number(opts.maxSteps) : config.maxSteps;
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
          consent: opts.yes,
          mockReply,
        },
        {},
      );

      if (!global.json && !global.quiet) {
        info(`${c.cyan('vg code')} · ${c.dim(route.reason)}`);
      }

      // `--stream-json`: the machine protocol for host UIs (the VS Code panel).
      // NDJSON agent events on stdout; approval decisions read as JSON lines on
      // stdin. Governance is preserved — the host answers the same approve gate.
      if (opts.streamJson && !opts.mock) {
        const primarySlug = route.providers[0]?.model.includes('/') ? route.providers[0].model.split('/')[0] : route.providers[0]?.id;
        const { runCodeStreamJson } = await import('../code/stream-json.js');
        const { nodeCodeFs } = await import('../code/session.js');
        const readline = await import('node:readline');
        const child = await import('node:child_process');
        const run = (command: string): { stdout: string; exitCode: number } => {
          const res = child.spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
          return { stdout: (res.stdout ?? '') + (res.stderr ? `\n${res.stderr}` : ''), exitCode: res.status ?? 1 };
        };
        const emit = (line: unknown): void => {
          process.stdout.write(JSON.stringify(line) + '\n');
        };
        await runCodeStreamJson({
          graph,
          root,
          instruction,
          providers: route.providers,
          fsImpl: nodeCodeFs(root),
          run,
          auto: !!auto,
          maxSteps,
          budget: Number(opts.budget) || undefined,
          contextBudget,
          denyCommands: config.denyCommands,
          testCommand: config.testCommand,
          stream: true,
          verify,
          attribution: { client: 'vg-code', provider: primarySlug, model: route.providers[0]?.model },
          now: () => Date.now(),
          emit,
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
          const agentResult = await agentTask({
            root,
            graph,
            instruction,
            providers: route.providers,
            fsImpl: nodeCodeFs(root),
            attribution: { client: 'vg-code', provider: primarySlug, model: route.providers[0]?.model },
            auto: autonomous,
            maxSteps,
            budget: Number(opts.budget) || undefined,
            contextBudget,
            denyCommands: config.denyCommands,
            testCommand: config.testCommand,
            stream: opts.stream,
            verify,
            priorSummary,
            externalTools: mcpTools,
            prompter,
          });
          if (global.json) json(agentResult);
          if (agentResult.stopped === 'error') process.exitCode = ExitCode.ERROR;
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

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
