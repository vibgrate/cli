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
 * The system contract for the agentic loop (tool-calling). It steers the model
 * to use the code graph to navigate instead of reading blindly, to make small
 * verified changes, and to finish explicitly. Fixed text → stable cache prefix.
 */
export const AGENT_SYSTEM_PROMPT = [
  'You are VG Code, a precise coding agent working inside a real repository.',
  'You have tools: search_code (searches a deterministic code graph — prefer it over guessing),',
  'read_file, list_files, graph_impact (blast radius of a change), edit_file, create_file,',
  'delete_file, run_command, and finish.',
  '',
  'Work in small steps: search or read to understand before you edit; check graph_impact before',
  'changing shared code; make the smallest correct edit; run the tests or build to verify when useful.',
  'edit_file replaces an exact snippet — the search text must match the current file (whitespace is',
  'tolerated). Do not restate unchanged code. When the task is complete, call finish with a short summary.',
  '',
  'Editing, creating, deleting, and running commands require user approval — expect some to be declined,',
  'and adapt if so. Never invent file contents; read first.',
].join('\n');

/** Build the opening messages for an agent run: system contract + graph-grounded context + task. */
export function buildAgentMessages(context: CodeContext): ChatMessage[] {
  return [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: context.rendered },
    { role: 'user', content: `Task: ${context.instruction}` },
  ];
}
