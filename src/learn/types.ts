/**
 * Session-failure learning — shared types.
 *
 * Scanners normalise every agent's transcript format into `Session`s made of
 * `Turn`s; `detectLoops`, `analyze` and `learnVerbosity` consume that shape
 * and never look at raw files. Plain data only.
 */

export type AgentId = 'claude' | 'codex' | 'gemini' | 'grok' | 'opencode' | 'cursor' | 'copilot' | 'aider';

export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'gemini', 'grok', 'opencode', 'cursor', 'copilot', 'aider'];

export function isAgentId(x: unknown): x is AgentId {
  return typeof x === 'string' && (AGENT_IDS as readonly string[]).includes(x);
}

export type ErrorCategory =
  | 'file_not_found'
  | 'module_not_found'
  | 'command_not_found'
  | 'permission_denied'
  | 'file_too_large'
  | 'is_directory'
  | 'syntax_error'
  | 'runtime_error'
  | 'timeout'
  | 'no_matches'
  | 'user_rejected'
  | 'sibling_error'
  | 'exit_code'
  | 'connection_error'
  | 'build_failure'
  | 'unknown';

export interface ToolCall {
  /** Normalised tool name (`Bash`, `Read`, `Grep`, `Glob`, `Edit`, `Write`, …). */
  name: string;
  id: string;
  input: Record<string, unknown>;
  /** Result content (may be the error message). */
  output: string;
  isError: boolean;
  errorCategory: ErrorCategory;
  /** Bytes of output (UTF-8). */
  outputBytes: number;
}

export type TurnKind = 'tool_call' | 'user' | 'assistant' | 'interruption' | 'agent_summary';

export interface Turn {
  /** Position in the transcript (monotonic within a session). */
  index: number;
  kind: TurnKind;
  /** Milliseconds since the epoch when known. */
  ts?: number;
  /** User / assistant text (already truncated by the scanner). */
  text?: string;
  toolCall?: ToolCall;
  /** Assistant-only: word count of the visible text. */
  words?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Assistant-only: the turn carried tool calls. */
  hasToolUse?: boolean;
  /** agent_summary only. */
  agent?: { id: string; toolCalls: number; tokens: number; durationMs: number; prompt: string };
}

export type SessionSource = 'main' | 'subagent' | 'workflow';

export interface Session {
  id: string;
  agent: AgentId | string;
  /** Absolute project root when the transcript records one. */
  project?: string;
  startedAt: number;
  endedAt: number;
  turns: Turn[];
  /** Transcript file (or directory) the session was read from. */
  path: string;
  source?: SessionSource;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ScanOptions {
  sinceMs?: number;
  /** Restrict to sessions whose project equals (or is inside) this root. */
  project?: string;
  now: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface Scanner {
  agent: AgentId;
  /** Directories the scanner reads (existing or not) — for doctor/diagnostics. */
  sessionsDir(env?: NodeJS.ProcessEnv, home?: string): string[];
  scan(opts: ScanOptions): Session[];
}

export type LoopKind = 'error-loop' | 'refetch-loop' | 'edit-cycle' | 'same-error';

export interface Loop {
  kind: LoopKind;
  tool: string;
  /** Canonical, variant-collapsed signature (`tool::normalised input`). */
  signature: string;
  sample: string;
  count: number;
  /** Measured lower bound on wasted tokens (bytes / 4). */
  wastedTokens: number;
  /** Turn indices of every occurrence, ascending. */
  indices: number[];
  /** Sessions the loop was seen in (ids), ascending. */
  sessions: string[];
}

export type RuleTarget = 'context' | 'memory';

export interface Rule {
  target: RuleTarget;
  section: string;
  /** Markdown, 1–3 bullet lines. */
  content: string;
  confidence: number;
  evidenceCount: number;
  estimatedTokensSaved: number;
  isLoopGuardrail: boolean;
  loopOccurrences: number;
}

export interface FailingCommand {
  command: string;
  count: number;
  category: ErrorCategory;
  sample: string;
}

export interface Recovery {
  tool: string;
  failed: string;
  success: string;
  category: ErrorCategory;
  count: number;
}

export interface VerbosityStats {
  responses: number;
  medianWords: number;
  meanWords: number;
  bulletsRatio: number;
  codeRatio: number;
  longOutputRate: number;
  interruptRate: number;
  fastSkipRate: number;
}

export interface Digest {
  sessions: number;
  toolCalls: number;
  failures: number;
  failureRate: number;
  tokensIn: number;
  tokensOut: number;
  loops: Loop[];
  failingCommands: FailingCommand[];
  missingPaths: Array<{ path: string; count: number }>;
  recoveries: Recovery[];
  corrections: Array<{ text: string; count: number }>;
  verbosity: VerbosityStats;
  rules: Rule[];
  /** `heuristic` or the analyzer CLI that produced `rules`. */
  analyzer: string;
}

export interface VerbosityProfile {
  projectPath: string | null;
  /** 1 (lightest) .. 4. */
  verbosityLevel: number;
  /** `VG_OUTPUT_VERBOSITY_LEVEL` value. */
  suggested: 'L1' | 'L2' | 'L3' | 'L4';
  confidence: 'low' | 'medium' | 'high';
  source: 'heuristic';
  rationale: string;
  signals: VerbosityStats & { sessions: number; humanTurns: number; interrupts: number };
  learnedAt: number | null;
}
