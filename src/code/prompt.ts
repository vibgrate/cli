/**
 * Prompt assembly with cache-stable ordering (VG-CLI-CODE §5.1).
 *
 * The fast coding tools lean hard on prompt caching — cached tokens are roughly
 * an order of magnitude cheaper and skip re-encoding, so hit-rate is a
 * first-class speed lever. A cache only helps if the *prefix* is byte-stable
 * across turns, which makes prompt ordering a scheduling constraint, not a
 * cosmetic choice: put the invariant material (the instruction contract + the
 * repo-derived context) first and the volatile turn-specific ask last. This
 * module is the single place that ordering is enforced, so every provider
 * inherits it.
 */

import type { ChatMessage, CodeContext } from './types.js';

/**
 * The system contract for the planner. Intentionally fixed (no interpolation)
 * so it is a perfectly stable cache prefix. It pins the edit *format* the
 * deterministic applier expects — the model's only job is to emit these blocks.
 */
export const CODE_SYSTEM_PROMPT = [
  'You are a precise code-editing assistant operating inside the Vibgrate CLI.',
  'You are given repository context derived from a deterministic code graph, then a task.',
  'Propose the smallest correct change. Do not restate unchanged code.',
  '',
  'Reply ONLY with edit blocks in this exact format, one per change:',
  '',
  '<path/to/file>',
  '<<<<<<< SEARCH',
  '<exact current lines to find>',
  '=======',
  '<replacement lines>',
  '>>>>>>> REPLACE',
  '',
  'The SEARCH text must match the current file (whitespace differences are tolerated).',
  'To add a new file use:',
  'CREATE <path/to/file>',
  '<full file body>',
  'END CREATE',
  'To remove a file use: DELETE <path/to/file>',
  '',
  'Respect every hard constraint in the context. Keep edits minimal and self-consistent.',
].join('\n');

/**
 * Build the chat messages for a planning turn, in cache-stable order:
 *   1. system contract (fixed)
 *   2. repository context (stable for the repo/turn — the big, reusable prefix)
 *   3. the task instruction (volatile — always last)
 *
 * Keeping the volatile instruction in its own trailing user turn maximizes the
 * reusable prefix when the same repo is edited across multiple asks.
 */
export function buildMessages(context: CodeContext): ChatMessage[] {
  return [
    { role: 'system', content: CODE_SYSTEM_PROMPT },
    { role: 'user', content: context.rendered },
    { role: 'user', content: `Now produce the edit blocks for: ${context.instruction}` },
  ];
}

/**
 * The system contract for the agentic loop (tool-calling). Fixed text → stable
 * cache prefix. Full coding agent (Claude Code / Codex / Cline / OpenHands class):
 * free tool use, Markdown answers, edits only via tools — never a forced edit IR.
 */
export const AGENT_SYSTEM_PROMPT = [
  'You are VG Code — a full coding agent in a real repository (parity with Claude Code / Codex / Cline / OpenHands).',
  'You handle every intent: questions, locate/search, design discussion, and multi-file edits. The host never forces an edit format on your turn — you choose tools.',
  'Most requests change application source. Prefer editing code under packages/src, not package manifests,',
  'unless the user asks for dependency or packaging work.',
  '',
  'You receive a Task Capsule (ranked symbols + source slices) as first-turn evidence. Use it;',
  'it does not replace tools when you need more context.',
  '',
  'Tools: search_code (graph + literal string/URL sweep — like workspace Find), read_file, list_files, graph_impact,',
  'library_docs, edit_file, create_file, delete_file, apply_patch, run_command, set_progress, inspect_task,',
  'inspect_change, verify_change, ask_user, finish, abort.',
  '',
  'You also always have the local Vibgrate AI Context MCP tools (namespaced',
  'mcp__vibgrate__*): search_symbols, query_graph, orient, get_node, impact_of,',
  'library_docs, check_drift, and the rest of `vg serve`. Prefer them for deep',
  'graph navigation, docs, and drift. Project MCP servers may add more mcp__* tools.',
  '',
  '## How to work',
  '- Search or read before you edit. Never invent file contents.',
  '- Smallest correct change; check graph_impact / mcp__vibgrate__impact_of before touching shared hubs.',
  '- edit_file SEARCH must match current file (whitespace-flexible). Prefer apply_patch for multi-file edits.',
  '- Run tests or build when useful; use verify_change after multi-file work.',
  '- For multi-step tasks, call set_progress early with a short plan; mark items done as you complete them.',
  '- Mutating tools and shell need user approval — adapt if declined.',
  '',
  '## Answers and task space',
  '- Call finish with a Markdown summary: what you did or found, key `file:line` refs, next steps.',
  '- Q&A / locate / explain: use search_code (pass the exact needle, e.g. stripe or "stripe"), then finish with Markdown.',
  '- Do not invent PatchIR, dummy edits, or raw JSON as the user-facing answer. Edits only via edit_file / apply_patch tools.',
  '',
  '## When stuck',
  '- If intent, scope, or trade-off is ambiguous, call ask_user with one clear question (optional options).',
  '- Prefer ask_user over abort when the user can unblock you. Do not guess product requirements.',
  '- abort only when the request is impossible after clarification or lookup.',
  '',
  'Never dump raw JSON schemas, PatchIR templates, or tool wire formats as the user-facing answer.',
].join('\n');

/** Build the opening messages for an agent run: system contract + graph-grounded context + task. */
export function buildAgentMessages(context: CodeContext): ChatMessage[] {
  return [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: context.rendered },
    { role: 'user', content: `Task: ${context.instruction}` },
  ];
}
