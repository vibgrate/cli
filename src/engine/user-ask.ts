/**
 * Split the user's ask from host-injected attachment metadata.
 *
 * The VS Code panel (`codeAttachments.ts`) and other hosts append a markdown
 * block after a `---` fence:
 *
 *   ## User attachments (always include in your reasoning for this turn)
 *   ### Attached image: `image.png`
 *   … saved at: `.vibgrate/code-attachments/…`
 *
 * Those backticks are for the model. If the full instruction is fed into
 * {@link extractLiteralNeedles} / seed ranking, attachment basenames and paths
 * become **literal-locate hard constraints** ("0 hits → finish, do not invent
 * an edit") and the agent aborts a real coding task. Field report: version-badge
 * health UI with a screenshot — agent searched for `image.png` and stopped.
 *
 * Retrieval, needle pinning, locate-only detection, and relevance analysis must
 * use {@link userAskFromInstruction}. The full instruction (with attachments)
 * still belongs in the Task / user message so the model can see the appendix.
 */

/** Heading written by hosts when packing panel attachments into the instruction. */
export const USER_ATTACHMENTS_HEADING_PREFIX = '## User attachments';

/**
 * Return only the user-authored portion of an instruction, dropping a trailing
 * host "User attachments" appendix when present. Unchanged when no appendix.
 */
export function userAskFromInstruction(instruction: string): string {
  if (!instruction) return instruction;

  // Canonical host shape: blank line, --- fence, then the attachments heading.
  const fenced = /\n---\s*\n## User attachments\b[^\n]*\n?/;
  const m = fenced.exec(instruction);
  if (m && m.index != null) {
    return instruction.slice(0, m.index).trimEnd();
  }

  // Defensive: heading without the fence (older hosts / hand-edited prompts).
  const bare = instruction.search(/(?:^|\n)## User attachments\b/);
  if (bare > 0) {
    return instruction.slice(0, bare).trimEnd();
  }
  if (bare === 0) {
    // Instruction is only the appendix — no user ask left.
    return '';
  }

  return instruction;
}
