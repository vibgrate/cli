/**
 * ACP hybrid backend for `vg code` — drive an external Agent Client Protocol
 * agent (Grok Build: `grok agent stdio`) and re-emit its work as ordinary
 * {@link AgentEvent}s, so every host of `vg code --stream-json` (the VS Code
 * panel) keeps its permission cards, activity lines and Changes card unchanged.
 *
 * Wire: JSON-RPC 2.0, one JSON object per line over the child's stdio (ACP v1,
 * agentclientprotocol.com). The flow per session is
 *   initialize → (authenticate, only when the agent demands it) → session/new
 * and per turn
 *   session/prompt  … session/update notifications … → { stopReason }.
 *
 * Governance is preserved across the process boundary, the same as the native
 * loop (GUARDRAILS §5): every `session/request_permission` becomes the host's
 * approve round-trip (plan mode denies engine-side; under autonomy the
 * dangerous-command denylist still screens shell asks), and every
 * `fs/write_text_file` must be covered by an approval for that file or go
 * through the gate itself. Reads and writes are confined to the workspace.
 * The agent signs in by itself; no credential ever passes through here.
 *
 * Transport is injectable (`spawnImpl`) so the protocol mapping is unit-tested
 * against a scripted fake agent without the vendor CLI.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ActivityAggregator, summarizeChanges, type ActivitySnapshot } from './activity-aggregator.js';
import type { AgentEvent, AgentMetrics, AgentResult, AgentStop } from './agent.js';
import { findMatchingRule, ruleLabel, type ApprovalRule } from './approvals.js';
import { unifiedDiff } from './diff.js';
import { redactSecrets } from './providers.js';
import { dangerousCommand, readOnlyCommand } from './safety.js';
import type { CodeFs } from './session.js';
import type { AskUserRequest, MutatingAction } from './tools.js';
import { createTrajectoryCollector, type TrajectoryCollector } from './trajectory.js';
import type { FileChange, ImageAttachment } from './types.js';

/** ACP protocol version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** The Grok Build ACP server command (`--provider grok-build`). */
export const GROK_BUILD_ACP_COMMAND = 'grok agent stdio';
/** Grok Build's vendor steer method (mid-turn user content). */
export const GROK_BUILD_STEER_METHOD = '_x.ai/interject';

/** JSON-RPC error codes this client sends or recognises. */
export const ACP_ERROR = {
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  authRequired: -32000,
  resourceNotFound: -32002,
} as const;

/** stdio MCP server handed to the agent in `session/new` (session-scoped, nothing written to vendor config). */
export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

/** The subset of a child process the client needs (lets tests inject a fake). */
export interface AcpChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type AcpSpawn = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => AcpChild;

export interface AcpSessionOptions {
  /** Command line of the ACP server, e.g. `grok agent stdio`. */
  command: string;
  /** Workspace root: the agent's cwd and the fs/* confinement boundary. */
  cwd: string;
  /** Provider id reported in results (`grok-build`, `acp`). */
  providerId?: string;
  /** Human label for messages, e.g. `Grok Build`. */
  label?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: AcpSpawn;
  /** MCP servers to hand the agent (e.g. the local `vg serve` graph tools). */
  mcpServers?: AcpMcpServer[];
  /** Workspace fs (root-relative). Defaults to the real filesystem under `cwd`. */
  fsImpl?: CodeFs;
  /** Vendor steer method; when absent, mid-turn steers are sent as a follow-up prompt. */
  steerMethod?: string;
  /** How long `initialize` / `session/new` may take before the run fails. Default 60s. */
  startTimeoutMs?: number;
  /** Raw wire log (one call per JSON line, redacted). For `--acp-log`. */
  log?: (direction: 'send' | 'recv' | 'stderr', line: string) => void;
  clientVersion?: string;
}

export interface AcpTurnOptions {
  instruction: string;
  /** Text placed before the instruction in the first content block (graph capsule, recap). */
  preamble?: string;
  images?: ImageAttachment[];
  onEvent?: (e: AgentEvent) => void;
  approve: (action: MutatingAction) => Promise<boolean>;
  askUser?: (req: AskUserRequest) => Promise<string>;
  /** Unattended: the dangerous-command denylist rejects shell asks without a card. */
  auto?: boolean;
  /** Read-only turn: every permission and every write is denied engine-side. */
  plan?: boolean;
  denyCommands?: string[];
  approvalRules?: () => ApprovalRule[];
  checkpoint?: (files: string[]) => { ref: string; commit: string; seq: number } | null;
  signal?: { aborted: boolean };
  takeInjected?: () => string | null;
  wallClock?: () => number;
  /** Hard cap on one turn. Default 30 minutes. */
  turnTimeoutMs?: number;
}

// ── small helpers ─────────────────────────────────────────────────────────────

/** Split a command line into argv with POSIX-style quoting (no expansion). */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      inToken = true;
    } else if (/\s/.test(c)) {
      if (inToken) out.push(cur);
      cur = '';
      inToken = false;
    } else {
      cur += c;
      inToken = true;
    }
  }
  if (inToken) out.push(cur);
  return out;
}

/** Real-filesystem CodeFs rooted at `root` (used when the caller passes none). */
function nodeFs(root: string): CodeFs {
  const abs = (f: string): string => path.resolve(root, f);
  return {
    read: (f) => {
      try {
        return fs.readFileSync(abs(f), 'utf8');
      } catch {
        return null;
      }
    },
    write: (f, c) => {
      fs.mkdirSync(path.dirname(abs(f)), { recursive: true });
      fs.writeFileSync(abs(f), c);
    },
    remove: (f) => {
      fs.rmSync(abs(f), { force: true });
    },
    appendAudit: () => {},
  };
}

/** Workspace-relative path for an ACP (absolute) path; null when it escapes the root. */
export function workspaceRelative(root: string, p: string): string | null {
  if (typeof p !== 'string' || !p) return null;
  const resolved = path.resolve(root, p);
  const rel = path.relative(path.resolve(root), resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

/** Infer an ACP tool kind from a title when the agent omitted it. */
function inferKind(title: string): ToolKind {
  const t = title.toLowerCase();
  if (/^(read|view|open|cat)\b/.test(t)) return 'read';
  if (/\b(grep|search|find|glob|list|ls)\b/.test(t)) return 'search';
  if (/\b(delete|remove|rm)\b/.test(t)) return 'delete';
  if (/\b(edit|write|replace|patch|create|update)\b/.test(t)) return 'edit';
  if (/\b(run|bash|shell|exec|command|terminal)\b/.test(t)) return 'execute';
  if (/\b(fetch|http|url|web)\b/.test(t)) return 'fetch';
  return 'other';
}

/**
 * The VG Code tool name an ACP tool kind maps onto, so activity aggregation,
 * trajectory counters and host icons treat Grok's work like native work.
 */
export function toolNameForKind(kind: ToolKind): string {
  switch (kind) {
    case 'read':
      return 'read_file';
    case 'search':
      return 'search_code';
    case 'edit':
    case 'move':
      return 'edit_file';
    case 'delete':
      return 'delete_file';
    case 'execute':
      return 'run_command';
    case 'fetch':
      return 'web_fetch';
    case 'think':
      return 'think';
    case 'switch_mode':
      return 'set_progress';
    default:
      return 'acp_tool';
  }
}

interface TrackedTool {
  id: string;
  title: string;
  kind: ToolKind;
  name: string;
  rawInput: unknown;
  locations: string[];
  status: string;
  resulted: boolean;
  content: unknown[];
  rawOutput: unknown;
}

/** Text of an ACP content block list / raw output, bounded for a tool-result row. */
function renderToolOutput(content: unknown[], rawOutput: unknown, root: string): string {
  const parts: string[] = [];
  for (const c of content) {
    const item = c as { type?: string; content?: { type?: string; text?: string }; path?: string; terminalId?: string };
    if (item.type === 'content' && item.content?.type === 'text' && item.content.text) parts.push(item.content.text);
    else if (item.type === 'diff' && item.path) parts.push(`(diff) ${workspaceRelative(root, item.path) ?? path.basename(item.path)}`);
    else if (item.type === 'terminal' && item.terminalId) parts.push(`(terminal ${item.terminalId})`);
  }
  if (!parts.length && rawOutput !== undefined && rawOutput !== null) {
    parts.push(typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput));
  }
  const text = parts.join('\n');
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}

/** Shell command line from a permission / tool-call raw input. */
function commandFrom(rawInput: unknown, title: string): string {
  const r = (rawInput ?? {}) as { command?: unknown; cmd?: unknown; args?: unknown };
  const cmd = r.command ?? r.cmd;
  if (Array.isArray(cmd)) return cmd.map(String).join(' ');
  if (typeof cmd === 'string') {
    return Array.isArray(r.args) && r.args.length ? `${cmd} ${r.args.map(String).join(' ')}` : cmd;
  }
  return title.replace(/^(run|execute|bash|shell)\s*:?\s*/i, '').trim() || title;
}

// ── JSON-RPC peer ─────────────────────────────────────────────────────────────

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout };

class AcpRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  closed = false;
  onRequest: (method: string, params: unknown) => Promise<unknown> = async () => {
    throw new AcpRpcError('method not found', ACP_ERROR.methodNotFound);
  };
  onNotification: (method: string, params: unknown) => void = () => {};

  constructor(
    private readonly out: Writable,
    input: Readable,
    private readonly log?: AcpSessionOptions['log'],
  ) {
    const rl = createInterface({ input });
    rl.on('line', (line) => this.receive(line));
  }

  private write(msg: unknown): void {
    if (this.closed) return;
    const line = JSON.stringify(msg);
    this.log?.('send', line);
    try {
      this.out.write(line + '\n');
    } catch {
      /* the child is gone; the exit handler reports it */
    }
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('the agent process has exited'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      if (timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpRpcError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`, ACP_ERROR.internalError));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  failAll(err: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private receive(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    this.log?.('recv', line);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // a stray non-JSON line (agent banner) is ignored
    }
    if (!msg || typeof msg !== 'object') return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === 'string') {
      if (hasId) {
        const id = msg.id as number | string;
        this.onRequest(msg.method, msg.params).then(
          (result) => this.write({ jsonrpc: '2.0', id, result: result ?? null }),
          (e: unknown) => {
            const code = e instanceof AcpRpcError ? e.code : ACP_ERROR.internalError;
            this.write({ jsonrpc: '2.0', id, error: { code, message: redactSecrets((e as Error)?.message ?? String(e)) } });
          },
        );
      } else {
        this.onNotification(msg.method, msg.params);
      }
      return;
    }
    if (hasId) {
      const p = this.pending.get(msg.id as number | string);
      if (!p) return;
      this.pending.delete(msg.id as number | string);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error && typeof msg.error === 'object') {
        const err = msg.error as { code?: number; message?: string };
        p.reject(new AcpRpcError(err.message ?? 'agent error', typeof err.code === 'number' ? err.code : ACP_ERROR.internalError));
      } else {
        p.resolve(msg.result);
      }
    }
  }
}

// ── the session ───────────────────────────────────────────────────────────────

/** Per-turn mutable state, reset by every {@link AcpSession.prompt}. */
interface TurnState {
  opts: AcpTurnOptions;
  emit: (e: AgentEvent) => void;
  /** Emit a live update of the open activity line (step boundaries). */
  flushActivity: () => void;
  activity: ActivityAggregator;
  tools: Map<string, TrackedTool>;
  changes: FileChange[];
  /** Workspace-relative files an approval in this turn already covers. */
  approvedFiles: Set<string>;
  /** path\0newText of diffs already recorded (fs write vs. diff content dedupe). */
  seenDiffs: Set<string>;
  messageBuf: string;
  lastMessage: string;
  allText: string[];
  steps: number;
  /** Tool calls of the current burst (a new burst after they all resolved = a new model step). */
  burst: TrackedTool[];
  inToolBurst: boolean;
  toolCalls: number;
  trajectory: TrajectoryCollector;
  /** Settles every approval still waiting on the host (cancel / turn end). */
  pendingPermissions: Set<() => void>;
  followUps: string[];
}

export class AcpSession {
  private child: AcpChild | null = null;
  private peer: JsonRpcPeer | null = null;
  private sessionId = '';
  private stderrTail = '';
  private exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private closing = false;
  private turn: TurnState | null = null;
  private readonly fsImpl: CodeFs;
  /** Agent capabilities from `initialize` (prompt image support etc.). */
  agentCapabilities: Record<string, unknown> = {};
  agentInfo: { name?: string; version?: string } = {};
  /** Session modes the agent advertised in `session/new` (plan-mode mapping). */
  private modes: { currentModeId?: string; availableModes?: Array<{ id: string; name?: string }> } = {};
  readonly label: string;
  readonly providerId: string;

  constructor(private readonly opts: AcpSessionOptions) {
    this.fsImpl = opts.fsImpl ?? nodeFs(opts.cwd);
    this.label = opts.label ?? 'ACP agent';
    this.providerId = opts.providerId ?? 'acp';
  }

  get id(): string {
    return this.sessionId;
  }

  /** Spawn the agent, negotiate, and open a session. Rejects with an actionable error. */
  async start(): Promise<void> {
    const argv = splitCommandLine(this.opts.command);
    if (!argv.length) throw new Error('the ACP command is empty — pass e.g. --acp-command "grok agent stdio"');
    const spawnImpl: AcpSpawn =
      this.opts.spawnImpl ??
      ((command, args, o) =>
        nodeSpawn(command, args, {
          cwd: o.cwd,
          env: o.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          // Windows resolves `grok.cmd` shims only through the shell.
          shell: process.platform === 'win32',
        }) as unknown as AcpChild);
    const timeout = this.opts.startTimeoutMs ?? 60_000;

    const spawnError = new Promise<never>((_, reject) => {
      try {
        this.child = spawnImpl(argv[0], argv.slice(1), { cwd: this.opts.cwd, env: this.opts.env ?? process.env });
      } catch (e) {
        reject(this.notFound(argv[0], e as Error));
        return;
      }
      this.child.on('error', (e: Error) => {
        reject(this.notFound(argv[0], e));
        this.peer?.failAll(this.notFound(argv[0], e));
      });
    });
    const child = this.child as AcpChild | null;
    if (!child) return spawnError;
    // EPIPE on a dead child's stdin must not crash the CLI; the exit handler reports it.
    child.stdin.on('error', () => {});
    child.stderr?.on('data', (d: Buffer | string) => {
      const s = String(d);
      this.opts.log?.('stderr', s.trimEnd());
      this.stderrTail = (this.stderrTail + s).slice(-4000);
    });
    child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      if (!this.closing) this.peer?.failAll(new Error(this.exitMessage()));
    });
    this.peer = new JsonRpcPeer(child.stdin, child.stdout, this.opts.log);
    this.peer.onRequest = (method, params) => this.handleRequest(method, params);
    this.peer.onNotification = (method, params) => this.handleNotification(method, params);
    // Swallow the spawn-error promise once the handshake settles one way or the other.
    spawnError.catch(() => {});

    const handshake = async (): Promise<void> => {
      const init = (await this.peer!.request(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
          clientInfo: { name: 'vibgrate-vg-code', title: 'VG Code', version: this.opts.clientVersion ?? '0' },
        },
        timeout,
      )) as {
        protocolVersion?: number;
        agentCapabilities?: Record<string, unknown>;
        authMethods?: Array<{ id: string; name?: string; type?: string; args?: string[] }>;
        agentInfo?: { name?: string; version?: string };
      } | null;
      if (!init || typeof init.protocolVersion !== 'number') {
        throw new Error(`${this.label} returned an invalid initialize response — is \`${this.opts.command}\` an ACP server?`);
      }
      this.agentCapabilities = init.agentCapabilities ?? {};
      this.agentInfo = init.agentInfo ?? {};
      const newSession = (): Promise<unknown> =>
        this.peer!.request('session/new', { cwd: this.opts.cwd, mcpServers: this.opts.mcpServers ?? [] }, timeout);
      let created: unknown;
      try {
        created = await newSession();
      } catch (e) {
        if (!(e instanceof AcpRpcError) || e.code !== ACP_ERROR.authRequired) throw e;
        // The agent wants a sign-in. Only an in-band (`agent`) method can be
        // completed here; a terminal login is the user's to run.
        const methods = init.authMethods ?? [];
        const inBand = methods.find((m) => !m.type || m.type === 'agent');
        if (!inBand) {
          const terminal = methods.find((m) => m.type === 'terminal');
          throw new Error(
            `${this.label} is not signed in. Run ${terminal?.args?.length ? `\`${terminal.args.join(' ')}\`` : 'its login command (for Grok Build: `grok login`)'} in a terminal, then retry.`,
          );
        }
        await this.peer!.request('authenticate', { methodId: inBand.id }, timeout);
        created = await newSession();
      }
      const modes = (created as { modes?: unknown } | null)?.modes;
      if (modes && typeof modes === 'object') this.modes = modes as typeof this.modes;
      const sid = (created as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sid !== 'string' || !sid) throw new Error(`${this.label} did not return a session id from session/new`);
      this.sessionId = sid;
    };
    await Promise.race([handshake(), spawnError]);
  }

  private notFound(bin: string, e: Error): Error {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return new Error(
        `\`${bin}\` was not found on PATH. Install ${this.label} (Grok Build: \`npm install -g @xai-official/grok\`, then \`grok login\`), or point --acp-command at the ACP server.`,
      );
    }
    return new Error(`could not start \`${this.opts.command}\`: ${redactSecrets(e.message)}`);
  }

  private exitMessage(): string {
    const tail = redactSecrets(this.stderrTail.trim().split('\n').slice(-3).join('\n'));
    const how = this.exited?.signal ? `signal ${this.exited.signal}` : `code ${this.exited?.code ?? 'unknown'}`;
    return `${this.label} exited unexpectedly (${how}).${tail ? `\n${tail}` : ''}`;
  }

  /** Run one prompt turn; resolves when the agent answers `session/prompt`. */
  async prompt(turnOpts: AcpTurnOptions): Promise<AgentResult> {
    if (!this.peer || !this.sessionId) throw new Error('ACP session is not started');
    if (this.turn) throw new Error('an ACP turn is already running');
    const wallClock = turnOpts.wallClock ?? Date.now;
    const wallStart = wallClock();
    const sink = turnOpts.onEvent ?? (() => {});
    const activity = new ActivityAggregator();
    const emitActivity = (snap: ActivitySnapshot | null): void => {
      if (snap) sink({ type: 'activity', ...snap });
    };
    const emit = (e: AgentEvent): void => {
      if (e.type === 'assistant' && e.text.trim()) emitActivity(activity.seal());
      activity.observe(e);
      sink(e);
    };
    const turn: TurnState = {
      opts: turnOpts,
      emit,
      flushActivity: () => emitActivity(activity.flush()),
      activity,
      tools: new Map(),
      changes: [],
      approvedFiles: new Set(),
      seenDiffs: new Set(),
      messageBuf: '',
      lastMessage: '',
      allText: [],
      steps: 0,
      burst: [],
      inToolBurst: false,
      toolCalls: 0,
      trajectory: createTrajectoryCollector(),
      pendingPermissions: new Set(),
      followUps: [],
    };
    this.turn = turn;

    let stopped: AgentStop = 'finished';
    let errorText = '';
    // Plan mode: our gate denies every permission and every fs write, but an
    // agent that writes on its own bypasses fs/*. So also switch the agent into
    // its own read-only mode when it has one, and say so in the prompt.
    const restoreMode = turnOpts.plan ? await this.enterPlanMode() : null;
    const poll = setInterval(() => {
      if (turnOpts.signal?.aborted && this.turn === turn) {
        this.peer?.notify('session/cancel', { sessionId: this.sessionId });
        for (const settle of [...turn.pendingPermissions]) settle();
        turn.pendingPermissions.clear();
      }
      const steer = this.turn === turn ? turnOpts.takeInjected?.() : null;
      if (steer) this.steer(turn, steer);
    }, 100);

    try {
      const task = turnOpts.plan
        ? `[Plan mode — read-only. Do not modify files or run commands that change state. Investigate, then present a step-by-step plan.]\n${turnOpts.instruction}`
        : turnOpts.instruction;
      let text = turnOpts.preamble ? `${turnOpts.preamble}\n\n${task}` : task;
      let first = true;
      // A follow-up (queued steer) re-enters the loop as another prompt on the
      // same session, so the agent factors it in before the turn ends.
      for (;;) {
        this.newStep(turn);
        const blocks: unknown[] = [{ type: 'text', text }];
        const promptCaps = (this.agentCapabilities.promptCapabilities ?? {}) as { image?: boolean };
        if (first && turnOpts.images?.length) {
          if (promptCaps.image) {
            for (const img of turnOpts.images) blocks.push({ type: 'image', data: img.dataBase64, mimeType: img.mediaType });
          } else {
            emit({ type: 'notice', text: `${this.label} does not accept images — attached image(s) are referenced by name only.` });
          }
        }
        first = false;
        const res = (await this.peer.request(
          'session/prompt',
          { sessionId: this.sessionId, prompt: blocks },
          turnOpts.turnTimeoutMs ?? 30 * 60_000,
        )) as { stopReason?: string } | null;
        this.flushMessage(turn);
        const reason = res?.stopReason ?? 'end_turn';
        stopped =
          reason === 'cancelled' || turnOpts.signal?.aborted
            ? 'cancelled'
            : reason === 'max_tokens' || reason === 'max_turn_requests'
              ? 'max-steps'
              : reason === 'refusal'
                ? 'error'
                : 'finished';
        if (reason === 'refusal') errorText = `${this.label} declined the request.`;
        const next = stopped === 'finished' ? turn.followUps.shift() ?? turnOpts.takeInjected?.() ?? null : null;
        if (!next) break;
        turn.emit({ type: 'injected', text: next });
        text = `[The user sent this while you were working — factor it in before finishing:]\n${next}`;
      }
    } catch (e) {
      this.flushMessage(turn);
      stopped = turnOpts.signal?.aborted ? 'cancelled' : 'error';
      errorText = redactSecrets((e as Error).message);
      if (stopped === 'error') emit({ type: 'assistant', text: `error: ${errorText}` });
    } finally {
      clearInterval(poll);
      for (const settle of [...turn.pendingPermissions]) settle();
      turn.pendingPermissions.clear();
      this.turn = null;
      if (restoreMode) await restoreMode();
    }

    // Terminal frames in the native order: last activity line, Changes card, metrics.
    emitActivity(activity.seal());
    if (turn.changes.length) {
      const card = summarizeChanges(turn.changes);
      if (card.files.length) sink({ type: 'changes-summary', ...card });
    }
    const finalText =
      stopped === 'cancelled'
        ? 'stopped at your request'
        : stopped === 'error'
          ? errorText || `${this.label} failed`
          : turn.lastMessage || turn.allText.join('\n\n').trim() ||
            (turn.changes.length ? `Edited ${[...new Set(turn.changes.map((c) => c.file))].join(', ')}.` : 'done');
    const traj = turn.trajectory.finalize({
      taskId: turnOpts.instruction.slice(0, 48),
      arm: turnOpts.preamble ? 'capsule' : 'metadata',
      solved: stopped === 'finished',
      verified: stopped === 'finished',
      steps: turn.steps,
      stopped,
      inferenceTurns: turn.steps,
      filesChanged: new Set(turn.changes.map((c) => c.file)).size,
      usedCapsule: !!turnOpts.preamble,
      elapsedMs: Math.max(0, wallClock() - wallStart),
      provider: { id: this.providerId, model: this.agentModel() },
    });
    const metrics: AgentMetrics = {
      discoveryToolCalls: traj.discoveryToolCalls,
      mutationToolCalls: traj.mutationToolCalls,
      shellCommands: traj.shellCommands,
      znsAt1: traj.znsAt1,
      usedCapsule: !!turnOpts.preamble,
      failureCapsuleBuilt: false,
      trajectory: traj,
      steps: turn.steps,
      stopReason: stopped,
      wallMs: Math.max(0, wallClock() - wallStart),
      toolCalls: turn.toolCalls,
      changes: turn.changes.length,
      activityGroups: activity.groups,
    };
    sink({ type: 'metrics', metrics });
    return {
      finalText,
      changes: turn.changes,
      steps: turn.steps,
      stopped,
      provider: { id: this.providerId, model: this.agentModel(), fellBack: false },
      usage: { promptTokens: 0, completionTokens: 0 },
      metrics,
      failureCapsule: null,
      capsuleSummary: null,
    };
  }

  /** Switch to the agent's plan / read-only mode if advertised; returns the restore step. */
  private async enterPlanMode(): Promise<(() => Promise<void>) | null> {
    const available = this.modes.availableModes ?? [];
    const planMode = available.find((m) => /plan|read[-_ ]?only|\bask\b/i.test(`${m.id} ${m.name ?? ''}`));
    const previous = this.modes.currentModeId;
    if (!planMode || !this.peer || planMode.id === previous) return null;
    try {
      await this.peer.request('session/set_mode', { sessionId: this.sessionId, modeId: planMode.id }, 15_000);
    } catch {
      return null; // the prompt prefix and the engine-side gate still hold
    }
    return async () => {
      if (!previous || !this.peer || this.peer.closed) return;
      try {
        await this.peer.request('session/set_mode', { sessionId: this.sessionId, modeId: previous }, 15_000);
      } catch {
        /* best effort */
      }
    };
  }

  /** `name@version` the agent reported in `initialize` (the provider id before start). */
  get model(): string {
    return this.agentModel();
  }

  private agentModel(): string {
    const v = this.agentInfo.version ? `@${this.agentInfo.version}` : '';
    return `${this.agentInfo.name ?? this.providerId}${v}`;
  }

  /** Steer the running turn: vendor method when available, else a queued follow-up prompt. */
  private steer(turn: TurnState, text: string): void {
    const method = this.opts.steerMethod;
    if (!method || !this.peer) {
      turn.followUps.push(text);
      return;
    }
    turn.emit({ type: 'injected', text });
    this.peer.request(method, { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, 30_000).catch(() => {
      // Not accepted mid-turn: deliver it as a follow-up prompt instead of dropping it.
      turn.followUps.push(text);
    });
  }

  /** Close the session and stop the agent process. */
  async close(): Promise<void> {
    this.closing = true;
    this.peer?.failAll(new Error('session closed'));
    const child = this.child;
    if (!child || this.exited) return;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* gone */
        }
        resolve();
      }, 2_000);
      child.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  // ── updates ────────────────────────────────────────────────────────────────

  private newStep(turn: TurnState): void {
    turn.flushActivity();
    turn.steps++;
    turn.emit({ type: 'step', n: turn.steps });
  }

  /** Emit the buffered agent message as one `assistant` event. */
  private flushMessage(turn: TurnState): void {
    const text = turn.messageBuf.trim();
    turn.messageBuf = '';
    if (!text) return;
    turn.lastMessage = text;
    turn.allText.push(text);
    turn.emit({ type: 'assistant', text });
  }

  private handleNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as { sessionId?: unknown; update?: unknown };
    const isUpdate = method === 'session/update' || /session_notification$/.test(method);
    if (!isUpdate || !p.update || typeof p.update !== 'object') return;
    if (typeof p.sessionId === 'string' && p.sessionId !== this.sessionId) return;
    const turn = this.turn;
    if (!turn) return;
    this.onUpdate(turn, p.update as Record<string, unknown>);
  }

  private onUpdate(turn: TurnState, u: Record<string, unknown>): void {
    const kind = String(u.sessionUpdate ?? '');
    switch (kind) {
      case 'agent_message_chunk': {
        const c = u.content as { type?: string; text?: string } | undefined;
        if (c?.type === 'text' && typeof c.text === 'string') {
          // Prose after a tool burst starts a new model step (native parity).
          if (turn.inToolBurst) {
            turn.inToolBurst = false;
            this.newStep(turn);
          }
          turn.messageBuf += c.text;
          turn.emit({ type: 'token', text: c.text });
        }
        return;
      }
      case 'agent_thought_chunk': {
        const c = u.content as { type?: string; text?: string } | undefined;
        if (c?.type === 'text' && c.text) turn.emit({ type: 'thinking', text: c.text });
        return;
      }
      case 'tool_call':
        this.onToolCall(turn, u);
        return;
      case 'tool_call_update':
        this.onToolUpdate(turn, u);
        return;
      case 'plan': {
        const entries = Array.isArray(u.entries) ? (u.entries as Array<{ content?: string; status?: string }>) : [];
        turn.emit({
          type: 'progress',
          items: entries.map((e, i) => ({
            id: String(i + 1),
            title: String(e.content ?? ''),
            status: e.status === 'completed' ? 'done' : e.status === 'in_progress' ? 'in_progress' : 'pending',
          })),
        });
        return;
      }
      case 'notice': {
        const title = String(u.title ?? '');
        const desc = typeof u.description === 'string' ? ` — ${u.description}` : '';
        if (title) turn.emit({ type: 'notice', text: `${this.label}: ${title}${desc}` });
        return;
      }
      default:
        return; // usage_update, available_commands_update, mode updates: not part of the transcript
    }
  }

  private onToolCall(turn: TurnState, u: Record<string, unknown>): void {
    const id = String(u.toolCallId ?? '');
    if (!id) return;
    this.flushMessage(turn);
    // A tool call after the previous burst fully resolved is the model's next
    // step (it saw those results); calls racing an open burst are parallel.
    if (turn.inToolBurst && turn.burst.length && turn.burst.every((t) => t.resulted)) {
      this.newStep(turn);
      turn.burst = [];
    }
    if (!turn.inToolBurst) turn.burst = [];
    turn.inToolBurst = true;
    const title = String(u.title ?? '');
    const kind = (typeof u.kind === 'string' ? u.kind : inferKind(title)) as ToolKind;
    const name = toolNameForKind(kind);
    const locations = Array.isArray(u.locations)
      ? (u.locations as Array<{ path?: string }>).map((l) => l.path).filter((p): p is string => typeof p === 'string')
      : [];
    const tool: TrackedTool = {
      id,
      title,
      kind,
      name,
      rawInput: u.rawInput,
      locations,
      status: String(u.status ?? 'pending'),
      resulted: false,
      content: Array.isArray(u.content) ? (u.content as unknown[]) : [],
      rawOutput: u.rawOutput,
    };
    turn.tools.set(id, tool);
    turn.burst.push(tool);
    if (name !== 'think') turn.toolCalls++;
    const args: Record<string, unknown> = { title };
    if (u.rawInput && typeof u.rawInput === 'object' && !Array.isArray(u.rawInput)) Object.assign(args, u.rawInput as object);
    const rel = locations.map((l) => workspaceRelative(this.opts.cwd, l) ?? l);
    if (rel.length) args.locations = rel;
    turn.emit({ type: 'tool-call', name, args });
    this.maybeResult(turn, tool);
  }

  private onToolUpdate(turn: TurnState, u: Record<string, unknown>): void {
    const id = String(u.toolCallId ?? '');
    let tool = turn.tools.get(id);
    if (!tool) {
      // An update for a call we never saw (agent skipped `tool_call`): adopt it.
      this.onToolCall(turn, { ...u, status: u.status ?? 'in_progress' });
      tool = turn.tools.get(id);
      if (!tool) return;
    }
    if (typeof u.title === 'string') tool.title = u.title;
    if (typeof u.kind === 'string') tool.kind = u.kind as ToolKind;
    if (u.rawInput !== undefined) tool.rawInput = u.rawInput;
    if (u.rawOutput !== undefined) tool.rawOutput = u.rawOutput;
    if (Array.isArray(u.locations)) {
      tool.locations = (u.locations as Array<{ path?: string }>).map((l) => l.path).filter((p): p is string => typeof p === 'string');
    }
    if (Array.isArray(u.content)) tool.content = u.content as unknown[];
    if (typeof u.status === 'string') tool.status = u.status;
    this.maybeResult(turn, tool);
  }

  private maybeResult(turn: TurnState, tool: TrackedTool): void {
    if (tool.resulted || (tool.status !== 'completed' && tool.status !== 'failed')) return;
    tool.resulted = true;
    // A diff on a pending call is a PROPOSAL (it rides the permission card);
    // only a completed call's diff is an applied change.
    if (tool.status === 'completed') this.recordDiffs(turn, tool.content);
    if (tool.name === 'think') return;
    const failed = tool.status === 'failed';
    const mutated = !failed && ['edit_file', 'delete_file', 'run_command'].includes(tool.name);
    turn.trajectory.recordTool(tool.name, turn.steps, mutated);
    turn.emit({
      type: 'tool-result',
      name: tool.name,
      content: redactSecrets(renderToolOutput(tool.content, tool.rawOutput, this.opts.cwd)) || (failed ? 'failed' : 'done'),
      mutated,
      ...(failed ? { failed: true } : {}),
    });
  }

  /** Diff content on a tool call → `change` events (unless an fs write already recorded it). */
  private recordDiffs(turn: TurnState, content: unknown[]): void {
    for (const c of content) {
      const d = c as { type?: string; path?: string; oldText?: string | null; newText?: string };
      if (d.type !== 'diff' || typeof d.path !== 'string' || typeof d.newText !== 'string') continue;
      const rel = workspaceRelative(this.opts.cwd, d.path);
      if (!rel) continue;
      this.recordChange(turn, rel, d.oldText ?? null, d.newText);
    }
  }

  private recordChange(turn: TurnState, rel: string, before: string | null, after: string | null): void {
    const key = `${rel}\0${after ?? '\u0000deleted'}`;
    if (turn.seenDiffs.has(key) || before === after) return;
    turn.seenDiffs.add(key);
    const change: FileChange = { file: rel, before, after, outcomes: [], diff: unifiedDiff(before, after, rel) };
    turn.changes.push(change);
    turn.emit({ type: 'change', change });
  }

  // ── client-side requests (agent → us) ──────────────────────────────────────

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'session/request_permission':
        return this.onPermission(p);
      case 'fs/read_text_file':
        return this.onRead(p);
      case 'fs/write_text_file':
        return this.onWrite(p);
      case 'x.ai/ask_user_question':
      case '_x.ai/ask_user_question':
        return this.onAskUser(p);
      default:
        throw new AcpRpcError(`${method} is not supported by this client`, ACP_ERROR.methodNotFound);
    }
  }

  private async onAskUser(p: Record<string, unknown>): Promise<unknown> {
    const turn = this.turn;
    const question = typeof p.question === 'string' ? p.question : 'The agent has a question.';
    const options = Array.isArray(p.options)
      ? p.options.map((o) => (typeof o === 'string' ? o : String((o as { label?: unknown })?.label ?? (o as { value?: unknown })?.value ?? o)))
      : undefined;
    if (!turn?.opts.askUser) return { answer: 'No human is available. Proceed with the safest defaults and state your assumptions.' };
    const answer = await turn.opts.askUser({ question, options });
    return { answer };
  }

  /** Map an ACP permission request onto the VG Code approval gate. */
  private async onPermission(p: Record<string, unknown>): Promise<unknown> {
    const turn = this.turn;
    const options = Array.isArray(p.options) ? (p.options as Array<{ optionId: string; kind?: string }>) : [];
    const pick = (approve: boolean): unknown => {
      const want = approve ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
      for (const k of want) {
        const o = options.find((x) => x.kind === k);
        if (o) return { outcome: { outcome: 'selected', optionId: o.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    };
    if (!turn) return pick(false);
    const tc = (p.toolCall ?? {}) as Record<string, unknown>;
    const known = turn.tools.get(String(tc.toolCallId ?? ''));
    const title = String(tc.title ?? known?.title ?? '');
    const kind = (typeof tc.kind === 'string' ? tc.kind : known?.kind ?? inferKind(title)) as ToolKind;
    const content = Array.isArray(tc.content) ? (tc.content as unknown[]) : known?.content ?? [];
    const rawInput = tc.rawInput ?? known?.rawInput;
    const locations = Array.isArray(tc.locations)
      ? (tc.locations as Array<{ path?: string }>).map((l) => l.path).filter((x): x is string => typeof x === 'string')
      : known?.locations ?? [];
    const action = this.permissionAction(kind, title, content, rawInput, locations);

    if (turn.opts.plan) {
      turn.emit({ type: 'notice', text: `Plan mode: declined ${this.label}'s request to ${title || kind} (read-only turn).` });
      return pick(false);
    }
    const files = action.kind === 'edit' || action.kind === 'create' || action.kind === 'delete' ? [action.file] : [];
    for (const l of locations) {
      const rel = workspaceRelative(this.opts.cwd, l);
      if (rel && (kind === 'edit' || kind === 'delete' || kind === 'move') && !files.includes(rel)) files.push(rel);
    }
    const approved = await this.gate(turn, action, files);
    if (approved) for (const f of files) turn.approvedFiles.add(f);
    return pick(approved);
  }

  /** Native-parity approval: denylist under autonomy, read-only shortcut, standing rules, then the host. */
  private async gate(turn: TurnState, action: MutatingAction, files: string[]): Promise<boolean> {
    if (turn.opts.plan) return false;
    if (action.kind === 'run' && dangerousCommand(action.command, turn.opts.denyCommands)) {
      if (turn.opts.auto) {
        turn.emit({ type: 'notice', text: `Blocked in autonomous mode: \`${action.command}\` matches the dangerous-command denylist.` });
        return false;
      }
    } else if (action.kind === 'run' && readOnlyCommand(action.command)) {
      return true;
    } else {
      const rules = turn.opts.approvalRules?.();
      const rule = rules?.length ? findMatchingRule(action, rules) : null;
      if (rule) {
        turn.emit({ type: 'notice', text: `Auto-approved by standing rule: ${ruleLabel(rule)}` });
        this.checkpoint(turn, files);
        return true;
      }
    }
    // Cancel (or the turn ending) settles a card the host never answered as a denial.
    const approved = await new Promise<boolean>((resolve) => {
      const cancel = (): void => resolve(false);
      turn.pendingPermissions.add(cancel);
      turn.opts.approve(action).then(
        (v) => {
          turn.pendingPermissions.delete(cancel);
          resolve(v);
        },
        () => {
          turn.pendingPermissions.delete(cancel);
          resolve(false);
        },
      );
    });
    if (approved) this.checkpoint(turn, files);
    return approved;
  }

  private checkpoint(turn: TurnState, files: string[]): void {
    if (!files.length || !turn.opts.checkpoint) return;
    try {
      const cp = turn.opts.checkpoint(files);
      if (cp) turn.emit({ type: 'checkpoint', ...cp, files });
    } catch {
      /* a checkpoint never blocks an approved change */
    }
  }

  private permissionAction(kind: ToolKind, title: string, content: unknown[], rawInput: unknown, locations: string[]): MutatingAction {
    if (kind === 'execute') return { kind: 'run', command: commandFrom(rawInput, title) };
    if (kind === 'edit' || kind === 'delete' || kind === 'move') {
      const diff = content.find((c) => (c as { type?: string }).type === 'diff') as
        | { path: string; oldText?: string | null; newText: string }
        | undefined;
      const target = diff?.path ?? locations[0] ?? (rawInput as { path?: string; file_path?: string } | undefined)?.path ?? (rawInput as { file_path?: string } | undefined)?.file_path;
      const rel = target ? workspaceRelative(this.opts.cwd, target) ?? target : title;
      if (kind === 'delete') return { kind: 'delete', file: rel };
      if (diff) {
        const before = diff.oldText ?? (target ? this.fsImpl.read(rel) : null);
        if (before === null || before === undefined) {
          return { kind: 'create', file: rel, bytes: Buffer.byteLength(diff.newText ?? '') };
        }
        return { kind: 'edit', file: rel, diff: unifiedDiff(before, diff.newText, rel) };
      }
      return { kind: 'edit', file: rel, diff: '' };
    }
    const args = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {};
    return { kind: 'tool', name: title || kind, args };
  }

  private onRead(p: Record<string, unknown>): unknown {
    const rel = workspaceRelative(this.opts.cwd, String(p.path ?? ''));
    if (!rel) throw new AcpRpcError('path is outside the workspace', ACP_ERROR.invalidParams);
    const content = this.fsImpl.read(rel);
    if (content === null) throw new AcpRpcError(`file not found: ${rel}`, ACP_ERROR.resourceNotFound);
    const line = typeof p.line === 'number' && p.line > 0 ? p.line : null;
    const limit = typeof p.limit === 'number' && p.limit > 0 ? p.limit : null;
    if (line === null && limit === null) return { content };
    const lines = content.split('\n');
    const start = (line ?? 1) - 1;
    return { content: lines.slice(start, limit === null ? undefined : start + limit).join('\n') };
  }

  /** Writes are gated: covered by an approval for this file this turn, or approved here. */
  private async onWrite(p: Record<string, unknown>): Promise<unknown> {
    const turn = this.turn;
    const rel = workspaceRelative(this.opts.cwd, String(p.path ?? ''));
    if (!rel) throw new AcpRpcError('path is outside the workspace', ACP_ERROR.invalidParams);
    if (typeof p.content !== 'string') throw new AcpRpcError('content must be a string', ACP_ERROR.invalidParams);
    if (!turn) throw new AcpRpcError('no turn is running', ACP_ERROR.internalError);
    if (turn.opts.plan) throw new AcpRpcError('plan mode is read-only — present the plan instead of writing', ACP_ERROR.internalError);
    const before = this.fsImpl.read(rel);
    if (!turn.approvedFiles.has(rel)) {
      const action: MutatingAction =
        before === null
          ? { kind: 'create', file: rel, bytes: Buffer.byteLength(p.content) }
          : { kind: 'edit', file: rel, diff: unifiedDiff(before, p.content, rel) };
      if (!(await this.gate(turn, action, [rel]))) {
        throw new AcpRpcError(`the user declined the write to ${rel}`, ACP_ERROR.internalError);
      }
      turn.approvedFiles.add(rel);
    }
    this.fsImpl.write(rel, p.content);
    this.recordChange(turn, rel, before, p.content);
    return null;
  }
}

/** One-shot convenience: start, run one turn, close. */
export async function runAcpSession(opts: AcpSessionOptions & AcpTurnOptions): Promise<AgentResult> {
  const session = new AcpSession(opts);
  try {
    await session.start();
    return await session.prompt(opts);
  } finally {
    await session.close();
  }
}
