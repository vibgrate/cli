/**
 * The VG Code agentic loop (VG-CLI-CODE §12).
 *
 * This is what makes `vg code` a coding *agent* rather than a one-shot proposer:
 * the model is given the tool set (search the graph, read, list, impact, edit,
 * create, delete, run a command) and iterates — call tools, read the results,
 * call more tools — until it calls `finish` (or a step cap is hit). Mutating
 * tools pass through the injected approval gate, so the same governance holds
 * whether you approve each step interactively or run autonomously with `--auto`.
 *
 * For real multi-step sessions it also: writes an append-only, secret-free
 * **audit record** at the end of every run (governance parity with the
 * single-shot path); **compacts the transcript** so a long session stays under
 * the context-rot threshold that is the whole reason the graph exists; and
 * **guards against no-progress loops** so a model that repeats a failing call
 * stops cleanly instead of burning to the step cap.
 *
 * The model is the only non-deterministic seam (behind the provider list, with
 * fallback). Everything else — the loop, tool execution, gating, compaction,
 * guard, audit — is deterministic and unit-tested with a scripted provider.
 */

import { buildCodeContext } from './context.js';
import { buildAgentMessages } from './prompt.js';
import { AGENT_TOOLS, executeTool, type MutatingAction, type ShellResult, type ToolContext, type ToolResult } from './tools.js';
import { recordCliCall, CLI_TOOL_ALIASES } from '../engine/savings.js';
import type { SymbolSpan } from './apply.js';
import type { CodeFs } from './session.js';
import type { ChatMessage, FileChange, Provider, ProviderResult, ToolCall, ToolSpec } from './types.js';
import type { VgGraph } from '../schema.js';
import { redactSecrets } from './providers.js';

export type AgentEvent =
  | { type: 'assistant'; text: string }
  | { type: 'token'; text: string }
  | { type: 'tool-call'; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; name: string; content: string; mutated: boolean }
  | { type: 'change'; change: FileChange }
  | { type: 'compact'; droppedRounds: number }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'verify'; command: string; passed: boolean }
  | { type: 'step'; n: number };

export interface AgentOptions {
  graph: VgGraph;
  root: string;
  instruction: string;
  providers: Provider[];
  fsImpl: CodeFs;
  /** Run a shell command (injected). */
  run: (command: string) => ShellResult;
  /** Approval gate for mutating actions. */
  approve: (action: MutatingAction) => Promise<boolean>;
  maxSteps?: number;
  budget?: number;
  /** Approx token budget for the running transcript before it is compacted. */
  contextBudget?: number;
  /** Autonomous mode — enforce the command denylist (no human reviews each call). */
  auto?: boolean;
  /** Project-configured extra denylist rules for autonomous commands. */
  denyCommands?: string[];
  /** The project's test/verify command, surfaced to the model. */
  testCommand?: string;
  /** Auto-verify: after the model finishes, run this command and make it fix failures. */
  verify?: { command: string; maxRounds?: number };
  /** Stream assistant tokens as they arrive (emits `token` events). */
  stream?: boolean;
  /** A recap of earlier tasks (from `--continue`) to seed continuity. */
  priorSummary?: string;
  /** External MCP tools the model may also call (already approval-bound). */
  externalTools?: { specs: ToolSpec[]; owns: (name: string) => boolean; execute: (call: ToolCall) => Promise<ToolResult> };
  onEvent?: (e: AgentEvent) => void;
  /** Per-model savings attribution for graph-backed (`search_code`) calls. */
  attribution?: { client: string; provider?: string; model?: string };
  now?: () => number;
  /** Skip the audit record (tests / programmatic dry calls). */
  noAudit?: boolean;
}

export type AgentStop = 'finished' | 'max-steps' | 'no-tools' | 'no-progress' | 'error';

export interface AgentResult {
  finalText: string;
  changes: FileChange[];
  steps: number;
  stopped: AgentStop;
  provider: { id: string; model: string; fellBack: boolean };
  /** Total tokens the model reported over the run (for the cost meter). */
  usage: { promptTokens: number; completionTokens: number };
}

const DEFAULT_MAX_STEPS = 24;
/** Compact the transcript once it grows past this many estimated tokens. */
const DEFAULT_CONTEXT_BUDGET = 16_000;
/** Rounds (assistant + its tool results) to keep verbatim when compacting. */
const KEEP_ROUNDS = 8;
/** After this many identical, non-progressing repeats, nudge the model. */
const NUDGE_AT = 3;
/** After this many, stop the run as no-progress. */
const STOP_AT = 5;

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const { graph, root, instruction, providers, fsImpl } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const contextBudget = options.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  const now = options.now ?? (() => 0);
  const onEvent = options.onEvent ?? (() => {});

  const allTools = [...AGENT_TOOLS, ...(options.externalTools?.specs ?? [])];
  const context = buildCodeContext(graph, instruction, { budget: options.budget ?? 3000 });
  const messages: ChatMessage[] = buildAgentMessages(context);
  if (options.priorSummary) {
    messages.push({ role: 'user', content: options.priorSummary });
  }
  if (options.testCommand) {
    messages.push({ role: 'user', content: `When you want to verify a change, the project's test command is: \`${options.testCommand}\`` });
  }
  const spans = buildSpanIndex(graph);

  const changes: FileChange[] = [];
  const repeats = new Map<string, number>();
  let recordedSearch = false;
  let commandCount = 0;
  let verifyRounds = options.verify?.maxRounds ?? 2;
  const usage = { promptTokens: 0, completionTokens: 0 };
  let providerInfo = { id: providers[0]?.id ?? 'none', model: providers[0]?.model ?? '', fellBack: false };

  const ctx: ToolContext = { root, graph, fsImpl, spans, run: options.run, approve: options.approve, auto: options.auto, denyCommands: options.denyCommands };

  /** Single terminal path: writes the audit record once, then returns. */
  const finish = (stopped: AgentStop, finalText: string, steps: number): AgentResult => {
    const result: AgentResult = { finalText, changes, steps, stopped, provider: providerInfo, usage };
    if (!options.noAudit) writeAgentAudit(fsImpl, { instruction, providerInfo, changes, commandCount, steps, stopped }, now());
    return result;
  };

  /**
   * When the model calls finish: if auto-verify is on, changes were made, and
   * rounds remain, run the verify command. On failure feed the output back and
   * return 'retry' (the loop continues so the model fixes it); otherwise 'done'.
   */
  const verifyOnFinish = (): 'retry' | 'done' => {
    const v = options.verify;
    if (!v || verifyRounds <= 0 || changes.length === 0) return 'done';
    const res = options.run(v.command);
    onEvent({ type: 'verify', command: v.command, passed: res.exitCode === 0 });
    if (res.exitCode === 0) return 'done';
    verifyRounds--;
    messages.push({ role: 'user', content: `The task isn't finished — \`${v.command}\` failed (exit ${res.exitCode}):\n${res.stdout.slice(0, 8000)}\n\nFix the failing tests, then call finish again.${verifyRounds === 0 ? ' (last verification attempt)' : ''}` });
    return 'retry';
  };

  for (let step = 1; step <= maxSteps; step++) {
    onEvent({ type: 'step', n: step });

    // Keep the transcript under the budget: preserve the cache-stable prefix
    // (system + graph context + task) and the recent rounds, summarize the rest.
    const compacted = compact(messages, contextBudget, changes);
    if (compacted.droppedRounds > 0) {
      messages.length = 0;
      messages.push(...compacted.messages);
      onEvent({ type: 'compact', droppedRounds: compacted.droppedRounds });
    }

    let result: ProviderResult;
    try {
      const c = await complete(providers, messages, allTools, onEvent, options.stream);
      result = c.result;
      providerInfo = { id: c.provider.id, model: c.provider.model, fellBack: c.fellBack };
    } catch (e) {
      const msg = redactSecrets((e as Error).message);
      onEvent({ type: 'assistant', text: `error: ${msg}` });
      return finish('error', msg, step);
    }

    // Accumulate token usage for the cost meter.
    if (result.usage) {
      usage.promptTokens += result.usage.promptTokens ?? 0;
      usage.completionTokens += result.usage.completionTokens ?? 0;
      onEvent({ type: 'usage', promptTokens: result.usage.promptTokens ?? 0, completionTokens: result.usage.completionTokens ?? 0 });
    }

    if (result.text) onEvent({ type: 'assistant', text: result.text });

    const toolCalls = result.toolCalls ?? [];
    if (toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: result.text });
      return finish('no-tools', result.text, step);
    }

    messages.push({ role: 'assistant', content: result.text, toolCalls });

    for (const call of toolCalls) {
      onEvent({ type: 'tool-call', name: call.name, args: call.arguments });
      if (call.name === 'search_code' && options.attribution?.client && !recordedSearch) {
        recordedSearch = true;
        recordSearchSaving(root, context, options.attribution, now());
      }

      const toolResult = options.externalTools?.owns(call.name) ? await options.externalTools.execute(call) : await executeTool(call, ctx);
      if (call.name === 'run_command' && toolResult.mutated) commandCount++;
      if (toolResult.change) {
        changes.push(toolResult.change);
        onEvent({ type: 'change', change: toolResult.change });
      }

      // No-progress guard: a mutating call is progress (reset); a repeated
      // non-mutating identical call accumulates → nudge, then stop.
      const sig = `${call.name}:${stableArgs(call.arguments)}`;
      let content = toolResult.content;
      let stopNoProgress = false;
      if (toolResult.mutated || toolResult.finished) {
        repeats.delete(sig);
      } else {
        const n = (repeats.get(sig) ?? 0) + 1;
        repeats.set(sig, n);
        if (n >= STOP_AT) stopNoProgress = true;
        else if (n >= NUDGE_AT) content += `\n\n(note: you have called this exact tool call ${n} times with no change — try a different approach, read more context, or call finish.)`;
      }

      onEvent({ type: 'tool-result', name: call.name, content, mutated: toolResult.mutated });
      messages.push({ role: 'tool', content, toolCallId: call.id, name: call.name });

      if (toolResult.finished) {
        // Auto-verify: on failure, keep going so the model fixes it.
        if (verifyOnFinish() === 'retry') break;
        return finish('finished', toolResult.finalSummary ?? 'done', step);
      }
      if (stopNoProgress) return finish('no-progress', `stopped: the model repeated \`${call.name}\` without making progress`, step);
    }
  }
  return finish('max-steps', 'reached the step limit before finishing', maxSteps);
}

/** Try providers in order, falling back on transport failure. Throws the last actionable error. */
async function complete(
  providers: Provider[],
  messages: ChatMessage[],
  tools: ToolSpec[],
  onEvent: (e: AgentEvent) => void,
  stream?: boolean,
): Promise<{ result: ProviderResult; provider: Provider; fellBack: boolean }> {
  if (providers.length === 0) throw new Error('no model provider available');
  const onToken = stream ? (t: string): void => onEvent({ type: 'token', text: t }) : undefined;
  let lastErr: unknown;
  for (let i = 0; i < providers.length; i++) {
    try {
      const result = await providers[i].chat(messages, { temperature: 0, tools, stream, onToken });
      return { result, provider: providers[i], fellBack: i > 0 };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(lastErr instanceof Error ? redactSecrets(lastErr.message) : String(lastErr));
}

/**
 * Compact the transcript when it exceeds `budget` tokens: keep the first three
 * messages (system + graph context + task — the cache-stable prefix) and the
 * last {@link KEEP_ROUNDS} rounds verbatim, replacing the middle with a short
 * summary. A "round" is an assistant turn plus the tool results it triggered, so
 * an assistant/tool pair is never split (which an OpenAI-compatible API rejects).
 */
export function compact(messages: ChatMessage[], budget: number, changes: FileChange[]): { messages: ChatMessage[]; droppedRounds: number } {
  if (estimateTokens(messages) <= budget) return { messages, droppedRounds: 0 };
  const head = messages.slice(0, 3);
  const body = messages.slice(3);
  const rounds: ChatMessage[][] = [];
  for (const m of body) {
    if (m.role === 'assistant' || rounds.length === 0) rounds.push([m]);
    else rounds[rounds.length - 1].push(m);
  }
  if (rounds.length <= KEEP_ROUNDS) return { messages, droppedRounds: 0 };
  const dropped = rounds.slice(0, rounds.length - KEEP_ROUNDS);
  const kept = rounds.slice(-KEEP_ROUNDS).flat();
  const toolCalls = dropped.flat().reduce((n, m) => n + (m.role === 'assistant' ? (m.toolCalls?.length ?? 0) : 0), 0);
  const filesChanged = [...new Set(changes.map((c) => c.file))];
  const note: ChatMessage = {
    role: 'user',
    content: `[earlier steps summarized to save context: ${dropped.length} round(s), ${toolCalls} tool call(s) omitted.${filesChanged.length ? ` Files changed so far: ${filesChanged.join(', ')}.` : ''} Continue the task.]`,
  };
  return { messages: [...head, note, ...kept], droppedRounds: dropped.length };
}

function recordSearchSaving(root: string, context: ReturnType<typeof buildCodeContext>, attribution: NonNullable<AgentOptions['attribution']>, ts: number): void {
  const files = new Set(context.seeds.map((s) => s.node.file).filter(Boolean));
  recordCliCall(
    root,
    {
      tool: CLI_TOOL_ALIASES.ask,
      client: attribution.client,
      provider: attribution.provider,
      model: attribution.model,
      outcome: context.seeds.length ? 'complete' : 'miss',
      vgTokens: context.tokensEstimate,
      baselineFiles: files.size,
    },
    ts,
  );
}

/** An append-only, secret-free audit record for one agent run (no code, no output, no keys). */
function writeAgentAudit(
  fsImpl: CodeFs,
  rec: { instruction: string; providerInfo: { id: string; model: string }; changes: FileChange[]; commandCount: number; steps: number; stopped: AgentStop },
  ts: number,
): void {
  try {
    fsImpl.appendAudit(
      JSON.stringify({
        ts,
        kind: 'agent',
        instruction: rec.instruction.slice(0, 500),
        provider: rec.providerInfo.id,
        model: rec.providerInfo.model,
        steps: rec.steps,
        stopped: rec.stopped,
        commands: rec.commandCount,
        files: rec.changes.map((c) => ({ file: c.file, statuses: c.outcomes.map((o) => o.status) })),
      }),
    );
  } catch {
    /* audit is best-effort — never fail a run on a logging problem */
  }
}

/** Deterministic argument signature for the repeat guard (order-independent). */
function stableArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  return JSON.stringify(keys.map((k) => [k, args[k]]));
}

/** ~4 chars/token estimate over the transcript, including serialized tool calls. */
function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    if (m.role === 'assistant' && m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
  }
  return Math.ceil(chars / 4);
}

/** Per-file symbol spans, so an agent edit lands in the right place when its SEARCH is ambiguous. */
function buildSpanIndex(graph: VgGraph): Map<string, SymbolSpan[]> {
  const map = new Map<string, SymbolSpan[]>();
  for (const n of graph.nodes) {
    if (n.kind === 'file' || n.kind === 'external') continue;
    const file = n.file.replace(/\\/g, '/').replace(/^\.\//, '');
    const list = map.get(file) ?? [];
    list.push({ qualifiedName: n.qualifiedName, file, start: n.span.start, end: n.span.end });
    map.set(file, list);
  }
  return map;
}
