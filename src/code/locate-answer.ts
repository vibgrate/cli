/**
 * Optional deterministic string/URL locate answers (opt-in via
 * `deterministicLocate: true` on the agent).
 *
 * The default VG Code path is a full coding agent: Task Capsule → model → tools.
 * This module remains for offline/CI shortcuts and for sanitizing accidental
 * PatchIR dumps out of the panel when a model ignores the tool contract.
 */

import { extractLiteralNeedles, isLocateOnlyInstruction } from '../engine/query.js';
import { searchSymbols, type TextHit } from '../engine/search.js';
import type { VgGraph } from '../schema.js';

export { isLocateOnlyInstruction };

export interface LocateAnswer {
  needle: string;
  hits: Array<{ file: string; line: number; preview: string }>;
  totalTextMatches: number;
  /** Human summary for the panel (finalText / assistant). */
  summary: string;
}

/** Prefer the longest extracted URL/quote; else the trimmed instruction. */
export function primaryLocateNeedle(instruction: string): string {
  const needles = extractLiteralNeedles(instruction);
  if (needles.length === 0) return instruction.trim();
  return [...needles].sort((a, b) => b.length - a.length)[0]!;
}

export function formatLocateAnswer(
  needle: string,
  hits: Array<{ file: string; line: number; preview: string }>,
  total: number,
): string {
  if (hits.length === 0) {
    return (
      `No occurrences of \`${needle}\` in this workspace.\n` +
      `(Literal search complete — 0 matches.)`
    );
  }
  const lines = hits.slice(0, 20).map((h) => `- ${h.file}:${h.line}  ${h.preview.trim().slice(0, 120)}`);
  const more =
    total > hits.length
      ? `\n… and ${total - hits.length} more (showing ${hits.length} of ${total}).`
      : total > 1
        ? `\n(${total} occurrence${total === 1 ? '' : 's'}.)`
        : '';
  return `Found \`${needle}\`:\n${lines.join('\n')}${more}`;
}

/**
 * Run the hybrid literal sweep and build a panel-ready locate answer.
 * Call only when {@link isLocateOnlyInstruction} is true and the agent opted into
 * `deterministicLocate`.
 *
 * Always forces an occurrence-quality search (quoted needle) so a single token
 * like `stripe` runs the full literal sweep — same corpus idea as workspace Find —
 * instead of symbol-only / skip-scan paths that report false "0 matches".
 */
export async function answerLocateInstruction(
  graph: VgGraph,
  root: string,
  instruction: string,
  limit = 30,
): Promise<LocateAnswer> {
  const needle = primaryLocateNeedle(instruction);
  // Quote so searchSymbols treats this as an occurrence sweep (isPhrase), not a
  // single-name symbol lookup that can skip the tree scan after an exact hit.
  const occurrenceQuery = /^https?:\/\//i.test(needle) ? needle : JSON.stringify(needle);
  const result = await searchSymbols(graph, root, occurrenceQuery, limit);
  const textHits = result.matches
    .filter((m): m is TextHit => m.kind === 'text')
    .map((m) => ({ file: m.file, line: m.line, preview: m.preview }));
  // Include symbol hits as file:line when the literal pass is empty but the graph
  // knows the name — better than a false "0 matches" against workspace Find.
  const symbolHits = result.matches
    .filter((m) => m.kind !== 'text')
    .map((m) => ({
      file: m.file,
      line: m.line,
      preview: 'name' in m ? `${m.name} (${m.kind})` : m.kind,
    }));
  const hits = textHits.length > 0 ? textHits : symbolHits;
  const total = result.totalTextMatches ?? hits.length;
  return {
    needle,
    hits,
    totalTextMatches: total,
    summary: formatLocateAnswer(needle, hits, total),
  };
}

/**
 * Strip model dump noise that must never be the panel's "answer":
 * PatchIR JSON blobs and `/* vg: unknown identifiers … *\/` annotations.
 */
export function sanitizeAgentDisplayText(text: string): string {
  if (!text) return text;
  let t = text.replace(/\n*\/\*\s*vg:\s*unknown identifiers[\s\S]*?\*\//gi, '').trim();
  // PatchIR is a tool payload, not a chat answer — drop it so the loop can continue
  // or finish cleanly. Do not re-route the user into a locate short-circuit.
  if (
    /"schemaVersion"\s*:\s*"patch-ir\/0"/i.test(t) ||
    (/"op"\s*:\s*"replace-text"/i.test(t) && /"operations"\s*:/i.test(t))
  ) {
    return (
      'The model returned an edit-shaped payload instead of a chat answer. ' +
      'Use tools (search_code, read_file, edit_file, apply_patch) or finish with Markdown.'
    );
  }
  return t;
}
