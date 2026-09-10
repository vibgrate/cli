/**
 * Types for agent routing — pointing an AI coding agent through the
 * local compression proxy (Vibgrate AI Context).
 *
 * Everything here is pure data; the proxy lifecycle is injected (see
 * `EnsureProxyFn`, which mirrors `ensureProxyRunning` from
 * `src/proxy/lifecycle.ts`) so the wrap layer is testable without a server.
 */

export type WrapAgent =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'aider'
  | 'copilot'
  | 'opencode'
  | 'cline'
  | 'continue'
  | 'goose'
  | 'openhands'
  | 'vibe'
  | 'kimi'
  | 'grok'
  | 'zcode'
  | 'vscode-claude'
  | 'gemini'
  | 'qwen'
  | 'crush'
  | 'amp'
  | 'droid'
  | 'kiro';

export const WRAP_AGENTS: readonly WrapAgent[] = [
  'claude',
  'codex',
  'cursor',
  'aider',
  'copilot',
  'opencode',
  'cline',
  'continue',
  'goose',
  'openhands',
  'vibe',
  'kimi',
  'grok',
  'zcode',
  'vscode-claude',
  'gemini',
  'qwen',
  'crush',
  'amp',
  'droid',
  'kiro',
];

export function isWrapAgent(x: unknown): x is WrapAgent {
  return typeof x === 'string' && (WRAP_AGENTS as readonly string[]).includes(x);
}

export type WrapMethod = 'env' | 'settings-json' | 'config-toml' | 'config-yaml' | 'config-json' | 'args';

/** A value that was (or was not) present before we edited a config field. */
export interface PrevValue {
  present: boolean;
  value?: unknown;
}

/** Scope for durable (non-session) proxy wiring written by `vg install --proxy`. */
export type DurableScope = 'user' | 'project';

/**
 * Per-process identity used by the owners file. `startTime` is the process
 * start time (from `/proc/<pid>/stat` on Linux) and lets a recycled PID be
 * told apart from the original holder — but only with proof (same source,
 * start times more than a second apart); uncertainty never evicts a holder.
 */
export interface ProcIdentity {
  pid: number;
  startSrc?: 'proc';
  startTime?: number;
}

/** Context threaded through apply/revert so tests can pin pid/time/liveness. */
export interface EditContext {
  agent: WrapAgent;
  /** Parent environment (provider switches such as `CLAUDE_CODE_USE_VERTEX`). */
  env?: NodeJS.ProcessEnv;
  pid?: number;
  port?: number;
  now?: () => number;
  /** vg version stamped into the marker. */
  version?: string;
  isAlive?: (pid: number) => boolean;
  identity?: (pid: number) => ProcIdentity;
  /** Revert even when other live sessions still hold the field (`vg uninstall --force`). */
  force?: boolean;
  /** This apply is durable (`vg install <agent> --compress`): held by no process, released only by `vg uninstall`. */
  durable?: boolean;
  /** This revert is `vg uninstall`: durable holders are released too. */
  releaseDurable?: boolean;
  /** Lock staleness threshold in ms (default 30 000). */
  lockStaleMs?: number;
  /** Lock wait budget in ms (default 5 000). */
  lockTimeoutMs?: number;
}

export type FileChangeStatus = 'applied' | 'updated' | 'unchanged' | 'reverted' | 'skipped' | 'noop';

export type AppliedChange =
  | { kind: 'env'; name: string; value: string }
  | { kind: 'unset'; name: string }
  | { kind: 'args'; args: string[] }
  | {
      kind: 'file';
      agent: WrapAgent;
      file: string;
      method: WrapMethod;
      status: FileChangeStatus;
      backup?: string;
      fields: string[];
      reason?: string;
    };

export interface ApplyResult {
  changed: boolean;
  backup?: string;
  status: FileChangeStatus;
  fields: string[];
}

export interface RevertResult {
  changed: boolean;
  status: FileChangeStatus;
  fields: string[];
  reason?: string;
}

export interface LaunchContext {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface AgentSpec {
  id: WrapAgent;
  /** Human name shown in the banner. */
  name: string;
  /** Candidate executables on PATH, in preference order. Empty = no CLI (watcher mode). */
  binary: string[];
  method: WrapMethod;
  /**
   * Environment the wrapped process receives. `token` is a bearer for agents
   * that need one (Copilot); `ctx` carries the parent env for lane decisions.
   */
  env(url: string, token?: string, ctx?: LaunchContext): Record<string, string>;
  /** Variables removed from the child environment before `env()` is applied. */
  unsetEnv?(url: string, token?: string, ctx?: LaunchContext): string[];
  /** Session config file edited by `wrap()` (and reverted on exit). */
  configFile?(home: string, cwd: string, env?: NodeJS.ProcessEnv): string;
  /** Durable config file edited by `vg install <agent> --compress` / reverted by `vg uninstall`. */
  durableFile?(home: string, cwd: string, scope: DurableScope, env?: NodeJS.ProcessEnv): string;
  apply?(file: string, url: string, ctx?: EditContext): ApplyResult;
  revert?(file: string, ctx?: EditContext): RevertResult;
  /** Args prepended to the user's args (session-local routing, e.g. Codex `--config`). */
  launchArgs?(url: string, args: string[], ctx: LaunchContext): string[];
  /**
   * Environment for the listener when this run has to start compression
   * itself — upstream pins such as `VG_PROXY_OPENAI_API_URL` or
   * `VG_PROXY_PROVIDER`. Settings, not flags: `vg serve` deliberately has no
   * per-provider URL flags (the ~130 `VG_*` knobs are read from the env).
   */
  proxyEnv?(env: NodeJS.ProcessEnv): Record<string, string>;
  /** Setup lines printed for agents whose endpoint is a GUI setting. */
  notes?: string;
  /** Install hint when the binary is missing. */
  install?: string;
  supportsUnwrap: boolean;
  /** `wrap()` edits `configFile` for the session (default true when `apply` exists). */
  sessionEdits?: boolean;
}

/** `ensureProxyRunning` from `src/proxy/lifecycle.ts` (structural copy of §3.3). */
export type EnsureProxyFn = (opts: {
  port?: number;
  host?: string;
  timeoutMs?: number;
  spawnArgs?: string[];
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
}) => Promise<{ url: string; port: number; pid: number; started: boolean; state?: unknown }>;

export interface WrapPlan {
  agent: WrapAgent;
  name: string;
  binary: string | null;
  watcher: boolean;
  proxyUrl: string;
  env: Record<string, string>;
  unset: string[];
  args: string[];
  configFile?: string;
  /** Flags the listener is started with (profile only). */
  proxyArgs: string[];
  /** Upstream pins handed to the listener when this run starts it. */
  proxyEnv: Record<string, string>;
}

export interface WrapStatusRow {
  agent: WrapAgent;
  wrapped: boolean;
  file?: string;
  owner?: string;
  since?: number;
  url?: string;
  stale?: boolean;
}
