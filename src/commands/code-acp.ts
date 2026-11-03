/**
 * `vg code --provider grok-build` / `vg code --acp-command "<cmd>"` — run the
 * turn on an external ACP agent (Grok Build by default) instead of the native
 * VG Code loop, while keeping everything a host already relies on:
 *
 *  - `--stream-json` (one-shot and `--session`) emits the same NDJSON frames as
 *    the native loop: permission round-trips, `activity` lines, the
 *    `changes-summary` card, `metrics`, `done` / `idle`.
 *  - Approvals keep the native posture: plan mode denies engine-side, standing
 *    allow-always rules apply, the dangerous-command denylist screens shell
 *    asks under `--auto`, and approved edits are checkpointed for undo.
 *  - The graph reaches the agent two ways, both optional: the local `vg serve`
 *    tools as a session-scoped MCP server (`--no-acp-mcp` to skip), and a
 *    capsule summary prepended to the first prompt (`--inject-capsule`).
 *
 * The agent authenticates itself (e.g. `grok login`); no credential passes
 * through this process.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import type { VgGraph } from '../schema.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, json } from '../util/output.js';
import { AcpSession, GROK_BUILD_ACP_COMMAND, GROK_BUILD_STEER_METHOD, splitCommandLine, type AcpMcpServer } from '../code/acp-client.js';
import { acpWireLogger, ProfileRecorder, profilingEnabled, type ProfileSwitches } from '../code/profile.js';
import type { AgentResult } from '../code/agent.js';
import type { TurnRequest, StreamJsonOut } from '../code/stream-json.js';
import type { MutatingAction } from '../code/tools.js';

/** Which external agent a run targets. */
export interface AcpTarget {
  command: string;
  providerId: string;
  label: string;
  steerMethod?: string;
}

/**
 * Resolve the ACP target from flags: `--provider grok-build` is the
 * convenience alias for `--acp-command "grok agent stdio"`; an explicit
 * `--acp-command` wins over the alias's default command. Null → native loop.
 */
export function resolveAcpTarget(opts: { provider?: string; acpCommand?: string }): AcpTarget | null {
  const grok = opts.provider === 'grok-build' || opts.provider === 'grok';
  if (!grok && !opts.acpCommand) return null;
  const command = opts.acpCommand?.trim() || GROK_BUILD_ACP_COMMAND;
  if (grok) return { command, providerId: 'grok-build', label: 'Grok Build', steerMethod: GROK_BUILD_STEER_METHOD };
  const bin = path.basename(splitCommandLine(command)[0] ?? 'acp');
  const isGrokBinary = /^grok(\.cmd|\.exe)?$/i.test(bin);
  return isGrokBinary
    ? { command, providerId: 'grok-build', label: 'Grok Build', steerMethod: GROK_BUILD_STEER_METHOD }
    : { command, providerId: 'acp', label: `${bin} (ACP)` };
}

export interface RunCodeAcpParams {
  target: AcpTarget;
  /** The run's root (a worktree checkout when --worktree is set). */
  root: string;
  /** The main repository root (sessions, approval rules). */
  mainRoot: string;
  graph: VgGraph;
  instruction: string;
  streamJson: boolean;
  session: boolean;
  auto: boolean;
  continueSession?: boolean | string;
  files: string[];
  budget: number;
  injectCapsule: boolean;
  acpMcp: boolean;
  denyCommands?: string[];
  json: boolean;
  quiet: boolean;
  profile: ProfileSwitches;
  engineVersion: string;
  worktree?: { path: string; base: string };
}

/** The local graph tools, offered to the agent as a stdio MCP server for this session only. */
export function vgServeMcpServer(): AcpMcpServer | null {
  const entry = process.argv[1];
  if (!entry) return null;
  return {
    name: 'vibgrate',
    command: process.execPath,
    // execArgv carries a dev loader (tsx) when running from source.
    args: [...process.execArgv, entry, 'serve', '--client', 'vg-code-acp'],
    env: [],
  };
}

/** First-turn graph capsule: the deterministic, budget-bounded context block. */
async function capsulePreamble(graph: VgGraph, instruction: string, budget: number, files: string[]): Promise<string | undefined> {
  try {
    const { buildCodeContext } = await import('../code/context.js');
    const ctx = buildCodeContext(graph, instruction, { budget, files: files.length ? files : undefined });
    if (!ctx.rendered.trim()) return undefined;
    return [
      'Repository context from the Vibgrate code graph (deterministic map of this repo; verify against the files before relying on it):',
      ctx.rendered,
      '---',
    ].join('\n');
  } catch {
    return undefined; // the capsule is advisory — never block the turn on it
  }
}

/** Git-backed checkpoints for undo (same refs + private index as the native loop). */
async function makeCheckpointer(root: string): Promise<(files: string[]) => { ref: string; commit: string; seq: number } | null> {
  const { createCheckpoint } = await import('../code/checkpoint.js');
  const indexFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vg-code-cp-')), 'index');
  const git = (gitArgs: string[], gitEnv?: Record<string, string>) => {
    const res = spawnSync('git', gitArgs, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...(gitEnv ?? {}) },
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout: res.stdout ?? '', exitCode: res.status ?? 1 };
  };
  const sessionId = `a${Date.now().toString(36)}`;
  let seq = 0;
  return (files) => createCheckpoint(git, { sessionId, seq: ++seq, files, indexFile });
}

export async function runCodeAcp(p: RunCodeAcpParams): Promise<void> {
  const { target } = p;
  const { loadApprovalRules, addApprovalRule, ruleForAction, ruleLabel } = await import('../code/approvals.js');
  const { nodeCodeFs } = await import('../code/session.js');
  const mcpServers: AcpMcpServer[] = [];
  if (p.acpMcp) {
    const vg = vgServeMcpServer();
    if (vg) mcpServers.push(vg);
  }
  const acp = new AcpSession({
    command: target.command,
    cwd: p.root,
    providerId: target.providerId,
    label: target.label,
    steerMethod: target.steerMethod,
    mcpServers,
    fsImpl: nodeCodeFs(p.root),
    clientVersion: p.engineVersion,
    log: p.profile.acpLog ? acpWireLogger(p.profile.acpLog) : undefined,
  });
  const checkpoint = await makeCheckpointer(p.root);
  const approvalRules = () => loadApprovalRules(p.mainRoot);
  const profiler = profilingEnabled(p.profile)
    ? new ProfileRecorder(p.profile, { backend: target.providerId, provider: target.providerId, model: target.label })
    : null;

  // ── stream-json: the host protocol ────────────────────────────────────────
  if (p.streamJson) {
    const write = (line: unknown): void => {
      process.stdout.write(JSON.stringify(line) + '\n');
    };
    const emit = (line: StreamJsonOut): void => {
      profiler?.observe(line as unknown as Record<string, unknown>);
      write(line);
    };
    const { StreamJsonSession, runCodeStreamJsonSession, parseHostMessage, STREAM_JSON_PROTOCOL_VERSION } = await import(
      '../code/stream-json.js'
    );
    try {
      await acp.start();
      profiler?.setModel(acp.model);
    } catch (e) {
      write({ event: 'error', message: (e as Error).message });
      process.exitCode = ExitCode.ERROR;
      await acp.close();
      return;
    }
    const persistAlways = (action: MutatingAction): void => {
      const rule = ruleForAction(action);
      if (!rule) return;
      const saved = addApprovalRule(p.mainRoot, rule);
      write({
        event: 'event',
        type: 'notice',
        text: saved
          ? `Always-allow rule saved: ${ruleLabel(rule)} (manage in .vibgrate/code-approvals.json)`
          : 'Could not save the always-allow rule (is .vibgrate writable?) — approved this once.',
      });
    };

    try {
      if (!p.session) {
        // One-shot: one turn, then `done` / `error`.
        const session = new StreamJsonSession(emit, p.auto);
        session.onAlwaysRule = persistAlways;
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', (raw) => {
          const msg = parseHostMessage(raw);
          if (!msg) return;
          if (msg.kind === 'approve') session.submitDecision(msg.id, msg.approve, msg.always);
          else if (msg.kind === 'answer') session.submitAnswer(msg.id, msg.answer);
          else if (msg.kind === 'inject') session.inject(msg.text);
          else if (msg.kind === 'cancel') session.cancelTurn();
        });
        const signal = session.beginTurn();
        profiler?.beginTurn(p.instruction);
        try {
          const result = await acp.prompt({
            instruction: p.instruction,
            preamble: p.injectCapsule ? await capsulePreamble(p.graph, p.instruction, p.budget, p.files) : undefined,
            onEvent: session.onEvent,
            approve: session.approve,
            askUser: session.askUser,
            auto: p.auto,
            denyCommands: p.denyCommands,
            approvalRules,
            checkpoint,
            signal,
            takeInjected: () => session.drainInjected(),
          });
          emit({ event: 'done', result });
          if (result.stopped === 'error') process.exitCode = ExitCode.ERROR;
        } catch (e) {
          emit({ event: 'error', message: (e as Error).message });
          process.exitCode = ExitCode.ERROR;
        } finally {
          session.cancelPending();
          profiler?.endTurn();
          rl.close();
        }
        return;
      }

      // Session mode: the agent process stays warm across turns.
      const store = await import('../code/session-store.js');
      const resumed =
        typeof p.continueSession === 'string'
          ? store.loadSession(p.mainRoot, p.continueSession)
          : p.continueSession
            ? store.loadLatestSession(p.mainRoot)
            : undefined;
      if (typeof p.continueSession === 'string' && !resumed) {
        write({ event: 'event', type: 'notice', text: `Could not load session ${p.continueSession} — starting a fresh conversation.` });
      }
      let record = resumed ?? store.newSession(`s${Date.now().toString(36)}`, target.providerId, acp.model, Date.now());
      if (p.worktree) record = { ...record, worktree: p.worktree as never };
      const queue: TurnRequest[] = [];
      let wake: ((t: TurnRequest | null) => void) | undefined;
      let ended = false;
      const push = (t: TurnRequest | null): void => {
        if (wake) {
          const w = wake;
          wake = undefined;
          w(t);
        } else if (t) queue.push(t);
      };
      let turnNo = 0;
      let lastAttachments: TurnRequest['attachments'];
      let sessionReader: readline.Interface | undefined;
      await runCodeStreamJsonSession({
        emit,
        auto: p.auto,
        sessionId: record.id,
        resumed: !!resumed,
        sessionInfo: {
          sessionDir: store.sessionsDir(p.mainRoot),
          engineVersion: p.engineVersion,
          protocolVersion: STREAM_JSON_PROTOCOL_VERSION,
          provider: target.providerId,
          // The agent's own name@version from `initialize` (e.g. grok@1.0.52).
          model: acp.model,
          ...(p.worktree ? { worktree: p.worktree } : {}),
        },
        instruction: p.instruction || undefined,
        nextTurn: () => {
          if (ended) return Promise.resolve(null);
          const q = queue.shift();
          if (q) return Promise.resolve(q);
          return new Promise((resolve) => {
            wake = resolve;
          });
        },
        bindDecisions: (session) => {
          session.onAlwaysRule = persistAlways;
          const rl = readline.createInterface({ input: process.stdin });
          sessionReader = rl;
          rl.on('line', (raw) => {
            const msg = parseHostMessage(raw);
            if (!msg) return;
            if (msg.kind === 'approve') session.submitDecision(msg.id, msg.approve, msg.always);
            else if (msg.kind === 'answer') session.submitAnswer(msg.id, msg.answer);
            else if (msg.kind === 'submit') {
              push({
                instruction: msg.instruction,
                agentMode: msg.agentMode,
                images: msg.images,
                reasoningEffort: msg.reasoningEffort,
                attachments: msg.attachments,
              });
            } else if (msg.kind === 'inject') session.inject(msg.text);
            else if (msg.kind === 'cancel') session.cancelTurn();
            else if (msg.kind === 'restore') {
              void import('../code/checkpoint.js').then(({ restoreCheckpoint }) => {
                const git = (gitArgs: string[], gitEnv?: Record<string, string>) => {
                  const res = spawnSync('git', gitArgs, { cwd: p.root, encoding: 'utf8', env: { ...process.env, ...(gitEnv ?? {}) } });
                  return { stdout: res.stdout ?? '', exitCode: res.status ?? 1 };
                };
                const outcome = restoreCheckpoint(git, { commit: msg.commit, files: msg.files });
                write({ event: 'checkpoint-restored', commit: msg.commit, ...outcome });
              });
            } else if (msg.kind === 'rename') {
              const t = msg.title.slice(0, 120);
              if (t) record = { ...record, title: t };
              else {
                record = { ...record };
                delete record.title;
              }
              store.saveSession(p.mainRoot, record);
            } else if (msg.kind === 'compact') {
              write({ event: 'event', type: 'notice', text: `${target.label} manages its own context — nothing to compact here.` });
            } else if (msg.kind === 'end') {
              ended = true;
              push(null);
            }
          });
          rl.on('close', () => {
            ended = true;
            session.cancelTurn();
            push(null);
          });
        },
        runTurn: async ({ instruction, signal, session, agentMode, auto, images, attachments }) => {
          turnNo++;
          lastAttachments = attachments;
          profiler?.beginTurn(instruction);
          // First turn: the graph capsule and, on resume, the stored recap.
          const parts: string[] = [];
          if (turnNo === 1) {
            if (resumed) {
              const recap = store.summarizeSession(record);
              if (recap) parts.push(recap);
            }
            if (p.injectCapsule) {
              const cap = await capsulePreamble(p.graph, instruction, p.budget, p.files);
              if (cap) parts.push(cap);
            }
          }
          return acp.prompt({
            instruction,
            preamble: parts.length ? parts.join('\n\n') : undefined,
            images,
            onEvent: session.onEvent,
            approve: session.approve,
            askUser: session.askUser,
            auto,
            plan: agentMode === 'plan',
            denyCommands: p.denyCommands,
            approvalRules,
            checkpoint,
            signal,
            takeInjected: () => session.drainInjected(),
          });
        },
        onTurnEnd: (turn) => {
          profiler?.endTurn();
          record = store.recordTask(
            record,
            {
              instruction: turn.instruction,
              summary: turn.result?.finalText ?? 'turn failed',
              changes: turn.result?.changes ?? [],
              stopped: turn.result?.stopped ?? 'error',
              attachments: lastAttachments,
            },
            Date.now(),
          );
          store.saveSession(p.mainRoot, record);
          // The agent keeps its own conversation; no recap is re-sent per turn.
          return undefined;
        },
      });
      // `end` (or the host closing stdin) finished the session: release stdin
      // so the process exits instead of waiting for the host to kill it.
      sessionReader?.close();
      process.stdin.destroy();
    } finally {
      await acp.close();
    }
    return;
  }

  // ── terminal: interactive approvals, or --auto ─────────────────────────────
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!p.auto && !tty) {
    throw new CliError(
      `${target.label} asks before each edit/command — run in a terminal to approve interactively, or pass --auto to run autonomously (or --stream-json for a host UI).`,
      ExitCode.USAGE_ERROR,
    );
  }
  const { ttyApprover, ttyEventRenderer } = await import('../code/interactive.js');
  const { TtyPrompter } = await import('../code/ui.js');
  const prompter = tty ? new TtyPrompter() : undefined;
  const approve = ttyApprover(p.auto, prompter);
  const { onEvent: render, closeStream } = ttyEventRenderer();
  if (!p.json && !p.quiet) info(`${c.cyan('vg code')} · ${target.label} via ACP (${c.dim(target.command)})`);
  try {
    await acp.start();
    profiler?.setModel(acp.model);
  } catch (e) {
    await acp.close();
    throw new CliError((e as Error).message, ExitCode.ERROR);
  }
  let result: AgentResult;
  profiler?.beginTurn(p.instruction);
  try {
    result = await acp.prompt({
      instruction: p.instruction,
      preamble: p.injectCapsule ? await capsulePreamble(p.graph, p.instruction, p.budget, p.files) : undefined,
      onEvent: (e) => {
        profiler?.observe({ event: 'event', ...e });
        if (!p.json) render(e);
      },
      approve,
      askUser: prompter
        ? async (q) => prompter.input(`${q.question}${q.options?.length ? ` (${q.options.join(' / ')})` : ''}`)
        : undefined,
      auto: p.auto,
      denyCommands: p.denyCommands,
      approvalRules,
      checkpoint,
    });
  } finally {
    closeStream();
    await acp.close();
  }
  profiler?.observe({ event: 'done', result });
  profiler?.endTurn();
  if (p.json) json(result);
  else if (!p.quiet && result.finalText && result.finalText !== '') info(`\n${result.finalText}`);
  if (result.stopped === 'error') process.exitCode = ExitCode.ERROR;
}
