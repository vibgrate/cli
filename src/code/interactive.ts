/**
 * The `vg code` guided, interactive mode (VG-CLI-CODE §8–§11).
 *
 * Running bare `vg code` at a terminal enters this flow: show the VG Code
 * banner, make sure the code map is built (behind a spinner, no map banner),
 * walk the developer through choosing a provider + model (local or a top hosted
 * provider), run a memory pre-flight before pulling any local model, then drop
 * into a coding REPL that proposes a diff per instruction and writes only what
 * the developer approves.
 *
 * The decision logic (catalog grouping, wizard tree, capability assessment) is
 * pure and unit-tested elsewhere; this module is the I/O shell that wires those
 * pieces to the terminal, the graph build, and the model runtime.
 */

import { loadGraph } from '../engine/load.js';
import { refreshIfStale } from '../engine/refresh.js';
import { discoverModels } from '../engine/models.js';
import { runBuild } from '../commands/build.js';
import { printCodeLogo } from '../util/logo.js';
import { c, info, out } from '../util/output.js';
import type { GlobalOpts } from '../cli-options.js';
import { fetchCatalog } from './catalog.js';
import { runProviderWizard, type WizardResult } from './wizard.js';
import { TtyPrompter, PromptCancelled, type Prompter } from './ui.js';
import { estimateModelBytes, assessCapability, fmt } from './capability.js';
import { gatherSystemMemory, hasOllama, stopModel, pullModelClean } from './local-runtime.js';
import { spawnSync } from 'node:child_process';
import { resolveProviders } from './router.js';
import { nodeCodeFs, undoChanges } from './session.js';
import { runAgent, type AgentEvent, type AgentOptions, type AgentResult } from './agent.js';
import { readModelSavings } from '../engine/savings.js';
import { SessionMeter } from './cost.js';
import { McpToolset, defaultMcpConnect, type McpConnect } from './mcp-tools.js';
import { loadLatestSession, saveSession, summarizeSession, newSession, recordTask, type StoredSession } from './session-store.js';
import type { McpServerConfig } from './config.js';
import type { MutatingAction, ShellResult } from './tools.js';
import type { FileChange, Provider } from './types.js';
import { GraphProcess } from './graph-process.js';
import { summarizeDiffs } from './diff.js';

export interface InteractiveOptions {
  provider?: string;
  model?: string;
  modelPath?: string;
  budget?: string;
  file?: string[];
  /** Auto-approve edits and commands (autonomous). */
  auto?: boolean;
  /** Cap on agent steps per instruction. */
  maxSteps?: number;
  /** Extra command-denylist rules for autonomous mode (from config). */
  denyCommands?: string[];
  /** Project test/verify command surfaced to the agent (from config). */
  testCommand?: string;
  /** Transcript compaction budget in tokens (from config / model window). */
  contextBudget?: number;
  /** Stream assistant tokens live. */
  stream?: boolean;
  /** Auto-verify: run the test command after the agent finishes and fix failures. */
  verify?: { command: string; maxRounds?: number };
  /** External MCP servers whose tools the agent may call. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Which config files the MCP servers came from (for a transparent note). */
  mcpSources?: string[];
  /** Resume the most recent session (inject a recap, restore /undo). */
  continueSession?: boolean;
  /** Injectable MCP connect (tests). */
  mcpConnect?: McpConnect;
}

/** Entry point for guided `vg code` (no instruction, at a TTY). */
export async function runInteractive(root: string, global: GlobalOpts, opts: InteractiveOptions, prompter: Prompter = new TtyPrompter()): Promise<void> {
  printCodeLogo(root);
  try {
    await ensureMap(root, global, prompter);
    const selection = await chooseModel(root, global, opts, prompter);
    if (!selection) return; // aborted (e.g. can't run a local model)
    await codingRepl(root, global, opts, selection, prompter);
  } catch (e) {
    if (e instanceof PromptCancelled) {
      info(c.dim('\n  cancelled — no changes were made'));
      return;
    }
    throw e;
  }
}

/** Build the code map if missing, or refresh it if the tree drifted — behind a spinner, no map banner. */
async function ensureMap(root: string, global: GlobalOpts, prompter: Prompter): Promise<void> {
  const existing = loadGraph(root, global.graph);
  if (!existing) {
    const sp = prompter.spinner('Building the code map…');
    try {
      // quiet:true suppresses the map's own banner/progress so our UI stays clean.
      await runBuild([root], {}, { ...global, quiet: true });
      sp.stop('Code map built');
    } catch (e) {
      sp.fail(`couldn't build the code map: ${(e as Error).message}`);
      throw e;
    }
    return;
  }
  const sp = prompter.spinner('Checking the code map is up to date…');
  const refreshed = await refreshIfStale(root).catch(() => null);
  if (refreshed?.status === 'refreshed') sp.stop('Code map refreshed');
  else sp.stop('Code map ready');
}

/** Resolve the provider/model — from flags if given, else via the guided wizard. */
async function chooseModel(root: string, global: GlobalOpts, opts: InteractiveOptions, prompter: Prompter): Promise<WizardResult | null> {
  // Explicit flags skip the wizard entirely.
  if (opts.provider && (opts.model || opts.modelPath)) {
    const local = opts.provider === 'ollama' || opts.provider === 'lmstudio' || opts.provider === 'llama-cpp' || !!global.local;
    return { kind: local ? 'local' : 'hosted', provider: opts.provider === 'ollama' ? 'ollama' : 'openrouter', model: opts.model ?? opts.modelPath ?? '', providerSlug: opts.provider, needsPull: false };
  }

  const sp = prompter.spinner('Loading the model catalog…');
  const catalog = await fetchCatalog({ offline: global.local });
  sp.stop(catalog.source === 'network' ? 'Model catalog loaded' : catalog.source === 'cache' ? 'Model catalog (cached)' : 'Model catalog (offline list)');
  const localModels = discoverModels();

  const selection = await runProviderWizard(prompter, { catalog, localModels });

  if (selection.kind === 'local' && selection.needsPull) {
    const ok = await preflightAndPull(selection, prompter);
    if (!ok) return null;
  }
  if (selection.kind === 'hosted' && !process.env.OPENROUTER_API_KEY) {
    prompter.note(c.yellow('Set OPENROUTER_API_KEY in your environment to use this hosted model (keys are never passed as flags).'));
  }
  return selection;
}

/** Memory pre-flight, then a clean, wrapped `ollama pull`. Returns false if we shouldn't proceed. */
async function preflightAndPull(selection: WizardResult, prompter: Prompter): Promise<boolean> {
  if (!hasOllama()) {
    prompter.note(c.yellow('Ollama isn’t installed — get it from https://ollama.com, then re-run. (We never install a runtime for you.)'));
    return false;
  }
  const estimate = estimateModelBytes(selection.model);
  const report = assessCapability(estimate, gatherSystemMemory());

  prompter.note(`${c.bold(selection.model)} — estimated ${fmt(estimate.bytes)}${estimate.guessed ? c.dim(' (size guessed)') : ''}; ~${fmt(report.availableBytes)} free now`);
  for (const s of report.suggestions) prompter.note(c.dim(`· ${s}`));

  if (!report.canRun) {
    prompter.note(c.red('This machine doesn’t have enough memory for that model — not pulling it. Pick a smaller model or a lower quant.'));
    return false;
  }
  if (report.needsUnload) {
    const biggest = [...report.loaded].sort((a, b) => b.bytes - a.bytes)[0];
    if (biggest && (await prompter.confirm(`Unload ${biggest.name} to free ~${fmt(biggest.bytes)}?`, true))) {
      stopModel(biggest.name);
    }
  }
  if (!(await prompter.confirm(`Pull ${selection.model} (~${fmt(estimate.bytes)})?`, true))) return false;

  const sp = prompter.spinner(`Pulling ${selection.model}…`);
  const ok = await pullModelClean(selection.model, sp);
  if (ok) sp.stop(`Pulled ${selection.model}`);
  else sp.fail(`couldn’t pull ${selection.model}`);
  return ok;
}

/** The coding REPL: a graph-grounded agent per task, plus slash-commands (/help, /undo, …). */
async function codingRepl(root: string, global: GlobalOpts, opts: InteractiveOptions, selection: WizardResult, prompter: Prompter): Promise<void> {
  let sel = selection;
  let route = resolveProviders({ provider: sel.provider, model: sel.model, local: sel.kind === 'local' || global.local });
  const fsImpl = nodeCodeFs(root);
  const meter = new SessionMeter();
  let lastChanges: FileChange[] = [];

  // Resume the most recent session (recap for the model + restore /undo).
  let store: StoredSession = newSession(sessionId(), sel.providerSlug, sel.model, Date.now());
  let priorSummary: string | undefined;
  if (opts.continueSession) {
    const prev = loadLatestSession(root);
    if (prev) {
      store = prev;
      lastChanges = prev.lastChanges ?? [];
      priorSummary = summarizeSession(prev);
      prompter.note(c.dim(`resumed session — ${prev.tasks.length} earlier task(s); /undo restores the last change`));
    } else prompter.note(c.dim('no previous session to continue'));
  }

  // Connect external MCP tools (from config), if any.
  let mcp: McpToolset | undefined;
  if (opts.mcpServers && Object.keys(opts.mcpServers).length) {
    const sp = prompter.spinner('Connecting MCP tools…');
    const { toolset, warnings } = await McpToolset.connect(opts.mcpServers, opts.mcpConnect ?? defaultMcpConnect);
    mcp = toolset;
    const from = opts.mcpSources?.length ? ` (from ${opts.mcpSources.join(', ')})` : '';
    sp.stop(`MCP tools: ${toolset.specs().length} from ${Object.keys(opts.mcpServers).length} server(s)${from}`);
    for (const w of warnings) prompter.note(c.yellow(`  ${w}`));
  }

  const graphProc = GraphProcess.start({ root });
  const cleanup = (): void => {
    graphProc?.dispose();
    void mcp?.dispose();
  };
  process.once('SIGINT', cleanup);

  const autoNote = opts.auto ? c.yellow(' · auto-approve ON') : '';
  prompter.intro(`Ready — ${sel.providerSlug}/${sel.model}${graphProc ? c.dim(' · graph ' + graphProc.pid) : ''}${autoNote}. Describe a task, or /help. Empty line to exit.`);

  try {
    for (;;) {
      const line = (await prompter.input('code ›')).trim();
      if (!line || /^(exit|quit)$/i.test(line) || line === '/exit' || line === '/quit') break;

      if (line.startsWith('/')) {
        const [cmd] = line.slice(1).split(/\s+/);
        if (cmd === 'help') {
          prompter.note('commands: /undo /diff /model /cost /clear /exit');
        } else if (cmd === 'undo') {
          if (lastChanges.length === 0) prompter.note(c.dim('nothing to undo'));
          else {
            const restored = undoChanges(lastChanges, fsImpl);
            prompter.note(c.green(`↩ reverted ${restored.length} file(s): ${restored.join(', ')}`));
            lastChanges = [];
            store = { ...store, lastChanges: [] };
            saveSession(root, store);
          }
        } else if (cmd === 'diff') {
          if (lastChanges.length === 0) prompter.note(c.dim('no recent change'));
          else for (const ch of lastChanges) if (ch.diff) out(ch.diff);
        } else if (cmd === 'model') {
          const swapped = await reselectModel(root, global, prompter);
          if (swapped) {
            sel = swapped;
            route = resolveProviders({ provider: sel.provider, model: sel.model, local: sel.kind === 'local' || global.local });
            prompter.note(c.green(`now using ${sel.providerSlug}/${sel.model}`));
          }
        } else if (cmd === 'cost') {
          prompter.note(`this session: ${meter.summary()}`);
          printCost(root);
        } else if (cmd === 'clear') {
          prompter.note(c.dim('each task already starts fresh — nothing to clear'));
        } else {
          prompter.note(c.yellow(`unknown command /${cmd} — try /help`));
        }
        continue;
      }

      const graph = loadGraph(root, global.graph);
      if (!graph) {
        prompter.note(c.red('the code map disappeared — run `vg` to rebuild'));
        break;
      }
      const result = await agentTask({
        root,
        graph,
        instruction: line,
        providers: route.providers,
        fsImpl,
        attribution: { client: 'vg-code', provider: sel.providerSlug, model: sel.model },
        auto: !!opts.auto,
        maxSteps: opts.maxSteps,
        denyCommands: opts.denyCommands,
        testCommand: opts.testCommand,
        contextBudget: opts.contextBudget,
        stream: opts.stream,
        verify: opts.verify,
        priorSummary,
        externalTools: mcp ? mcpExternalTools(mcp, agentApprove(opts, prompter)) : undefined,
        meter,
        prompter,
      });
      priorSummary = undefined; // recap only seeds the first task after --continue
      if (result.changes.length) {
        lastChanges = result.changes;
        prompter.note(c.dim('  /undo to revert · /diff to review'));
      }
      // Persist the session after each task so --continue and /undo survive a restart.
      store = recordTask(store, { instruction: line, summary: result.finalText, changes: result.changes, stopped: result.stopped }, Date.now());
      saveSession(root, store);
    }
  } finally {
    cleanup();
    process.removeListener('SIGINT', cleanup);
  }
  prompter.outro('Done.');
}

/** Approval gate closure for MCP tools (mirrors agentTask's gate). */
function agentApprove(opts: InteractiveOptions, prompter: Prompter): (a: MutatingAction) => Promise<boolean> {
  return async (action) => {
    if (opts.auto) return true;
    if (action.kind === 'tool') return prompter.confirm(`Call ${action.name}?`, false);
    return true;
  };
}

/** Bind an McpToolset to the agent's externalTools shape. */
function mcpExternalTools(mcp: McpToolset, approve: (a: MutatingAction) => Promise<boolean>): AgentOptions['externalTools'] {
  return { specs: mcp.specs(), owns: (name) => mcp.owns(name), execute: (call) => mcp.execute(call, approve) };
}

/** A time-free-ish session id (runtime randomness is fine — not a graph artifact). */
function sessionId(): string {
  let s = '';
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

/** Re-run the provider/model wizard mid-session (the `/model` command). */
async function reselectModel(root: string, global: GlobalOpts, prompter: Prompter): Promise<WizardResult | null> {
  try {
    const sp = prompter.spinner('Loading the model catalog…');
    const catalog = await fetchCatalog({ offline: global.local });
    sp.stop('Model catalog loaded');
    const selection = await runProviderWizard(prompter, { catalog, localModels: discoverModels() });
    if (selection.kind === 'local' && selection.needsPull) {
      const ok = await preflightAndPull(selection, prompter);
      if (!ok) return null;
    }
    return selection;
  } catch (e) {
    if (e instanceof PromptCancelled) return null;
    prompter.note(c.yellow(`couldn't switch model: ${(e as Error).message}`));
    return null;
  }
}

/** Print the local per-model savings for `/cost`. */
function printCost(root: string): void {
  const now = Date.now();
  const models = readModelSavings(root, 30, now);
  if (models.length === 0) {
    info(c.dim('  no usage recorded yet this session'));
    return;
  }
  info(c.bold('  savings by model (last 30 days, local)'));
  for (const m of models) info(`    ${m.key.padEnd(32)} ${m.queries} call(s) · ~${m.vgTokens} tokens · saved ≈ $${m.saved}`);
}

/**
 * Run one agentic task and render it to the terminal. Shared by the guided REPL
 * and the one-shot command. Read-only tools stream as dim status lines; each
 * mutating tool (edit / create / delete / run) is gated — auto-approved under
 * `--auto`, otherwise confirmed by the developer (with the diff or command shown).
 */
export async function agentTask(params: {
  root: string;
  graph: import('../schema.js').VgGraph;
  instruction: string;
  providers: Provider[];
  fsImpl: ReturnType<typeof nodeCodeFs>;
  attribution: { client: string; provider?: string; model?: string };
  auto: boolean;
  maxSteps?: number;
  budget?: number;
  contextBudget?: number;
  denyCommands?: string[];
  testCommand?: string;
  stream?: boolean;
  verify?: { command: string; maxRounds?: number };
  priorSummary?: string;
  externalTools?: AgentOptions['externalTools'];
  meter?: SessionMeter;
  prompter?: Prompter;
}): Promise<AgentResult> {
  const { prompter } = params;
  const approve = async (action: MutatingAction): Promise<boolean> => {
    if (params.auto) return true;
    if (!prompter) return false; // non-interactive without --auto: refuse mutations
    switch (action.kind) {
      case 'edit':
        out(action.diff);
        return prompter.confirm(`Apply edit to ${action.file}?`, true);
      case 'create':
        return prompter.confirm(`Create ${action.file} (${action.bytes} bytes)?`, true);
      case 'delete':
        return prompter.confirm(`Delete ${action.file}?`, false);
      case 'run':
        return prompter.confirm(`Run \`${action.command}\`?`, false);
      case 'tool':
        return prompter.confirm(`Call ${action.name}(${briefArgs(action.args)})?`, false);
    }
  };

  // Event rendering, with live token streaming: raw tokens print inline; any
  // other event first closes the streamed line so the layout stays clean.
  let streaming = false;
  const closeStream = (): void => {
    if (streaming) {
      process.stderr.write('\n');
      streaming = false;
    }
  };
  const onEvent = (e: AgentEvent): void => {
    if (e.type === 'token') {
      process.stderr.write(e.text);
      streaming = true;
      return;
    }
    closeStream();
    if (e.type === 'assistant') {
      if (e.text.trim()) info(e.text.trim());
    } else if (e.type === 'tool-call') {
      info(c.dim(`  → ${e.name}(${briefArgs(e.args)})`));
    } else if (e.type === 'tool-result') {
      info(c.dim(`    ${e.mutated ? c.green('✔ ') : ''}${e.content.split('\n')[0].slice(0, 100)}`));
    } else if (e.type === 'compact') {
      info(c.dim(`  · compacted context (${e.droppedRounds} earlier round(s) summarized)`));
    } else if (e.type === 'verify') {
      info(e.passed ? c.green(`  ✔ ${e.command} passed`) : c.yellow(`  ✗ ${e.command} failed — asking the model to fix it`));
    }
  };

  const result = await runAgent({
    graph: params.graph,
    root: params.root,
    instruction: params.instruction,
    providers: params.providers,
    fsImpl: params.fsImpl,
    run: shellRunner(params.root),
    approve,
    onEvent,
    attribution: params.attribution,
    maxSteps: params.maxSteps,
    budget: params.budget,
    contextBudget: params.contextBudget,
    auto: params.auto,
    denyCommands: params.denyCommands,
    testCommand: params.testCommand,
    stream: params.stream,
    verify: params.verify,
    priorSummary: params.priorSummary,
    externalTools: params.externalTools,
    now: () => Date.now(),
  });
  closeStream();

  const perTask = params.meter?.add(result.usage);
  const summary = summarizeDiffs(result.changes.map((ch) => ({ file: ch.file, diff: ch.diff })));
  info('');
  info(
    result.stopped === 'finished'
      ? c.green(`✔ ${result.finalText}`)
      : result.stopped === 'max-steps'
        ? c.yellow(`stopped at the step limit — ${result.changes.length} change(s) so far`)
        : c.dim(result.finalText),
  );
  const meterNote = perTask !== undefined ? ` · ${params.meter!.summary()}` : '';
  if (result.changes.length || perTask) info(c.dim(`  ${summary} · via ${result.provider.id}/${result.provider.model}${result.provider.fellBack ? ' (fell back)' : ''}${meterNote}`));
  return result;
}

function briefArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}: ${s.length > 40 ? s.slice(0, 40) + '…' : s}`);
    if (parts.length >= 2) break;
  }
  return parts.join(', ');
}

/** A shell runner for the agent's run_command tool, scoped to the repo root. */
function shellRunner(root: string): (command: string) => ShellResult {
  return (command: string) => {
    const res = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    const stdout = (res.stdout ?? '') + (res.stderr ? `\n${res.stderr}` : '');
    return { stdout, exitCode: res.status ?? 1 };
  };
}
