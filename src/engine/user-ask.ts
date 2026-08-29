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
 * The panel also appends `@`-mention / active-editor context:
 *
 *   ---
 *   Context the user attached:
 *   Files the user pointed at:
 *   - packages/vibgrate-cli-public/src/code/session-store.ts
 *
 * Those backticks and paths are for the model. If the full instruction is fed
 * into {@link extractLiteralNeedles} / seed ranking, attachment basenames and
 * path segments (`packages`, `src`, `index`) become **literal-locate hard
 * constraints** and ranking tokens. Field reports: version-badge health UI with
 * a screenshot — agent searched for `image.png` and stopped; "where is the help
 * files for the cli" with the active editor under `packages/` ranked packaging
 * / vulnerability symbols.
 *
 * Retrieval, needle pinning, locate-only detection, and relevance analysis must
 * use {@link userAskFromInstruction}. The full instruction (with attachments
 * and mentions) still belongs in the Task / user message so the model can see
 * the appendix.
 */

/** Heading written by hosts when packing panel attachments into the instruction. */
export const USER_ATTACHMENTS_HEADING_PREFIX = '## User attachments';

/**
 * Heading written by the VS Code panel when packing `@`-mentions and the
 * active-editor file chip (`mentions.ts` `renderMentionContext`). Paths under
 * `packages/` in that block must not become ranking tokens.
 */
export const USER_MENTION_CONTEXT_HEADING = 'Context the user attached:';

const HOST_APPENDIX_RES: RegExp[] = [
  /\n---\s*\n## User attachments\b/,
  /\n---\s*\nContext the user attached:/,
  /(?:^|\n)## User attachments\b/,
  /(?:^|\n)Context the user attached:/,
];

/**
 * Return only the user-authored portion of an instruction, dropping trailing
 * host appendixes (attachments, @-mention / active-editor context). Unchanged
 * when no appendix.
 */
export function userAskFromInstruction(instruction: string): string {
  if (!instruction) return instruction;

  let cut = instruction.length;
  for (const re of HOST_APPENDIX_RES) {
    const m = re.exec(instruction);
    if (m && m.index != null && m.index < cut) cut = m.index;
  }
  if (cut === 0) return '';
  if (cut < instruction.length) return instruction.slice(0, cut).trimEnd();
  return instruction;
}

/**
 * The ask the RANKER sees. Same as {@link userAskFromInstruction}: host
 * appendixes stripped, user text otherwise intact.
 *
 * An earlier revision also deleted scope-fence sentences ("do not change the
 * tax helper", "leave X alone") before ranking. That recovered 0 of the −5 pt
 * fenced-ask penalty it targeted (docs/graph/VG-ASK-LENGTH-CAPSULE-ANALYSIS.md
 * §7.3) and is sentence-level deletion — a negation can be a fence or the
 * defect itself. It is not shipped. The alias stays so every caller
 * (`vg code`, `vg ask`, MCP, token-bench) keeps one name for "the ranking
 * input" without a second transformation.
 */
export function rankingAskFrom(instruction: string): string {
  return userAskFromInstruction(instruction);
}
